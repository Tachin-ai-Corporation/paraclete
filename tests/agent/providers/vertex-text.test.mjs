// Tests for agent/providers/vertex-text.mjs.
//
// The classify cases guard a decision-loss defect: a cortex response that carried its classification
// under "type" (or bare under "action") was reduced to classification=undefined, which downstream
// treats as new_mission, so a reply to a mission waiting for input created a duplicate mission
// instead of resuming it. Two bugs compounded: no type/action alias existed, and the fast exit
// re-parsed the raw JSON and trusted a bare "action", which classify always has because it is the
// echoed mode marker ("action":"classify").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVertexText, CORTEX_SCHEMAS, smartTruncate, summarizeTitle } from '../../../agent/providers/vertex-text.mjs';

/** Fakes Vertex AI generateContent; each call takes the next scripted response (HTTP 500 when none). */
function fakeVertex(responses = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift() || { status: 500, body: { error: 'unavailable' } };
    return {
      ok: next.status === 200,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };
  return { fetch, calls };
}

const reply = (...texts) => ({ status: 200, body: { candidates: [{ content: { parts: texts.map((t) => (typeof t === 'string' ? { text: t } : t)) } }] } });

function client(vertex, extra = {}) {
  return createVertexText({
    projectId: 'your-gcp-project',
    fetch: vertex.fetch,
    getAccessToken: async () => 'vm-token',
    logger: () => {},
    enforceSchemaMaxAttempts: 1,
    ...extra,
  });
}

const PLAN = [{ instruction: 'i', accept_criteria: 'a', tasks: [{ agent: 'motor', task: 't' }] }];

describe('enforceSchema: classify type/action alias', () => {
  it('recovers the classification from "type" when the model wraps it under "action":"classify"', async () => {
    const vertex = fakeVertex();
    const raw = JSON.stringify({
      action: 'classify',
      type: 'continue',
      continue_mission: 'w-1700000000001-00c0ffee',
      instruction: 'The person confirms: investigate through Firestore directly.',
      reasoning: 'The user is answering the needs_input question from the earlier mission.',
    });
    const result = await client(vertex).enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'continue');
    assert.equal(result.continue_mission, 'w-1700000000001-00c0ffee');
    assert.equal(vertex.calls.length, 0, 'decided deterministically, no model call');
  });

  it('recovers the classification from a bare "action" when there is no "type"', async () => {
    const raw = JSON.stringify({ action: 'new_mission', instruction: 'Do the thing', reasoning: 'Unrelated new work.' });
    const result = await client(fakeVertex()).enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'new_mission');
  });

  it('never aliases the mode marker "classify" itself', async () => {
    const vertex = fakeVertex();
    const raw = JSON.stringify({ action: 'classify', reasoning: 'no real decision here' });
    const result = await client(vertex).enforceSchema(raw, 'classify');
    assert.notEqual(result.classification, 'classify');
    assert.equal(vertex.calls.length, 1, 'no deciding field: the response goes to the coercion model');
  });

  it('prefers an explicit "classification" over the aliases', async () => {
    const raw = JSON.stringify({ action: 'classify', type: 'new_mission', classification: 'attach', attach_to: 'w-abc', reasoning: 'explicit wins' });
    const result = await client(fakeVertex()).enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'attach');
  });

  it('does not apply the classify-only "type" alias to a decide response', async () => {
    const raw = JSON.stringify({ action: 'checkpoint_plan', type: 'continue', reasoning: 'r', checkpoints: PLAN });
    const result = await client(fakeVertex()).enforceSchema(raw, 'decide');
    assert.equal(result.action, 'checkpoint_plan');
    assert.equal(result.classification, undefined);
  });
});

describe('enforceSchema: fast exit', () => {
  it('returns at once when the classification is present, with no model call', async () => {
    const vertex = fakeVertex();
    const raw = JSON.stringify({ classification: 'respond', response: 'hi', reasoning: 'greeting' });
    const result = await client(vertex).enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'respond');
    assert.equal(vertex.calls.length, 0);
  });
});

describe('enforceSchema: field aliases', () => {
  it('move → action', async () => {
    const raw = JSON.stringify({ move: 'checkpoint_plan', reasoning: 'r', checkpoints: PLAN });
    assert.equal((await client(fakeVertex()).enforceSchema(raw, 'decide')).action, 'checkpoint_plan');
  });

  it('attach_to_mission → attach_to', async () => {
    const raw = JSON.stringify({ classification: 'attach', attach_to_mission: 'w-1', reasoning: 'r' });
    assert.equal((await client(fakeVertex()).enforceSchema(raw, 'classify')).attach_to, 'w-1');
  });

  it('continue_to → continue_mission', async () => {
    const raw = JSON.stringify({ classification: 'continue', continue_to: 'w-2', reasoning: 'r' });
    assert.equal((await client(fakeVertex()).enforceSchema(raw, 'classify')).continue_mission, 'w-2');
  });

  it('plan.checkpoints → checkpoints', async () => {
    const raw = JSON.stringify({ action: 'checkpoint_plan', plan: { checkpoints: PLAN } });
    assert.deepEqual((await client(fakeVertex()).enforceSchema(raw, 'decide')).checkpoints, PLAN);
  });
});

