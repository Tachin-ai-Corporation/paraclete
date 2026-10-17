// agent/services/brain/envelope-store.mjs: the brain's access to work envelopes in Firestore: reads,
// whole-document saves, field-masked patches, compare-and-swap updates, the durable claim that keeps
// one mission on one processor, status changes through the transition table, history records, and
// the checkpoint-and-task pair that wraps a message the brain writes under a mission. It decides
// nothing about what work to do; the runner, the intake and the actions do. Built once by main.mjs and
// shared by every brain module.

import { randomBytes } from 'node:crypto';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { firestoreEncode, StoreConflict, StoreUnavailable } from '../../storage/firestore.mjs';
import { applyTransition, canTransition } from '../../work/work-transitions.mjs';
import { enforceMissionParentInvariant } from '../../work/plan-utils.mjs';
import { createHistoryWriter } from '../../context/history.mjs';
import { parseAddress } from '../../providers/channel.mjs';

/** How many times a compare-and-swap update re-reads and tries again after losing a race. */
const UPDATE_ATTEMPTS = 3;

/** The source_meta fields a message the brain writes under a mission carries from its mission. */
const ADDRESS_META = ['address', 'sender', 'sender_name', 'channel_msg_id'];

/**
 * A unique, time-ordered id: `<prefix>-<ms>-<8 hex>`. One plain path segment, so it is safe as a
 * document id, a directory name and a branch name.
 *
 * @param {string} [prefix='w']
 * @param {Function} [clock]
 * @returns {string}
 */
export function generateId(prefix = 'w', clock = Date.now) {
  return `${prefix}-${clock()}-${randomBytes(4).toString('hex')}`;
}

/**
 * The Address a reply goes to, from a decoded source_meta: its `address` (the ears stamp one on every
 * intake), else Chat's flat space and thread fields, else the dashboard. parseAddress in
 * agent/providers/channel.mjs is the one reader of an Address; it takes Firestore's encoded fields, so
 * the address fields are encoded for it.
 *
 * @param {object} [sourceMeta]
 * @param {string} [sourceChannel]
 * @returns {object} the Address
 */
export function addressOf(sourceMeta, sourceChannel) {
  if (!sourceMeta || typeof sourceMeta !== 'object') return parseAddress(null, sourceChannel);
  const subset = {};
  for (const key of ['address', 'spaceName', 'space', 'threadName']) {
    if (sourceMeta[key] !== undefined && sourceMeta[key] !== null) subset[key] = sourceMeta[key];
  }
  return parseAddress(firestoreEncode(subset), sourceChannel);
}

/** The Address an envelope's reply goes to. */
export function addressFor(envelope) {
  return addressOf(envelope?.source_meta, envelope?.source_channel);
}

/**
 * The source_meta a message written under a mission carries: where the mission came from and who
 * asked, never the mission's resume state.
 *
 * @param {object} [meta]
 * @returns {object}
 */
export function addressMeta(meta) {
  const out = {};
  for (const key of ADDRESS_META) if (meta && meta[key] !== undefined) out[key] = meta[key];
  return out;
}

/**
 * Creates the envelope store.
 *
 * @param {object}   deps
 * @param {object}   deps.db                 a client from agent/storage/firestore.mjs
 * @param {Function} [deps.log]              (level, message, fields?)
 * @param {Function} [deps.clock]            () => ms
 * @param {string}   [deps.transitionGuard]  'enforce' refuses an illegal status change; 'observe' logs it
 * @param {Function} [deps.defaultProjectId] () => the project a mission with none goes to
 * @param {number}   [deps.claimStaleMs]     how old a claim must be before another processor may take it
 */
