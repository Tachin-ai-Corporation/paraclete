// agent/services/brain/gateway-client.mjs: the brain's calls to the gateway, the local service that
// runs organ turns. One organ turn is POST /v1/chat/completions with model 'brain/<organ>'; the gateway
// leads every turn with the organ's own prompt, so the brain sends only its context blocks (as system
// messages) and the turn itself (as the user message). This file renders a task into that message,
// stores large tool results by reference and swaps in a digest (agent/context/tool-record.mjs), and
// keeps the cortex's per-mission session: open, continue with only what is new, and reopen on any miss.
// What to ask an organ, and what to do with the answer, belongs to the runner, the intake and the
// actions. The HTTP contract is agent/gateway/README.md.

import { completeToolLog, digestInstruction, recordPolicy, TOOL_RESULTS_COLLECTION } from '../../context/tool-record.mjs';
import { toStr } from '../../providers/to-str.mjs';

/** Marks a gateway turn as the brain's own, not a person's chat turn. The gateway passes it through. */
export const BRAIN_MARKER = '[BRAIN-ORCHESTRATED]';

/** Why a session `continue` can miss: the brain reopens on every one of them. */
export const SESSION_MISS_REASONS = Object.freeze(['absent', 'organ', 'system_hash', 'seq']);

/**
 * Reads the gateway's bearer token from its file. A missing or empty token stops the brain at
 * startup: every organ call would be refused.
 *
 * @param {string} file
 * @param {(path: string) => string} readText
 * @returns {string}
 */
export function readGatewayToken(file, readText) {
  let token;
  try {
    token = String(readText(file) || '').trim();
  } catch (e) {
    throw new Error(`Cannot read the gateway token at ${file}: ${e.message}`);
  }
  if (!token) throw new Error(`The gateway token at ${file} is empty`);
  return token;
}

/** The text of a chat message's content, whether a string or an array of text parts. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
  return '';
}

/** A recalled memory packet as text: the recall object `{ recalled }` or a plain string. */
export function memoryText(memory) {
  if (!memory) return '';
  if (typeof memory === 'string') return memory;
  return typeof memory.recalled === 'string' ? memory.recalled : '';
}

/**
 * The user message for one organ task. Mission-stable sections lead and the task comes last: the
 * stable prefix stays byte-identical across a plan's tasks, which the providers' prompt caching keys
 * on, and the end of a long context is where a model attends most.
 *
 * @param {object} payload - { instruction, accept_criteria, context_summary, _missionId, _projectContext,
 *   _sourceText, _requester, prior_results_context, memory_context } (the checkpoint executor's shape)
 * @param {object} [opts]
 * @param {Function} [opts.missionDir] - (missionId) => the mission tree's path
 * @returns {string}
 */
