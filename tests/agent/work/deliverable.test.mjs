// Tests for agent/work/deliverable.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeDeliverable,
  composeFallbackSummary,
  isEmptyDeliverable,
  stripArtifactFooter,
} from '../../../agent/work/deliverable.mjs';

const ARTIFACT_LINE = '\n\n📎 Artifacts: repo@main a1b2c3d4 — 5 file(s)';

describe('stripArtifactFooter', () => {
  it('removes the artifact footer', () => {
    assert.equal(stripArtifactFooter('Real summary.' + ARTIFACT_LINE), 'Real summary.');
  });
  it('leaves footer-free text untouched', () => {
    assert.equal(stripArtifactFooter('Just a summary.'), 'Just a summary.');
  });
  it('reduces an artifact-only body to empty', () => {
    assert.equal(stripArtifactFooter(ARTIFACT_LINE), '');
  });
  it('handles null and undefined', () => {
    assert.equal(stripArtifactFooter(null), '');
    assert.equal(stripArtifactFooter(undefined), '');
  });
});

describe('isEmptyDeliverable', () => {
  it('is true for empty, whitespace, and artifact-only bodies', () => {
    assert.ok(isEmptyDeliverable(''));
    assert.ok(isEmptyDeliverable('   \n  '));
    assert.ok(isEmptyDeliverable(ARTIFACT_LINE));
  });
  it('is false for a real summary', () => {
    assert.ok(!isEmptyDeliverable('The deployment completed successfully on us-central1.'));
  });
});

describe('composeFallbackSummary', () => {
  it('never returns empty, even with a bare envelope', () => {
    assert.ok(composeFallbackSummary({ status: 'complete' }).length > 0);
  });

  it('leads with an outcome headline scaled to status', () => {
    assert.match(composeFallbackSummary({ status: 'blocked', title: 'Investigate the work history' }), /^Blocked:/);
    assert.match(composeFallbackSummary({ status: 'failed', title: 'x' }), /^Could not complete:/);
    assert.match(composeFallbackSummary({ status: 'timed_out', title: 'x' }), /^Timed_out:/, 'an unlisted status still leads');
  });

  it('surfaces the blocker', () => {
    const out = composeFallbackSummary({ status: 'blocked', blocker: 'the brain is crash-looping (missing module)' });
    assert.match(out, /crash-looping/);
  });

  it('distills findings from prior results, marking success and failure', () => {
    const out = composeFallbackSummary(
      { status: 'failed', title: 'Assess the account' },
      { priorResults: [
        { agent: 'motor', success: false, result: 'gcloud logging read returned no output' },
        { agent: 'system', result: 'ignored' },
        { agent: 'temporal-memory', success: true, result: 'No prior work found for the account' },
      ] },
    );
    assert.match(out, /✗ motor/);
    assert.match(out, /✓ temporal-memory/);
    assert.ok(!out.includes('ignored'), 'system entries are excluded');
  });

  it('falls back to the goal when no work produced findings, and says it was composed', () => {
    const out = composeFallbackSummary({ status: 'complete', accept_criteria: 'A report exists. More detail.' });
    assert.match(out, /Goal: A report exists\./);
    assert.match(out, /composed from mission state/);
  });
});

describe('composeDeliverable', () => {
  it('uses a real synthesis verbatim (composed=false)', () => {
    const synthesis = 'Deployed the analytics service; smoke tests green.';
    const { body, composed } = composeDeliverable({ status: 'complete' }, { synthesis });
    assert.equal(composed, false);
    assert.equal(body, synthesis);
  });

  it('composes a floor summary when synthesis is empty (composed=true)', () => {
    const { body, composed } = composeDeliverable(
      { status: 'blocked', title: 'Investigate the outage', blocker: 'brain dead' },
      { synthesis: '', priorResults: [{ agent: 'motor', success: false, result: 'no data' }] },
    );
    assert.equal(composed, true);
    assert.ok(body.length > 0);
    assert.match(body, /Blocked:/);
  });

  it('treats an artifact-only synthesis as empty and composes a summary', () => {
    const { body, composed } = composeDeliverable({ status: 'complete', title: 'x' }, { synthesis: ARTIFACT_LINE });
    assert.equal(composed, true);
    assert.ok(stripArtifactFooter(body).length > 0, 'the body has a real summary, not just the footer');
  });

  it('places the artifact footer under the summary, never as the whole body', () => {
    const footer = '📎 Artifacts: repo@main abc — 2 file(s)';
    const { body } = composeDeliverable({ status: 'complete' }, { synthesis: 'All done.', artifactFooter: footer });
    assert.ok(body.startsWith('All done.'), 'summary leads');
    assert.ok(body.endsWith(footer), 'artifacts follow');
  });

  it('respects a custom minChars threshold', () => {
    const short = 'ok';
    const loose = composeDeliverable({ status: 'complete' }, { synthesis: short, minChars: 1 });
    assert.equal(loose.composed, false, 'a short synthesis passes a low threshold');
    const strict = composeDeliverable({ status: 'complete' }, { synthesis: short, minChars: 40 });
    assert.equal(strict.composed, true, 'a short synthesis fails a high threshold');
  });
});
