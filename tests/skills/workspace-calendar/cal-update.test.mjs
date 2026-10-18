// Tests for skills/workspace-calendar/cal-update.mjs: a new start keeps the event's length, people are
// invited and removed (and only then, or with --notify, told), an event someone else organizes is
// refused before anything is sent, and an all-day event moves by whole days.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as calUpdate from '../../../skills/workspace-calendar/cal-update.mjs';
import { createCalendarClient } from '../../../agent/providers/workspace-calendar.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const TZ = 'America/Chicago';
const MINE = {
  id: 'ev1', summary: 'Sync', organizer: { email: 'agent@example.com', self: true },
  start: { dateTime: '2026-10-21T09:00:00-05:00' }, end: { dateTime: '2026-10-21T09:45:00-05:00' },
  attendees: [{ email: 'agent@example.com', self: true, organizer: true, responseStatus: 'accepted' }, { email: 'lee@example.com', responseStatus: 'declined' }],
};
const ALL_DAY = { id: 'ev2', summary: 'Offsite', organizer: { self: true }, start: { date: '2026-10-23' }, end: { date: '2026-10-25' } };
const THEIRS = { ...MINE, id: 'ev3', organizer: { email: 'pat@example.com', displayName: 'Pat Example' } };

function google() {
  const events = { ev1: MINE, ev2: ALL_DAY, ev3: THEIRS };
  return fakeGoogle([
    ['GET', /^\/calendar\/v3\/calendars\/primary\/events\/(ev\d)$/, (call, m) => json(events[m[1]])],
    ['GET', '/calendar/v3/calendars/primary/events', () => json({ items: [], timeZone: TZ })],
    ['PATCH', /^\/calendar\/v3\/calendars\/primary\/events\/(ev\d)$/, (call, m) => json({ ...events[m[1]], ...call.json() })],
  ]);
}
const calendarFor = (g) => createCalendarClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });
const patches = (g) => g.calls.filter((c) => c.method === 'PATCH');

describe('cal-update', () => {
  test('a new start keeps the length; nobody is told', async () => {
    const g = google();
    const r = await run(calUpdate, ['ev1', '--start', '2026-10-21T11:00', '--tz', TZ], { calendar: calendarFor(g) });
    assert.equal(r.code, 0, r.err);
    const [patch] = patches(g);
    assert.equal(patch.params.get('sendUpdates'), 'none');
    assert.deepEqual(patch.json(), { start: { dateTime: '2026-10-21T11:00:00-05:00', timeZone: TZ }, end: { dateTime: '2026-10-21T11:45:00-05:00', timeZone: TZ } });
    assert.equal(r.out, [
      'Changed the time of "Sync" on your calendar: Wed 2026-10-21 11:00-11:45 (America/Chicago)',
      'id: ev1',
      'Nobody was told of this change.',
      '',
    ].join('\n'));
  });

  test('inviting and removing tells those people; --notify tells everyone', async () => {
    const g = google();
    const r = await run(calUpdate, ['ev1', '--invite', 'sam@example.com', '--uninvite', 'lee@example.com,nobody@example.com', '--tz', TZ], { calendar: calendarFor(g) });
    assert.equal(r.code, 0, r.err);
    const [patch] = patches(g);
    assert.equal(patch.params.get('sendUpdates'), 'all');
    assert.deepEqual(patch.json(), { attendees: [MINE.attendees[0], { email: 'sam@example.com' }] });
    assert.match(r.out, /Invited, and emailed by Google: sam@example\.com\nRemoved, and told by Google: lee@example\.com\nNot on the list, so not removed: nobody@example\.com\nGoogle emailed the attendees about this change\./);
    const g2 = google();
    await run(calUpdate, ['ev1', '--location', 'Room 9', '--notify', '--tz', TZ], { calendar: calendarFor(g2) });
    assert.equal(patches(g2)[0].params.get('sendUpdates'), 'all');
  });

  test('an all-day event moved by date keeps its number of days', async () => {
    const g = google();
    const r = await run(calUpdate, ['ev2', '--start', '2026-10-30', '--tz', TZ], { calendar: calendarFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(patches(g)[0].json(), { start: { date: '2026-10-30' }, end: { date: '2026-11-01' } });
  });

  test("someone else's event is refused, and nothing is sent", async () => {
    const g = google();
    const r = await run(calUpdate, ['ev3', '--title', 'Renamed', '--tz', TZ], { calendar: calendarFor(g) });
    assert.equal(r.code, 1);
    assert.match(r.err, /^cal-update: "Sync" is organized by Pat Example <pat@example\.com>, not by agent@example\.com: only its organizer may change it\./);
    assert.equal(patches(g).length, 0);
  });

  test('mistakes are refused before any call', async () => {
    const g = google();
    for (const argv of [['ev1'], [], ['ev1', '--invite', 'x@example.com', '--uninvite', 'x@example.com'], ['ev1', '--end', '2026-10-21T10:00', '--minutes', '30'], ['ev1', '--title', ' ']]) {
      assert.equal((await run(calUpdate, argv, { calendar: calendarFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
  });
});
