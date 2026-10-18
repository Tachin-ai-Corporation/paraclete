// Tests for agent/gateway/organs.mjs: which model each organ runs on, its toolset, and its prompt.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORGANS, DEFAULT_MODELS, DEFAULT_MAX_STEPS, resolveOrganModels, loadOrganPrompt, createOrganRegistry,
} from '../../../agent/gateway/organs.mjs';
import { OPEN_TOOLSET, CEREBELLUM_TOOLSET, MEMORY_TOOLSET } from '../../../agent/gateway/tools.mjs';

const models = {
  cortex: 'vertex-anthropic/claude-opus-x',
  strong: 'vertex-anthropic/claude-opus-y',
  fast: 'vertex-google/gemini-fast',
  fallback: 'vertex-google/gemini-fallback',
};

describe('model resolution', () => {
  it('cortex → models.cortex; prefrontal, motor, cerebellum → models.strong; temporal organs → models.fast', () => {
    const expected = {
      cortex: models.cortex,
      prefrontal: models.strong,
      motor: models.strong,
      cerebellum: models.strong,
      'temporal-memory': models.fast,
      'temporal-research': models.fast,
    };
    for (const [organ, model] of Object.entries(expected)) {
      assert.deepEqual(resolveOrganModels(organ, models), { model, fallbackModel: models.fallback }, organ);
    }
    assert.deepEqual(Object.keys(ORGANS).sort(), Object.keys(expected).sort());
  });

  it('defaults to gemini-4-argon for the cortex and the strong tier, gemini-3.8-flash for the rest', () => {
    assert.deepEqual(DEFAULT_MODELS, {
      cortex: 'vertex-google/gemini-4-argon',
      strong: 'vertex-google/gemini-4-argon',
      fast: 'vertex-google/gemini-3.8-flash',
      fallback: 'vertex-google/gemini-3.8-flash',
    });
    assert.deepEqual(resolveOrganModels('motor'), { model: DEFAULT_MODELS.strong, fallbackModel: DEFAULT_MODELS.fallback });
    assert.deepEqual(resolveOrganModels('cortex', { strong: 'x' }).model, DEFAULT_MODELS.cortex, 'a missing tier keeps its default');
  });

  it('the registry resolves the same models and exposes them', () => {
    const organs = createOrganRegistry({ models });
    assert.equal(organs.get('cerebellum').model, models.strong);
    assert.equal(organs.get('temporal-research').fallbackModel, models.fallback);
    assert.deepEqual(organs.models, models);
  });

  it('refuses an unknown organ with a 400', () => {
    assert.throws(() => createOrganRegistry().get('hippocampus'), (err) => err.statusCode === 400 && /unknown organ/.test(err.message));
    assert.throws(() => resolveOrganModels('main'), /unknown organ/);
  });
});

describe('toolsets and steps', () => {
  const organs = createOrganRegistry({ maxSteps: 30 });

  it('the cerebellum holds only the verifier toolset and must answer with a call', () => {
    const c = organs.get('cerebellum');
    assert.deepEqual(c.toolset, [...CEREBELLUM_TOOLSET]);
    assert.equal(c.forceToolCall, true);
  });

  it('motor and temporal-research hold the open toolset, without the verdict tools', () => {
    for (const id of ['motor', 'temporal-research']) {
      const o = organs.get(id);
      assert.deepEqual(o.toolset, [...OPEN_TOOLSET], id);
      assert.equal(o.forceToolCall, false, `${id} may answer in text`);
      assert.equal(o.maxSteps, 30);
    }
  });

  it('temporal-memory is toolless on recall and holds exactly the memory toolset when asked to execute', () => {
    assert.deepEqual(organs.get('temporal-memory').toolset, []);
    assert.equal(organs.get('temporal-memory').maxSteps, 1);
    const tooled = organs.get('temporal-memory', { exec: true });
    assert.deepEqual(tooled.toolset, [...MEMORY_TOOLSET]);
    assert.ok(!tooled.toolset.includes('runCommand') && !tooled.toolset.includes('writeFile'));
    assert.equal(tooled.maxSteps, 30);
  });

  it('the organs that execute, research and verify can view images; no other organ can', () => {
    const viewers = organs.ids.filter((id) => organs.get(id).toolset.includes('viewImage') || organs.get(id, { exec: true }).toolset.includes('viewImage'));
    assert.deepEqual(viewers, ['motor', 'cerebellum', 'temporal-research']);
  });

  it('exec changes nothing for the other organs', () => {
    assert.deepEqual(organs.get('motor', { exec: true }).toolset, [...OPEN_TOOLSET]);
    assert.deepEqual(organs.get('cortex', { exec: true }).toolset, []);
  });

  it('the planning organs are toolless, one step', () => {
    for (const id of ['cortex', 'prefrontal']) {
      assert.deepEqual(organs.get(id).toolset, [], id);
      assert.equal(organs.get(id).maxSteps, 1, id);
    }
    assert.equal(createOrganRegistry().get('motor').maxSteps, DEFAULT_MAX_STEPS);
  });

  it('each organ carries its job and sampling', () => {
    const motor = organs.get('motor');
    assert.equal(motor.job, 'Executes tasks with tools');
    assert.deepEqual([motor.maxTokens, motor.temperature, motor.topP], [65536, 0.3, 0.9]);
    assert.equal(organs.get('cerebellum').maxTokens, 32768, 'room to reason and still return a verdict');
  });
});

describe('organ prompts', () => {
  it('reads the base prompt and appends the role prompt when there is one', () => {
    const root = mkdtempSync(join(tmpdir(), 'organ-prompts-'));
    try {
      const prompts = join(root, 'prompts');
      const role = join(root, 'roles', 'devops-engineer', 'prompts');
      mkdirSync(prompts, { recursive: true });
      mkdirSync(role, { recursive: true });
      writeFileSync(join(prompts, 'motor.md'), 'You execute tasks.\n');
      writeFileSync(join(prompts, 'cortex.md'), 'You decide.\n');
      writeFileSync(join(role, 'motor.md'), 'A deploy passes only on a live 2xx.\n');
      const dirs = { promptsDir: prompts, rolePromptsDir: role };
      assert.equal(loadOrganPrompt('motor', dirs), 'You execute tasks.\n\nA deploy passes only on a live 2xx.');
      assert.equal(loadOrganPrompt('cortex', dirs), 'You decide.');
      assert.equal(loadOrganPrompt('prefrontal', dirs), '', 'a missing prompt reads as empty');
      assert.equal(createOrganRegistry(dirs).get('motor').systemPrompt, 'You execute tasks.\n\nA deploy passes only on a live 2xx.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
