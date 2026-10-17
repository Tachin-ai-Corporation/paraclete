// Tests for agent/work/mission-record.mjs. The writer is exercised against a temporary directory.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderMissionRecordHeader, renderMissionRecordBody, renderResultJson, writeMissionRecord,
} from '../../../agent/work/mission-record.mjs';

const mission = (over = {}) => ({
  id: 'w-1700000000000-0a1b2c3d',
  type: 'M',
  title: 'Weekly briefing',
  status: 'complete',
  created_at: '2026-01-05T08:00:00Z',
  completed_at: '2026-01-05T08:20:00Z',
  project_id: 'general',
  accept_criteria: 'The doc exists and every section has content.',
  output: 'Created the briefing doc.',
  children: ['c-1', 'c-2'],
  iteration: 2,
  ...over,
});

describe('renderMissionRecordHeader', () => {
  it('tabulates the mission and leaves out what it does not have', () => {
    const header = renderMissionRecordHeader(mission());
    assert.match(header, /^# Mission: Weekly briefing\n/);
    assert.match(header, /\| ID \| `w-1700000000000-0a1b2c3d` \|/);
    assert.match(header, /\| Status \| complete \|/);
    assert.match(header, /\| Project \| `general` \|/);
    assert.match(header, /\| Accept Criteria \| The doc exists/);
    assert.ok(!header.includes('Stakes'));
    assert.ok(!header.includes('## Epistemic State'), 'no epistemic section without anything to say');
  });

  it('records the epistemic state when the mission has one', () => {
    const header = renderMissionRecordHeader(mission({
      stakes: 'consequential',
      _brief: { kill_shot: 'The template id is wrong' },
      _lastDecision: { assumptions: [{ status: 'verified', claim: 'The folder exists', note: 'listed it' }] },
      _compaction: { durable_learnings: ['Read the doc back before reporting'] },
    }));
    assert.match(header, /\| Stakes \| consequential \|/);
    assert.match(header, /## Epistemic State/);
    assert.match(header, /- \*\*Kill shot:\*\* The template id is wrong/);
    assert.match(header, /  - `verified` The folder exists — listed it/);
    assert.match(header, /  - Read the doc back before reporting/);
  });

  it('falls back for a bare envelope', () => {
    const header = renderMissionRecordHeader({ id: 'w-x' });
    assert.match(header, /# Mission: Untitled/);
    assert.match(header, /\| Status \| unknown \|/);
    assert.match(header, /\| Created \| — \|/);
  });
});

describe('renderMissionRecordBody / renderResultJson', () => {
  it('puts the output under the header', () => {
    const body = renderMissionRecordBody(mission());
    assert.match(body, /---\n\n## Output\n\nCreated the briefing doc\.\n$/);
    assert.match(renderMissionRecordBody(mission({ output: '' })), /## Output\n\n\(no output\)\n$/);
  });

  it('summarizes the mission for deterministic recovery', () => {
    const json = renderResultJson(mission(), { verdict: 'PASS', summary: 'All sections present', extra: 'dropped' });
    assert.equal(json.id, 'w-1700000000000-0a1b2c3d');
    assert.equal(json.output_chars, 'Created the briefing doc.'.length);
    assert.equal(json.children_count, 2);
    assert.deepEqual(json.verification, { verdict: 'PASS', summary: 'All sections present' });
    assert.equal(json.compaction, null);
    assert.equal(renderResultJson(mission()).verification, null);
  });

  it('caps the output preview at 500 characters', () => {
    assert.equal(renderResultJson(mission({ output: 'z'.repeat(2000) })).output_preview.length, 500);
  });
});

describe('writeMissionRecord', () => {
  it('writes output.md and result.json under missions/, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-record-'));
    try {
      const first = writeMissionRecord(mission(), dir);
      assert.deepEqual(first, { written: true, files: ['missions/output.md', 'missions/result.json'] });
      const md = readFileSync(join(dir, 'missions', 'output.md'), 'utf8');
      const json = readFileSync(join(dir, 'missions', 'result.json'), 'utf8');
      assert.equal(md, renderMissionRecordBody(mission()));
      assert.deepEqual(JSON.parse(json), renderResultJson(mission()));
      assert.ok(json.endsWith('\n'));

      writeMissionRecord(mission(), dir);
      assert.equal(readFileSync(join(dir, 'missions', 'output.md'), 'utf8'), md, 'rewriting changes nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips, without throwing, when the shared directory is missing', () => {
    const logs = [];
    const r = writeMissionRecord(mission(), join(tmpdir(), 'does-not-exist-mission-record'), (level, msg) => logs.push(level, msg));
    assert.deepEqual(r, { written: false, files: [] });
    assert.equal(logs[0], 'DEBUG');
    assert.deepEqual(writeMissionRecord(mission(), ''), { written: false, files: [] });
  });

  it('reports a failed write instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-record-'));
    try {
      writeFileSync(join(dir, 'missions'), 'a file where the directory should be');
      const logs = [];
      const r = writeMissionRecord(mission(), dir, (level, msg) => logs.push({ level, msg }));
      assert.deepEqual(r, { written: false, files: [] });
      assert.equal(logs.at(-1).level, 'WARN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
