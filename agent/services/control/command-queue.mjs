// agent/services/control/command-queue.mjs: the control service's queue: the root `commands`
// collection the dashboard writes to. Each tick it claims pending commands one at a time, runs each
// through its handler, and records the outcome on the command document. What each command does lives
// in commands.mjs; the request and result shapes are documented in README.md.
//
// A command is never run twice. It is claimed with a compare-and-swap (pending to running, only if the
// document is unchanged since it was read) before anything runs, and a command found `running` when
// the service starts was interrupted: it is marked failed, never run again. The one exception is a
// command that runs outside this process (an upgrade, in its own systemd unit): it carries a
// `detached` record, and each tick asks its handler how it stands until it has finished.
//
// Only signed commands run (agent/auth/command-signature.mjs). A command whose signature is missing,
// wrong or expired is claimed and failed as refused, without running. One whose signature cannot be
// checked yet (Google's keys unreachable) stays pending for the next tick.

import { firestoreEncode, StoreConflict } from '../../storage/firestore.mjs';
import { CommandSignatureError } from '../../auth/command-signature.mjs';

export const STATUS = Object.freeze({ pending: 'pending', running: 'running', done: 'done', failed: 'failed' });

/** Pending commands read per tick; any more wait for the next tick. */
const PENDING_PER_TICK = 10;

const DETACHED = Symbol('detached');
const THEN = Symbol('then');
const REFUSED = Symbol('refused');

/** A handler's answer for a command that keeps running outside this process; its record is already stored. */
export function detached() {
  return { [DETACHED]: true };
}

/**
 * A handler's answer for a command that must be recorded as done before a last action, because the
 * action ends this process (control restarting itself).
 *
 * @param {object}   result
 * @param {Function} action async () => void
 */
export function thenRun(result, action) {
  return { [THEN]: action, result };
}

/**
 * Creates the queue.
 *
 * @param {object}   o
 * @param {object}   o.db          a client from agent/storage/firestore.mjs
 * @param {object}   o.collections COLLECTIONS
 * @param {Record<string, {run: Function, watch?: Function}>} o.handlers by command type. run(params,
 *   ctx) returns the result, detached() or thenRun(); it throws to fail the command, and an error's
 *   `result` is kept. watch(record, ctx) returns {finished: false} or {finished: true, ok, result, error}.
 * @param {Function} o.verifyCommand async (command, id) => claims; rejects with CommandSignatureError
 *   when the command may not run (createCommandVerifier() in agent/auth/command-signature.mjs)
 * @param {Function} [o.log]
 * @param {Function} [o.now]       () => Date
 */
