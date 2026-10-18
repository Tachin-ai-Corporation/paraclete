// Tests for agent/providers/workspace-calendar.mjs: the time arithmetic (dates and times read in a
// zone, daylight-saving edges, RFC 3339 out, how events are described, shared free time), and the
// Calendar calls: exact URLs and bodies, invitations sent only when people are named, changes only to
// events the agent organizes, attendees' answers never touched. Google is a fake fetch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarClient, parseInstant, formatRfc3339, eventTime, describeWhen, describeAttendees, freeSlots, addDays,
  isTimeZone, zoneOffsetMinutes, meetLink, isDate,
} from '../../../agent/providers/workspace-calendar.mjs';
import { INSTANCE, json, googleError, fakeTokens, fakeGoogle } from './workspace-fakes.mjs';

const TZ = 'America/Chicago';
const BASE = 'https://www.googleapis.com/calendar/v3';
const client = (google) => createCalendarClient({ instance: INSTANCE, fetch: google.fetch, getDwdToken: fakeTokens() });

describe('time', () => {
  test('dates and times are read in the zone; an offset or Z wins over it', () => {
    assert.equal(formatRfc3339(parseInstant('2026-10-20T15:00', TZ), TZ), '2026-10-20T15:00:00-05:00');
    assert.equal(formatRfc3339(parseInstant('2026-10-20 15:00:30', TZ), TZ), '2026-10-20T15:00:30-05:00');
    assert.equal(formatRfc3339(parseInstant('2026-11-02', TZ), TZ), '2026-11-02T00:00:00-06:00', 'a date is the start of that day');
    assert.equal(new Date(parseInstant('2026-10-20T15:00:00Z', TZ)).toISOString(), '2026-10-20T15:00:00.000Z');
    assert.equal(new Date(parseInstant('2026-10-20T15:00+05:30', TZ)).toISOString(), '2026-10-20T09:30:00.000Z');
    assert.equal(formatRfc3339(parseInstant('2026-10-20T15:00', 'Asia/Kolkata'), 'Asia/Kolkata'), '2026-10-20T15:00:00+05:30');
  });

  test('a time skipped by the clocks moving forward reads past the jump; a repeated one is the first', () => {
    assert.equal(formatRfc3339(parseInstant('2026-03-08T02:30', TZ), TZ), '2026-03-08T03:30:00-05:00');
    assert.equal(formatRfc3339(parseInstant('2026-11-01T01:30', TZ), TZ), '2026-11-01T01:30:00-05:00');
    assert.equal(zoneOffsetMinutes(Date.parse('2026-07-01T00:00:00Z'), TZ), -300);
    assert.equal(zoneOffsetMinutes(Date.parse('2026-01-01T00:00:00Z'), TZ), -360);
  });

  test('nonsense is refused, naming the forms that work', () => {
    for (const bad of ['tomorrow', '2026-13-01T10:00', '2026-10-20T25:00', '']) {
      assert.throws(() => parseInstant(bad, TZ), /is not a (date or time|real date)/);
    }
    assert.equal(isTimeZone('America/Chicago'), true);
    assert.equal(isTimeZone('Mars/Olympus'), false);
    assert.equal(isDate('2026-10-20'), true);
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  test('an event time: a date stays all-day, anything else a dateTime with offset and zone', () => {
    assert.deepEqual(eventTime('2026-10-20', TZ), { date: '2026-10-20' });
    assert.deepEqual(eventTime('2026-10-20T09:00', TZ), { dateTime: '2026-10-20T09:00:00-05:00', timeZone: TZ });
    assert.deepEqual(eventTime('2026-10-20T14:00:00Z', TZ), { dateTime: '2026-10-20T09:00:00-05:00', timeZone: TZ });
  });

  test('events are described in the zone', () => {
    const ev = (s, e) => ({ start: { dateTime: s }, end: { dateTime: e } });
    assert.equal(describeWhen(ev('2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z'), TZ), 'Tue 2026-10-20 09:00-09:30');
    assert.equal(describeWhen(ev('2026-10-21T03:00:00Z', '2026-10-21T06:00:00Z'), TZ), 'Tue 2026-10-20 22:00 to Wed 2026-10-21 01:00');
    assert.equal(describeWhen({ start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }, TZ), 'Tue 2026-10-20, all day');
    assert.equal(describeWhen({ start: { date: '2026-10-20' }, end: { date: '2026-10-23' } }, TZ), 'Tue 2026-10-20 to Thu 2026-10-22, all day');
    assert.equal(describeAttendees([
      { email: 'a@example.com', responseStatus: 'accepted' }, { email: 'b@example.com', responseStatus: 'accepted' },
      { email: 'c@example.com', responseStatus: 'declined' }, { email: 'd@example.com', responseStatus: 'needsAction' },
      { email: 'room@example.com', resource: true },
    ]), '4 attendees (2 yes, 1 no, 1 no answer)');
    assert.equal(describeAttendees([]), 'no attendees');
    assert.equal(meetLink({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:1' }, { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] } }), 'https://meet.google.com/abc-defg-hij');
  });

  test('shared free time: working hours on weekdays, outside every busy block, long enough', () => {
    const from = parseInstant('2026-10-23', TZ); // a Friday
    const to = parseInstant('2026-10-27', TZ);
    const slots = freeSlots({
      busy: [
        { start: '2026-10-23T14:00:00Z', end: '2026-10-23T16:00:00Z' }, // Fri 09:00-11:00
        { start: '2026-10-23T18:00:00Z', end: '2026-10-23T18:20:00Z' }, // Fri 13:00-13:20
        { start: '2026-10-26T13:30:00Z', end: '2026-10-26T22:00:00Z' }, // Mon 08:30-17:00
      ],
      from, to, timeZone: TZ, minutes: 30,
    });
    assert.deepEqual(slots.map((s) => [formatRfc3339(s.start, TZ), formatRfc3339(s.end, TZ)]), [
      ['2026-10-23T11:00:00-05:00', '2026-10-23T13:00:00-05:00'],
      ['2026-10-23T13:20:00-05:00', '2026-10-23T17:00:00-05:00'],
    ]);
    const weekend = freeSlots({ busy: [], from, to, timeZone: TZ, minutes: 60, hours: ['10:00', '12:00'], weekends: true });
    assert.equal(weekend.length, 4, 'Friday to Monday, one morning slot each');
  });
});

describe('reading', () => {
  test('listEvents asks for single events in start order within the window, and pages up to the limit', async () => {
    const google = fakeGoogle([['GET', '/calendar/v3/calendars/primary/events', (call) => (call.params.get('pageToken')
      ? json({ items: [{ id: 'e3' }], timeZone: TZ })
      : json({ items: [{ id: 'e1' }, { id: 'e2' }], nextPageToken: 'p2', timeZone: TZ, summary: 'agent@example.com' }))]]);
    const result = await client(google).listEvents({ timeMin: '2026-10-20T00:00:00-05:00', timeMax: '2026-10-21T00:00:00-05:00', query: 'sync', limit: 3 });
    assert.deepEqual(result.events.map((e) => e.id), ['e1', 'e2', 'e3']);
    assert.equal(result.capped, false);
    assert.equal(result.timeZone, TZ);
    const first = google.calls[0];
    assert.equal(first.url, `${BASE}/calendars/primary/events?timeMin=2026-10-20T00%3A00%3A00-05%3A00&timeMax=2026-10-21T00%3A00%3A00-05%3A00&q=sync&singleEvents=true&orderBy=startTime&maxResults=3`);
    assert.equal(first.headers.Authorization, 'Bearer tok-calendar');
    assert.equal(google.calls[1].params.get('maxResults'), '1');
  });

  test("another person's calendar is addressed by its id, and an unseen one points to free/busy", async () => {
    const google = fakeGoogle([['GET', /\/events$/, () => googleError(404, 'notFound', 'Not Found')]]);
    await assert.rejects(client(google).listEvents({ calendarId: 'pat@example.com', timeMin: 'a', timeMax: 'b' }),
      (err) => err.kind === 'not_found' && /^agent@example\.com cannot see calendar pat@example\.com: .*use cal-freebusy instead/.test(err.message));
    assert.equal(google.calls[0].path, '/calendar/v3/calendars/pat%40example.com/events');
  });

  test('the calendar time zone', async () => {
    const google = fakeGoogle([['GET', '/calendar/v3/calendars/primary', () => json({ id: 'agent@example.com', timeZone: TZ })]]);
    assert.equal(await client(google).timeZone(), TZ);
    assert.equal(google.calls[0].params.get('fields'), 'id,summary,timeZone');
  });

  test('freeBusy asks for everyone at once and reports a calendar it cannot see as unknown', async () => {
    const google = fakeGoogle([['POST', '/calendar/v3/freeBusy', () => json({
      calendars: {
        'pat@example.com': { busy: [{ start: '2026-10-20T14:00:00Z', end: '2026-10-20T15:00:00Z' }] },
        'lee@example.com': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
      },
    })]]);
    const result = await client(google).freeBusy({ people: ['Pat@example.com', 'lee@example.com'], timeMin: 'a', timeMax: 'b', timeZone: TZ });
    assert.deepEqual(google.calls[0].json(), { timeMin: 'a', timeMax: 'b', timeZone: TZ, items: [{ id: 'Pat@example.com' }, { id: 'lee@example.com' }] });
    assert.deepEqual(result, [
      { id: 'Pat@example.com', busy: [{ start: '2026-10-20T14:00:00Z', end: '2026-10-20T15:00:00Z' }], errors: [] },
      { id: 'lee@example.com', busy: [], errors: ['notFound'] },
    ]);
    await assert.rejects(client(google).freeBusy({ people: [], timeMin: 'a', timeMax: 'b' }), /at least one person/);
  });
});

describe('writing', () => {
  const start = { dateTime: '2026-10-20T09:00:00-05:00', timeZone: TZ };
  const end = { dateTime: '2026-10-20T09:30:00-05:00', timeZone: TZ };

  test('createEvent puts the event on the agent\'s own calendar and tells nobody when no one is invited', async () => {
    const google = fakeGoogle([['POST', '/calendar/v3/calendars/primary/events', (call) => json({ id: 'new1', ...call.json() })]]);
    const event = await client(google).createEvent({ summary: 'Focus', start, end, description: 'Prep', location: 'Desk' });
    assert.equal(event.id, 'new1');
    assert.equal(google.calls[0].url, `${BASE}/calendars/primary/events?sendUpdates=none`);
    assert.deepEqual(google.calls[0].json(), { summary: 'Focus', start, end, description: 'Prep', location: 'Desk' });
  });

  test('named attendees are invited (Google emails them); a Meet link is asked for when wanted', async () => {
    const google = fakeGoogle([['POST', /events$/, (call) => json({ id: 'new2', ...call.json() })]]);
    await client(google).createEvent({ summary: 'Sync', start, end, attendees: ['pat@example.com'], meet: true, requestId: 'req-1' });
    assert.equal(google.calls[0].url, `${BASE}/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`);
    const body = google.calls[0].json();
    assert.deepEqual(body.attendees, [{ email: 'pat@example.com' }]);
    assert.deepEqual(body.conferenceData, { createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } });
  });

  const ORGANIZED = {
    id: 'ev1', summary: 'Sync', organizer: { email: 'agent@example.com', self: true }, start, end,
    attendees: [
      { email: 'agent@example.com', self: true, organizer: true, responseStatus: 'accepted' },
      { email: 'pat@example.com', responseStatus: 'declined', comment: 'Away' },
      { email: 'lee@example.com', responseStatus: 'tentative' },
    ],
  };

  test('updateEvent patches only what changes, quietly unless people are invited or removed', async () => {
    const google = fakeGoogle([
      ['GET', '/calendar/v3/calendars/primary/events/ev1', () => json(ORGANIZED)],
      ['PATCH', '/calendar/v3/calendars/primary/events/ev1', (call) => json({ ...ORGANIZED, ...call.json() })],
    ]);
    const quiet = await client(google).updateEvent({ eventId: 'ev1', changes: { summary: 'Weekly sync', location: undefined } });
    assert.equal(google.calls[1].url, `${BASE}/calendars/primary/events/ev1?sendUpdates=none`);
    assert.deepEqual(google.calls[1].json(), { summary: 'Weekly sync' });
    assert.deepEqual(quiet.invited, []);
    const told = await client(google).updateEvent({ eventId: 'ev1', changes: { start, end }, notify: true });
    assert.equal(google.calls[3].params.get('sendUpdates'), 'all');
    assert.deepEqual(told.removed, []);
  });

  test("inviting and removing keeps everyone else's entry and answer exactly as it was", async () => {
    const google = fakeGoogle([
      ['GET', /events\/ev1$/, () => json(ORGANIZED)],
      ['PATCH', /events\/ev1$/, (call) => json({ ...ORGANIZED, ...call.json() })],
    ]);
    const r = await client(google).updateEvent({ eventId: 'ev1', invite: ['sam@example.com', 'PAT@example.com'], uninvite: ['lee@example.com', 'nobody@example.com'] });
    const patch = google.calls[1].json();
    assert.deepEqual(patch.attendees, [ORGANIZED.attendees[0], ORGANIZED.attendees[1], { email: 'sam@example.com' }]);
    assert.equal(google.calls[1].params.get('sendUpdates'), 'all');
    assert.deepEqual(r.invited, ['sam@example.com']);
    assert.deepEqual(r.alreadyInvited, ['PAT@example.com']);
    assert.deepEqual(r.removed, ['lee@example.com']);
    assert.deepEqual(r.notInvited, ['nobody@example.com']);
  });

  test("an event someone else organizes is refused before anything is sent", async () => {
    const theirs = { ...ORGANIZED, organizer: { email: 'pat@example.com', displayName: 'Pat Example' } };
    const google = fakeGoogle([['GET', /events\/ev1$/, () => json(theirs)]]);
    await assert.rejects(client(google).updateEvent({ eventId: 'ev1', changes: { summary: 'Mine now' } }),
      (err) => err.kind === 'not_organizer' && /^"Sync" is organized by Pat Example <pat@example\.com>, not by agent@example\.com/.test(err.message));
    assert.equal(google.calls.filter((c) => c.method === 'PATCH').length, 0);
  });

  test('nothing to change is a plain refusal', async () => {
    const google = fakeGoogle([['GET', /events\/ev1$/, () => json(ORGANIZED)]]);
    await assert.rejects(client(google).updateEvent({ eventId: 'ev1' }), /Nothing to change/);
  });
});