export function renderTaskMessage(payload = {}, { missionDir } = {}) {
  const p = payload || {};
  const missionId = p._missionId || null;
  const dir = missionId && typeof missionDir === 'function' ? missionDir(missionId) : null;
  const memory = memoryText(p.memory_context);
  return [
    BRAIN_MARKER,
    dir ? [
      '',
      '## Mission Tree',
      `This mission's working tree is \`${dir}/\`, a git checkout of its project's artifact repository.`,
      'Write the files the work produces there, and refer to them by name in your answer; they are',
      'committed after each checkpoint passes. Notes from earlier steps are under missions/<mission id>/steps/ in it.',
    ].join('\n') : '',
    p._requester ? `\n## Requester\nThe person who asked for this work: ${p._requester}. Use this address when the work shares something with them.` : '',
    p._projectContext ? `\n## Project Context\n${p._projectContext}` : '',
    p._sourceText ? `\n## Original Request\n${p._sourceText}` : '',
    memory ? `\n## Relevant Memory\n${memory}` : '',
    p.context_summary ? `\n## Context\n${p.context_summary}` : '',
    p.prior_results_context ? `\n## Prior Work\n${p.prior_results_context}` : '',
    p.instruction || p.task ? `\n## Task\n${p.instruction || p.task}` : '',
    p.accept_criteria ? `\n## Acceptance Criteria\n${p.accept_criteria}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Creates the gateway client.
 *
 * @param {object}   deps
 * @param {string}   deps.url               the gateway's origin, e.g. http://127.0.0.1:18789
 * @param {string}   deps.token             the bearer token
 * @param {Function} [deps.fetch]
 * @param {number}   [deps.timeoutMs]       how long one organ turn may take
 * @param {Function} [deps.temperatureFor]  (organ) => temperature to send, or undefined for the organ's default
 * @param {Function} [deps.missionDir]      (missionId) => the mission tree's path, named in task messages
 * @param {object}   [deps.toolRecords]     where large tool results go: { db, policy, digest(rec), newId(prefix) }
 * @param {Function} [deps.onUsage]         (missionId, organ, usage, durationMs) => void, for token accounting
 * @param {Function} [deps.log]
 * @param {Function} [deps.clock]
 */
export function createGatewayClient({
  url,
  token,
  fetch = globalThis.fetch,
  timeoutMs = 300_000, // default; callers pass the contracts value (brain.gateway_timeout_ms)
  temperatureFor = () => undefined,
  missionDir = null,
  toolRecords = null,
  onUsage = () => {},
  log = () => {},
  clock = Date.now,
}) {
  if (!url) throw new Error('createGatewayClient: url is required');
  if (!token) throw new Error('createGatewayClient: token is required');
  const base = url.replace(/\/+$/, '');
  const policy = recordPolicy(toolRecords?.policy);
  const auth = { Authorization: `Bearer ${token}` };

  /**
   * One organ turn. Never throws: a transport failure comes back as { ok: false, error }.
   *
   * @param {string} organ
   * @param {object} body - messages, plus max_tokens, temperature, top_p, exec, session
   * @returns {Promise<{ok: boolean, status?: number, data?: object, content: string, durationMs: number,
   *   error?: string, timedOut?: boolean}>}
   */
  async function turn(organ, body) {
    const start = clock();
    const temperature = body.temperature ?? temperatureFor(organ);
    try {
      const resp = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `brain/${organ}`,
          ...body,
          ...(temperature !== undefined ? { temperature } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const durationMs = clock() - start;
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        log('ERROR', `gateway ${organ} turn failed: HTTP ${resp.status} ${text.substring(0, 200)}`);
        return { ok: false, status: resp.status, content: '', durationMs, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      return { ok: true, status: resp.status, data, content: contentText(data.choices?.[0]?.message?.content), durationMs };
    } catch (e) {
      const durationMs = clock() - start;
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      const error = timedOut
        ? `The operation timed out after ${Math.round(durationMs / 1000)}s`
        : `the gateway is unreachable: ${e?.cause?.message || e?.message || e}`;
      log(timedOut ? 'WARN' : 'ERROR', `gateway ${organ} turn: ${error}`);
      return { ok: false, content: '', durationMs, error, ...(timedOut ? { timedOut: true } : {}) };
    }
  }

  /** Stores one large tool result in full. Objects before refs: the ref exists once the write did. */
  async function storeToolResult(rec, { missionId, organ }) {
    const id = toolRecords.newId('tr');
    const now = new Date(clock());
    await toolRecords.db.write(`${TOOL_RESULTS_COLLECTION}/${id}`, {
      id,
      mission_id: missionId || null,
      organ,
      tool: rec.tool,
      args: rec.args,
      chars: rec.chars,
      result: rec.result,
      created_at: now.toISOString(),
      // A timestamp, so the collection's TTL policy expires it.
      expire_at: new Date(now.getTime() + policy.store_ttl_days * 86_400_000),
    }, { strict: true });
    return `${TOOL_RESULTS_COLLECTION}/${id}`;
  }

  /**
   * One task turn for an organ, in the shape the checkpoint executor takes: { success, output, error,
   * durationMs, finishReason?, timedOut?, usage? }. A successful HTTP turn is a success; judging the
   * content is the caller's job.
   *
   * @param {string} organ
   * @param {object} payload - see renderTaskMessage; `_exec: true` gives temporal-memory its tools
   */
  async function callAgent(organ, payload = {}) {
    const missionId = payload._missionId || null;
    const res = await turn(organ, {
      messages: [{ role: 'user', content: renderTaskMessage(payload, { missionDir }) }],
      exec: payload._exec === true,
    });
    if (!res.ok) {
      return { success: false, output: null, error: res.error, durationMs: res.durationMs, ...(res.timedOut ? { timedOut: true } : {}) };
    }
    let content = res.content;
    const large = res.data?.tool_records;
    if (Array.isArray(large) && large.length > 0 && toolRecords) {
      const done = await completeToolLog(content, large, {
        policy,
        store: (rec) => storeToolResult(rec, { missionId, organ }),
        digest: toolRecords.digest ? (rec) => toolRecords.digest(rec, policy) : undefined,
      });
      content = done.text;
      for (const r of done.recorded) {
        log('INFO', `[TELEMETRY] tool_record mission=${missionId || '-'} organ=${organ} tool=${r.tool} chars=${r.chars} digested=${r.digested} ref=${r.ref || 'none'}`);
      }
    }
    onUsage(missionId, organ, res.data?.usage || null, res.durationMs);
    return {
      success: true,
      output: content,
      error: null,
      durationMs: res.durationMs,
      usage: res.data?.usage || null,
      finishReason: res.data?.choices?.[0]?.finish_reason || 'stop',
    };
  }

  /**
   * One cortex (or prefrontal) turn whose answer is a JSON decision, held to its schema.
   *
   * @param {object} p
   * @param {string}   [p.organ='cortex']
   * @param {string}   p.mode            the schema: classify, decide, analyze, plan or respond_compose
   * @param {string[]} p.system          system blocks, most stable first
   * @param {Array}    p.user            the user turn's content parts (or text)
   * @param {string}   [p.assistant]     the previous decision, replayed before a session `continue`
   * @param {object}   [p.session]       { id, op, seq }
   * @param {Function} p.enforceSchema   (raw, mode) => Promise<object>; vertex-text's
   * @param {string}   [p.missionId]     for token accounting
   * @returns {Promise<object>} the decision, with `usage`, `durationMs`, `_session` and `_coercedDecision`;
   *   { _session_miss: true, reason } when a continue missed; { error } on a failed turn
   */
  async function askJson({ organ = 'cortex', mode, system = [], user, assistant = null, session = null, enforceSchema, missionId = null }) {
    const res = await turn(organ, {
      messages: [
        ...system.filter(Boolean).map((content) => ({ role: 'system', content })),
        ...(assistant ? [{ role: 'assistant', content: assistant }] : []),
        { role: 'user', content: user },
      ],
      ...(session ? { session } : {}),
    });
    if (!res.ok) return { error: res.error || 'gateway_error', durationMs: res.durationMs };
    const echo = res.data?.session || null;
    if (session?.op === 'continue' && echo?.present !== true) {
      const reason = echo?.reason || 'no_echo';
      log('INFO', `[TELEMETRY] session_miss id=${session.id} reason=${reason}`);
      return { _session_miss: true, reason };
    }
    onUsage(missionId, organ, res.data?.usage || null, res.durationMs);
    const parsed = await enforceSchema(res.content, mode);
    const decision = parsed && typeof parsed === 'object' ? parsed : { error: 'parse_failed' };
    // The coerced decision, captured before brain-side fields are attached, is what a later
    // session `continue` replays as the assistant turn: valid JSON, never the raw reply.
    decision._coercedDecision = decision.error ? null : JSON.stringify(decision);
    decision.usage = res.data?.usage || null;
    decision.durationMs = res.durationMs;
    decision._session = echo;
    return decision;
  }

  /** Drops a session. Idempotent; a failure is left to the gateway's idle expiry. */
  async function closeSession(id) {
    try {
      await fetch(`${base}/v1/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      log('WARN', `session close failed (the gateway's idle expiry clears it): ${e.message}`);
    }
  }

  /** Whether the gateway answers at all. */
  async function ping() {
    try {
      const resp = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  return { turn, callAgent, askJson, closeSession, ping, url: base, token, digestPolicy: policy };
}

/**
 * The digest a large tool result is replaced by in the log: the utility model's condensation,
 * labelled as one. Utility work, not an organ's judgement.
 *
 * @param {object} vertexText - a client from agent/providers/vertex-text.mjs
 * @returns {(rec: object, policy: object) => Promise<string|null>}
 */
export function toolResultDigester(vertexText) {
  return (rec, policy) => vertexText.transform(toStr(rec.result), digestInstruction(policy), {
    maxTokens: Math.ceil(policy.digest_max_chars / 3),
    temperature: 0.1,
    disableThinking: true,
    timeoutMs: policy.digest_timeout_ms,
  });
}

/**
 * The cortex's session for one mission run. The gateway keeps the mission's conversation, so a
 * `continue` sends only what is new since the last decision; the first turn opens it with the full
 * context. A session is a cache that can always be rebuilt: any miss (absent, organ, system_hash, seq)
 * or a reply that would not parse reopens it with the full context in the same turn, and after
 * `breaker` misses the mission stops using sessions and sends the full context every turn.
 *
 * @param {object} p
 * @param {object}   p.client         from createGatewayClient()
 * @param {string}   p.missionId
 * @param {boolean}  [p.enabled]      contracts.session.enabled
 * @param {number}   [p.breaker=3]    misses before the session is given up for this run
 * @param {number}   [p.generation=0] the last generation used for this mission (envelope._session)
 * @param {Function} p.enforceSchema
 * @param {Function} [p.log]
 */
export function createCortexSession({ client, missionId, enabled = false, breaker = 3, generation = 0, enforceSchema, log = () => {} }) {
  let live = null; // { id, seq }
  let gen = generation;
  let misses = 0;
  let lastDecision = null;
  let sentUpto = 0;

  const usable = () => enabled && misses < breaker;

  async function open({ system, openUser, resultsCount }) {
    gen += 1;
    const id = `${missionId}:cortex:g${gen}`;
    const opened = await client.askJson({ mode: 'decide', system, user: openUser, session: { id, op: 'open', seq: 0 }, enforceSchema, missionId });
    if (opened.error) {
      misses += 1;
      return null;
    }
    if (opened._session?.present) {
      live = { id, seq: opened._session.seq ?? 0 };
      lastDecision = opened._coercedDecision || null;
      sentUpto = resultsCount;
      log('INFO', `[TELEMETRY] session_open mission=${missionId} id=${id}`);
    } else {
      misses += 1; // a full-context decision, valid, but no session came of it
    }
    return opened;
  }

  /**
   * One decide turn.
   *
   * @param {object} p
   * @param {string[]} p.system
   * @param {Array}    p.openUser       the full working state, for an open or a stateless call
   * @param {(sentUpto: number) => Array} p.deltaUser  only what is new since result `sentUpto`
   * @param {number}   p.resultsCount   how many prior results the model will have seen after this turn
   * @returns {Promise<object>} the decision (see askJson)
   */
  async function decide({ system, openUser, deltaUser, resultsCount }) {
    if (usable() && live && lastDecision) {
      const cont = await client.askJson({
        mode: 'decide', system, user: deltaUser(sentUpto), assistant: lastDecision,
        session: { id: live.id, op: 'continue', seq: live.seq }, enforceSchema, missionId,
      });
      if (!cont._session_miss && !cont.error) {
        live.seq = cont._session?.seq ?? live.seq + 1;
        lastDecision = cont._coercedDecision || lastDecision;
        sentUpto = resultsCount;
        return cont;
      }
      // A reply that would not parse is not replayed into the transcript: drop the session.
      if (cont.error) await client.closeSession(live.id);
      log('INFO', `[TELEMETRY] session_reopen mission=${missionId} reason=${cont.reason || 'unparseable'}`);
      live = null;
      misses += 1;
    }
    if (usable() && !live) {
      const opened = await open({ system, openUser, resultsCount });
      if (opened) return opened;
    }
    return client.askJson({ mode: 'decide', system, user: openUser, enforceSchema, missionId });
  }

  /** Ends the session: at every exit, and whenever the context it holds was rewritten. */
  async function close() {
    if (live) await client.closeSession(live.id);
    live = null;
    lastDecision = null;
  }

  return {
    decide,
    close,
    /** The ids and counters the envelope keeps (never content). */
    snapshot: () => ({ id: live?.id || null, seq: live?.seq ?? null, generation: gen }),
    get open() { return Boolean(live); },
    get misses() { return misses; },
  };
}