export function createCommandQueue({ db, collections, handlers, verifyCommand, log = () => {}, now = () => new Date() }) {
  if (typeof verifyCommand !== 'function') throw new Error('createCommandQueue: verifyCommand is required; only signed commands run');
  const iso = () => now().toISOString();
  const pathOf = (id) => `${collections.commands}/${id}`;
  let firstPass = true;
  // Whether a detached command may still be running, so the running commands are worth a query.
  let watching = false;

  const byStatus = (status, limit) => db.query('', collections.commands,
    [{ field: 'status', op: 'EQUAL', value: { stringValue: status } }], { noOrderBy: true, limit, strict: true });

  /**
   * Claims a pending command: pending to running, only if the document is unchanged since it was read.
   * Null when it is no longer pending, another writer got there first, or its signature cannot be
   * checked yet. A command whose signature is refused is claimed too, so it can be failed, never run.
   * The claim rewrites the whole document, so every timestamp in it is an ISO string afterwards.
   *
   * @param {string} id
   * @returns {Promise<object|null>} the command as claimed
   */
  async function claim(id) {
    const current = await db.readDoc(pathOf(id));
    if (!current || current.data.status !== STATUS.pending) return null;
    let refusal = null;
    try {
      await verifyCommand(current.data, id);
    } catch (err) {
      if (!(err instanceof CommandSignatureError)) {
        log('WARN', `command ${id}: its signature could not be checked (${err.message}); it stays pending`);
        return null;
      }
      refusal = err.message;
    }
    const data = { ...current.data, status: STATUS.running, started_at: iso() };
    try {
      await db.commit([{ path: pathOf(id), data, precondition: { updateTime: current.updateTime } }]);
    } catch (err) {
      if (err instanceof StoreConflict) return null;
      throw err;
    }
    return refusal ? { ...data, [REFUSED]: refusal } : data;
  }

  /**
   * Records a command's outcome. A result Firestore refuses (too large, say) would leave the command
   * running forever on the dashboard, so the outcome is written again without the result, saying why.
   *
   * @param {string} id
   * @param {{ok: boolean, result?: object|null, error?: string|null}} outcome
   */
  async function finish(id, { ok, result = null, error = null }) {
    const fields = { status: ok ? STATUS.done : STATUS.failed, result, error: ok ? null : String(error || 'failed'), finished_at: iso() };
    try {
      await db.patch(pathOf(id), Object.keys(fields), firestoreEncode(fields), { strict: true });
    } catch (err) {
      log('ERROR', `command ${id}: its outcome could not be stored (${err.message}); storing it without the result`);
      const lost = `the result could not be stored: ${err.message}`;
      const bare = { status: fields.status, result: null, error: ok ? lost : `${fields.error}; ${lost}`, finished_at: iso() };
      await db.patch(pathOf(id), Object.keys(bare), firestoreEncode(bare), { strict: true });
    }
    log(ok ? 'INFO' : 'WARN', `command ${id} ${fields.status}${ok ? '' : `: ${fields.error}`}`);
  }

  /** Runs one claimed command through its handler and records the outcome. */
  async function execute(id, command) {
    if (command[REFUSED]) {
      log('WARN', `command ${id} ${command.type} refused: ${command[REFUSED]}`, { command: id, type: command.type, requested_by: command.requested_by ?? null });
      return finish(id, { ok: false, error: `refused: ${command[REFUSED]}` });
    }
    const handler = Object.hasOwn(handlers, command.type) ? handlers[command.type] : null;
    if (!handler) {
      return finish(id, { ok: false, error: `unknown command type '${command.type}' (expected one of ${Object.keys(handlers).join(', ')})` });
    }
    const ctx = {
      id,
      requestedBy: typeof command.requested_by === 'string' ? command.requested_by : null,
      /** Stores the record of a command that will keep running outside this process. */
      detach: (record) => db.patch(pathOf(id), ['detached'], firestoreEncode({ detached: record }), { strict: true }),
    };
    log('INFO', `command ${id} ${command.type} running`, { command: id, type: command.type, requested_by: ctx.requestedBy });
    let answer;
    try {
      const params = command.params && typeof command.params === 'object' && !Array.isArray(command.params) ? command.params : {};
      answer = await handler.run(params, ctx);
    } catch (err) {
      return finish(id, { ok: false, error: err.message, result: err.result ?? null });
    }
    if (answer?.[DETACHED]) {
      watching = true;
      log('INFO', `command ${id} ${command.type} continues outside the control service`);
      return undefined;
    }
    if (answer?.[THEN]) {
      await finish(id, { ok: true, result: answer.result });
      return answer[THEN]();
    }
    return finish(id, { ok: true, result: answer ?? null });
  }

  /**
   * The running commands. On the first pass after startup, one that is not detached was interrupted
   * when this service stopped: it is failed, never run again. A detached one is asked how it stands,
   * and recorded once it has finished. Later passes query only while something detached is running.
   */
  async function sweepRunning() {
    if (!firstPass && !watching) return;
    let unfinished = 0;
    for (const command of await byStatus(STATUS.running, 100)) {
      if (!command.detached) {
        if (firstPass) {
          await finish(command.id, {
            ok: false,
            error: 'interrupted: the control service stopped while this command ran, so how it ended is unknown; it was not run again',
          });
        }
        continue;
      }
      const handler = Object.hasOwn(handlers, command.type) ? handlers[command.type] : null;
      if (!handler?.watch) {
        await finish(command.id, { ok: false, error: `no handler watches '${command.type}' commands` });
        continue;
      }
      try {
        const state = await handler.watch(command.detached, { id: command.id });
        if (state.finished) await finish(command.id, state);
        else unfinished += 1;
      } catch (err) {
        unfinished += 1;
        log('WARN', `command ${command.id}: could not read how it stands: ${err.message}`);
      }
    }
    firstPass = false;
    watching = unfinished > 0;
  }

  /**
   * One pass: the running commands, then the pending ones, claimed and run one at a time, oldest
   * first. Store failures propagate; the caller logs them and tries again next tick.
   */
  async function tick() {
    await sweepRunning();
    const pending = await byStatus(STATUS.pending, PENDING_PER_TICK);
    // Ordered here, not by the query: ordering on top of the status filter would need an index, and a
    // created_at written as a timestamp and one written as a string would sort apart.
    pending.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id));
    for (const { id } of pending) {
      const command = await claim(id);
      if (command) await execute(id, command);
    }
  }

  return { tick, claim, finish };
}
