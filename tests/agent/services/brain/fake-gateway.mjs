// tests/agent/services/brain/fake-gateway.mjs: a stand-in for the gateway service's HTTP contract
// (agent/gateway/README.md), served on 127.0.0.1 so the brain's real gateway client talks to it: POST
// /v1/chat/completions answered by a scripted responder per turn, the session protocol (open, continue
// with a typed miss, delete), bearer-token auth and GET /v1/models. Records every turn. Used by the
// brain's tests.
import { createServer } from 'node:http';

/** The text of a message's content: a string, or text parts. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p?.text || '').join('\n\n');
  return '';
}

/** A tool log in the gateway's format, for an organ answer. */
export function toolLog(lines) {
  return `\n\n---\n[TOOL EXECUTION LOG]\n${lines.join('\n')}\n[END TOOL LOG]`;
}

/** A cerebellum verdict reply. */
export function verdict(pass, { reasoning = 'checked', caveat, checks = [] } = {}) {
  const args = pass
    ? JSON.stringify({ reasoning, checks, ...(caveat ? { caveat } : {}) })
    : JSON.stringify({ reasoning, checks: checks.length ? checks : [{ criterion: 'outcome', pass: false, evidence: reasoning }], recommendation: 'fix it' });
  return `Verdict reached.${toolLog([`[TOOL] ${pass ? 'report_pass' : 'report_fail'}(${args}) → recorded`])}`;
}

/**
 * Starts the fake gateway.
 *
 * @param {object} opts
 * @param {(turn: object) => (object|string|Promise<object|string>)} opts.respond - the answer for one
 *   turn: a string (the content), or { content, tool_records?, usage?, finish_reason? }, or
 *   { status, error } for a failed turn
 * @param {string} [opts.token='test-gateway-token']
 * @param {boolean} [opts.sessions=true] - whether sessions are on
 */
export async function startFakeGateway({ respond, token = 'test-gateway-token', sessions: sessionsOn = true } = {}) {
  const turns = [];
  const deletes = [];
  const sessions = new Map(); // id -> { organ, seq, systemHash }
  let n = 0;

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [] });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { message: 'Unauthorized', type: 'auth_error' } });
    if (req.method === 'DELETE' && req.url.startsWith('/v1/sessions/')) {
      const id = decodeURIComponent(req.url.slice('/v1/sessions/'.length));
      deletes.push(id);
      return send(200, { ok: true, existed: sessions.delete(id) });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: { message: 'not found' } });

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const organ = String(body.model || 'brain/cortex').replace(/^brain\//, '');
    const messages = body.messages || [];
    const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content));
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const user = textOf(nonSystem[nonSystem.length - 1]?.content);
    const turn = { n: ++n, organ, body, system, user, assistant: nonSystem.find((m) => m.role === 'assistant')?.content || null, session: body.session || null };

    let echo;
    if (sessionsOn && body.session?.id && organ !== 'cerebellum') {
      const s = body.session;
      if (s.op === 'continue') {
        const live = sessions.get(s.id);
        const reason = !live ? 'absent' : live.organ !== organ ? 'organ' : (live.systemHash !== system[0]) ? 'system_hash' : (live.seq !== s.seq ? 'seq' : null);
        if (reason) {
          turns.push({ ...turn, miss: reason });
          return send(200, { session: { id: s.id, present: false, reason } });
        }
        live.seq += 1;
        echo = { id: s.id, present: true, seq: live.seq };
      } else {
        sessions.set(s.id, { organ, seq: 0, systemHash: system[0] });
        echo = { id: s.id, present: true, seq: 0 };
      }
    }
    turns.push(turn);

    let answer;
    try {
      answer = await respond(turn);
    } catch (e) {
      return send(500, { error: { message: e.message, type: 'gateway_error', code: 500 } });
    }
    if (answer && typeof answer === 'object' && answer.status) {
      return send(answer.status, { error: { message: answer.error || 'failed', type: 'gateway_error', code: answer.status } });
    }
    const a = typeof answer === 'string' ? { content: answer } : (answer || { content: '' });
    return send(200, {
      id: `chatcmpl-fake-${turn.n}`,
      object: 'chat.completion',
      model: 'vertex-google/fake',
      choices: [{ index: 0, message: { role: 'assistant', content: a.content ?? '' }, finish_reason: a.finish_reason || 'STOP' }],
      usage: a.usage || { prompt_tokens: 100, completion_tokens: 10, promptTokenCount: 100, candidatesTokenCount: 10 },
      ...(echo ? { session: echo } : {}),
      ...(a.tool_records ? { tool_records: a.tool_records } : {}),
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    turns,
    deletes,
    sessions,
    /** The turns one organ received. */
    of: (organ) => turns.filter((t) => t.organ === organ && !t.miss),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
