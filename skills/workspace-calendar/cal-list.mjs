#!/usr/bin/env node
// skills/workspace-calendar/cal-list.mjs: the cal-list command. Lists the events in a window on the
// agent's own calendar, or on another calendar it can see, in a time zone: when, title, id, organizer,
// how the attendees answered, the Meet link and the place. It also exports what the other calendar
// commands share: the time zone a command works in, the window from --from/--to/--days, an event as
// lines and as JSON, and email lists. The Calendar calls are agent/providers/workspace-calendar.mjs.
// Documented in skills/workspace-calendar/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import {
  createCalendarClient, parseInstant, formatRfc3339, describeInstant, describeWhen, describeAttendees, meetLink, isTimeZone,
} from '../../agent/providers/workspace-calendar.mjs';

export const USAGE = 'Usage: cal-list [--from <date or time>] [--to <date or time> | --days <n>] [--calendar <calendar id or email>] [--search <words>] [--limit <n>] [--tz <time zone>] [--json]';

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const EMAIL = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

/** The options every window-reading command takes. */
export const WINDOW_OPTIONS = Object.freeze({ from: { type: 'string' }, to: { type: 'string' }, days: { type: 'string' }, tz: { type: 'string' } });

/**
 * Checks the window and zone options, before any call. Returns the problem, or null.
 *
 * @param {{from?: string, to?: string, days?: string, tz?: string}} values
 * @returns {string|null}
 */
export function windowProblem({ from, to, days, tz }) {
  if (tz !== undefined && !isTimeZone(tz)) return `--tz '${tz}' is not a time zone: use a name like America/Chicago, Europe/Paris or UTC`;
  if (to !== undefined && days !== undefined) return 'use --to or --days, not both';
  if (days !== undefined && !(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 366)) return '--days must be a whole number from 1 to 366';
  for (const [name, value] of [['--from', from], ['--to', to]]) {
    if (value === undefined) continue;
    try { parseInstant(value, 'UTC'); } catch (err) { return `${name}: ${err.message}`; }
  }
  return null;
}

/**
 * The time zone a command works in: --tz, else the agent's own calendar's.
 *
 * @param {object} calendar from createCalendarClient()
 * @param {string} [tz]
 * @returns {Promise<string>}
 */
export async function zoneFor(calendar, tz) {
  return tz || calendar.timeZone('primary');
}

/**
 * The window a command reads: from --from (default now) to --to, or --days later (default 7). A date
 * is the start of that day in the zone, so --to 2026-10-21 ends as the 21st begins.
 *
 * @returns {{from: number, to: number, timeMin: string, timeMax: string}}
 * @throws {Error} when the window ends before it starts
 */
export function windowFor({ from, to, days }, timeZone, now = Date.now()) {
  const start = from !== undefined ? parseInstant(from, timeZone) : now;
  const end = to !== undefined ? parseInstant(to, timeZone) : start + Number(days ?? DEFAULT_DAYS) * 86_400_000;
  if (end <= start) throw new Error(`the window ends (${formatRfc3339(end, timeZone)}) before it starts (${formatRfc3339(start, timeZone)})`);
  return { from: start, to: end, timeMin: formatRfc3339(start, timeZone), timeMax: formatRfc3339(end, timeZone) };
}

/**
 * Email addresses from repeatable, comma-separated options.
 *
 * @param {string[]|undefined} values
 * @returns {{emails: string[], bad: string[]}}
 */
