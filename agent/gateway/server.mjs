// agent/gateway/server.mjs: the gateway's HTTP surface. One OpenAI-style chat completions endpoint
// runs an organ turn (the request's `model` names the organ, e.g. 'brain/motor'), plus session
// teardown, status, and liveness and readiness probes. It returns a server that is not listening: the
// gateway service (agent/services/) reads the configuration and the token file, builds the clients,
// organs, tools and sessions, and calls listen() on loopback. The brain and the other services call
// it over HTTP, never by import. The endpoints are documented in README.md.
//
// The gateway is the only way to a model, and binding to loopback is not an authorization decision:
// every process on the VM is a local caller. Every endpoint that runs a model or touches a session
// needs the bearer token, and the server refuses to exist without one. A gateway that once treated a
// missing token as "auth disabled" served anyone.

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseModel, providerStatus } from './model-clients.mjs';
import { runTurnWithFallback } from './turn-loop.mjs';
import { createSessionStore, hashSystem } from './sessions.mjs';
import { handleHealth } from './health.mjs';

/** Server settings. Defaults; callers pass the contracts values. */
export const DEFAULT_SERVER_SETTINGS = Object.freeze({
  session: Object.freeze({
    enabled: false,
    // Organs that never join a session, whatever a caller asks. The verifier re-derives every claim
    // from evidence; a transcript of earlier turns would let it recognize instead of re-derive.
    excludedOrgans: Object.freeze(['cerebellum']),
  }),
  maxBodyBytes: 16 * 1024 * 1024,
});

const TIERS = new Set(['boot', 'mission', 'volatile']);

/**
 * Builds the gateway's HTTP server, not yet listening.
 *
 * @param {object}   o
 * @param {string}   o.token          the bearer token every model and session request must carry
 * @param {object}   o.clients        from createModelClients() (or fakes of its shape)
 * @param {object}   o.organs         from createOrganRegistry()
 * @param {object}   o.tools          from createToolRegistry()
 * @param {object}   [o.settings]     the turn settings (turn-loop.mjs DEFAULT_SETTINGS) plus
 *                                    `session` and `maxBodyBytes` (DEFAULT_SERVER_SETTINGS)
 * @param {object}   [o.sessions]     from createSessionStore(); a default store when omitted
 * @param {string}   [o.skillCatalog] the skill index text from buildSkillCatalog()
 * @param {Function} [o.logger]       (level, msg, fields?) logger
 * @param {Function} [o.now]          clock in milliseconds
 * @param {Function} [o.sleep]        (ms) => Promise, for retry backoff (injectable for tests)
 * @returns {import('node:http').Server}
 */
