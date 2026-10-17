// agent/work/mission-record.mjs: renders a mission's durable record (missions/output.md, the
// readable result with a header, and missions/result.json, a structured summary for deterministic
// recovery) and writes both into the mission's artifact working tree. Committing and publishing
// that tree belongs to the artifact store in agent/storage. The brain calls writeMissionRecord
// before the artifact publish step, so the publish captures the record.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---- Pure render functions ----

/**
 * Render the markdown header block for a mission record. Pure.
 *
 * @param {object} envelope - The mission envelope
 * @returns {string} Markdown header string
 */
export function renderMissionRecordHeader(envelope) {
  const lines = [
    `# Mission: ${envelope.title || 'Untitled'}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| ID | \`${envelope.id}\` |`,
    `| Status | ${envelope.status || 'unknown'} |`,
    `| Created | ${envelope.created_at || '—'} |`,
    `| Completed | ${envelope.completed_at || '—'} |`,
  ];

  if (envelope.project_id) {
    lines.push(`| Project | \`${envelope.project_id}\` |`);
  }
  if (envelope.accept_criteria) {
    lines.push(`| Accept Criteria | ${envelope.accept_criteria} |`);
  }
  if (envelope.stakes) {
    lines.push(`| Stakes | ${envelope.stakes} |`);
  }

  lines.push('');

  // Epistemic state: what the mission staked, what would sink it, what it assumed and what it
  // learned. Every claim in the record carries how far it was checked.
  const compactionLearnings = envelope._compaction?.durable_learnings;
  if (envelope.stakes || envelope._brief?.kill_shot || envelope._lastDecision?.assumptions?.length
      || (Array.isArray(compactionLearnings) && compactionLearnings.length > 0)) {
    lines.push('## Epistemic State', '');
    if (envelope.stakes) lines.push(`- **Stakes:** ${envelope.stakes}`);
    if (envelope._brief?.kill_shot) lines.push(`- **Kill shot:** ${envelope._brief.kill_shot}`);
    const assumptions = envelope._lastDecision?.assumptions;
    if (Array.isArray(assumptions) && assumptions.length > 0) {
      lines.push('- **Assumptions:**');
      for (const a of assumptions) {
        lines.push(`  - \`${a.status}\` ${a.claim}${a.note ? ` — ${a.note}` : ''}`);
      }
    }
    // Learnings distilled when the mission's context was compacted.
    if (Array.isArray(compactionLearnings) && compactionLearnings.length > 0) {
      lines.push('- **Durable learnings (context compaction):**');
      for (const l of compactionLearnings) {
        lines.push(`  - ${l}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render the full output.md content for a mission record. Pure.
 *
 * @param {object} envelope - The mission envelope
 * @returns {string} Full output.md content
 */
export function renderMissionRecordBody(envelope) {
  const header = renderMissionRecordHeader(envelope);
  const output = envelope.output || '(no output)';
  return `${header}---\n\n## Output\n\n${output}\n`;
}

/**
 * Render the structured result.json content for a mission record. Pure.
 *
 * @param {object} envelope - The mission envelope
 * @param {object} [verification] - Optional verification result
 * @returns {object} Structured result object (serializable to JSON)
 */
export function renderResultJson(envelope, verification = null) {
  return {
    id: envelope.id,
    type: envelope.type || 'M',
    status: envelope.status,
    title: envelope.title || null,
    project_id: envelope.project_id || null,
    created_at: envelope.created_at || null,
    completed_at: envelope.completed_at || null,
    accept_criteria: envelope.accept_criteria || null,
    output_chars: (envelope.output || '').length,
    output_preview: (envelope.output || '').substring(0, 500),
    artifact_status: envelope.context?.artifact_status || null,
    verification: verification ? {
      verdict: verification.verdict || null,
      summary: verification.summary || null,
    } : null,
    children_count: envelope.children?.length || 0,
    iteration: envelope.iteration || 0,
    stakes: envelope.stakes || null,
    job_to_be_done: envelope.job_to_be_done || null,
    kill_shot: envelope._brief?.kill_shot || null,
    assumptions: envelope._lastDecision?.assumptions || null,
    compaction: envelope._compaction ? {
      seq: envelope._compaction.seq || 0,
      covered: envelope._compaction.covered || null,
      durable_learnings: envelope._compaction.durable_learnings || [],
    } : null,
  };
}

/**
 * Write the mission record files into the mission's shared directory in the artifact working
 * tree. The effectful edge of this module. Idempotent: rewriting the same envelope produces
 * identical files. Never throws: a failed write is logged and reported, because a missing record
 * must not fail the mission it describes.
 *
 * @param {object} envelope - The mission envelope
 * @param {string} sharedDir - Absolute path to the mission's shared/<envelopeId>/ directory
 * @param {Function} [logFn] - Optional log function (level, message)
 * @returns {{ written: boolean, files: string[] }} paths relative to sharedDir
 */
export function writeMissionRecord(envelope, sharedDir, logFn) {
  const log = logFn || (() => {});

  if (!sharedDir || !existsSync(sharedDir)) {
    log('DEBUG', `writeMissionRecord: shared dir missing for ${envelope.id}, skipping`);
    return { written: false, files: [] };
  }

  const missionsDir = join(sharedDir, 'missions');
  const files = [];

  try {
    if (!existsSync(missionsDir)) {
      mkdirSync(missionsDir, { recursive: true });
    }

    writeFileSync(join(missionsDir, 'output.md'), renderMissionRecordBody(envelope), 'utf8');
    files.push('missions/output.md');

    writeFileSync(join(missionsDir, 'result.json'), JSON.stringify(renderResultJson(envelope), null, 2) + '\n', 'utf8');
    files.push('missions/result.json');

    log('INFO', `writeMissionRecord: wrote ${files.length} files for ${envelope.id}`);
    return { written: true, files };
  } catch (e) {
    log('WARN', `writeMissionRecord failed: ${e.message}`);
    return { written: false, files: [] };
  }
}
