// Tests for agent/services/brain/gateway-client.mjs: one organ turn over the gateway's HTTP contract,
// a task rendered into its message, large tool results stored by reference, a cortex decision held to
// its schema, and the cortex's session: open, continue with only the delta, reopen on any miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { parseJsonResponse } from '../../../../agent/providers/json-repair.mjs';
import {
  BRAIN_MARKER, SESSION_MISS_REASONS, contentText, createCortexSession, createGatewayClient, memoryText,
  readGatewayToken, renderTaskMessage, toolResultDigester,
} from '../../../../agent/services/brain/gateway-client.mjs';
import { startFakeGateway } from './fake-gateway.mjs';

const enforceSchema = async (raw) => parseJsonResponse(raw);

test('the gateway token is read from its file, and an empty or missing one stops the brain', () => {
  assert.equal(readGatewayToken('/etc/paraclete/gateway-token', () => '  tok-1\n'), 'tok-1');
  assert.throws(() => readGatewayToken('/x', () => '  '), /is empty/);
  assert.throws(() => readGatewayToken('/x', () => { throw new Error('ENOENT'); }), /Cannot read the gateway token at \/x: ENOENT/);
});

test('content and memory read as text in every shape they arrive in', () => {
  assert.equal(contentText('plain'), 'plain');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(contentText(null), '');
  assert.equal(memoryText({ recalled: 'packet' }), 'packet');
  assert.equal(memoryText('packet'), 'packet');
  assert.equal(memoryText({}), '');
});

test('a task message leads with the stable sections and ends with the task', () => {
  const text = renderTaskMessage({
    instruction: 'Write the report', accept_criteria: 'report.md exists', _missionId: 'w-1',
    _requester: 'person@example.com', _projectContext: '## Project Context: Site', _sourceText: 'please write it',
    memory_context: { recalled: 'Earlier: Q2 report in /reports.' }, context_summary: 'ctx', prior_results_context: 'CP1 done',
  }, { missionDir: (id) => `/var/lib/paraclete/missions/${id}` });
  assert.ok(text.startsWith(BRAIN_MARKER));
  const order = ['## Mission Tree', '## Requester', '## Project Context', '## Original Request', '## Relevant Memory', '## Context', '## Prior Work', '## Task', '## Acceptance Criteria']
    .map((h) => text.indexOf(h));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `sections in order: ${order}`);
  assert.match(text, /`\/var\/lib\/paraclete\/missions\/w-1\/`/);
  // Fixed defect: a recalled packet arrives as { recalled }, and was rendered "[object Object]".
  assert.match(text, /## Relevant Memory\nEarlier: Q2 report in \/reports\./);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('a task names its mission id and the files shared with the request, each with the command that fetches it', () => {
  const text = renderTaskMessage({
    instruction: 'Turn the PDF into a Word document', _missionId: 'w-1',
    _sharedFiles: [{ name: 'q3 report.pdf', size: 2048, gcsPath: 'files/in/u-1760000000000-1a2b3c4d/q3 report.pdf' }],
  }, { missionDir: (id) => `/var/lib/paraclete/missions/${id}` });
  assert.match(text, /This mission's id is `w-1`\./);
  assert.match(text, /## Files shared with this request/);
  assert.match(text, /- q3 report\.pdf \(2048 bytes\): `file-get --mission w-1 'files\/in\/u-1760000000000-1a2b3c4d\/q3 report\.pdf'`/);
  assert.ok(text.indexOf('## Files shared with this request') < text.indexOf('## Task'), 'before the task');
  assert.doesNotMatch(renderTaskMessage({ instruction: 'x', _missionId: 'w-2', _sharedFiles: [] }, { missionDir: (id) => `/m/${id}` }), /Files shared/);
});

test('a recall task carries no mission sections', () => {
  const text = renderTaskMessage({ instruction: 'Recall', accept_criteria: 'a packet' });
  assert.equal(text, `${BRAIN_MARKER}\n\n## Task\nRecall\n\n## Acceptance Criteria\na packet`);
});

test('callAgent: one authenticated turn on brain/<organ>, its answer in the executor\'s shape', async () => {
  const gw = await startFakeGateway({ respond: () => ({ content: 'done', usage: { promptTokenCount: 7 }, finish_reason: 'MAX_TOKENS' }) });
  const usage = [];
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token, temperatureFor: (o) => (o === 'motor' ? 0.42 : undefined), onUsage: (...a) => usage.push(a) });
    const r = await client.callAgent('motor', { instruction: 'Do it', _missionId: 'w-1', _exec: true });
    assert.deepEqual(r, { success: true, output: 'done', error: null, durationMs: r.durationMs, usage: { promptTokenCount: 7 }, finishReason: 'MAX_TOKENS' });
    assert.equal(gw.turns[0].body.model, 'brain/motor');
    assert.equal(gw.turns[0].body.exec, true);
    assert.equal(gw.turns[0].body.temperature, 0.42);
    assert.deepEqual(usage[0].slice(0, 3), ['w-1', 'motor', { promptTokenCount: 7 }]);
    await client.callAgent('cerebellum', { instruction: 'Verify' });
    assert.equal('temperature' in gw.turns[1].body, false, 'no temperature at the default effort');
    assert.equal(gw.turns[1].body.exec, false);
  } finally {
    await gw.stop();
  }
});