export function emailList(values) {
  const all = (values || []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  return { emails: [...new Set(all.filter((e) => EMAIL.test(e)))], bad: all.filter((e) => !EMAIL.test(e)) };
}

const ANSWERS = Object.freeze({ accepted: 'yes', declined: 'no', tentative: 'maybe', needsAction: 'no answer' });

/** Someone as "Name <email>", or the email. */
export const person = (p) => (p?.displayName ? `${p.displayName} <${p.email}>` : (p?.email || 'unknown'));

/**
 * An event as two plain lines: when, title and id; then organizer, attendees, your answer, Meet and
 * place.
 *
 * @param {object} event
 * @param {string} timeZone
 * @returns {string[]}
 */
export function eventLines(event, timeZone) {
  const me = (event.attendees || []).find((a) => a.self);
  const details = [
    event.organizer ? `organizer ${event.organizer.self ? 'you' : person(event.organizer)}` : null,
    event.attendees?.length ? describeAttendees(event.attendees) : null,
    me && !me.organizer ? `your answer: ${ANSWERS[me.responseStatus] || 'no answer'}` : null,
    meetLink(event) ? `Meet ${meetLink(event)}` : null,
    event.location ? `at ${event.location}` : null,
    event.status === 'cancelled' ? 'CANCELLED' : null,
  ].filter(Boolean);
  return [`${describeWhen(event, timeZone)} | ${event.summary || '(no title)'} | id ${event.id}`, ...(details.length ? [details.join(' | ')] : [])];
}

/** An event as the JSON the commands print. */
export function eventJson(event) {
  return {
    id: event.id,
    summary: event.summary ?? null,
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    all_day: Boolean(event.start?.date),
    location: event.location ?? null,
    organizer: event.organizer ? { email: event.organizer.email ?? null, name: event.organizer.displayName ?? null, self: event.organizer.self === true } : null,
    attendees: (event.attendees || []).map((a) => ({ email: a.email, name: a.displayName ?? null, response: ANSWERS[a.responseStatus] || 'no answer', organizer: a.organizer === true, self: a.self === true })),
    meet: meetLink(event),
    link: event.htmlLink ?? null,
    status: event.status ?? null,
    recurring: Boolean(event.recurringEventId),
  };
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { window, calendarId, search, limit, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      options: {
        ...WINDOW_OPTIONS, calendar: { type: 'string' }, search: { type: 'string' }, limit: { type: 'string' },
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  const problem = windowProblem(values);
  if (problem) return { error: problem };
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `--limit must be a whole number from 1 to ${MAX_LIMIT}` };
  }
  if (values.calendar !== undefined && !/^[^\s/]+$/.test(values.calendar)) return { error: `'${values.calendar}' is not a calendar id or email` };
  return {
    window: { from: values.from, to: values.to, days: values.days, tz: values.tz },
    calendarId: values.calendar && values.calendar !== 'me' ? values.calendar : 'primary',
    search: values.search, limit, json: values.json === true,
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime]  from createCliRuntime(): instance, getAccessToken, fetch
 * @param {object} [deps.calendar] from createCalendarClient()
 * @param {Function} [deps.now]    clock in milliseconds
 * @returns {Promise<number>} 0, 1 when Calendar refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`cal-list: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const calendar = deps.calendar || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createCalendarClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const timeZone = await zoneFor(calendar, args.window.tz);
    let window;
    try {
      window = windowFor(args.window, timeZone, (deps.now || Date.now)());
    } catch (err) {
      return fail(`${err.message}\n${USAGE}`, 2);
    }
    const found = await calendar.listEvents({ calendarId: args.calendarId, timeMin: window.timeMin, timeMax: window.timeMax, query: args.search, limit: args.limit });
    const whose = args.calendarId === 'primary' ? `your calendar (${calendar.account})` : `calendar ${args.calendarId}`;
    if (args.json) {
      stdout.write(`${JSON.stringify({ calendar: args.calendarId === 'primary' ? calendar.account : args.calendarId, time_zone: timeZone, from: window.timeMin, to: window.timeMax, events: found.events.map(eventJson), capped: found.capped }, null, 2)}\n`);
      return 0;
    }
    const lines = [`Events on ${whose}${args.search ? ` matching "${args.search}"` : ''}, ${describeInstant(window.from, timeZone)} to ${describeInstant(window.to, timeZone)} (${timeZone}):`];
    if (!found.events.length) lines.push('No events.');
    found.events.forEach((event, i) => {
      const [first, second] = eventLines(event, timeZone);
      lines.push(`${i + 1}. ${first}`);
      if (second) lines.push(`   ${second}`);
    });
    if (found.capped) lines.push(`More events fall in the window: narrow it, or raise --limit (at most ${MAX_LIMIT}).`);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
