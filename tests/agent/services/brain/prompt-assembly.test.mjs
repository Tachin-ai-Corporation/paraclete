// Tests for agent/services/brain/prompt-assembly.mjs: the context the brain sends with an organ turn,
// after the organ's own prompt (which only the gateway reads): the system blocks, the capability map,
// and each cortex mode's and the prefrontal's user turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CLASSIFICATION_GUIDANCE, analyzeRequest, capabilityMap, classifyBlocks, cortexSystem, cortexUser, decideBlocks,
  decideDeltaBlocks, decidePayload, planInstruction, readSkills, respondComposeBlocks, singleCheckpointInstruction, splitEnvelope,
} from '../../../../agent/services/brain/prompt-assembly.mjs';
import { REPO_ROOT } from './harness.mjs';

const RESOURCES = { 'drive_folder:reports': { kind: 'drive_folder', name: 'Reports', id: '1AbCdEfGhIjKlMnOpQrSt' } };
const envelope = (over = {}) => ({
  id: 'w-1', type: 'M', instruction: 'Write the reports summary', accept_criteria: 'The summary is in the Reports folder',
  context_summary: null, conversation_context: null, context: { resources: RESOURCES }, ...over,
});

function skillDir(skills) {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const [name, manifest] of Object.entries(skills)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'skill.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  return dir;
}

test('skills are read once each, first directory wins, and a broken manifest is skipped', () => {
  const base = skillDir({ shell: { id: 'shell', name: 'Shell', when_to_use: 'Running commands. And more.', organs: ['motor'] }, broken: '{not json' });
  const agentOwn = skillDir({ shell2: { id: 'shell', name: 'Shell (again)', organs: ['motor'] }, notes: { id: 'notes', name: 'Notes', organs: ['temporal-memory', 'motor'] } });
  const skills = readSkills([base, '/no/such/dir', agentOwn]);
  assert.deepEqual(skills.map((s) => s.id), ['shell', 'notes']);
  assert.equal(skills[0].name, 'Shell');
});

