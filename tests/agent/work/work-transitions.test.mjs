// Tests for agent/work/work-transitions.mjs. Property tests rather than examples: the table is small
// enough to enumerate completely, so every legal move and every illegal one is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGAL_TRANSITIONS, TERMINAL_STATUSES, PAUSED_STATUSES, RUNNING_STATUSES, ENVELOPE_STATUSES,
  TRANSITION_REQUIREMENTS,
  canTransition, applyTransition, reachableFrom, isTerminal,
} from '../../../agent/work/work-transitions.mjs';
import { WORK_SCHEMA } from '../../../agent/work/work-schema.mjs';
import { validate } from '../../../agent/work/validate-schema.mjs';

const AT = '2026-08-15T12:00:00Z';
const LATER = '2026-08-15T12:05:00Z';

const env = (over = {}) => ({
  id: 'w-1', type: 'T', parent_id: 'c-1', status: 'pending',
  intent: 'do', instruction: 'do the thing', accept_criteria: 'the thing is done',
  source_channel: 'chat', created_at: AT, updated_at: AT, iteration: 0, ...over,
});

// ── Table integrity ────────────────────────────────────────────────────

test('the table covers exactly the declared statuses', () => {
  assert.deepEqual(Object.keys(LEGAL_TRANSITIONS).sort(), [...ENVELOPE_STATUSES].sort());
});

test('every target in the table is a declared status', () => {
  for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(ENVELOPE_STATUSES.includes(to), `${from} → ${to} names an undeclared status`);
    }
    assert.equal(new Set(targets).size, targets.length, `${from} lists a duplicate target`);
    assert.ok(!targets.includes(from), `${from} lists itself as a target`);
  }
});

test('every status except the intake state is reachable', () => {
  const reachable = new Set(reachableFrom('pending'));
  for (const s of ENVELOPE_STATUSES) {
    if (s === 'pending') continue;
    assert.ok(reachable.has(s), `${s} is unreachable from intake: a dead status`);
  }
});

test('terminal statuses lead only to archived, and archived leads nowhere', () => {
  for (const s of TERMINAL_STATUSES) {
    if (s === 'archived') {
      assert.deepEqual(LEGAL_TRANSITIONS[s], []);
      assert.equal(isTerminal(s), true);
      continue;
    }
    assert.deepEqual(LEGAL_TRANSITIONS[s], ['archived'], `${s} must lead only to archived`);
  }
});

test('no cycle can run without passing through active', () => {
  // The only cycles allowed are pause → active → pause. Anything else would let an envelope churn
  // without ever consuming an iteration.
  for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
    if (from === 'active' || RUNNING_STATUSES.includes(from)) continue;
    for (const to of targets) {
      if (to === 'active') continue;
      const back = LEGAL_TRANSITIONS[to] || [];
      assert.ok(!back.includes(from), `${from} ⇄ ${to} is a cycle that never passes through execution`);
    }
  }
});

test('every pause resumes to active', () => {
  for (const s of PAUSED_STATUSES) {
    assert.ok(LEGAL_TRANSITIONS[s].includes('active'), `${s} must be resumable`);
  }
});

test('rejection is reachable only from a decision point', () => {
  const sources = Object.entries(LEGAL_TRANSITIONS)
    .filter(([, t]) => t.includes('rejected'))
    .map(([f]) => f)
    .sort();
  assert.deepEqual(sources, ['awaiting_approval', 'needs_review'],
    'only an approval or a review can reject: nothing else has a decider');
});

// ── Exhaustive legality ────────────────────────────────────────────────

test('every from×to pair agrees with the table', () => {
  let legal = 0;
  let illegal = 0;
  for (const from of ENVELOPE_STATUSES) {
    for (const to of ENVELOPE_STATUSES) {
      const { allowed } = canTransition(from, to);
      if (from === to) { assert.equal(allowed, true, `${from} → ${to} (no-op)`); continue; }
      const expected = LEGAL_TRANSITIONS[from].includes(to);
      assert.equal(allowed, expected, `${from} → ${to}`);
      if (expected) legal++; else illegal++;
    }
  }
  assert.ok(legal > 30, 'the machine has real breadth');
  assert.ok(illegal > 150, 'and most pairs are correctly refused');
});

