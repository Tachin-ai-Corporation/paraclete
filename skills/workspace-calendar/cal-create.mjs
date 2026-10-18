#!/usr/bin/env node
// skills/workspace-calendar/cal-create.mjs: the cal-create command. Adds an event to the agent's own
// calendar: a timed event (a start, and an end or a length, 30 minutes by default) or an all-day one (a
// start date, and optionally the last day). People are invited only when --invite names them, and then
// Google emails them the invitation; without --invite nobody is told. --meet adds a Google Meet link.
// Before creating, it looks for events already in that time on the agent's calendar and says so. It
// also exports the start and end arithmetic cal-update uses. The Calendar calls are
// agent/providers/workspace-calendar.mjs. Documented in skills/workspace-calendar/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import {
  createCalendarClient, addDays, describeWhen, eventSpan, eventTime, formatRfc3339, isDate, isTimeZone, meetLink, parseInstant,
} from '../../agent/providers/workspace-calendar.mjs';
import { zoneFor, eventJson, emailList } from './cal-list.mjs';

export const USAGE = [
  'Usage: cal-create --title <title> --start <date or time> [--end <date or time> | --minutes <n>] [--tz <time zone>]',
  '                  [--description <text>] [--location <text>] [--invite <email>[,<email>...]] [--meet] [--json]',
].join('\n');

const DEFAULT_MINUTES = 30;

/**
 * An event's start and end as Calendar takes them. A start date makes an all-day event that runs
 * through --end's date (the last day, included) or one day; a start time runs to --end, or for
 * --minutes, or for `defaultMinutes`.
 *
 * @param {{start: string, end?: string, minutes?: number}} o
 * @param {string} timeZone
 * @param {number} [defaultMinutes]
 * @returns {{start: object, end: object, allDay: boolean}}
 * @throws {Error} in plain words when the times do not make an event
 */
export function eventTimes({ start, end, minutes }, timeZone, defaultMinutes = DEFAULT_MINUTES) {
  if (isDate(start)) {
    if (minutes !== undefined) throw new Error('an all-day event has no length in minutes: give its last day with --end <date>, or a start time');
    if (end !== undefined && !isDate(end)) throw new Error('an all-day event ends on a date: --end 2026-10-22 (its last day)');
    const last = end ?? start;
    if (last < start) throw new Error(`the last day (${last}) is before the first (${start})`);
    return { start: { date: start }, end: { date: addDays(last, 1) }, allDay: true };
  }
  const from = parseInstant(start, timeZone);
  if (end !== undefined && isDate(end)) throw new Error('a timed event ends at a time: --end 2026-10-20T16:00, or --minutes');
  const to = end !== undefined ? parseInstant(end, timeZone) : from + (minutes ?? defaultMinutes) * 60_000;
  if (to <= from) throw new Error(`the event ends (${formatRfc3339(to, timeZone)}) before it starts (${formatRfc3339(from, timeZone)})`);
  return { start: eventTime(formatRfc3339(from, timeZone), timeZone), end: eventTime(formatRfc3339(to, timeZone), timeZone), allDay: false };
}

/** Checks --minutes: a whole number from 5 to 10080 (a week), or undefined. Returns the number or the problem. */
export function minutesOption(value) {
  if (value === undefined) return { minutes: undefined };
  const n = Number(value);
  return Number.isInteger(n) && n >= 5 && n <= 10_080 ? { minutes: n } : { error: '--minutes must be a whole number from 5 to 10080' };
}

/** The events already on the agent's calendar during a new event, cancelled ones and itself aside. */
export async function overlapping(calendar, times, timeZone, exceptId = null) {
  const span = eventSpan(times, timeZone);
  const found = await calendar.listEvents({ timeMin: formatRfc3339(span.start, timeZone), timeMax: formatRfc3339(span.end, timeZone), limit: 20 });
  return found.events.filter((e) => e.status !== 'cancelled' && e.id !== exceptId && e.transparency !== 'transparent');
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { title, start, end, minutes, tz, description, location, invite, meet, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      options: {
        title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, minutes: { type: 'string' }, tz: { type: 'string' },
        description: { type: 'string' }, location: { type: 'string' }, invite: { type: 'string', multiple: true }, meet: { type: 'boolean' },
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  if (!values.title?.trim()) return { error: '--title is required: a short, specific title' };
  if (!values.start) return { error: '--start is required: a date (all day) or a date and time' };
  if (values.end !== undefined && values.minutes !== undefined) return { error: 'use --end or --minutes, not both' };
  const { minutes, error } = minutesOption(values.minutes);
  if (error) return { error };
  if (values.tz !== undefined && !isTimeZone(values.tz)) return { error: `--tz '${values.tz}' is not a time zone: use a name like America/Chicago or UTC` };
  for (const [name, value] of [['--start', values.start], ['--end', values.end]]) {
    if (value === undefined) continue;
    try { parseInstant(value, 'UTC'); } catch (err) { return { error: `${name}: ${err.message}` }; }
  }
  const { emails, bad } = emailList(values.invite);
  if (bad.length) return { error: `--invite takes email addresses; not: ${bad.join(', ')}` };
  return {
    title: values.title.trim(), start: values.start, end: values.end, minutes, tz: values.tz,
    description: values.description, location: values.location, invite: emails, meet: values.meet === true, json: values.json === true,
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime]  from createCliRuntime()
 * @param {object} [deps.calendar] from createCalendarClient()
 * @returns {Promise<number>} 0, 1 when Calendar refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`cal-create: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const calendar = deps.calendar || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createCalendarClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const timeZone = await zoneFor(calendar, args.tz);
    let times;
    try {
      times = eventTimes(args, timeZone);
    } catch (err) {
      return fail(`${err.message}\n${USAGE}`, 2);
    }
    const clashes = await overlapping(calendar, times, timeZone);
    const event = await calendar.createEvent({
      summary: args.title, start: times.start, end: times.end, description: args.description, location: args.location,
      attendees: args.invite, meet: args.meet,
    });
    if (args.json) {
      stdout.write(`${JSON.stringify({ ...eventJson(event), time_zone: timeZone, invited: args.invite, overlaps: clashes.map(eventJson) }, null, 2)}\n`);
      return 0;
    }
    const lines = [
      `Created "${event.summary || args.title}" on your calendar (${calendar.account}): ${describeWhen(event, timeZone)} (${timeZone})`,
      `id: ${event.id}`,
      event.htmlLink ? `link: ${event.htmlLink}` : null,
      args.invite.length ? `Invited, and emailed by Google: ${args.invite.join(', ')}` : 'Nobody was invited or told.',
      meetLink(event) ? `Meet: ${meetLink(event)}` : (args.meet ? 'Meet: asked for; Google has not added the link yet. cal-get shows it once it has.' : null),
      ...clashes.map((c) => `Overlaps: "${c.summary || '(no title)'}" ${describeWhen(c, timeZone)} (id ${c.id})`),
    ].filter(Boolean);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
