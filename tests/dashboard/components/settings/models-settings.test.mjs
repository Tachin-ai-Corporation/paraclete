// Tests for dashboard/components/settings/models-settings.js: the Models tab's decisions as data. The
// Model Garden link is the control service's; models read as people name them; Claude's state follows
// the brain_config result, including a gateway that has not restarted; each candidate shows its last
// test; and the switch turns Claude on only with the newest model that passed a recent test, saying why
// when it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContracts } from '../../../../config/contracts.mjs';
import { modelGardenUrl } from '../../../../agent/services/control/claude-check.mjs';
import {
  candidateRows, checkSummary, claudeState, modelGardenLink, modelId, modelLabel, switchDecision, switchOutcome, TEST_FRESH_MS,
} from '../../../../dashboard/components/settings/models-settings.js';

const PROJECT = 'your-gcp-project';
const contracts = loadContracts();
const m = contracts.vertex.models;
const [NEWEST, SECOND] = m.claude_candidates;
const NOW = Date.parse('2026-10-18T09:00:00.000Z');

/** A brain_config result, as the control service returns it. */
function brainConfig({ on = false, model = m.claude, ignored = null, running = null } = {}) {
  return {
    settings: { claude_enabled: on, claude_model: model, claude_model_ignored: ignored, effort: 'medium', claude_updated_at: '2026-10-18T08:00:00.000Z', claude_updated_by: 'admin@example.com' },
    tiers: { ...m },
    locations: { google: contracts.vertex.location, anthropic: contracts.vertex.anthropic_location },
    running: running ? { reachable: true, ready: true, models: running } : null,
  };
}

/** A claude_check result in which `answered` models answered. */
function claudeCheck(answered, { at = new Date(NOW - 60_000).toISOString() } = {}) {
  const models = m.claude_candidates.map((model) => {
    const ok = answered.includes(model);
    return { model, id: modelId(model), ok, status: ok ? 200 : 404, error: ok ? null : 'not found', fix: ok ? null : 'Open its Model Garden page.', model_garden: modelGardenUrl(model, PROJECT) };
  });
  return { checked_at: at, project: PROJECT, location: contracts.vertex.anthropic_location, models, best: models.find((e) => e.ok)?.model ?? null };
}

test('the Model Garden link is the one the control service reports', () => {
  for (const model of [...m.claude_candidates, 'claude-opus-4-5@20251101']) {
    assert.equal(modelGardenLink(model, PROJECT), modelGardenUrl(model, PROJECT), model);
  }
});

