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

test('the Claude candidates: newest first from Opus 5.5, the contracts Claude model among them, each with a context window', () => {
  const { models, context_windows: windows } = loadContracts().vertex;
  assert.equal(models.claude_candidates[0], 'vertex-anthropic/claude-opus-5-5');
  assert.equal(models.claude_candidates.at(-1), models.claude);
  for (const model of models.claude_candidates) {
    assert.match(model, /^vertex-anthropic\/claude-opus-/);
    assert.ok(windows[model.split('/')[1]] > 0, `${model} has a context window`);
  }
});

test('a Claude candidate list that is empty, repeats a model, names Gemini, lacks a context window or leaves out the Claude model is refused', () => {
  const problemsWith = (change) => {
    const c = real();
    change(c.vertex);
    return validateContracts(c);
  };
  assert.ok(problemsWith((v) => { v.models.claude_candidates = []; }).some((p) => p.includes('non-empty list')));
  assert.ok(problemsWith((v) => { delete v.models.claude_candidates; }).some((p) => p.includes('non-empty list')));
  assert.ok(problemsWith((v) => { v.models.claude_candidates.push(v.models.claude); }).some((p) => p.includes('twice')));
  assert.ok(problemsWith((v) => { v.models.claude_candidates.unshift('vertex-google/gemini-4-argon'); }).some((p) => p.includes("only 'vertex-anthropic/")));
  assert.ok(problemsWith((v) => { delete v.context_windows['claude-opus-5-5']; }).some((p) => p.includes('give claude-opus-5-5 a context window')));
  assert.ok(problemsWith((v) => { v.models.claude_candidates = v.models.claude_candidates.filter((m) => m !== v.models.claude); })
    .some((p) => p.includes('must include vertex.models.claude')));
});

test('one organ turn has room for the longest single-turn work: the nightly memory consolidation', () => {
  // A turn that reaches organs.max_steps stops where it is, before its last step. The consolidation
  // runs as one temporal-memory turn and writes its report last; on a dev instance it took 16 to 19
  // steps a night, so a budget of 16 cut it short (v2026.10.22.1.2). 20 is the floor, 25 the value.
  const { organs } = loadContracts();
  assert.ok(organs.max_steps >= 20, `organs.max_steps is ${organs.max_steps}; a nightly consolidation needs up to 19 steps in one turn`);
  assert.equal(organs.max_steps, 25);
});

test('the gateway listens on loopback only', () => {
  const c = real();
  c.gateway.bind = '0.0.0.0';
  assert.ok(validateContracts(c).some((p) => p.includes('loopback')));
});

test("the dashboard's build and service are checked: sizes, ingress, image, build config, timeout and the release check", () => {
  const { dashboard } = loadContracts();
  assert.deepEqual(dashboard.service, { cpu: '1', memory: '1Gi', max_instances: 3, ingress: 'all' });
  assert.equal(dashboard.build_config_path, 'dashboard/cloudbuild.json');
  const problemsWith = (change) => {
    const c = real();
    change(c.dashboard);
    return validateContracts(c);
  };
  assert.ok(problemsWith((d) => { d.service.cpu = 'one'; }).some((p) => p.startsWith('dashboard.service.cpu')));
  assert.ok(problemsWith((d) => { d.service.memory = '1GB'; }).some((p) => p.startsWith('dashboard.service.memory')));
  assert.ok(problemsWith((d) => { d.service.max_instances = '3'; }).some((p) => p.startsWith('dashboard.service.max_instances')));
  assert.ok(problemsWith((d) => { d.service.ingress = 'public'; }).some((p) => p.startsWith('dashboard.service.ingress')));
  assert.ok(problemsWith((d) => { d.image_name = 'Dashboard'; }).some((p) => p.startsWith('dashboard.image_name')));
  assert.ok(problemsWith((d) => { d.build_config_path = 'dashboard/cloudbuild.yaml'; }).some((p) => p.startsWith('dashboard.build_config_path')));
  assert.ok(problemsWith((d) => { d.build_timeout_seconds = 0; }).some((p) => p.startsWith('dashboard.build_timeout_seconds')));
  assert.ok(problemsWith((d) => { d.release_check_ttl_seconds = 60; }).some((p) => p.includes('60 unauthenticated requests an hour')));
  const c = real();
  delete c.dashboard;
  assert.deepEqual(validateContracts(c), ['missing section: dashboard']);
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
