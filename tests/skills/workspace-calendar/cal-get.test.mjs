// Tests for skills/workspace-calendar/cal-get.mjs: one event whole, in a time zone, with every attendee's
// answer, the Meet link and the description (HTML turned into text); and a wrong id. Google is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as calGet from '../../../skills/workspace-calendar/cal-get.mjs';
import { createCalendarClient } from '../../../agent/providers/workspace-calendar.mjs';
import { INSTANCE, json, googleError, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const EVENT = {
  id: 'ev1', summary: 'Budget review', status: 'confirmed', htmlLink: 'https://www.google.com/calendar/event?eid=ev1',
  start: { dateTime: '2026-10-21T14:00:00Z' }, end: { dateTime: '2026-10-21T15:00:00Z' }, location: 'Room 4',
  organizer: { email: 'agent@example.com', self: true }, recurringEventId: 'base1',
  description: '<p>Agenda:</p><ul><li>Q3 numbers</li></ul>',
  conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
  attendees: [
    { email: 'agent@example.com', self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'pat@example.com', displayName: 'Pat Example', responseStatus: 'tentative', optional: true },
    { email: 'room@example.com', resource: true, responseStatus: 'accepted' },
  ],
};

const google = () => fakeGoogle([
  ['GET', '/calendar/v3/calendars/primary/events/ev1', () => json(EVENT)],
  ['GET', /\/events\/nope$/, () => googleError(404, 'notFound', 'Not Found')],
]);
const calendarFor = (g) => createCalendarClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

test('cal-get prints the event whole, in the zone asked for', async () => {
  const g = google();
  const r = await run(calGet, ['ev1', '--tz', 'America/New_York'], { calendar: calendarFor(g) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    'Budget review',
    'When: Wed 2026-10-21 10:00-11:00 (America/New_York)',
    'Where: Room 4',
    'Organizer: you (agent@example.com)',
    'Attendees (2):',
    '- agent@example.com (you) (organizer): yes',
    '- Pat Example <pat@example.com>: maybe, optional',
    'Meet: https://meet.google.com/abc-defg-hij',
    'Repeats: yes (this is one occurrence)',
    'id: ev1',
    'link: https://www.google.com/calendar/event?eid=ev1',
    'Description:',
    'Agenda:\n\n- Q3 numbers',
    '',
  ].join('\n'));
  assert.equal(g.calls.length, 1);
});

test('cal-get --json, and a wrong id', async () => {
  const g = google();
  const r = await run(calGet, ['ev1', '--json', '--tz', 'UTC'], { calendar: calendarFor(g) });
  assert.equal(JSON.parse(r.out).description, EVENT.description);
  const missing = await run(calGet, ['nope', '--tz', 'UTC'], { calendar: calendarFor(g) });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^cal-get: Google Calendar has no event nope on your calendar .*List the events \(cal-list\) to find its id\./);
  assert.equal((await run(calGet, [], { calendar: calendarFor(g) })).code, 2);
  assert.equal((await run(calGet, ['--help'])).code, 0);
});
