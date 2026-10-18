// agent/providers/workspace-calendar.mjs: a Google Calendar API v3 client acting as the agent's own
// Workspace account (agent/providers/workspace.mjs), plus the pure time arithmetic its commands need:
// reading what a person wrote ("2026-10-20", "2026-10-20T15:00", "...Z") as instants in a time zone,
// printing events in one, and finding the free time several people share.
//
// What it may do: read any calendar the account can see, ask for people's free and busy times, and
// create and change events on the agent's own calendar. It changes an event only when the agent
// organizes it, and it never answers an invitation (accept or decline) for anyone: an attendee's
// response is never written. Attendees are invited, and emailed, only when the caller names them.
//
// Called by the workspace-calendar skill's commands (skills/workspace-calendar/).

import { randomUUID } from 'node:crypto';
import { createWorkspaceSession, sameEmail, WorkspaceError } from './workspace.mjs';

const BASE = '/calendar/v3';
const MAX_EVENTS = 250;
/** Google's limit on calendars in one free/busy query. */
export const MAX_FREEBUSY_PEOPLE = 50;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const DAY_MS = 86_400_000;

/** Whether a time zone name is one this host knows (an IANA name like America/Chicago, or UTC). */
export function isTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of an instant in a zone. */
function zonedFields(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
    h: Number(get('hour')) % 24, mi: Number(get('minute')), s: Number(get('second')), weekday: get('weekday'),
  };
}

/**
 * How many minutes a zone is ahead of UTC at an instant. Pure.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export function zoneOffsetMinutes(ms, timeZone) {
  const f = zonedFields(ms, timeZone);
  const whole = Math.floor(ms / 1000) * 1000;
  return Math.round((Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - whole) / 60_000);
}

/**
 * The instant a wall-clock time in a zone names. A time that happens twice (clocks going back) is the
 * first one; a time that never happens (clocks going forward) is read past the jump, as clocks do.
 */
function wallClockToMs({ y, mo, d, h = 0, mi = 0, s = 0 }, timeZone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = naive - zoneOffsetMinutes(naive, timeZone) * 60_000;
  const second = naive - zoneOffsetMinutes(first, timeZone) * 60_000;
  const reads = (ms) => {
    const f = zonedFields(ms, timeZone);
    return f.y === y && f.mo === mo && f.d === d && f.h === h && f.mi === mi;
  };
  const matching = [first, second].filter(reads);
  return matching.length ? Math.min(...matching) : Math.max(first, second);
}

/**
 * An instant from what a person wrote: a date (the start of that day in the zone), a date and time
 * (in the zone), or a date and time with Z or an offset (the zone does not matter). Pure.
 *
 * @param {string} text
 * @param {string} timeZone
 * @returns {number} milliseconds since the epoch
 * @throws {Error} naming the accepted forms
 */
export function parseInstant(text, timeZone) {
  const s = String(text ?? '').trim();
  const date = DATE.exec(s);
  if (date) return wallClockToMs({ y: +date[1], mo: +date[2], d: +date[3] }, timeZone);
  const m = DATE_TIME.exec(s);
  if (!m) throw new Error(`'${s}' is not a date or time: write 2026-10-20, 2026-10-20T15:00, or 2026-10-20T15:00:00-05:00`);
  const [, y, mo, d, h, mi, sec = '0', zone] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +sec > 59) throw new Error(`'${s}' is not a real date and time`);
  if (!zone) return wallClockToMs({ y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +sec }, timeZone);
  if (/^z$/i.test(zone)) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - offset * 60_000;
}

