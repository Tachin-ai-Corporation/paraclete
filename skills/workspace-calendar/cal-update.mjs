#!/usr/bin/env node
// skills/workspace-calendar/cal-update.mjs: the cal-update command. Changes an event on the agent's own
// calendar that the agent organizes: its title, time, place or description, and who is invited. A new
// start keeps the event's length unless an end or a length is given. Invited and removed people are
// emailed by Google, and with --notify everyone is told of the change; otherwise nobody is. An event
// someone else organizes is refused, and nobody's answer to an invitation is ever changed. The
// Calendar calls are agent/providers/workspace-calendar.mjs. Documented in
// skills/workspace-calendar/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createCalendarClient, addDays, describeWhen, eventSpan, isDate, isTimeZone, parseInstant } from '../../agent/providers/workspace-calendar.mjs';
import { zoneFor, eventJson, emailList } from './cal-list.mjs';
import { eventTimes, minutesOption, overlapping } from './cal-create.mjs';

export const USAGE = [
  'Usage: cal-update <event id> [--title <title>] [--start <date or time>] [--end <date or time> | --minutes <n>] [--tz <time zone>]',
  '                  [--description <text>] [--location <text>] [--invite <email>[,...]] [--uninvite <email>[,...]] [--notify] [--json]',
].join('\n');

/**
 * The new start and end, from the options and the event as it is: a new start keeps the length; a new
 * end or length keeps the start. Null when no time option was given.
 *
 * @param {{start?: string, end?: string, minutes?: number}} o
 * @param {object} event
 * @param {string} timeZone
 * @returns {{start: object, end: object, allDay: boolean}|null}
 */
export function newTimes({ start, end, minutes }, event, timeZone) {
  if (start === undefined && end === undefined && minutes === undefined) return null;
  const wasAllDay = Boolean(event.start?.date);
  const span = eventSpan(event, timeZone);
  if (start !== undefined) {
    if (isDate(start)) {
      const days = wasAllDay ? Math.max(1, Math.round((span.end - span.start) / 86_400_000)) : 1;
      return eventTimes({ start, end: end ?? (minutes === undefined ? addDays(start, days - 1) : undefined), minutes }, timeZone);
    }
    const length = wasAllDay ? undefined : Math.max(5, Math.round((span.end - span.start) / 60_000));
    return eventTimes({ start, end, minutes }, timeZone, length);
  }
  if (wasAllDay) return eventTimes({ start: event.start.date, end, minutes }, timeZone);
  return eventTimes({ start: event.start.dateTime, end, minutes }, timeZone);
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { eventId, changes..., invite, uninvite, notify, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, minutes: { type: 'string' }, tz: { type: 'string' },
        description: { type: 'string' }, location: { type: 'string' }, invite: { type: 'string', multiple: true },
        uninvite: { type: 'string', multiple: true }, notify: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one event at a time, got ${positionals.length}` : 'the event id is required (cal-list prints it)' };
  if (!/^[^\s/]+$/.test(positionals[0])) return { error: `'${positionals[0]}' is not an event id` };
  if (values.end !== undefined && values.minutes !== undefined) return { error: 'use --end or --minutes, not both' };
  const { minutes, error } = minutesOption(values.minutes);
  if (error) return { error };
  if (values.tz !== undefined && !isTimeZone(values.tz)) return { error: `--tz '${values.tz}' is not a time zone: use a name like America/Chicago or UTC` };
  for (const [name, value] of [['--start', values.start], ['--end', values.end]]) {
    if (value === undefined) continue;
    try { parseInstant(value, 'UTC'); } catch (err) { return { error: `${name}: ${err.message}` }; }
  }
  if (values.title !== undefined && !values.title.trim()) return { error: '--title cannot be empty' };
  const invite = emailList(values.invite);
  const uninvite = emailList(values.uninvite);
  const bad = [...invite.bad, ...uninvite.bad];
  if (bad.length) return { error: `--invite and --uninvite take email addresses; not: ${bad.join(', ')}` };
  const both = invite.emails.filter((e) => uninvite.emails.some((u) => u.toLowerCase() === e.toLowerCase()));
  if (both.length) return { error: `${both.join(', ')}: both invited and removed` };
  const any = [values.title, values.start, values.end, minutes, values.description, values.location].some((v) => v !== undefined)
    || invite.emails.length || uninvite.emails.length;
  if (!any) return { error: 'say what to change: --title, --start, --end, --minutes, --description, --location, --invite or --uninvite' };
  return {
    eventId: positionals[0], title: values.title?.trim(), start: values.start, end: values.end, minutes, tz: values.tz,
    description: values.description, location: values.location, invite: invite.emails, uninvite: uninvite.emails,
    notify: values.notify === true, json: values.json === true,
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
  const fail = (message, code = 1) => { stderr.write(`cal-update: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const calendar = deps.calendar || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createCalendarClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const timeZone = await zoneFor(calendar, args.tz);
    const event = await calendar.getEvent({ eventId: args.eventId });
    let times;
    try {
      times = newTimes(args, event, timeZone);
    } catch (err) {
      return fail(`${err.message}\n${USAGE}`, 2);
    }
    const changes = {
      summary: args.title, description: args.description, location: args.location,
      ...(times ? { start: times.start, end: times.end } : {}),
    };
    const result = await calendar.updateEvent({ eventId: args.eventId, event, changes, invite: args.invite, uninvite: args.uninvite, notify: args.notify });
    const clashes = times ? await overlapping(calendar, times, timeZone, event.id) : [];
    const told = result.invited.length || result.removed.length || args.notify;
    if (args.json) {
      stdout.write(`${JSON.stringify({
        ...eventJson(result.event), time_zone: timeZone, invited: result.invited, removed: result.removed,
        already_invited: result.alreadyInvited, not_invited: result.notInvited, notified: Boolean(told), overlaps: clashes.map(eventJson),
      }, null, 2)}\n`);
      return 0;
    }
    const changed = [
      args.title !== undefined ? 'title' : null, times ? 'time' : null, args.location !== undefined ? 'place' : null,
      args.description !== undefined ? 'description' : null, result.invited.length || result.removed.length ? 'attendees' : null,
    ].filter(Boolean);
    const lines = [
      `Changed the ${changed.join(', ')} of "${result.event.summary || '(no title)'}" on your calendar: ${describeWhen(result.event, timeZone)} (${timeZone})`,
      `id: ${result.event.id}`,
      result.invited.length ? `Invited, and emailed by Google: ${result.invited.join(', ')}` : null,
      result.removed.length ? `Removed, and told by Google: ${result.removed.join(', ')}` : null,
      result.alreadyInvited.length ? `Already invited, left as they were: ${result.alreadyInvited.join(', ')}` : null,
      result.notInvited.length ? `Not on the list, so not removed: ${result.notInvited.join(', ')}` : null,
      told ? 'Google emailed the attendees about this change.' : 'Nobody was told of this change.',
      ...clashes.map((c) => `Overlaps: "${c.summary || '(no title)'}" ${describeWhen(c, timeZone)} (id ${c.id})`),
    ].filter(Boolean);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
