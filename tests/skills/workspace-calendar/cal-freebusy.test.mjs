// Tests for skills/workspace-calendar/cal-freebusy.mjs: everyone's busy blocks in one query, 'me' as the
// agent's own calendar, the free time all share within working hours, and a person whose calendar
// cannot be read reported as unknown and left out of the free time, never counted as free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as calFreebusy from '../../../skills/workspace-calendar/cal-freebusy.mjs';
import { createCalendarClient } from '../../../agent/providers/workspace-calendar.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const google = () => fakeGoogle([
  ['POST', '/calendar/v3/freeBusy', () => json({
    calendars: {
      'agent@example.com': { busy: [{ start: '2026-10-23T14:00:00Z', end: '2026-10-23T15:00:00Z' }] },
      'pat@example.com': { busy: [{ start: '2026-10-23T18:00:00Z', end: '2026-10-23T20:00:00Z' }] },
      'lee@example.com': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
    },
  })],
]);
const calendarFor = (g) => createCalendarClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

test('busy blocks per person, and the free time the readable calendars share', async () => {
  const g = google();
  const r = await run(calFreebusy, ['me', 'pat@example.com,lee@example.com', '--from', '2026-10-23', '--days', '1', '--tz', 'America/Chicago', '--slots', '60'], { calendar: calendarFor(g) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(g.calls[0].json(), {
    timeMin: '2026-10-23T00:00:00-05:00', timeMax: '2026-10-24T00:00:00-05:00', timeZone: 'America/Chicago',
    items: [{ id: 'agent@example.com' }, { id: 'pat@example.com' }, { id: 'lee@example.com' }],
  });
  assert.equal(r.out, [
    'Busy times, Fri 2026-10-23 00:00 to Sat 2026-10-24 00:00 (America/Chicago):',
    'agent@example.com: 1 busy block',
    '  - Fri 2026-10-23 09:00-10:00',
    'pat@example.com: 1 busy block',
    '  - Fri 2026-10-23 13:00-15:00',
    "lee@example.com: unknown: agent@example.com cannot see this calendar's free/busy (notFound). Not the same as free.",
    'Free for all 2, at least 60 minutes, 09:00-17:00 on weekdays:',
    '  - Fri 2026-10-23 10:00-13:00',
    '  - Fri 2026-10-23 15:00-17:00',
    'These free times leave out lee@example.com, whose calendar could not be read.',
    '',
  ].join('\n'));
});

test('--json, and mistakes refused before any call', async () => {
  const g = google();
  const r = await run(calFreebusy, ['me', 'pat@example.com', 'lee@example.com', '--from', '2026-10-23', '--days', '1', '--tz', 'UTC', '--slots', '30', '--hours', '08:00-12:00', '--json'], { calendar: calendarFor(g) });
  const out = JSON.parse(r.out);
  assert.deepEqual(out.free_leaves_out, ['lee@example.com']);
  assert.deepEqual(out.people[2].unknown, ['notFound']);
  assert.ok(out.free.every((s) => s.start >= '2026-10-23T08:00:00+00:00'));
  const calls = g.calls.length;
  for (const argv of [[], ['not-an-email'], ['me', '--hours', '09:00-17:00'], ['me', '--slots', '30', '--hours', '17:00-09:00'], ['me', '--slots', '2']]) {
    const bad = await run(calFreebusy, argv, { calendar: calendarFor(g) });
    assert.equal(bad.code, 2, argv.join(' '));
  }
  assert.equal(g.calls.length, calls);
});