export function createEnvelopeStore({
  db,
  log = () => {},
  clock = Date.now,
  transitionGuard = 'enforce', // default; callers pass the contracts value (brain.transition_guard)
  defaultProjectId = () => null,
  claimStaleMs = 600_000, // default; callers pass the contracts value (brain.claim_stale_ms)
}) {
  if (!db) throw new Error('createEnvelopeStore: db is required');
  const iso = () => new Date(clock()).toISOString();
  const workPath = (id) => `${COLLECTIONS.work}/${id}`;
  const newId = (prefix = 'w') => generateId(prefix, clock);
  const history = createHistoryWriter({
    firestoreWrite: (collection, docId, data) => db.write(`${collection}/${docId}`, data),
    now: clock,
  });

  /** The rules every saved envelope keeps: missions never nest, and every mission has a project. */
  function prepare(env) {
    if (enforceMissionParentInvariant(env)) {
      log('ERROR', `mission ${env.id} had parent ${env.parent_id} and no responsibility origin; demoted to a checkpoint`);
    }
    if (env.type === 'M' && !env.project_id) env.project_id = defaultProjectId() || null;
    return env;
  }

  async function read(id) {
    return db.read(workPath(id));
  }

  /** Throws StoreUnavailable when Firestore cannot answer; null only when the envelope is absent. */
  async function readStrict(id) {
    return db.read(workPath(id), { strict: true });
  }

  async function save(env, { strict = false } = {}) {
    prepare(env);
    return db.write(workPath(env.id), env, strict ? { strict: true } : {});
  }

  /** Writes only the named fields, so a concurrent writer of other fields is never overwritten. */
  async function patch(id, fields, { strict = false } = {}) {
    return db.patch(workPath(id), Object.keys(fields), firestoreEncode(fields), strict ? { strict: true } : {});
  }

  async function query(filters, opts = {}) {
    return db.query('', COLLECTIONS.work, filters, opts);
  }

  /**
   * A read-modify-write that lands only if the envelope did not change since it was read: a
   * compare-and-swap on the document's update time, retried a few times after a lost race.
   * `mutate` gets a copy of the current envelope and returns the envelope to write, or null to leave
   * it alone.
   *
   * @param {string} id
   * @param {(env: object) => object|null|Promise<object|null>} mutate
   * @returns {Promise<object|null>} what was written, or null when absent, declined or still racing
   * @throws {StoreUnavailable} when Firestore cannot answer
   */
  async function update(id, mutate) {
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
      const current = await db.readDoc(workPath(id));
      if (!current) return null;
      const next = await mutate({ ...current.data, id });
      if (!next) return null;
      prepare(next);
      try {
        await db.commit([{ path: workPath(id), data: next, precondition: { updateTime: current.updateTime } }]);
        return next;
      } catch (e) {
        if (!(e instanceof StoreConflict)) throw e;
        log('INFO', `envelope ${id} changed while it was being updated; reading it again (attempt ${attempt})`);
      }
    }
    return null;
  }

  /** Whether another processor holds the envelope right now. A claim older than claimStaleMs is dead. */
  function isClaimLive(env) {
    return Boolean(env?.claimed_by) && clock() - (Number(env.claimed_at_ms) || 0) < claimStaleMs;
  }

  /**
   * Claims an envelope for this processor. The claim is durable (it survives a restart) and atomic
   * (compare-and-swap), so two processors can never run one mission. When Firestore cannot answer,
   * the claim is declined: not knowing whether someone else holds it is not permission to take it.
   *
   * @param {string} id
   * @returns {Promise<{claimId: string, envelope: object}|null>}
   */
  async function claim(id) {
    const claimId = newId('claim');
    try {
      const envelope = await update(id, (doc) => {
        if (isClaimLive(doc)) {
          log('WARN', `envelope ${id} is claimed by ${doc.claimed_by}; not taking it`);
          return null;
        }
        return { ...doc, claimed_by: claimId, claimed_at_ms: clock() };
      });
      return envelope ? { claimId, envelope } : null;
    } catch (e) {
      if (e instanceof StoreUnavailable) {
        log('WARN', `claim of ${id} declined: Firestore could not answer (${e.message}), so whether another processor holds it is unknown`);
        return null;
      }
      throw e;
    }
  }

  /** Releases this processor's claim, if it still holds it. Field-masked, so nothing else is touched. */
  async function release(id, claimId) {
    try {
      const env = await read(id);
      if (env && env.claimed_by === claimId) await patch(id, { claimed_by: null, claimed_at_ms: null });
    } catch (e) {
      log('WARN', `claim release failed for ${id}: ${e.message}`);
    }
  }

  /**
   * Moves an envelope to `to` in place, through the transition table, and returns the moves made. A
   * paused envelope that cannot go straight to `to` passes through active (awaiting_approval →
   * active → complete), the same rule the checkpoint executor follows.
   *
   * @param {object} env
   * @param {string} to
   * @param {object} [event] - output, error, blocker, blockerType, reason, resumeAt, resumeInstruction
   * @returns {Array<[string, string]>} the moves, [] for a no-op
   * @throws {Error} on an illegal move while the guard enforces
   */
  function move(env, to, event = {}) {
    const at = iso();
    const from = env.status;
    let res = applyTransition(env, { ...event, to, at });
    let hops = [[from, to]];
    if (!res.ok && to !== 'active' && canTransition(from, 'active').allowed && canTransition('active', to).allowed) {
      const resumed = applyTransition(env, { to: 'active', at });
      const onward = resumed.ok ? applyTransition(resumed.envelope, { ...event, to, at }) : resumed;
      if (onward.ok) {
        res = onward;
        hops = [[from, 'active'], ['active', to]];
      }
    }
    if (!res.ok) {
      const reason = `${env.id}: '${from}' → '${to}' refused: ${res.reason}`;
      log('WARN', `[TELEMETRY] illegal_transition envelope=${env.id} type=${env.type} from=${from} to=${to}`);
      if (transitionGuard !== 'observe') throw new Error(`illegal envelope transition, ${reason}`);
      Object.assign(env, { status: to, updated_at: at });
      return [[from, to]];
    }
    if (!res.changed) return [];
    Object.assign(env, res.envelope);
    return hops;
  }

  /**
   * Changes an envelope's status, saves it, and writes one history record per move.
   *
   * @returns {Promise<boolean>} whether the status changed
   */
  async function setStatus(env, to, detail, { event = {}, actor = 'brain', strict = false } = {}) {
    const hops = move(env, to, event);
    if (hops.length === 0) return false;
    await save(env, { strict });
    for (const [from, next] of hops) await history.write(env.id, from, next, actor, detail);
    return true;
  }

  /** Appends one record to the envelope's history (agent/context/history.mjs). */
  async function writeHistory(envelopeId, prevStatus, newStatus, actor, detail, logicalKey) {
    try {
      await history.write(envelopeId, prevStatus, newStatus, actor, detail, logicalKey);
    } catch (e) {
      log('WARN', `history write failed for ${envelopeId}: ${e.message}`);
    }
  }

  /**
   * Writes a checkpoint and task pair under a mission, for something the brain itself produced (an
   * acknowledgment, a synthesis), keeping every output inside the mission → checkpoint → task shape.
   * Idempotent by `ctKey`: a pair already written under the mission with that key is returned instead
   * of written again, so a replay never duplicates a message.
   *
   * @param {object} parent - the mission; its children list is updated in place (the caller saves it)
   * @param {object} opts
   * @returns {Promise<string>} the checkpoint's id
   */
  async function createCT(parent, {
    checkpointTitle, taskTitle, taskOutput, taskIntent = 'execute', taskStatus = 'complete',
    deliveryStatus = 'internal', deliveryAddress = null, ctKey = null,
  }) {
    if (ctKey) {
      for (const childId of parent.children || []) {
        const existing = await read(childId).catch(() => null);
        if (existing?.type === 'C' && existing.source_meta?.ct_key === ctKey) return childId;
      }
    }
    const cpId = newId('w');
    const taskId = newId('w');
    const at = iso();
    const done = taskStatus === 'complete';
    const cp = {
      id: cpId, type: 'C', parent_id: parent.id, status: done ? 'complete' : 'active', intent: 'checkpoint',
      title: checkpointTitle, instruction: checkpointTitle, accept_criteria: '', context_summary: null, output: null,
      children: [taskId], context_forward: null, error: null, source_channel: 'brain',
      source_meta: ctKey ? { ct_key: ctKey } : {}, project_id: parent.project_id || null,
      created_at: at, started_at: at, completed_at: done ? at : null, updated_at: at, iteration: 0,
      delivery_status: 'internal',
    };
    const task = {
      id: taskId, type: 'T', parent_id: cpId, status: taskStatus, intent: taskIntent,
      title: taskTitle, instruction: taskTitle, accept_criteria: '', context_summary: null,
      output: taskOutput, children: [], context_forward: null, error: null,
      source_channel: parent.source_channel || 'brain', source_meta: addressMeta(parent.source_meta),
      project_id: parent.project_id || null,
      created_at: at, started_at: at, completed_at: done ? at : null, updated_at: at, iteration: 0,
      delivery_status: deliveryStatus,
      ...(deliveryAddress ? { delivery_address: deliveryAddress } : {}),
    };
    await db.write(workPath(cpId), cp);
    await db.write(workPath(taskId), task);
    parent.children = [...(parent.children || []), cpId];
    parent.updated_at = at;
    return cpId;
  }

  return {
    newId,
    iso,
    read,
    readStrict,
    save,
    patch,
    query,
    update,
    isClaimLive,
    claim,
    release,
    move,
    setStatus,
    writeHistory,
    createCT,
    /** Library adapters, in the (collection, docId) shape agent/work and agent/context take. */
    firestoreRead: (collection, docId) => db.read(`${collection}/${docId}`),
    firestoreWrite: (collection, docId, data) => db.write(`${collection}/${docId}`, data),
    firestoreQuery: (collection, filters, opts) => db.query('', collection, filters, opts),
  };
}