test('models read as people name them', () => {
  assert.equal(modelLabel('vertex-anthropic/claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelLabel('vertex-anthropic/claude-opus-5'), 'Claude Opus 5');
  assert.equal(modelLabel('vertex-anthropic/claude-opus-4-6'), 'Claude Opus 4.6');
  assert.equal(modelLabel('claude-opus-4-5@20251101'), 'Claude Opus 4.5');
  assert.equal(modelLabel('vertex-google/gemini-3.8-flash'), 'Gemini 3.8 Flash');
  assert.equal(modelId('vertex-anthropic/claude-opus-5-5'), 'claude-opus-5-5');
});

test("Claude's state: off, on with a model, a choice set aside, and a gateway that has not restarted", () => {
  assert.equal(claudeState(null), null);
  const off = claudeState(brainConfig({ running: { cortex: m.cortex, strong: m.strong } }));
  assert.deepEqual([off.on, off.model, off.gatewayDiffers, off.location], [false, m.claude, false, contracts.vertex.anthropic_location]);
  assert.deepEqual(off.candidates, [...m.claude_candidates]);
  assert.equal(off.updatedBy, 'admin@example.com');

  const on = claudeState(brainConfig({ on: true, model: NEWEST, running: { cortex: NEWEST, strong: NEWEST } }));
  assert.deepEqual([on.on, on.model, on.label, on.gatewayDiffers], [true, NEWEST, 'Claude Opus 5.5', false]);
  assert.equal(on.fallback, m.claude_fallback);

  const stale = claudeState(brainConfig({ on: true, model: NEWEST, running: { cortex: m.cortex, strong: m.strong } }));
  assert.equal(stale.gatewayDiffers, true);

  const ignored = claudeState(brainConfig({ on: true, model: m.claude, ignored: 'vertex-anthropic/claude-opus-1' }));
  assert.deepEqual([ignored.model, ignored.ignored], [m.claude, 'vertex-anthropic/claude-opus-1']);
});

test('each candidate row has its link and, after a test, what it said', () => {
  const state = claudeState(brainConfig({ on: true, model: SECOND }));
  const untested = candidateRows({ candidates: state.candidates, check: null, project: PROJECT, state });
  assert.deepEqual(untested.map((row) => row.model), [...m.claude_candidates]);
  assert.ok(untested.every((row) => row.test === null && row.link === modelGardenUrl(row.model, PROJECT)));
  assert.deepEqual(untested.map((row) => row.current), m.claude_candidates.map((model) => model === SECOND));

  const rows = candidateRows({ candidates: state.candidates, check: claudeCheck([SECOND]), project: PROJECT, state });
  assert.deepEqual(rows[0].test, { ok: false, status: 404, error: 'not found', fix: 'Open its Model Garden page.' });
  assert.deepEqual([rows[1].test.ok, rows[1].best], [true, true]);
  assert.equal(checkSummary(claudeCheck([SECOND])), `1 of ${m.claude_candidates.length} Claude models answered; the newest is Claude Opus 5.`);
  assert.equal(checkSummary(claudeCheck([])), `None of the ${m.claude_candidates.length} Claude models answered.`);
  assert.equal(checkSummary(null), '');
});

test('the switch turns Claude on only with the newest model that passed a recent test', () => {
  const off = claudeState(brainConfig());
  const cases = [
    [{ state: null, check: claudeCheck([NEWEST]) }, /^Waiting for the agent's VM/],
    [{ state: off, check: null }, /^Run Test first: Claude is turned on only with a model that answered a test/],
    [{ state: off, check: claudeCheck([NEWEST], { at: new Date(NOW - TEST_FRESH_MS - 1).toISOString() }) }, /^The last test is more than an hour old/],
    [{ state: off, check: claudeCheck([NEWEST], { at: 'yesterday' }) }, /^The last test is more than an hour old/],
    [{ state: off, check: claudeCheck([]) }, /^No Claude model answered the test/],
    [{ state: { ...off, candidates: [SECOND] }, check: claudeCheck([NEWEST]) }, /^The tested model is not one the agent can run any more/],
  ];
  for (const [input, reason] of cases) {
    const decision = switchDecision({ ...input, now: NOW });
    assert.equal(decision.allowed, false);
    assert.equal(decision.model, null);
    assert.match(decision.reason, reason);
  }

  assert.deepEqual(switchDecision({ state: off, check: claudeCheck([SECOND, m.claude]), now: NOW }),
    { allowed: true, action: 'on', model: SECOND, label: 'Claude Opus 5', reason: '' });

  const onOlder = claudeState(brainConfig({ on: true, model: m.claude }));
  assert.deepEqual(switchDecision({ state: onOlder, check: claudeCheck([NEWEST]), now: NOW }),
    { allowed: true, action: 'switch', model: NEWEST, label: 'Claude Opus 5.5', reason: '' });

  const onNewest = claudeState(brainConfig({ on: true, model: NEWEST }));
  const same = switchDecision({ state: onNewest, check: claudeCheck([NEWEST]), now: NOW });
  assert.equal(same.allowed, false);
  assert.match(same.reason, /^Claude is on with Claude Opus 5\.5, the newest model that answered\./);
});

test("the switch's outcome reads as what happened", () => {
  assert.deepEqual(switchOutcome({ status: 'done', result: { claude_model: NEWEST } }, { enabling: true, model: NEWEST }),
    { kind: 'ok', text: 'Claude is on: the cortex and the strong tier run Claude Opus 5.5, with Gemini as the fallback.' });
  assert.deepEqual(switchOutcome({ status: 'done', result: { claude_model: null } }, { enabling: false }),
    { kind: 'ok', text: 'Claude is off: Gemini runs every organ again.' });
  assert.deepEqual(switchOutcome({ status: 'failed', error: 'the gateway is not ready' }, { enabling: true, model: NEWEST }),
    { kind: 'error', text: 'Not switched: the gateway is not ready' });
  assert.equal(switchOutcome({ status: 'running' }, { enabling: true }).kind, 'warn');
});
