#!/usr/bin/env node
// skills/workspace-calendar/cal-get.mjs: the cal-get command. Prints one event whole: title, when (in a
// time zone), where, organizer, every attendee and their answer, the Meet link, whether it repeats,
// its status, link and description. The Calendar calls are agent/providers/workspace-calendar.mjs.
// Documented in skills/workspace-calendar/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createCalendarClient, describeWhen, meetLink, isTimeZone } from '../../agent/providers/workspace-calendar.mjs';
import { htmlToText } from '../../agent/providers/workspace-gmail.mjs';
import { zoneFor, eventJson, person } from './cal-list.mjs';

export const USAGE = 'Usage: cal-get <event id> [--calendar <calendar id or email>] [--tz <time zone>] [--json]';

const ANSWERS = Object.freeze({ accepted: 'yes', declined: 'no', tentative: 'maybe', needsAction: 'no answer' });

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { eventId, calendarId, tz, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: { calendar: { type: 'string' }, tz: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one event at a time, got ${positionals.length}` : 'the event id is required (cal-list prints it)' };
  if (!/^[^\s/]+$/.test(positionals[0])) return { error: `'${positionals[0]}' is not an event id` };
  if (values.tz !== undefined && !isTimeZone(values.tz)) return { error: `--tz '${values.tz}' is not a time zone: use a name like America/Chicago or UTC` };
  return { eventId: positionals[0], calendarId: values.calendar && values.calendar !== 'me' ? values.calendar : 'primary', tz: values.tz, json: values.json === true };
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
  const fail = (message, code = 1) => { stderr.write(`cal-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const calendar = deps.calendar || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createCalendarClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const timeZone = await zoneFor(calendar, args.tz);
    const event = await calendar.getEvent({ calendarId: args.calendarId, eventId: args.eventId });
    if (args.json) {
      stdout.write(`${JSON.stringify({ ...eventJson(event), time_zone: timeZone, description: event.description ?? null }, null, 2)}\n`);
      return 0;
    }
    const attendees = (event.attendees || []).filter((a) => !a.resource);
    const description = event.description ? (/<[a-z][^>]*>/i.test(event.description) ? htmlToText(event.description) : event.description.trim()) : '';
    const lines = [
      `${event.summary || '(no title)'}`,
      `When: ${describeWhen(event, timeZone)} (${timeZone})`,
      event.location ? `Where: ${event.location}` : null,
      event.organizer ? `Organizer: ${event.organizer.self ? `you (${calendar.account})` : person(event.organizer)}` : null,
      attendees.length ? `Attendees (${attendees.length}):` : 'Attendees: none',
      ...attendees.map((a) => `- ${person(a)}${a.self ? ' (you)' : ''}${a.organizer ? ' (organizer)' : ''}: ${ANSWERS[a.responseStatus] || 'no answer'}${a.optional ? ', optional' : ''}`),
      meetLink(event) ? `Meet: ${meetLink(event)}` : null,
      event.recurringEventId || event.recurrence ? 'Repeats: yes (this is one occurrence)' : null,
      event.status && event.status !== 'confirmed' ? `Status: ${event.status}` : null,
      `id: ${event.id}`,
      event.htmlLink ? `link: ${event.htmlLink}` : null,
      description ? `Description:\n${description}` : null,
    ].filter((l) => l !== null);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