test('callAgent: a refused, failed or unreachable gateway is a failed turn, never a throw', async () => {
  const gw = await startFakeGateway({ respond: () => ({ status: 500, error: 'both models failed' }) });
  try {
    const bad = createGatewayClient({ url: gw.url, token: 'wrong' });
    assert.deepEqual(await bad.callAgent('motor', { instruction: 'x' }).then((r) => [r.success, r.error]), [false, 'HTTP 401']);
    const client = createGatewayClient({ url: gw.url, token: gw.token });
    assert.deepEqual(await client.callAgent('motor', { instruction: 'x' }).then((r) => [r.success, r.error]), [false, 'HTTP 500']);
  } finally {
    await gw.stop();
  }
  const gone = createGatewayClient({ url: 'http://127.0.0.1:9', token: 't' });
  const r = await gone.callAgent('motor', { instruction: 'x' });
  assert.equal(r.success, false);
  assert.match(r.error, /the gateway is unreachable/);
});

test('callAgent: a turn past its time is a timeout, whose outcome is unknown, not a failure', async () => {
  const gw = await startFakeGateway({ respond: () => new Promise((resolve) => setTimeout(() => resolve('late'), 300)) });
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token, timeoutMs: 50 });
    const r = await client.callAgent('motor', { instruction: 'x' });
    assert.equal(r.success, false);
    assert.equal(r.timedOut, true);
    assert.match(r.error, /timed out/);
  } finally {
    await gw.stop();
  }
});

test('callAgent: a large tool result is stored in full and its excerpt replaced by a digest and its ref', async () => {
  const firestore = await startFirestore();
  const full = 'row\n'.repeat(3000);
  const gw = await startFakeGateway({
    respond: () => ({
      content: `Listed.\n\n---\n[TOOL EXECUTION LOG]\n[TOOL] runCommand({"command":"ls"}) → [large result #0: ${full.length} chars — excerpt]\nrow\nrow\n[/large result #0]\n[END TOOL LOG]`,
      tool_records: [{ seq: 0, tool: 'runCommand', args: '{"command":"ls"}', result: full, chars: full.length }],
    }),
  });
  try {
    const db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
    const digests = [];
    const client = createGatewayClient({
      url: gw.url, token: gw.token,
      toolRecords: {
        db, policy: { store_ttl_days: 30 }, newId: () => 'tr-1',
        digest: toolResultDigester({ transform: async (text, instruction, opts) => { digests.push({ text, opts }); return '3000 rows of "row"'; } }),
      },
    });
    const r = await client.callAgent('motor', { instruction: 'List', _missionId: 'w-1' });
    assert.match(r.output, /\[digest of 12000 chars — full result: tool_results\/tr-1\]\n3000 rows of "row"/);
    const stored = await db.read('tool_results/tr-1');
    assert.equal(stored.result, full);
    assert.equal(stored.mission_id, 'w-1');
    assert.equal(stored.organ, 'motor');
    assert.ok(Date.parse(stored.expire_at) > Date.parse(stored.created_at), 'it expires');
    assert.equal(digests[0].opts.disableThinking, true);
  } finally {
    await gw.stop();
    await firestore.stop();
  }
});

