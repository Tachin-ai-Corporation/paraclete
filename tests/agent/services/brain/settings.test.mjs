// Tests for agent/services/brain/settings.mjs: the contracts mapped onto each library's parameters,
// the effort level taken from the admin settings, and effort applied to an organ's temperature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContracts } from '../../../../config/contracts.mjs';
import { EXECUTOR_DEFAULTS } from '../../../../agent/work/checkpoint-executor.mjs';
import { VERIFY_DEFAULTS } from '../../../../agent/organs/cerebellum/verify.mjs';
import { DEFAULT_ARCHIVAL_CONFIG } from '../../../../agent/work/archival.mjs';
import { ORGANS } from '../../../../agent/gateway/organs.mjs';
import {
  ORGAN_BASE_TEMPERATURE, adminEffort, archivalConfig, brainSettings, executorSettings, organTemperature, verifySettings,
} from '../../../../agent/services/brain/settings.mjs';

const contracts = loadContracts();

function allDefined(value, path = '') {
  if (value === undefined) return [path];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => allDefined(v, path ? `${path}.${k}` : k));
  }
  return [];
}

test('the organ base temperatures mirror the gateway\'s organ table', () => {
  assert.deepEqual(Object.keys(ORGAN_BASE_TEMPERATURE).sort(), Object.keys(ORGANS).sort());
  for (const [organ, spec] of Object.entries(ORGANS)) assert.equal(ORGAN_BASE_TEMPERATURE[organ], spec.temperature, organ);
});

test('effort scales an organ\'s temperature; the default effort leaves the gateway\'s value alone', () => {
  assert.equal(organTemperature('cortex', 'medium'), undefined);
  assert.equal(organTemperature('cortex', 'nonsense'), undefined, 'an unknown level is the default');
  assert.equal(organTemperature('cortex', 'low'), 0.2);
  assert.ok(Math.abs(organTemperature('prefrontal', 'high') - 0.84) < 1e-9);
  assert.equal(organTemperature('prefrontal', 'max'), 1.0, 'clamped to the ceiling');
  assert.equal(organTemperature('no-such-organ', 'high'), undefined);
});

test('the effort level an admin chose, else the contracts default, and medium when unknown', () => {
  assert.equal(adminEffort({ effort: 'high', claude_enabled: true }, 'medium'), 'high');
  assert.equal(adminEffort({}, 'low'), 'low', 'no document: the contracts default');
  assert.equal(adminEffort(null, 'low'), 'low');
  assert.equal(adminEffort({ effort: 'extreme' }), 'medium');
});

test('every checkpoint executor setting maps from a contracts key', () => {
  const s = executorSettings(contracts);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(EXECUTOR_DEFAULTS).sort());
  assert.deepEqual(allDefined(s), []);
  assert.equal(s.ctxAgentStep, contracts.utility.context_budgets.agent_step);
  assert.equal(s.ctxDispatchFailure, contracts.utility.context_budgets.dispatch_failure);
  assert.equal(s.transitionGuard, 'enforce');
});

test("every one of the cerebellum's verification budgets maps from a contracts key", () => {
  const v = verifySettings(contracts);
  assert.deepEqual(Object.keys(v).sort(), Object.keys(VERIFY_DEFAULTS).sort());
  assert.deepEqual(allDefined(v), []);
  assert.equal(v.ctxVerifyInput, contracts.brain.ctx_verify_input);
  assert.equal(v.attackStakesMin, contracts.brain.attack_duty_stakes_min);
});

test('every archival threshold maps from a contracts key', () => {
  const a = archivalConfig(contracts);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(DEFAULT_ARCHIVAL_CONFIG).sort());
  assert.deepEqual(allDefined(a), []);
  assert.equal(a.waitingTimeoutHours, contracts.archival.waiting_timeout_hours);
});

test('the brain settings are complete and copy, never share, the frozen contracts', () => {
  const s = brainSettings(contracts);
  assert.deepEqual(allDefined(s), []);
  assert.equal(s.maxIterations, contracts.brain.max_iterations);
  assert.deepEqual(s.respondReads, ['recent_work']);
  assert.equal(s.effortDefault, contracts.effort.default);
  s.compaction.trigger_pct = 0.1;
  assert.notEqual(contracts.compaction.trigger_pct, 0.1);
});
