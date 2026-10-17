// Tests for agent/context/context-maintenance.mjs. The step asks for a lesson that the brain appends
// to working memory; it never writes project context or replaces a playbook's narrative.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldMaintainContext, buildMaintenancePrompt, parseMaintenanceResponse, shouldMaintainProcesses,
  buildProcessMaintenancePrompt, lessonLine,
} from '../../../agent/context/context-maintenance.mjs';

const ON = { enabled: true };
const OFF = { enabled: false };
const M = (over = {}) => ({ type: 'M', status: 'complete', project_id: 'marketing-site', title: 'g', output: 'o', ...over });

describe('shouldMaintainContext', () => {
  it('runs for a finished mission that worked in a project, with the step on', () => {
    const r = shouldMaintainContext(M(), ON);
    assert.equal(r.run, true);
    assert.equal(r.projectId, 'marketing-site');
  });

  it('does not run when the step is off', () => {
    assert.equal(shouldMaintainContext(M(), OFF).run, false);
    assert.equal(shouldMaintainContext(M(), {}).run, false);
  });

  it('does not run for a non-mission, an unfinished mission, or one without a project', () => {
    assert.equal(shouldMaintainContext(M({ type: 'C' }), ON).run, false);
    assert.equal(shouldMaintainContext(M({ status: 'blocked' }), ON).run, false);
    assert.equal(shouldMaintainContext(M({ project_id: null }), ON).run, false);
  });

  it('is null-safe', () => {
    assert.equal(shouldMaintainContext(null, ON).run, false);
    assert.equal(shouldMaintainContext(M(), null).run, false);
    assert.equal(shouldMaintainContext(M()).run, false);
  });
});

describe('buildMaintenancePrompt', () => {
  it('asks for a lesson for memory, shows the project context read-only, with a strict JSON contract', () => {
    const p = buildMaintenancePrompt(M({ title: 'Add FAQ', output: 'FAQ planned' }), { id: 'marketing-site', name: 'Example Web', context: { a: 1 } });
    assert.match(p, /temporal-memory organ/);
    assert.match(p, /MEMORY/);
    assert.match(p, /never written into the project record/i);
    assert.match(p, /PROJECT CONTEXT \(read-only\)/);
    assert.match(p, /Example Web/);
    assert.match(p, /Add FAQ/);
    assert.match(p, /FAQ planned/);
    assert.match(p, /"lesson"/);
    assert.doesNotMatch(p, /"update"/, 'a project-context update is not what this step asks for');
    assert.match(p, /EMPTY string if nothing durable/i);
  });

  it('bounds long outcomes and is null-safe on context', () => {
    const p = buildMaintenancePrompt(M({ output: 'x'.repeat(9000) }), { id: 'p' });
    assert.ok(p.length < 4000, 'prompt stays bounded');
    assert.match(p, /PROJECT CONTEXT \(read-only\): \(none\)/);
  });
});

describe('parseMaintenanceResponse', () => {
  it('extracts a durable lesson', () => {
    assert.equal(parseMaintenanceResponse('{"lesson": "Now uses a git source of truth."}').lesson, 'Now uses a git source of truth.');
  });

  it('returns empty when nothing was learned', () => {
    assert.equal(parseMaintenanceResponse('{"lesson": ""}').lesson, '');
  });

  it('reads only the lesson key', () => {
    assert.equal(parseMaintenanceResponse('{"update": "X changed."}').lesson, '');
  });

  it('extracts JSON embedded in prose and flattens whitespace to one line', () => {
    assert.equal(parseMaintenanceResponse('Here is my note:\n{"lesson": "X\\nchanged."}\ndone').lesson, 'X changed.');
  });

  it('never throws on garbage, empty input, or a lesson that is not a string', () => {
    assert.equal(parseMaintenanceResponse('not json').lesson, '');
    assert.equal(parseMaintenanceResponse('').lesson, '');
    assert.equal(parseMaintenanceResponse('{"lesson": 42}').lesson, '');
    assert.equal(parseMaintenanceResponse('{"lesson": ').lesson, '');
  });

  it('caps the lesson at 300 chars by default, and honors a custom cap', () => {
    assert.equal(parseMaintenanceResponse(JSON.stringify({ lesson: 'y'.repeat(900) })).lesson.length, 300);
    assert.equal(parseMaintenanceResponse(JSON.stringify({ lesson: 'y'.repeat(900) }), 120).lesson.length, 120);
  });
});