/** Whether a value is a bare date (an all-day value). */
export function isDate(text) {
  return DATE.test(String(text ?? '').trim());
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * An instant as RFC 3339 with the zone's offset: 2026-10-20T09:00:00-05:00. Pure.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {string}
 */
export function formatRfc3339(ms, timeZone) {
  const f = zonedFields(ms, timeZone);
  const off = zoneOffsetMinutes(ms, timeZone);
  const a = Math.abs(off);
  return `${f.y}-${pad(f.mo)}-${pad(f.d)}T${pad(f.h)}:${pad(f.mi)}:${pad(f.s)}${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** A date plus a number of days, as YYYY-MM-DD. Pure. */
export function addDays(date, days) {
  const m = DATE.exec(String(date));
  if (!m) throw new Error(`'${date}' is not a date`);
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * DAY_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * An event's start or end as Calendar takes it: a bare date stays a date (an all-day event); anything
 * else becomes a dateTime with the zone's offset, and the zone. Pure.
 *
 * @param {string} text
 * @param {string} timeZone
 * @returns {{date: string} | {dateTime: string, timeZone: string}}
 */
export function eventTime(text, timeZone) {
  const s = String(text ?? '').trim();
  if (isDate(s)) return { date: s };
  return { dateTime: formatRfc3339(parseInstant(s, timeZone), timeZone), timeZone };
}

/** "Mon 2026-10-20 09:00" in the zone, or "Mon 2026-10-20" with dateOnly. Pure. */
export function describeInstant(ms, timeZone, { dateOnly = false } = {}) {
  const f = zonedFields(ms, timeZone);
  const day = `${f.weekday} ${f.y}-${pad(f.mo)}-${pad(f.d)}`;
  return dateOnly ? day : `${day} ${pad(f.h)}:${pad(f.mi)}`;
}

/**
 * When an event happens, in a zone: "Mon 2026-10-20 09:00-09:30", "Mon 2026-10-20 22:00 to Tue
 * 2026-10-21 01:00", "Mon 2026-10-20, all day", or "Mon 2026-10-20 to Wed 2026-10-22, all day". Pure.
 *
 * @param {object} event a Calendar event (start, end)
 * @param {string} timeZone
 * @returns {string}
 */
export function describeWhen(event, timeZone) {
  const start = event?.start || {};
  const end = event?.end || {};
  if (start.date) {
    const first = parseInstant(start.date, 'UTC');
    const last = end.date ? parseInstant(addDays(end.date, -1), 'UTC') : first;
    const a = describeInstant(first, 'UTC', { dateOnly: true });
    const b = describeInstant(last, 'UTC', { dateOnly: true });
    return a === b ? `${a}, all day` : `${a} to ${b}, all day`;
  }
  const s = Date.parse(start.dateTime);
  const e = Date.parse(end.dateTime);
  if (!Number.isFinite(s)) return 'no time given';
  const from = describeInstant(s, timeZone);
  if (!Number.isFinite(e)) return from;
  const to = describeInstant(e, timeZone);
  return from.slice(0, 14) === to.slice(0, 14) ? `${from}-${to.slice(15)}` : `${from} to ${to}`;
}

/** An event's start and end as instants (an all-day event: from the start of its first day in the zone). */
export function eventSpan(event, timeZone) {
  const start = event?.start?.date ? parseInstant(event.start.date, timeZone) : Date.parse(event?.start?.dateTime);
  const end = event?.end?.date ? parseInstant(event.end.date, timeZone) : Date.parse(event?.end?.dateTime);
  return { start, end };
}

/** The Meet link of an event, or null. */
export function meetLink(event) {
  if (event?.hangoutLink) return event.hangoutLink;
  const video = (event?.conferenceData?.entryPoints || []).find((p) => p.entryPointType === 'video');
  return video?.uri || null;
}

/** How the attendees answered: "4 attendees (2 yes, 1 no, 1 no answer)". Pure. */
export function describeAttendees(attendees = []) {
  const people = (attendees || []).filter((a) => !a.resource);
  if (!people.length) return 'no attendees';
  const words = { accepted: 'yes', declined: 'no', tentative: 'maybe', needsAction: 'no answer' };
  const counts = new Map();
  for (const a of people) {
    const w = words[a.responseStatus] || 'no answer';
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const order = ['yes', 'maybe', 'no', 'no answer'];
  return `${people.length} attendee${people.length === 1 ? '' : 's'} (${order.filter((w) => counts.has(w)).map((w) => `${counts.get(w)} ${w}`).join(', ')})`;
}

/**
 * The free time everyone shares: gaps of at least `minutes` inside working hours on each day of the
 * window, outside every busy block. Pure.
 *
 * @param {object} o
 * @param {Array<{start: string, end: string}>} o.busy  every person's busy blocks together
 * @param {number} o.from    window start (ms)
 * @param {number} o.to      window end (ms)
 * @param {string} o.timeZone
 * @param {number} o.minutes the shortest gap worth listing
 * @param {[string, string]} [o.hours] working hours, 'HH:MM' each (default 09:00 to 17:00)
 * @param {boolean} [o.weekends] include Saturdays and Sundays
 * @returns {Array<{start: number, end: number}>}
 */
export function freeSlots({ busy, from, to, timeZone, minutes, hours = ['09:00', '17:00'], weekends = false }) {
  const [openH, openM] = hours[0].split(':').map(Number);
  const [closeH, closeM] = hours[1].split(':').map(Number);
  const blocks = (busy || [])
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const slots = [];
  const first = zonedFields(from, timeZone);
  let day = `${first.y}-${pad(first.mo)}-${pad(first.d)}`;
  for (let guard = 0; guard < 400; guard += 1) {
    const [y, mo, d] = day.split('-').map(Number);
    const dayStart = wallClockToMs({ y, mo, d }, timeZone);
    if (dayStart >= to) break;
    const weekday = zonedFields(dayStart + 12 * 3_600_000, timeZone).weekday;
    if (weekends || (weekday !== 'Sat' && weekday !== 'Sun')) {
      let cursor = Math.max(from, wallClockToMs({ y, mo, d, h: openH, mi: openM }, timeZone));
      const close = Math.min(to, wallClockToMs({ y, mo, d, h: closeH, mi: closeM }, timeZone));
      for (const b of blocks) {
        if (b.end <= cursor || b.start >= close) continue;
        if (b.start - cursor >= minutes * 60_000) slots.push({ start: cursor, end: b.start });
        cursor = Math.max(cursor, b.end);
      }
      if (close - cursor >= minutes * 60_000) slots.push({ start: cursor, end: close });
    }
    day = addDays(day, 1);
  }
  return slots;
}

/**
 * Creates a Calendar client acting as the agent's Workspace account.
 *
 * @param {object} [options] a `session` from createWorkspaceSession, or the options to make one
 *   (instance, getAccessToken, getDwdToken, fetch, now, hosts)
 */
export function createCalendarClient(options = {}) {
  const session = options.session || createWorkspaceSession(options);
  const { account } = session;
  const calendarPath = (id) => `${BASE}/calendars/${encodeURIComponent(id || 'primary')}`;
  const calendarWord = (id) => (!id || id === 'primary' || sameEmail(id, account) ? 'your calendar' : `calendar ${id}`);
  const notVisible = (id) => `${account} cannot see calendar ${id}: it is not shared with ${account}, or the id is wrong. For when someone is free or busy, use cal-freebusy instead.`;

  async function getEvent({ calendarId = 'primary', eventId }) {
    return session.request('calendar', 'GET', `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      about: { what: `event ${eventId} on ${calendarWord(calendarId)}`, hint: 'List the events (cal-list) to find its id.' },
    });
  }

  /** Whether the agent organizes an event: the only events it may change. */
  const organizes = (event) => event?.organizer?.self === true || sameEmail(event?.organizer?.email, account);

  return {
    account,

    /** The time zone of a calendar (default: the agent's own). */
    async timeZone(calendarId = 'primary') {
      const calendar = await session.request('calendar', 'GET', calendarPath(calendarId), {
        query: { fields: 'id,summary,timeZone' },
        about: { what: calendarWord(calendarId), ...(calendarId !== 'primary' ? { notFound: notVisible(calendarId) } : {}) },
      });
      return calendar.timeZone || 'UTC';
    },

    /**
     * Events in a window, recurring ones expanded, in start order.
     *
     * @param {object} o
     * @param {string} [o.calendarId] default: the agent's own ('primary')
     * @param {string} o.timeMin RFC 3339
     * @param {string} o.timeMax RFC 3339
     * @param {string} [o.query]  free-text search in the events
     * @param {number} [o.limit]  at most this many (default 50, at most 250)
     * @returns {Promise<{events: object[], capped: boolean, timeZone: string|null, summary: string|null}>}
     */
    async listEvents({ calendarId = 'primary', timeMin, timeMax, query, limit = 50 } = {}) {
      const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), MAX_EVENTS);
      const events = [];
      let pageToken;
      let timeZone = null;
      let summary = null;
      do {
        const page = await session.request('calendar', 'GET', `${calendarPath(calendarId)}/events`, {
          query: { timeMin, timeMax, q: query, singleEvents: 'true', orderBy: 'startTime', maxResults: cap - events.length, pageToken },
          about: { what: calendarWord(calendarId), ...(calendarId !== 'primary' ? { notFound: notVisible(calendarId) } : {}) },
        });
        events.push(...(page.items || []));
        timeZone = timeZone || page.timeZone || null;
        summary = summary || page.summary || null;
        pageToken = page.nextPageToken;
      } while (pageToken && events.length < cap);
      return { events: events.slice(0, cap), capped: Boolean(pageToken), timeZone, summary };
    },

    /** One event, whole. */
    getEvent,

    /**
     * When each person is busy in a window. A person whose calendar the account cannot see comes back
     * with `errors` (Google's reasons) and no busy blocks: their time is unknown, not free.
     *
     * @param {object} o
     * @param {string[]} o.people   email addresses (or calendar ids); at most 50
     * @param {string} o.timeMin
     * @param {string} o.timeMax
     * @param {string} [o.timeZone]
     * @returns {Promise<Array<{id: string, busy: Array<{start: string, end: string}>, errors: string[]}>>}
     */
    async freeBusy({ people, timeMin, timeMax, timeZone }) {
      if (!people?.length) throw new WorkspaceError('freeBusy needs at least one person', { kind: 'bad_request', api: 'calendar' });
      if (people.length > MAX_FREEBUSY_PEOPLE) {
        throw new WorkspaceError(`Calendar answers for at most ${MAX_FREEBUSY_PEOPLE} people at once; ask for fewer`, { kind: 'bad_request', api: 'calendar' });
      }
      const result = await session.request('calendar', 'POST', `${BASE}/freeBusy`, {
        json: { timeMin, timeMax, ...(timeZone ? { timeZone } : {}), items: people.map((id) => ({ id })) },
        about: { what: 'free/busy times' },
      });
      const calendars = result?.calendars || {};
      return people.map((id) => {
        const key = Object.keys(calendars).find((k) => sameEmail(k, id)) ?? id;
        const c = calendars[key] || {};
        return { id, busy: c.busy || [], errors: (c.errors || []).map((e) => e.reason || 'unknown') };
      });
    },

    /**
     * Adds an event to the agent's own calendar. Attendees are invited (Google emails them) only when
     * given; without them nobody hears of it.
     *
     * @param {object} o
     * @param {string} o.summary
     * @param {object} o.start      from eventTime()
     * @param {object} o.end        from eventTime()
     * @param {string} [o.description]
     * @param {string} [o.location]
     * @param {string[]} [o.attendees] email addresses to invite
     * @param {boolean} [o.meet]   add a Google Meet link
     * @param {string} [o.requestId] the Meet request id (default: a random UUID)
     * @returns {Promise<object>} the new event
     */
    async createEvent({ summary, start, end, description, location, attendees = [], meet = false, requestId }) {
      const body = { summary, start, end };
      if (description) body.description = description;
      if (location) body.location = location;
      if (attendees.length) body.attendees = attendees.map((email) => ({ email }));
      if (meet) body.conferenceData = { createRequest: { requestId: requestId || randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      return session.request('calendar', 'POST', `${calendarPath('primary')}/events`, {
        query: { sendUpdates: attendees.length ? 'all' : 'none', conferenceDataVersion: meet ? 1 : undefined },
        json: body,
        about: { what: 'your calendar', action: 'add an event to' },
      });
    },

    /**
     * Changes an event on the agent's own calendar that the agent organizes. Attendees are added and
     * removed as named; everyone else's entry, and their response, is kept exactly as it was. Google
     * emails the attendees only when people are invited or removed, or `notify` is set.
     *
     * @param {object} o
     * @param {string} o.eventId
     * @param {object} [o.changes]  any of summary, description, location, start, end
     * @param {string[]} [o.invite]
     * @param {string[]} [o.uninvite]
     * @param {boolean} [o.notify]
     * @param {object} [o.event]    the event as just read, to save reading it again
     * @returns {Promise<{event: object, invited: string[], removed: string[], alreadyInvited: string[], notInvited: string[]}>}
     * @throws {WorkspaceError} kind not_organizer for an event someone else organizes
     */
    async updateEvent({ eventId, changes = {}, invite = [], uninvite = [], notify = false, event: current }) {
      const event = current || await getEvent({ eventId });
      if (!organizes(event)) {
        const by = event.organizer?.displayName ? `${event.organizer.displayName} <${event.organizer.email}>` : (event.organizer?.email || 'someone else');
        throw new WorkspaceError(
          `"${event.summary || eventId}" is organized by ${by}, not by ${account}: only its organizer may change it. Tell the person what should change, and they or the organizer can do it.`,
          { kind: 'not_organizer', api: 'calendar' },
        );
      }
      const patch = {};
      for (const key of ['summary', 'description', 'location', 'start', 'end']) {
        if (changes[key] !== undefined) patch[key] = changes[key];
      }
      const existing = event.attendees || [];
      const removed = uninvite.filter((email) => existing.some((a) => sameEmail(a.email, email)));
      const notInvited = uninvite.filter((email) => !removed.includes(email));
      const kept = existing.filter((a) => !removed.some((email) => sameEmail(a.email, email)));
      const alreadyInvited = invite.filter((email) => kept.some((a) => sameEmail(a.email, email)));
      const invited = [...new Set(invite.filter((email) => !alreadyInvited.includes(email)).map((e) => e.trim()))];
      if (invited.length || removed.length) patch.attendees = [...kept, ...invited.map((email) => ({ email }))];
      if (!Object.keys(patch).length) {
        throw new WorkspaceError('Nothing to change: name a new title, time, place, description, or people to invite or remove.', { kind: 'bad_request', api: 'calendar' });
      }
      const updated = await session.request('calendar', 'PATCH', `${calendarPath('primary')}/events/${encodeURIComponent(event.id || eventId)}`, {
        query: { sendUpdates: invited.length || removed.length || notify ? 'all' : 'none' },
        json: patch,
        about: { what: `event ${eventId} on your calendar`, action: 'change' },
      });
      return { event: updated, invited, removed, alreadyInvited, notInvited };
    },
  };
}