test('an undeclared status is refused in either position', () => {
  assert.equal(canTransition('nonsense', 'active').allowed, false);
  assert.equal(canTransition('active', 'nonsense').allowed, false);
  assert.match(canTransition('active', 'nonsense').reason, /not a declared status/);
});

test('reopening a terminal envelope is refused with the reason that matters', () => {
  for (const s of ['complete', 'failed', 'rejected', 'timed_out', 'cancelled']) {
    const { allowed, reason } = canTransition(s, 'active');
    assert.equal(allowed, false, `${s} → active must be refused`);
    assert.match(reason, /terminal/, `${s}: ${reason}`);
    assert.match(reason, /describe work it did not produce/, 'the reason says why it matters');
  }
});

test('the table refuses and allows the moves a guard relies on', () => {
  for (const [from, to] of [['complete', 'active'], ['archived', 'active'], ['failed', 'complete']]) {
    assert.equal(canTransition(from, to).allowed, false, `${from} → ${to} must be refused`);
  }
  for (const [from, to] of [['pending', 'active'], ['active', 'complete'], ['complete', 'archived']]) {
    assert.equal(canTransition(from, to).allowed, true, `${from} → ${to} must be allowed`);
  }
});

// ── The reducer ────────────────────────────────────────────────────────

test('applyTransition never mutates its input', () => {
  const before = env({ status: 'pending' });
  const snapshot = JSON.stringify(before);
  applyTransition(before, { to: 'active', at: LATER });
  assert.equal(JSON.stringify(before), snapshot);
});