describe('enforceSchema: coercion', () => {
  it('asks the model to restructure the response under the schema, with the VM token', async () => {
    const vertex = fakeVertex([reply(JSON.stringify({ classification: 'respond', response: 'hi', reasoning: 'r' }))]);
    const result = await client(vertex).enforceSchema('The person just said hello, so I will say hi back.', 'classify');
    assert.equal(result.classification, 'respond');
    const [call] = vertex.calls;
    assert.equal(call.init.headers.Authorization, 'Bearer vm-token');
    assert.deepEqual(call.body.generationConfig.responseSchema, CORTEX_SCHEMAS.classify);
    assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
    assert.match(call.body.contents[0].parts[0].text, /said hello/);
  });

  it('falls back to the plain parse when every attempt fails', async () => {
    const vertex = fakeVertex([{ status: 503, body: {} }, reply('')]);
    const result = await client(vertex, { enforceSchemaMaxAttempts: 2 }).enforceSchema('narrative text, not JSON', 'decide');
    assert.equal(vertex.calls.length, 2);
    assert.equal(result.error, 'parse_failed');
  });

  it('never sends an empty response to the coercion model, which could invent a decision', async () => {
    for (const raw of ['', '   ', undefined, null]) {
      const vertex = fakeVertex([reply(JSON.stringify({ action: 'synthesize' }))]);
      const result = await client(vertex).enforceSchema(raw, 'decide');
      assert.equal(vertex.calls.length, 0, `no model call for ${JSON.stringify(raw)}`);
      assert.equal(result.error, 'parse_failed');
    }
  });

  it('parses without a schema check for an unknown schema name', async () => {
    const vertex = fakeVertex();
    assert.deepEqual(await client(vertex).enforceSchema('{"anything":1}', 'nope'), { anything: 1 });
    assert.equal(vertex.calls.length, 0);
  });
});

describe('CORTEX_SCHEMAS', () => {
  it('offers only single-agent actions and step types', () => {
    assert.deepEqual(CORTEX_SCHEMAS.decide.properties.action.enum, [
      'checkpoint_plan', 'synthesize', 'synthesize_with_failure', 'needs_input', 'blocked', 'status_update',
      'wait', 'trigger_responsibility',
    ]);
    const steps = [CORTEX_SCHEMAS.decide.properties.checkpoints, CORTEX_SCHEMAS.plan.properties.checkpoints]
      .map((cps) => cps.items.properties.tasks.items.properties.step_type.enum);
    for (const stepTypes of steps) assert.deepEqual(stepTypes, ['standard', 'approval_gate', 'ask']);
    for (const field of ['target_email', 'project']) assert.equal(CORTEX_SCHEMAS.decide.properties[field], undefined);
  });

  it('a brief part names no owner or specialty', () => {
    const part = CORTEX_SCHEMAS.analyze.properties.parts.items;
    assert.equal(part.properties.ownership, undefined);
    assert.equal(part.properties.specialty, undefined);
    assert.deepEqual(part.required, ['id', 'summary', 'risk']);
  });
});

describe('createVertexText', () => {
  it('calls the global endpoint with the default model unless the caller passes others', async () => {
    const vertex = fakeVertex([reply('ok'), reply('ok')]);
    await client(vertex).transform('x', 'y');
    assert.equal(vertex.calls[0].url,
      'https://aiplatform.googleapis.com/v1/projects/your-gcp-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
    await client(vertex, { location: 'us-central1', model: 'a-model' }).transform('x', 'y');
    assert.equal(vertex.calls[1].url,
      'https://us-central1-aiplatform.googleapis.com/v1/projects/your-gcp-project/locations/us-central1/publishers/google/models/a-model:generateContent');
  });

  it('requires a project id', () => {
    assert.throws(() => createVertexText({}), /projectId is required/);
  });

  it('transform returns the last answer part, skipping thoughts, and null on failure', async () => {
    const vertex = fakeVertex([reply({ text: 'thinking...', thought: true }, '  the answer  '), { status: 429, body: {} }]);
    const vtx = client(vertex);
    assert.equal(await vtx.transform('input', 'do it'), 'the answer');
    assert.equal(await vtx.transform('input', 'do it'), null);
  });

  it('summarize leaves text within budget alone and truncates when the model fails', async () => {
    const vertex = fakeVertex();
    const vtx = client(vertex);
    assert.equal(await vtx.summarize('short', 'summarize', { budget: 100 }), 'short');
    assert.equal(vertex.calls.length, 0);
    const long = 'x'.repeat(1000);
    assert.equal(await vtx.summarize(long, 'summarize', { budget: 100 }), smartTruncate(long, 100));
  });

  it('generateTitle asks the model only for missions', async () => {
    const vertex = fakeVertex([reply('"Mission: Quarterly revenue report"')]);
    const vtx = client(vertex);
    assert.equal(await vtx.generateTitle('Fix the login bug. Then deploy.', 'task'), 'Fix the login bug');
    assert.equal(vertex.calls.length, 0);
    assert.equal(await vtx.generateTitle('Build the quarterly revenue report', 'mission'), 'Quarterly revenue report');
  });
});

describe('pure helpers', () => {
  it('smartTruncate keeps head and tail and states the cut', () => {
    const text = `${'a'.repeat(500)}${'b'.repeat(500)}`;
    const out = smartTruncate(text, 100);
    assert.ok(out.startsWith('a'.repeat(40)) && out.endsWith('b'.repeat(40)));
    assert.match(out, /\[\.\.\.920 chars truncated\.\.\.\]/);
    assert.equal(smartTruncate('short', 100), 'short');
  });

  it('summarizeTitle strips chat framing and cuts at a word boundary', () => {
    assert.equal(summarizeTitle('[Current message - respond to this]\nUser: Draft the board memo. Thanks'), 'Draft the board memo');
    assert.equal(summarizeTitle('word '.repeat(40), 20), 'word word word word…');
    assert.equal(summarizeTitle(''), 'Untitled');
  });
});