test('the capability map says which organ can do what, never how', () => {
  const map = capabilityMap([
    { name: 'Web Search', whenToUse: 'Searching the web. Uses an API.', organs: ['temporal-research'] },
    { name: 'Shell', whenToUse: 'Running commands', organs: [] },
    { name: 'Plan', whenToUse: 'Planning', organs: ['prefrontal'] },
  ]);
  assert.equal(map, '## prefrontal\n- Plan — Planning\n\n## motor\n- Shell — Running commands\n\n## temporal-research\n- Web Search — Searching the web');
  assert.doesNotMatch(map, /SKILL\.md|readFile/);
  const real = capabilityMap(readSkills([join(REPO_ROOT, 'skills')]));
  assert.match(real, /## prefrontal\n- Checkpoint Plan Structuring/);
  assert.match(real, /## cerebellum/);
});

test('the cortex\'s system blocks: Deep Truths and registries first and stable, working memory last', () => {
  const blocks = cortexSystem({
    deepTruths: '- Verify before claiming.',
    workingMemory: '## Current Focus\nQ3 report',
    projects: { site: { id: 'site', name: 'Site', status: 'active', description: 'The website', context: { url: 'x' }, team: ['someone'] } },
    processes: { 'p-x': { id: 'p-x', name: 'X', description: 'd', narrative: 'n', steps: [1] } },
  });
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^\[DEEP TRUTHS[^\n]*\]\n- Verify before claiming\./);
  assert.match(blocks[0], /\[PROJECT REGISTRY/);
  assert.match(blocks[0], /\[PROCESS PLAYBOOKS/);
  assert.doesNotMatch(blocks[0], /team|steps/, 'a project\'s team and a playbook\'s old steps never reach the cortex');
  assert.doesNotMatch(blocks.join(), /You are the cortex/, 'the organ prompt is the gateway\'s');
  assert.equal(blocks[1], '[WORKING MEMORY — MEMORY.md]\n## Current Focus\nQ3 report');
  assert.deepEqual(cortexSystem({}), ['Respond with exactly one JSON object and nothing else.']);
});

test('a cortex turn opens with the brain\'s marker; the requester rides the mission tier', () => {
  const parts = cortexUser([{ label: 'X', text: 'payload', tier: 'volatile' }], { requester: 'person@example.com' });
  assert.deepEqual(parts.map((p) => p.tier), ['boot', 'mission', 'volatile']);
  assert.equal(parts[0].text, '[BRAIN-ORCHESTRATED]');
  assert.match(parts[1].text, /person@example\.com/);
});

test('the classify turn carries its guidance, the reads it may ask for and the registries', () => {
  const blocks = classifyBlocks({
    inbound: { text: 'hi', source: 'dashboard', source_meta: {} },
    respondReads: [{ id: 'recent_work', description: 'recent work' }],
    projects: { site: { id: 'site', name: 'Site', description: 'd', context: { required_processes: ['p-release'] } } },
    processes: { 'p-release': { id: 'p-release', name: 'Release', description: 'ship' } },
    lastAgentReply: 'Which quarter?',
  });
  const boot = JSON.parse(blocks[0].text);
  const turn = JSON.parse(blocks[1].text);
  assert.deepEqual(boot.classification_guidance, CLASSIFICATION_GUIDANCE);
  assert.match(boot.classification_guidance.cancel_target, /cancel_target/);
  assert.deepEqual(boot.respond_reads_available, [{ id: 'recent_work', description: 'recent work' }]);
  assert.deepEqual(boot.project_registry[0].required_processes, ['p-release']);
  assert.equal(turn.mode, 'classify');
  assert.equal(turn.last_agent_reply, 'Which quarter?');
  assert.deepEqual(boot.respond_reads_available.map((r) => r.id), ['recent_work'], 'only the reads it was given');
});

test('the respond_compose turn grounds a draft on a read', () => {
  const [block] = respondComposeBlocks({ inbound: { text: 'q' }, toolGrounding: '[TOOL RESULT: recent_work]\nx', draft: 'draft' });
  const p = JSON.parse(block.text);
  assert.equal(p.mode, 'respond_compose');
  assert.equal(p.draft_response, 'draft');
});

test('the decide turn: the ids resolved so far reach the cortex, in the full state and every delta', () => {
  const p = decidePayload({ envelope: envelope(), priorResults: [], iteration: 2 });
  assert.match(p.known_resources, /Reports.*1AbCdEfGhIjKlMnOpQrSt/);
  // Fixed defect: known_resources was computed and then left out of every tier.
  const full = decideBlocks(p).map((b) => b.text).join('\n');
  assert.match(full, /1AbCdEfGhIjKlMnOpQrSt/);
  assert.match(decideDeltaBlocks(p, 0)[0].text, /1AbCdEfGhIjKlMnOpQrSt/);
});

test('the decide turn\'s guidance: no delegation, a goal check when there are criteria, the premise flag', () => {
  const plain = decidePayload({ envelope: envelope() });
  assert.match(plain.dispatch_guidance.rule, /All work uses checkpoint_plan/);
  assert.match(plain.goal_state.instruction, /goal_check/);
  const briefed = decidePayload({
    envelope: envelope({ accept_criteria: null }),
    brief: { objective: 'o', parts: [], premise: 'flawed', premise_note: 'the folder does not exist' },
    triggerable: [{ id: 'r-x', name: 'X', purpose: 'p' }],
    project: { id: 'site', name: 'Site', standardProcesses: ['p-release'], context: {} },
    renderedProjectContext: '## Project Context: Site',
  });
  assert.doesNotMatch(briefed.dispatch_guidance.step_types, /delegat|teammate/);
  assert.match(briefed.dispatch_guidance.process_preference, /p-release/);
  assert.equal(briefed.goal_state, undefined);
  assert.equal(briefed.premise_check.note, 'the folder does not exist');
  assert.match(briefed.responsibility_trigger_guidance, /trigger_responsibility/);
  assert.equal(briefed.rendered_project_context, '## Project Context: Site');
});

test('the decide blocks are ordered boot, mission, working state; the envelope splits by what changes', () => {
  const p = decidePayload({ envelope: envelope(), priorResults: [{ agent: 'motor', result: 'r', success: true }], iteration: 3 });
  const blocks = decideBlocks(p);
  assert.deepEqual(blocks.map((b) => b.tier), ['boot', 'mission', 'volatile']);
  assert.equal(JSON.parse(blocks[2].text).iteration, 3);
  assert.deepEqual(splitEnvelope({ id: 'w', status: 'active', instruction: 'x', iteration: 2 }), {
    statics: { id: 'w', instruction: 'x' }, state: { iteration: 2, status: 'active' },
  });
});

test('a delta carries only results past the watermark, summaries in place of results, each capped', () => {
  const p = decidePayload({
    envelope: envelope(),
    priorResults: [
      { agent: 'motor', result: 'old' },
      { agent: 'motor', result: 'x'.repeat(5000), summary: 'a list of 3 items', ref: 'w-t1' },
      { agent: 'motor', result: 'y'.repeat(5000) },
    ],
  });
  const delta = JSON.parse(decideDeltaBlocks(p, 1)[0].text);
  assert.equal(delta.new_results.length, 2);
  assert.deepEqual(delta.new_results[0], { agent: 'motor', ref: 'w-t1', result: 'a list of 3 items' });
  assert.ok(delta.new_results[1].result.length < 2100);
});

test('the prefrontal\'s analyze request: context as system blocks, the payload as the turn', () => {
  const { system, user } = analyzeRequest({
    envelope: envelope(), processes: { 'p-x': { id: 'p-x', name: 'X', narrative: 'n' } },
    project: { id: 'site', name: 'Site', description: 'd', team: ['x'] }, capabilityMap: '## motor\n- Shell', requester: 'person@example.com',
  });
  assert.match(system[0], /PROCESS PLAYBOOKS/);
  assert.match(system[1], /PROJECT CONTEXT/);
  assert.doesNotMatch(system[1], /team/);
  assert.match(system[2], /CAPABILITY MAP/);
  assert.ok(user.startsWith('[BRAIN-ORCHESTRATED]\n## Requester'));
  assert.equal(JSON.parse(user.split('\n').pop()).mode, 'analyze');
});

test('plan requests carry the plan-structuring skill; a single checkpoint re-plan is a checklist', () => {
  const full = planInstruction({ goal: 'Ship', skillDoc: 'SKILL TEXT', capabilityMap: 'MAP', idRule: 'IDS', processHint: 'HINT', constraints: 'fast', priorResults: [{ checkpoint_step: '1.1', result: 'ok' }] });
  assert.ok(full.startsWith('[PLAN STRUCTURING]'));
  for (const s of ['SKILL TEXT', 'MAP', '## Goal\nShip', 'IDS', 'HINT', '## Constraints\nfast', '1.1: ok']) assert.ok(full.includes(s), s);
  assert.ok(full.indexOf('SKILL TEXT') < full.indexOf('## Goal'), 'stable content leads');

  const one = singleCheckpointInstruction({
    target: { n: 2, outcome: 'Docs edited', accept_criteria: 'ids identified and edits applied', tasks: [{ task: 'Edit doc 1AbC' }] },
    skillDoc: 'SKILL', failureNote: '- ids identified: not shown', idRule: '## Known Resources\n- doc: "A" = 1AbD',
  });
  assert.ok(one.startsWith('[PLAN STRUCTURING — SINGLE CHECKPOINT]'));
  assert.match(one, /## Checkpoint 2 — outcome \(FIXED, do not reword\)\nDocs edited/);
  assert.match(one, /every one needs a task/);
  assert.ok(one.indexOf('## Known Resources') < one.indexOf('## Tasks that were tried'), 'the ids sit right before the tried tasks');
  assert.match(one, /EXACTLY ONE checkpoint/);
});
