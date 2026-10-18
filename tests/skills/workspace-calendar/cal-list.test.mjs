// Tests for skills/workspace-calendar/cal-list.mjs: the window (now and seven days by default, dates as
// the start of the day in the calendar's time zone), another person's calendar, the event lines, JSON,
// usage errors refused before any call, and an instance with no Workspace account. Google is a fake.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as calList from '../../../skills/workspace-calendar/cal-list.mjs';
import { createCalendarClient } from '../../../agent/providers/workspace-calendar.mjs';
import { INSTANCE, NO_WORKSPACE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-10-20T17:00:00Z'); // 12:00 in Chicago

const EVENTS = [
  {
    id: 'ev1', summary: 'Weekly sync', start: { dateTime: '2026-10-21T09:00:00-05:00' }, end: { dateTime: '2026-10-21T09:30:00-05:00' },
    organizer: { email: 'pat@example.com', displayName: 'Pat Example' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', location: 'Room 4',
    attendees: [
      { email: 'pat@example.com', organizer: true, responseStatus: 'accepted' },
      { email: 'agent@example.com', self: true, responseStatus: 'needsAction' },
    ],
  },
  { id: 'ev2', summary: 'Offsite', start: { date: '2026-10-23' }, end: { date: '2026-10-24' }, organizer: { email: 'agent@example.com', self: true } },
];

function google(events = EVENTS) {
  return fakeGoogle([
    ['GET', '/calendar/v3/calendars/primary', () => json({ id: 'agent@example.com', timeZone: TZ })],
    ['GET', /^\/calendar\/v3\/calendars\/[^/]+\/events$/, () => json({ items: events, timeZone: TZ })],
  ]);
}
const calendarFor = (g) => createCalendarClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('cal-list', () => {
  test('--help', async () => {
    const r = await run(calList, ['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^Usage: cal-list /);
  });

  test('by default: from now, seven days, in the calendar\'s own time zone', async () => {
    const g = google();
    const r = await run(calList, [], { calendar: calendarFor(g), now: () => NOW });
    assert.equal(r.code, 0, r.err);
    const list = g.calls.find((c) => c.path.endsWith('/events'));
    assert.equal(list.params.get('timeMin'), '2026-10-20T12:00:00-05:00');
    assert.equal(list.params.get('timeMax'), '2026-10-27T12:00:00-05:00');
    assert.equal(list.params.get('singleEvents'), 'true');
    assert.equal(r.out, [
      'Events on your calendar (agent@example.com), Tue 2026-10-20 12:00 to Tue 2026-10-27 12:00 (America/Chicago):',
      '1. Wed 2026-10-21 09:00-09:30 | Weekly sync | id ev1',
      '   organizer Pat Example <pat@example.com> | 2 attendees (1 yes, 1 no answer) | your answer: no answer | Meet https://meet.google.com/abc-defg-hij | at Room 4',
      '2. Fri 2026-10-23, all day | Offsite | id ev2',
      '   organizer you',
      '',
    ].join('\n'));
  });

  test('a day in another zone, on another person\'s calendar, with words to find', async () => {
    const g = google([]);
    const r = await run(calList, ['--from', '2026-10-21', '--days', '1', '--tz', 'Europe/Paris', '--calendar', 'pat@example.com', '--search', 'sync'], { calendar: calendarFor(g), now: () => NOW });
    assert.equal(r.code, 0, r.err);
    assert.equal(g.calls.length, 1, 'with --tz the calendar\'s own zone is not read');
    assert.equal(g.calls[0].path, '/calendar/v3/calendars/pat%40example.com/events');
    assert.equal(g.calls[0].params.get('timeMin'), '2026-10-21T00:00:00+02:00');
    assert.equal(g.calls[0].params.get('timeMax'), '2026-10-22T00:00:00+02:00');
    assert.equal(g.calls[0].params.get('q'), 'sync');
    assert.match(r.out, /^Events on calendar pat@example\.com matching "sync", Wed 2026-10-21 00:00 to Thu 2026-10-22 00:00 \(Europe\/Paris\):\nNo events\.\n$/);
  });

  test('--json carries every event\'s fields', async () => {
    const r = await run(calList, ['--json', '--to', '2026-10-25'], { calendar: calendarFor(google()), now: () => NOW });
    const out = JSON.parse(r.out);
    assert.equal(out.calendar, 'agent@example.com');
    assert.equal(out.to, '2026-10-25T00:00:00-05:00');
    assert.deepEqual(out.events[0].attendees.map((a) => [a.email, a.response]), [['pat@example.com', 'yes'], ['agent@example.com', 'no answer']]);
    assert.equal(out.events[1].all_day, true);
    assert.equal(out.events[0].meet, 'https://meet.google.com/abc-defg-hij');
  });

  test('mistakes are refused before any call', async () => {
    const g = google();
    for (const argv of [['--to', '2026-10-21', '--days', '2'], ['--tz', 'Mars/Base'], ['--from', 'tomorrow'], ['--days', '0'], ['--limit', '900'], ['extra']]) {
      const r = await run(calList, argv, { calendar: calendarFor(g), now: () => NOW });
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /^cal-list: /);
    }
    const backwards = await run(calList, ['--from', '2026-10-22', '--to', '2026-10-21', '--tz', TZ], { calendar: calendarFor(g), now: () => NOW });
    assert.equal(backwards.code, 2);
    assert.match(backwards.err, /ends .* before it starts/);
    assert.equal(g.calls.length, 0);
  });

  test('an instance without a Workspace account says so', async () => {
    const r = await run(calList, [], { runtime: { instance: NO_WORKSPACE, getAccessToken: async () => 'vm', fetch: () => assert.fail('no call') } });
    assert.equal(r.code, 1);
    assert.match(r.err, /^cal-list: This instance has no Workspace account/);
  });
});
