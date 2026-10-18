// Tests for skills/workspace-calendar/cal-create.mjs: a timed event (30 minutes unless told), an all-day
// one (--end is its last day), invitations only for the people named (and then Google emails them), a
// Meet link, the overlap note, and the start and end arithmetic it shares with cal-update.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as calCreate from '../../../skills/workspace-calendar/cal-create.mjs';
import { createCalendarClient } from '../../../agent/providers/workspace-calendar.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const TZ = 'America/Chicago';
const EXISTING = { id: 'busy1', summary: 'Standup', start: { dateTime: '2026-10-21T09:15:00-05:00' }, end: { dateTime: '2026-10-21T09:30:00-05:00' } };

function google(existing = []) {
  return fakeGoogle([
    ['GET', '/calendar/v3/calendars/primary/events', () => json({ items: existing, timeZone: TZ })],
    ['POST', '/calendar/v3/calendars/primary/events', (call) => json({
      id: 'new1', htmlLink: 'https://www.google.com/calendar/event?eid=new1', organizer: { self: true, email: 'agent@example.com' }, ...call.json(),
      ...(call.json().conferenceData ? { hangoutLink: 'https://meet.google.com/new-meet-link' } : {}),
    })],
  ]);
}
const calendarFor = (g) => createCalendarClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('cal-create', () => {
  test('a timed event: 30 minutes by default, nobody told, overlaps named', async () => {
    const g = google([EXISTING, { ...EXISTING, id: 'gone', status: 'cancelled' }]);
    const r = await run(calCreate, ['--title', 'Focus time', '--start', '2026-10-21T09:00', '--tz', TZ, '--description', 'Prep the review'], { calendar: calendarFor(g) });
    assert.equal(r.code, 0, r.err);
    const check = g.calls[0];
    assert.equal(check.params.get('timeMin'), '2026-10-21T09:00:00-05:00');
    assert.equal(check.params.get('timeMax'), '2026-10-21T09:30:00-05:00');
    const post = g.calls[1];
    assert.equal(post.params.get('sendUpdates'), 'none');
    assert.deepEqual(post.json(), {
      summary: 'Focus time', start: { dateTime: '2026-10-21T09:00:00-05:00', timeZone: TZ }, end: { dateTime: '2026-10-21T09:30:00-05:00', timeZone: TZ },
      description: 'Prep the review',
    });
    assert.equal(r.out, [
      'Created "Focus time" on your calendar (agent@example.com): Wed 2026-10-21 09:00-09:30 (America/Chicago)',
      'id: new1',
      'link: https://www.google.com/calendar/event?eid=new1',
      'Nobody was invited or told.',
      'Overlaps: "Standup" Wed 2026-10-21 09:15-09:30 (id busy1)',
      '',
    ].join('\n'));
  });

  test('named people are invited and emailed; a Meet link is added', async () => {
    const g = google();
    const r = await run(calCreate, ['--title', 'Budget review', '--start', '2026-10-21T14:00:00Z', '--minutes', '45', '--tz', TZ, '--invite', 'pat@example.com, lee@example.com', '--invite', 'pat@example.com', '--meet'], { calendar: calendarFor(g) });
    assert.equal(r.code, 0, r.err);
    const post = g.calls[1];
    assert.equal(post.params.get('sendUpdates'), 'all');
    assert.equal(post.params.get('conferenceDataVersion'), '1');
    assert.deepEqual(post.json().attendees, [{ email: 'pat@example.com' }, { email: 'lee@example.com' }]);
    assert.equal(post.json().end.dateTime, '2026-10-21T09:45:00-05:00');
    assert.match(r.out, /Invited, and emailed by Google: pat@example\.com, lee@example\.com\nMeet: https:\/\/meet\.google\.com\/new-meet-link/);
  });

  test('an all-day event runs through its last day', async () => {
    const g = google();
    const r = await run(calCreate, ['--title', 'Offsite', '--start', '2026-10-23', '--end', '2026-10-24', '--tz', TZ, '--json'], { calendar: calendarFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([g.calls[1].json().start, g.calls[1].json().end], [{ date: '2026-10-23' }, { date: '2026-10-25' }]);
    assert.equal(JSON.parse(r.out).all_day, true);
  });

  test('mistakes are refused before anything is created', async () => {
    const g = google();
    for (const argv of [
      ['--start', '2026-10-21T09:00'], ['--title', 'x'], ['--title', 'x', '--start', '2026-10-21T09:00', '--end', '2026-10-21T10:00', '--minutes', '30'],
      ['--title', 'x', '--start', '2026-10-21T09:00', '--invite', 'pat'], ['--title', 'x', '--start', '2026-10-23', '--minutes', '30', '--tz', TZ],
      ['--title', 'x', '--start', '2026-10-21T09:00', '--end', '2026-10-21T08:00', '--tz', TZ], ['--title', 'x', '--start', '2026-10-21T09:00', '--end', '2026-10-22', '--tz', TZ],
    ]) {
      const r = await run(calCreate, argv, { calendar: calendarFor(g) });
      assert.equal(r.code, 2, argv.join(' '));
    }
    assert.equal(g.calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('eventTimes on its own', () => {
    assert.deepEqual(calCreate.eventTimes({ start: '2026-10-23' }, TZ), { start: { date: '2026-10-23' }, end: { date: '2026-10-24' }, allDay: true });
    assert.equal(calCreate.eventTimes({ start: '2026-10-21T09:00' }, TZ, 90).end.dateTime, '2026-10-21T10:30:00-05:00');
    assert.throws(() => calCreate.eventTimes({ start: '2026-10-23', end: '2026-10-22' }, TZ), /before the first/);
  });
});
