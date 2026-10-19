// Tests for agent/services/control/claude-check.mjs: the Claude test sends each candidate one short
// message on Vertex AI's Anthropic endpoint (the documented request, the VM's token, the right host for a
// region and for global), reports every model newest first with its status, Google's message and a fix
// of its own (terms, a model not offered, quota, the API off, an organization policy, the agent's role,
// Google failing, no network), names the newest that answered, and fails only when the VM has no token.
// Vertex AI is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContracts } from '../../../../config/contracts.mjs';
import {
  checkClaude, claudeFix, answerError, modelGardenUrl, modelIdOf, rawPredictUrl, quotaUrl,
  ANTHROPIC_VERSION, PROBE_MAX_TOKENS,
} from '../../../../agent/services/control/claude-check.mjs';

const PROJECT = 'your-gcp-project';
const NOW = new Date('2026-10-18T09:00:00.000Z');
const contracts = loadContracts();
const CANDIDATES = [...contracts.vertex.models.claude_candidates];

/** A Vertex AI that answers each model id with what `answers` says: a status and a body, or a thrown error. */
function fakeVertex(answers = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const id = /\/models\/([^/:]+):rawPredict$/.exec(new URL(url).pathname)?.[1];
    const answer = answers[decodeURIComponent(id)] ?? { status: 200, body: { type: 'message', content: [{ type: 'text', text: 'ready' }] } };
    if (answer instanceof Error) throw answer;
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { ok: answer.status < 400, status: answer.status, text: async () => text };
  };
  return { fetch, calls };
}

const vertexError = (status, message, state) => ({ status, body: { error: { code: status, message, status: state } } });
const run = (vertex, extra = {}) => checkClaude({
  candidates: CANDIDATES, project: PROJECT, location: 'us-east5', fetch: vertex.fetch, getAccessToken: async () => 'vm-token', now: () => NOW, ...extra,
});

