#!/usr/bin/env node
// skills/workspace-calendar/cal-freebusy.mjs: the cal-freebusy command. Shows when people are busy in a
// window (Calendar's free/busy, which most organizations share even when the events themselves are
// private), and with --slots the free time they all share: gaps of at least that many minutes inside
// working hours on weekdays. A person whose calendar the agent cannot see is reported as unknown, never
// as free. The Calendar calls and the interval arithmetic are agent/providers/workspace-calendar.mjs.
// Documented in skills/workspace-calendar/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import {
  createCalendarClient, describeInstant, freeSlots, formatRfc3339, MAX_FREEBUSY_PEOPLE,
} from '../../agent/providers/workspace-calendar.mjs';
import { WINDOW_OPTIONS, windowProblem, windowFor, zoneFor, emailList } from './cal-list.mjs';

export const USAGE = [
  'Usage: cal-freebusy <email|me> [<email> ...] [--from <date or time>] [--to <date or time> | --days <n>] [--tz <time zone>]',
  '                    [--slots <minutes> [--hours <HH:MM-HH:MM>] [--weekends]] [--json]',
].join('\n');

const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;

/** "Tue 2026-10-20 09:00-10:00", or both ends in full when they fall on different days. */
function span(start, end, timeZone) {
  const a = describeInstant(start, timeZone);
  const b = describeInstant(end, timeZone);
  return a.slice(0, 14) === b.slice(0, 14) ? `${a}-${b.slice(15)}` : `${a} to ${b}`;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { people, window, slots, hours, weekends, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        ...WINDOW_OPTIONS, slots: { type: 'string' }, hours: { type: 'string' }, weekends: { type: 'boolean' },
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const me = positionals.some((p) => p.split(',').map((s) => s.trim()).includes('me'));
  const { emails, bad } = emailList(positionals.flatMap((p) => p.split(',')).filter((p) => p.trim() !== 'me'));
  if (bad.length) return { error: `not email addresses: ${bad.join(', ')}` };
  if (!emails.length && !me) return { error: "name at least one person by email (or 'me' for your own calendar)" };
  if (emails.length + (me ? 1 : 0) > MAX_FREEBUSY_PEOPLE) return { error: `at most ${MAX_FREEBUSY_PEOPLE} people at once` };
  const problem = windowProblem(values);
  if (problem) return { error: problem };
  let slots = null;
  if (values.slots !== undefined) {
    slots = Number(values.slots);
    if (!Number.isInteger(slots) || slots < 5 || slots > 1440) return { error: '--slots must be a whole number of minutes from 5 to 1440' };
  } else if (values.hours !== undefined || values.weekends) {
    return { error: '--hours and --weekends shape --slots: add --slots <minutes>' };
  }
  let hours = ['09:00', '17:00'];
  if (values.hours !== undefined) {
    const m = HOURS.exec(values.hours);
    if (!m || `${m[3]}:${m[4]}` <= `${m[1]}:${m[2]}`) return { error: '--hours must be HH:MM-HH:MM, the end after the start, like 09:00-17:30' };
    hours = [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`];
  }
  return {
    people: [...(me ? ['me'] : []), ...emails],
    window: { from: values.from, to: values.to, days: values.days, tz: values.tz },
    slots, hours, weekends: values.weekends === true, json: values.json === true,
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime]  from createCliRuntime()
 * @param {object} [deps.calendar] from createCalendarClient()
 * @param {Function} [deps.now]    clock in milliseconds
 * @returns {Promise<number>} 0, 1 when Calendar refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`cal-freebusy: ${message}\n`); return code; };

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
    const people = args.people.map((p) => (p === 'me' ? calendar.account : p));
    const result = await calendar.freeBusy({ people, timeMin: window.timeMin, timeMax: window.timeMax, timeZone });
    const known = result.filter((r) => !r.errors.length);
    const unknown = result.filter((r) => r.errors.length);
    const slots = args.slots
      ? freeSlots({ busy: known.flatMap((r) => r.busy), from: window.from, to: window.to, timeZone, minutes: args.slots, hours: args.hours, weekends: args.weekends })
      : null;

    if (args.json) {
      stdout.write(`${JSON.stringify({
        time_zone: timeZone, from: window.timeMin, to: window.timeMax,
        people: result.map((r) => ({ email: r.id, busy: r.busy, unknown: r.errors.length ? r.errors : null })),
        free: slots ? slots.map((s) => ({ start: formatRfc3339(s.start, timeZone), end: formatRfc3339(s.end, timeZone) })) : null,
        free_leaves_out: slots ? unknown.map((r) => r.id) : null,
      }, null, 2)}\n`);
      return 0;
    }

    const lines = [`Busy times, ${describeInstant(window.from, timeZone)} to ${describeInstant(window.to, timeZone)} (${timeZone}):`];
    for (const r of result) {
      if (r.errors.length) {
        lines.push(`${r.id}: unknown: ${calendar.account} cannot see this calendar's free/busy (${r.errors.join(', ')}). Not the same as free.`);
        continue;
      }
      lines.push(`${r.id}: ${r.busy.length ? `${r.busy.length} busy block${r.busy.length === 1 ? '' : 's'}` : 'free the whole window'}`);
      for (const b of r.busy) lines.push(`  - ${span(Date.parse(b.start), Date.parse(b.end), timeZone)}`);
    }
    if (slots) {
      lines.push(`Free for ${known.length === 1 ? known[0].id : `all ${known.length}`}, at least ${args.slots} minutes, ${args.hours[0]}-${args.hours[1]} ${args.weekends ? 'every day' : 'on weekdays'}:`);
      if (!known.length) lines.push('  (nobody\'s calendar could be read, so no free time can be said)');
      else if (!slots.length) lines.push('  none in this window');
      else for (const s of slots) lines.push(`  - ${span(s.start, s.end, timeZone)}`);
      if (unknown.length && known.length) lines.push(`These free times leave out ${unknown.map((r) => r.id).join(', ')}, whose calendar${unknown.length === 1 ? '' : 's'} could not be read.`);
    }
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