test('askJson: a decision is held to its schema, with usage and the session echo attached', async () => {
  const gw = await startFakeGateway({ respond: () => '```json\n{"action":"wait","minutes":3}\n```' });
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token });
    const d = await client.askJson({ mode: 'decide', system: ['stable', '', 'memory'], user: [{ type: 'text', text: 'go' }], enforceSchema });
    assert.equal(d.action, 'wait');
    assert.equal(d._coercedDecision, '{"action":"wait","minutes":3}');
    assert.equal(gw.turns[0].system.length, 2, 'empty system blocks are dropped');
    assert.equal(gw.turns[0].body.model, 'brain/cortex');
  } finally {
    await gw.stop();
  }
});

test('the session protocol: open, continue with only the delta, every miss reason reopens', async () => {
  assert.deepEqual([...SESSION_MISS_REASONS], ['absent', 'organ', 'system_hash', 'seq']);
  let n = 0;
  const gw = await startFakeGateway({ respond: () => JSON.stringify({ action: 'status_update', message: `m${++n}` }) });
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token });
    const session = createCortexSession({ client, missionId: 'w-1', enabled: true, breaker: 3, generation: 2, enforceSchema });
    const turn = (results) => session.decide({ system: ['stable'], openUser: 'full context', deltaUser: (from) => `delta from ${from}`, resultsCount: results });

    await turn(1);
    assert.equal(gw.turns[0].session.op, 'open');
    assert.equal(gw.turns[0].session.id, 'w-1:cortex:g3', 'a new generation per open');
    assert.deepEqual(session.snapshot(), { id: 'w-1:cortex:g3', seq: 0, generation: 3 });

    await turn(4);
    assert.equal(gw.turns[1].session.op, 'continue');
    assert.equal(gw.turns[1].user, 'delta from 1', 'only what is new since the last decision');
    assert.equal(gw.turns[1].assistant, '{"action":"status_update","message":"m1"}', 'the previous decision, coerced, replayed');
    assert.equal(session.snapshot().seq, 1);

    gw.sessions.clear(); // the gateway restarted: the session is gone
    const d = await turn(5);
    assert.equal(d.message, 'm3', 'the miss was answered without a model call, and the reopen decided');
    assert.equal(gw.turns[2].miss, 'absent');
    assert.equal(gw.turns[3].session.op, 'open');
    assert.equal(gw.turns[3].user, 'full context');
    assert.equal(session.misses, 1);
  } finally {
    await gw.stop();
  }
});

test('an unreadable reply on a continue drops the session; past the breaker the mission goes stateless', async () => {
  const answers = ['{"action":"wait"}', 'not json at all', '{"action":"wait"}', '{"action":"blocked"}', '{"action":"blocked"}'];
  const gw = await startFakeGateway({ respond: () => answers.shift() });
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token });
    const session = createCortexSession({ client, missionId: 'w-2', enabled: true, breaker: 1, enforceSchema });
    const turn = () => session.decide({ system: ['s'], openUser: 'full', deltaUser: () => 'delta', resultsCount: 0 });
    await turn();
    const second = await turn();
    assert.equal(second.action, 'wait', 'garbage is never acted on: the stateless call decided');
    assert.deepEqual(gw.deletes, ['w-2:cortex:g1'], 'the session that received garbage is dropped');
    assert.equal(session.open, false);
    await turn();
    assert.equal(gw.turns.at(-1).session, null, 'past the breaker every turn sends the full context, no session');
  } finally {
    await gw.stop();
  }
});

test('with sessions off every decision is a full, stateless call', async () => {
  const gw = await startFakeGateway({ respond: () => '{"action":"wait"}' });
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token });
    const session = createCortexSession({ client, missionId: 'w-3', enabled: false, enforceSchema });
    await session.decide({ system: ['s'], openUser: 'full', deltaUser: () => 'delta', resultsCount: 0 });
    await session.decide({ system: ['s'], openUser: 'full', deltaUser: () => 'delta', resultsCount: 0 });
    assert.deepEqual(gw.turns.map((t) => [t.session, t.user]), [[null, 'full'], [null, 'full']]);
  } finally {
    await gw.stop();
  }
});

test('closing a session sends DELETE and never throws', async () => {
  const gw = await startFakeGateway({ respond: () => '' });
  try {
    const client = createGatewayClient({ url: gw.url, token: gw.token });
    await client.closeSession('w-1:cortex:g1');
    assert.deepEqual(gw.deletes, ['w-1:cortex:g1']);
    assert.equal(await client.ping(), true);
  } finally {
    await gw.stop();
  }
  await createGatewayClient({ url: 'http://127.0.0.1:9', token: 't' }).closeSession('x');
});