test('every candidate gets the documented request, as the VM, on its region\'s endpoint', async () => {
  const vertex = fakeVertex();
  const result = await run(vertex);
  assert.equal(vertex.calls.length, CANDIDATES.length);
  for (const [i, call] of vertex.calls.entries()) {
    assert.equal(call.url, `https://us-east5-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/us-east5/publishers/anthropic/models/${modelIdOf(CANDIDATES[i])}:rawPredict`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer vm-token');
    assert.deepEqual(Object.keys(call.body).sort(), ['anthropic_version', 'max_tokens', 'messages']);
    assert.equal(call.body.anthropic_version, ANTHROPIC_VERSION);
    assert.equal(call.body.max_tokens, PROBE_MAX_TOKENS);
    assert.ok(PROBE_MAX_TOKENS <= 32, 'a few output tokens only');
    assert.deepEqual(call.body.messages.map((m) => m.role), ['user']);
    assert.equal(typeof call.body.messages[0].content, 'string');
  }
  assert.equal(result.checked_at, NOW.toISOString());
  assert.deepEqual([result.project, result.location], [PROJECT, 'us-east5']);
  assert.deepEqual(result.models.map((entry) => entry.model), CANDIDATES, 'newest first, as the contracts list them');
  assert.ok(result.models.every((entry) => entry.ok && entry.status === 200 && entry.error === null && entry.fix === null));
  assert.equal(result.best, CANDIDATES[0]);
});

test('the global location has a host without a region; a dated snapshot has its model\'s Model Garden page', () => {
  assert.equal(rawPredictUrl({ project: PROJECT, location: 'global', model: 'vertex-anthropic/claude-opus-5-5' }),
    `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict`);
  assert.equal(modelGardenUrl('vertex-anthropic/claude-opus-5-5', PROJECT),
    `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/claude-opus-5-5?project=${PROJECT}`);
  assert.equal(modelGardenUrl('claude-opus-4-5@20251101', PROJECT),
    `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/claude-opus-4-5?project=${PROJECT}`);
  assert.equal(modelIdOf('vertex-anthropic/claude-opus-4-6'), 'claude-opus-4-6');
});

test('best is the newest model that answered; none answering leaves it null', async () => {
  const [newest, second, third] = CANDIDATES;
  const refused = vertexError(404, 'Publisher Model was not found or your project does not have access to it.', 'NOT_FOUND');
  const some = await run(fakeVertex({ [modelIdOf(newest)]: refused, [modelIdOf(second)]: refused }));
  assert.equal(some.best, third);
  assert.deepEqual(some.models.map((entry) => entry.ok), CANDIDATES.map((model) => ![newest, second].includes(model)));

  const none = await run(fakeVertex(Object.fromEntries(CANDIDATES.map((model) => [modelIdOf(model), refused]))));
  assert.equal(none.best, null);
  assert.ok(none.models.every((entry) => !entry.ok && entry.status === 404));
});

test('terms not accepted: Google\'s message and the Model Garden link, whether Vertex AI answers 403 or 400', async () => {
  const id = modelIdOf(CANDIDATES[0]);
  for (const answer of [
    vertexError(403, `Anthropic's terms of service have not been accepted for ${id} in this project. Enable the model in Model Garden.`, 'PERMISSION_DENIED'),
    vertexError(400, `Model ${id} is not enabled for this project. Please enable it in Model Garden and accept the terms.`, 'FAILED_PRECONDITION'),
    vertexError(400, `Project \`${PROJECT}\` is not allowed to use Publisher Model \`publishers/anthropic/models/${id}\``, 'FAILED_PRECONDITION'),
  ]) {
    const [entry] = (await run(fakeVertex({ [id]: answer }))).models;
    assert.equal(entry.ok, false);
    assert.equal(entry.status, answer.status);
    assert.equal(entry.error, answer.body.error.message);
    assert.ok(entry.fix.startsWith("Accept Anthropic's terms for this model in Model Garden: open https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/"), entry.fix);
    assert.ok(entry.fix.includes(modelGardenUrl(CANDIDATES[0], PROJECT)));
    assert.equal(entry.model_garden, modelGardenUrl(CANDIDATES[0], PROJECT));
  }
});

test('each other refusal gets its own fix', () => {
  const ctx = { model: CANDIDATES[0], project: PROJECT, location: 'us-east5' };
  const fix = (status, message, kind = '') => claudeFix({ status, message, kind }, ctx);
  const cases = [
    [fix(404, 'Publisher Model `projects/x/locations/us-east5/publishers/anthropic/models/claude-opus-5-5` not found.', 'NOT_FOUND'), /^Vertex AI does not offer claude-opus-5-5 to your-gcp-project in us-east5\. Open its Model Garden page/],
    [fix(429, 'Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model', 'RESOURCE_EXHAUSTED'), /^your-gcp-project has no quota left for claude-opus-5-5 in us-east5/],
    [fix(403, 'Vertex AI API has not been used in project 123 before or it is disabled.', 'PERMISSION_DENIED SERVICE_DISABLED'), /^The Vertex AI API \(aiplatform\.googleapis\.com\) is off in your-gcp-project/],
    [fix(403, 'Request violates constraint constraints/vertexai.allowedModels', 'FAILED_PRECONDITION'), /^An organization policy keeps your-gcp-project from using claude-opus-5-5/],
    [fix(403, "Permission 'aiplatform.endpoints.predict' denied on resource", 'PERMISSION_DENIED'), /^The agent's service account, paraclete-agent@your-gcp-project\.iam\.gserviceaccount\.com, may not call Vertex AI models/],
    [fix(403, 'Forbidden'), /^Vertex AI refused claude-opus-5-5 for your-gcp-project\. Open its Model Garden page/],
    [fix(401, 'Request had invalid authentication credentials.'), /^Vertex AI did not accept the VM's token/],
    [fix(503, 'The service is currently unavailable.'), /^Vertex AI failed on its side for claude-opus-5-5/],
    [fix(null, 'fetch failed'), /^Vertex AI could not be reached from the agent's VM/],
    [fix(400, 'max_tokens: field required'), /^Vertex AI refused the test request for claude-opus-5-5 \(HTTP 400\)/],
  ];
  for (const [text, pattern] of cases) assert.match(text, pattern);
  assert.ok(cases[1][0].includes(quotaUrl(PROJECT)), 'the quota fix links the Quotas page');
  assert.equal(new Set(cases.map(([text]) => text)).size, cases.length, 'no two causes share a fix');
});

test('Google\'s message is read from Vertex AI\'s error, a listed error, Anthropic\'s error, or the bare text, and clipped', () => {
  assert.deepEqual(answerError(404, JSON.stringify({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } })),
    { status: 404, message: 'not found', kind: 'NOT_FOUND' });
  assert.equal(answerError(403, JSON.stringify([{ error: { message: 'listed', status: 'PERMISSION_DENIED' } }])).message, 'listed');
  assert.deepEqual(answerError(400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } })),
    { status: 400, message: 'bad request', kind: 'invalid_request_error' });
  assert.equal(answerError(502, '<html>Bad Gateway</html>').message, '<html>Bad Gateway</html>');
  assert.equal(answerError(500, '').message, 'HTTP 500');
  assert.ok(answerError(400, JSON.stringify({ error: { message: 'x'.repeat(1000) } })).message.length <= 301);
});

test('a model Vertex AI cannot be reached for is reported, and the others still answer', async () => {
  const id = modelIdOf(CANDIDATES[0]);
  const result = await run(fakeVertex({ [id]: new TypeError('fetch failed') }));
  const [first, ...rest] = result.models;
  assert.deepEqual([first.ok, first.status, first.error], [false, null, 'fetch failed']);
  assert.match(first.fix, /could not be reached/);
  assert.ok(rest.every((entry) => entry.ok));
  assert.equal(result.best, CANDIDATES[1]);
});

test('without the VM\'s token nothing is tested and the command fails; an empty candidate list too', async () => {
  const vertex = fakeVertex();
  await assert.rejects(run(vertex, { getAccessToken: async () => { throw new Error('metadata server: HTTP 500'); } }),
    /the VM could not get its access token from the metadata server \(metadata server: HTTP 500\), so nothing was tested/);
  await assert.rejects(run(vertex, { candidates: [] }), /no Claude models to test/);
  assert.equal(vertex.calls.length, 0);
});