export function createGatewayServer({
  token,
  clients,
  organs,
  tools,
  settings = {},
  sessions = createSessionStore(),
  skillCatalog = '',
  logger = defaultLogger,
  now = Date.now,
  sleep,
}) {
  const log = logger;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('createGatewayServer: a gateway token is required; refusing to build an unauthenticated gateway');
  }
  if (!clients) throw new Error('createGatewayServer: clients are required');
  if (!organs) throw new Error('createGatewayServer: organs are required');
  if (!tools) throw new Error('createGatewayServer: tools are required');

  // Fail at startup, not on the first request: every organ's toolset must resolve.
  for (const id of organs.ids) {
    tools.select(organs.get(id).toolset);
    tools.select(organs.get(id, { exec: true }).toolset);
  }

  const session = {
    enabled: settings.session?.enabled === true,
    excludedOrgans: Array.isArray(settings.session?.excludedOrgans)
      ? settings.session.excludedOrgans
      : DEFAULT_SERVER_SETTINGS.session.excludedOrgans,
  };
  const maxBodyBytes = Number.isInteger(settings.maxBodyBytes) && settings.maxBodyBytes > 0
    ? settings.maxBodyBytes
    : DEFAULT_SERVER_SETTINGS.maxBodyBytes;
  const requiredProviders = [...new Set(organs.ids.flatMap((id) => {
    const organ = organs.get(id);
    return [organ.model, organ.fallbackModel].map((m) => parseModel(m).provider);
  }))];
  const expectedDigest = digest(`Bearer ${token}`);
  const startedAt = now();
  let requestCount = 0;

  // Constant time: both sides are hashed to equal length first, so neither the token's length nor a
  // matching prefix shows in the timing.
  const authorized = (req) => timingSafeEqual(digest(req.headers.authorization || ''), expectedDigest);

  async function handle(req, res) {
    const path = new URL(req.url || '/', 'http://gateway.invalid').pathname;

    if (req.method === 'GET') {
      if (handleHealth(path, res, { status: providerStatus(clients), requiredProviders })) return;
      if (path === '/v1/models') {
        // The liveness check other services make before they rely on the gateway.
        const providers = providerStatus(clients);
        return sendJson(res, 200, {
          object: 'list',
          data: Object.entries(providers).map(([id, info]) => ({
            id, object: 'model', owned_by: 'gateway', available: info.available, location: info.location,
          })),
        });
      }
      if (path === '/status') {
        if (!authorized(req)) return unauthorized(res);
        return sendJson(res, 200, {
          uptime_sec: Math.round((now() - startedAt) / 1000),
          requests: requestCount,
          sessions: sessions.listSessions(),
          providers: providerStatus(clients),
          models: organs.models,
          project: clients.project ?? null,
        });
      }
    }

    if (req.method === 'DELETE' && path.startsWith('/v1/sessions/')) {
      if (!authorized(req)) return unauthorized(res);
      const id = decodeURIComponent(path.substring('/v1/sessions/'.length));
      const existed = sessions.closeSession(id);
      log('INFO', `TELEMETRY session_close id=${id} existed=${existed}`);
      return sendJson(res, 200, { ok: true, existed });
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      if (!authorized(req)) return unauthorized(res);
      requestCount++;
      const rid = requestCount;
      try {
        return sendJson(res, 200, await handleCompletions(await readJson(req, maxBodyBytes), rid));
      } catch (err) {
        const code = Number.isInteger(err.statusCode) ? err.statusCode : 500;
        if (!err.logged) log('ERROR', `#${rid} ${err.message}`);
        return sendJson(res, code, { error: { message: err.message, type: 'gateway_error', code } });
      }
    }

    return sendJson(res, 404, { error: { message: 'not found' } });
  }

  async function handleCompletions(body, rid) {
    const {
      model: route,
      messages = [],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      session: sessionReq,
      exec,
    } = body || {};
    if (!Array.isArray(messages)) throw badRequest('messages must be an array');

    const organId = organFromRoute(route);
    const organ = organs.get(organId, { exec: exec === true });
    const toolSet = tools.select(organ.toolset);

    // The organ's own prompt always leads: only the gateway reads organ prompts, and as the most stable
    // block it carries the first cache breakpoint. The caller's system messages follow as separate
    // blocks, most stable first (the brain sends working memory and registries this way).
    const systemBlocks = messages.filter((m) => m?.role === 'system').map((m) => textOf(m.content)).filter(Boolean);
    let chatMessages = messages.filter((m) => m?.role !== 'system').map(chatMessage);
    const blocks = [organ.systemPrompt, ...systemBlocks].filter(Boolean);

    const turnStart = now();
    log('INFO', `#${rid} organ=${organId} model=${organ.model} msgs=${messages.length}${sessionReq?.id ? ` session=${sessionReq.id}:${sessionReq.op}` : ''}`);

    // Sessions are commanded by the brain. The gateway stores only messages the brain sent, never
    // model output. An excluded organ never joins a session.
    const sessionOn = Boolean(sessionReq?.id) && session.enabled;
    const excluded = session.excludedOrgans.includes(organId);
    if (sessionOn && excluded) log('WARN', `#${rid} session ignored for ${organId}: it never joins a session`);
    // A session's identity is the caller's stable block; the organ prompt changes only with a release.
    const stableHash = hashSystem(systemBlocks[0] || '');
    let live = null;
    let delta = null;
    let sessionCacheBoundary = 0;
    let echo;
    if (sessionOn && !excluded) {
      if (sessionReq.op === 'continue') {
        const lookup = sessions.continueSession({
          id: sessionReq.id,
          organ: organId,
          systemHash: systemBlocks.length > 0 ? stableHash : null,
          expectedSeq: sessionReq.seq,
        });
        if (lookup.miss) {
          // A specified case of the protocol, answered without a provider call: the brain reopens.
          log('INFO', `#${rid} TELEMETRY session_miss id=${sessionReq.id} reason=${lookup.miss}`);
          return { session: { id: sessionReq.id, present: false, reason: lookup.miss } };
        }
        live = lookup.session;
        // Replay [stored frozen prefix + the brain's delta]; the boundary marks where the delta starts.
        delta = chatMessages;
        sessionCacheBoundary = live.messages.length;
        chatMessages = [...live.messages, ...chatMessages];
        log('INFO', `#${rid} TELEMETRY session_hit id=${sessionReq.id} seq=${live.seq} stored=${sessionCacheBoundary} delta=${delta.length}`);
      } else if (sessionReq.op === 'open' || sessionReq.op === 'reset') {
        const store = sessionReq.op === 'open' ? sessions.openSession : sessions.resetSession;
        live = store({ id: sessionReq.id, organ: organId, systemHash: stableHash, messages: chatMessages });
        echo = { id: live.id, present: true, seq: live.seq };
        log('INFO', `#${rid} TELEMETRY session_${sessionReq.op} id=${sessionReq.id} msgs=${chatMessages.length}`);
      }
    }

    let result;
    try {
      result = await runTurnWithFallback({
        clients,
        model: organ.model,
        fallbackModel: organ.fallbackModel,
        systemBlocks: blocks,
        messages: chatMessages,
        tools: toolSet,
        skillCatalog,
        limits: { maxSteps: organ.maxSteps, maxTokens: positiveInt(maxTokens) ?? organ.maxTokens },
        sampling: {
          temperature: Number.isFinite(temperature) ? temperature : organ.temperature,
          topP: Number.isFinite(topP) ? topP : organ.topP,
        },
        forceToolCall: organ.forceToolCall,
        sessionCacheBoundary,
        affinityKey: `gateway-${organId}-${process.pid}`,
        settings,
        logger: log,
        now,
        ...(sleep ? { sleep } : {}),
      });
    } catch (e) {
      const durationMs = Math.max(0, now() - turnStart);
      log('ERROR', `#${rid} ${e.message}`, {
        event: 'organ_turn',
        status: 'error',
        organ: organId,
        duration_ms: durationMs,
        error: e.message,
      });
      e.logged = true;
      throw e;
    }

    const u = result.usage || {};
    const durationMs = Math.max(0, now() - turnStart);
    const steps = u.steps ?? 1;
    log('INFO', `#${rid} completed (${result.text.length} chars, in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'} `
      + `cached=${u.cachedContentTokenCount ?? 0} cache_write=${u.cacheCreationTokenCount ?? 0} steps=${steps} `
      + `provider=${u.provider || '?'}${result.fallbackFrom ? ` fallback_from=${result.fallbackFrom.model}` : ''})`, {
      event: 'organ_turn',
      status: 'ok',
      organ: organId,
      duration_ms: durationMs,
      output_chars: result.text.length,
      steps,
      model: result.model,
      ...(result.fallbackFrom ? { fallback_from: result.fallbackFrom.model } : {}),
    });

    // Commit the brain's delta only after a successful turn: a failure leaves seq where it was, and
    // the brain reopens.
    if (live && delta) {
      const updated = sessions.appendTurn(live.id, delta, u.last_step_input_tokens || 0);
      if (updated) echo = { id: updated.id, present: true, seq: updated.seq };
    }

    return {
      id: `chatcmpl-gateway-${rid}`,
      object: 'chat.completion',
      created: Math.floor(now() / 1000),
      model: result.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: result.finishReason || 'stop',
      }],
      usage: result.usage,
      ...(echo ? { session: echo } : {}),
      // Large tool results in full (agent/context/tool-record.mjs): the brain stores each one and
      // swaps its excerpt in the log for a digest and a ref. A caller that ignores this field still
      // has an honest, marked excerpt.
      ...(result.toolRecords?.length ? { tool_records: result.toolRecords } : {}),
    };
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger('ERROR', `request failed: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message, type: 'gateway_error', code: 500 } });
      else res.end();
    });
  });
}

/** The organ a route names: 'brain/motor' → 'motor'; a bare id is itself; none is the cortex. */
export function organFromRoute(route) {
  if (!route) return 'cortex';
  const parts = String(route).split('/');
  return parts[parts.length - 1];
}

function chatMessage(m) {
  if (!m || typeof m !== 'object') throw badRequest('each message must be an object');
  if (m.role !== 'user' && m.role !== 'assistant') throw badRequest(`unsupported message role '${m.role}'`);
  if (m.content === undefined || m.content === null || typeof m.content === 'string') {
    return { role: m.role, content: m.content ?? '' };
  }
  if (!Array.isArray(m.content)) throw badRequest('message content must be a string or an array of text parts');
  return {
    role: m.role,
    content: m.content.map((p) => {
      if (!p || (p.type && p.type !== 'text')) throw badRequest('only text content parts are accepted');
      return { type: 'text', text: String(p.text ?? ''), ...(TIERS.has(p.tier) ? { tier: p.tier } : {}) };
    }),
  };
}

function textOf(content) {
  return Array.isArray(content) ? content.map((p) => p?.text || '').join('\n\n') : (content || '');
}

function positiveInt(v) {
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

function digest(text) {
  return createHash('sha256').update(text).digest();
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error(`request body is over ${maxBytes} bytes`);
        err.statusCode = 413;
        fail(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(badRequest(`request body is not JSON: ${e.message}`));
      }
    });
    req.on('error', fail);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function unauthorized(res) {
  sendJson(res, 401, { error: { message: 'Unauthorized', type: 'auth_error' } });
}

function defaultLogger(level, msg) {
  console.log(`[gateway] ${level}: ${msg}`);
}