test('a transition must carry its timestamp', () => {
  const r = applyTransition(env(), { to: 'active' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must carry its timestamp/);
});

test('first activation stamps started_at; a resume counts an iteration', () => {
  const started = applyTransition(env({ status: 'pending' }), { to: 'active', at: LATER });
  assert.equal(started.envelope.started_at, LATER);
  assert.equal(started.envelope.iteration, 0, 'starting is not an iteration');

  const paused = applyTransition(started.envelope, { to: 'needs_input', at: LATER });
  const resumed = applyTransition(paused.envelope, { to: 'active', at: LATER });
  assert.equal(resumed.envelope.started_at, LATER, 'start time is not rewritten');
  assert.equal(resumed.envelope.iteration, 1, 'resuming from a pause is an iteration');
});

test('resuming clears the pause reason so a stale blocker cannot outlive it', () => {
  const blocked = applyTransition(env({ status: 'active', started_at: AT }), {
    to: 'blocked', at: LATER, blocker: 'waiting on a credential', blockerType: 'access',
  });
  assert.equal(blocked.envelope.blocker, 'waiting on a credential');
  assert.equal(blocked.envelope.blocked_at, LATER);

  const resumed = applyTransition(blocked.envelope, { to: 'active', at: LATER });
  assert.equal(resumed.envelope.blocker, null);
  assert.equal(resumed.envelope.blocker_type, null);
  assert.equal(resumed.envelope.blocked_at, null);
});

test('every ending stamps completed_at, the field no caller can now forget', () => {
  for (const to of ['complete', 'failed', 'rejected', 'timed_out', 'cancelled']) {
    const from = to === 'rejected' ? 'awaiting_approval' : 'active';
    const r = applyTransition(env({ status: from, started_at: AT }), { to, at: LATER });
    assert.equal(r.ok, true, `${from} → ${to}: ${r.reason}`);
    assert.equal(r.envelope.completed_at, LATER, `${to} must stamp completed_at`);
  }
});

test('a completed envelope produced by the reducer satisfies the work schema', () => {
  const active = applyTransition(env({ status: 'pending' }), { to: 'active', at: AT }).envelope;
  const done = applyTransition(active, { to: 'complete', at: LATER, output: 'the thing' }).envelope;
  const { valid, errors } = validate(WORK_SCHEMA, done);
  assert.equal(valid, true, JSON.stringify(errors));
  assert.equal(done.output, 'the thing');
});

test('a failure always carries an error, even when the caller supplies none', () => {
  const r = applyTransition(env({ status: 'active', started_at: AT }), { to: 'failed', at: LATER });
  assert.equal(r.envelope.error, 'envelope failed', 'failure is never silent');
  assert.equal(validate(WORK_SCHEMA, r.envelope).valid, true);
});

test('a block always carries a blocker', () => {
  const r = applyTransition(env({ status: 'active', started_at: AT }), { to: 'blocked', at: LATER });
  assert.equal(r.envelope.blocker, 'unspecified blocker');
  assert.equal(r.envelope.blocked_at, LATER);
});

test('a wait records how it resumes', () => {
  const r = applyTransition(env({ status: 'active', started_at: AT }), {
    to: 'waiting', at: LATER, resumeAt: '2026-08-15T13:00:00Z', resumeInstruction: 'check the build',
  });
  assert.equal(r.envelope.wait_resume_at, '2026-08-15T13:00:00Z');
  assert.equal(r.envelope.resume_instruction, 'check the build');
});

test('a wait with no resume time is refused: nothing would end it', () => {
  // Fixed defect: TRANSITION_REQUIREMENTS declares that a wait needs wait_resume_at, but the
  // reducer accepted a wait without one and stored null.
  const active = env({ status: 'active', started_at: AT });
  const r = applyTransition(active, { to: 'waiting', at: LATER });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(r.envelope, active, 'a refused move changes nothing');
  assert.match(r.reason, /'waiting' requires wait_resume_at/);
  assert.match(r.reason, /resumeAt/);
});

test('re-asserting the same status is a permitted no-op, not a change', () => {
  const active = env({ status: 'active', started_at: AT, iteration: 3 });
  const r = applyTransition(active, { to: 'active', at: LATER });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.envelope.iteration, 3, 'a no-op does not count an iteration');
  assert.equal(r.envelope, active, 'the identical object comes back');
});

test('an illegal transition returns the envelope untouched', () => {
  const done = env({ status: 'complete', completed_at: AT, started_at: AT });
  const r = applyTransition(done, { to: 'active', at: LATER });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(r.envelope.status, 'complete', 'a refused move changes nothing');
});

test('every declared requirement is satisfied by the reducer', () => {
  for (const [to, fields] of Object.entries(TRANSITION_REQUIREMENTS)) {
    const from = to === 'rejected' ? 'awaiting_approval' : 'active';
    const r = applyTransition(env({ status: from, started_at: AT }), {
      to, at: LATER, resumeAt: LATER,
    });
    assert.equal(r.ok, true, `${from} → ${to}`);
    for (const f of fields) {
      assert.notEqual(r.envelope[f], undefined, `${to} must set ${f}`);
      assert.notEqual(r.envelope[f], null, `${to} must set ${f}`);
    }
  }
});

test('a full lifecycle walks pending → active → pause → active → complete → archived', () => {
  let e = env({ status: 'pending' });
  for (const step of [
    { to: 'active', at: AT },
    { to: 'awaiting_approval', at: AT },
    { to: 'active', at: LATER },
    { to: 'complete', at: LATER, output: 'done' },
    { to: 'archived', at: LATER },
  ]) {
    const r = applyTransition(e, step);
    assert.equal(r.ok, true, `${e.status} → ${step.to}: ${r.reason}`);
    e = r.envelope;
  }
  assert.equal(e.status, 'archived');
  assert.equal(e.iteration, 1, 'one resume from the approval pause');
  assert.equal(e.completed_at, LATER);
});
