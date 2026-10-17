// Tests for config/contracts.mjs, run against the real config/contracts.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContracts, validateContracts, CONTRACTS_PATH } from '../../config/contracts.mjs';

const real = () => structuredClone(loadContracts());

function writeTemp(content) {
  const path = join(mkdtempSync(join(tmpdir(), 'contracts-')), 'contracts.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('the shipped contracts are valid and frozen', () => {
  const contracts = loadContracts();
  assert.deepEqual(validateContracts(structuredClone(contracts)), []);
  assert.ok(Object.isFrozen(contracts.vertex.models), 'nested sections are frozen too');
  assert.throws(() => { contracts.brain.max_iterations = 1; }, TypeError);
});

test('Gemini is the default for every organ tier, and Claude only where it is opted into', () => {
  const { models } = loadContracts().vertex;
  for (const tier of ['cortex', 'strong', 'fast', 'fallback', 'claude_fallback']) {
    assert.match(models[tier], /^vertex-google\//, `${tier} defaults to Gemini`);
  }
  assert.match(models.claude, /^vertex-anthropic\//);
});

test('the storage ceilings hold', () => {
  const c = real();
  c.brain.context_token_budget = 500000;
  assert.ok(validateContracts(c).some((p) => p.includes('brain.context_token_budget')));
  const d = real();
  d.compaction.working_budget_tokens = d.brain.context_token_budget + 1;
  assert.ok(validateContracts(d).some((p) => p.includes('compaction.working_budget_tokens')));
});

test('the stale-wait timeout must outlast the longest timed wait', () => {
  const c = real();
  c.archival.waiting_timeout_hours = 8;
  assert.ok(validateContracts(c).some((p) => p.includes('archival.waiting_timeout_hours')));
});

test('a model string must name its provider, and the fallbacks must be Gemini', () => {
  const c = real();
  c.vertex.models.strong = 'gemini-4-argon';
  c.vertex.models.fallback = 'vertex-anthropic/claude-opus-4-6';
  const problems = validateContracts(c);
  assert.ok(problems.some((p) => p.startsWith('vertex.models.strong')));
  assert.ok(problems.some((p) => p.startsWith('vertex.models.fallback must be a Gemini model')));
});

test('the gateway listens on loopback only', () => {
  const c = real();
  c.gateway.bind = '0.0.0.0';
  assert.ok(validateContracts(c).some((p) => p.includes('loopback')));
});

test('a missing section is named', () => {
  const c = real();
  delete c.archival;
  assert.deepEqual(validateContracts(c), ['missing section: archival']);
});

test('loadContracts names every problem, and an unreadable file', () => {
  const c = real();
  c.organs.max_steps = 0;
  c.effort.default = 'extreme';
  assert.throws(() => loadContracts({ path: writeTemp(c) }), /organs\.max_steps[\s\S]*effort\.default/);
  assert.throws(() => loadContracts({ path: writeTemp('{not json') }), /Cannot read contracts/);
});

test('contracts.json sits next to its loader', () => {
  assert.match(CONTRACTS_PATH.replace(/\\/g, '/'), /\/config\/contracts\.json$/);
});