describe('lessonLine', () => {
  it('is one scoped working-memory line', () => {
    assert.equal(lessonLine({ scope: 'project', id: 'general', lesson: 'Folder ids live in the project.', date: '2026-09-24' }),
      '- [2026-09-24] lesson (project general): Folder ids live in the project.\n');
    assert.equal(lessonLine({ scope: 'playbook', id: 'p-audit', lesson: 'Read before  you\nwrite.', date: '2026-09-24' }),
      '- [2026-09-24] lesson (playbook p-audit): Read before you write.\n');
  });

  it('is empty when there is no lesson, so nothing is appended', () => {
    assert.equal(lessonLine({ scope: 'project', id: 'x', lesson: '   ' }), '');
    assert.equal(lessonLine(), '');
  });
});

const MP = (over = {}) => ({ type: 'M', status: 'complete', project_id: 'marketing-site', recalled_processes: ['p-audit', 'p-review'], ...over });

describe('shouldMaintainProcesses', () => {
  it('runs for a finished mission that recalled playbooks, deduplicated and bounded to 3', () => {
    const r = shouldMaintainProcesses(MP({ recalled_processes: ['a', 'a', 'b', 'c', 'd'] }), ON);
    assert.equal(r.run, true);
    assert.deepEqual(r.processIds, ['a', 'b', 'c']);
  });

  it('honors a custom bound', () => {
    assert.deepEqual(shouldMaintainProcesses(MP({ recalled_processes: ['a', 'b', 'c'] }), ON, 1).processIds, ['a']);
  });

  it('does not run with no recalled playbooks, the step off, or an unfinished mission', () => {
    assert.equal(shouldMaintainProcesses(MP({ recalled_processes: [] }), ON).run, false);
    assert.equal(shouldMaintainProcesses(MP({ recalled_processes: null }), ON).run, false);
    assert.equal(shouldMaintainProcesses(MP(), OFF).run, false);
    assert.equal(shouldMaintainProcesses(MP({ status: 'blocked' }), ON).run, false);
  });

  it('is null-safe and filters ids that are not strings', () => {
    assert.equal(shouldMaintainProcesses(null, ON).run, false);
    assert.equal(shouldMaintainProcesses(MP(), null).run, false);
    assert.deepEqual(shouldMaintainProcesses(MP({ recalled_processes: ['ok', 42, '', null] }), ON).processIds, ['ok']);
  });
});

describe('buildProcessMaintenancePrompt', () => {
  it('asks for a lesson about the playbook, never a rewrite, with the narrative shown read-only', () => {
    const p = buildProcessMaintenancePrompt({ id: 'p-audit', name: 'Codebase Audit', narrative: 'An audit measures.' }, MP({ title: 'Audit X', output: 'found 3 issues' }));
    assert.match(p, /PROCESS PLAYBOOK/);
    assert.match(p, /Codebase Audit/);
    assert.match(p, /PLAYBOOK NARRATIVE \(read-only\): An audit measures/);
    assert.match(p, /Audit X/);
    assert.match(p, /read-only to memory: you never rewrite it/i);
    assert.match(p, /NO tool[\s\S]*syntax/i);
    assert.match(p, /"lesson"/);
    assert.doesNotMatch(p, /FULL refined narrative|complete replacement narrative/i,
      'a replacement narrative written over the playbook is what this step must never ask for');
  });

  it('bounds long outcomes and is null-safe on the narrative', () => {
    const p = buildProcessMaintenancePrompt({ id: 'p' }, MP({ output: 'z'.repeat(9000) }));
    assert.ok(p.length < 4000, 'prompt stays bounded');
    assert.match(p, /PLAYBOOK NARRATIVE \(read-only\): \(none\)/);
  });
});
