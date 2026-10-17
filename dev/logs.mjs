#!/usr/bin/env node
// dev/logs.mjs: reads a service's journal on your dev instance's VM over IAP:
// `sudo journalctl -u paraclete-<service>.service -n <lines> [-f] -o cat`, or every paraclete unit at
// once. The services log one JSON object per line; each is printed as one readable line (time, level,
// service, message, then the other fields as key=value). Anything else is printed as it came.
// It changes nothing on the VM.

import { SERVICES, serviceUnit } from '../agent/services/control/systemd.mjs';
import { DevError, devContext, isMain, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/logs.mjs <service|all> [--lines N] [--follow]
Prints a service's journal from your dev instance's VM, one readable line per log entry.
  <service>  ${SERVICES.join(', ')}, or all for every paraclete unit
  --lines    how many recent lines (default 100, at most 10000)
  --follow   keep printing new lines until you press Ctrl+C (also -f)`;

const DEFAULT_LINES = 100;
const MAX_LINES = 10_000;

function parseArgs(argv) {
  const opts = { service: null, lines: DEFAULT_LINES, follow: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--follow' || arg === '-f') opts.follow = true;
    else if (arg === '--lines' || arg === '-n') {
      const raw = argv[i += 1];
      if (!/^\d+$/.test(raw ?? '') || Number(raw) < 1 || Number(raw) > MAX_LINES) {
        throw new DevError(`--lines must be a whole number from 1 to ${MAX_LINES}, got '${raw ?? ''}'`, 2);
      }
      opts.lines = Number(raw);
    } else if (arg.startsWith('-')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
    else if (opts.service) throw new DevError(`One service at a time (or all), got '${opts.service}' and '${arg}'`, 2);
    else opts.service = arg;
  }
  if (opts.help) return opts;
  if (!opts.service) throw new DevError(`Name a service.\n${USAGE}`, 2);
  if (opts.service !== 'all' && !SERVICES.includes(opts.service)) {
    throw new DevError(`'${opts.service}' is not a paraclete service (one of ${SERVICES.join(', ')}, or all)`, 2);
  }
  return opts;
}

/**
 * The journalctl command run on the VM. Every unit name comes from the services list.
 *
 * @param {{service: string, lines: number, follow: boolean}} opts
 * @returns {string}
 */
export function journalCommand({ service, lines, follow }) {
  const services = service === 'all' ? SERVICES : [service];
  return ['sudo journalctl', ...services.map((s) => `-u ${serviceUnit(s)}`), `-n ${lines}`, ...(follow ? ['-f'] : []), '-o cat', '--no-pager'].join(' ');
}

function formatValue(value) {
  if (typeof value === 'string' && value && !/[\s"=]/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * One journal line as a readable line. A service's JSON log line becomes
 * `<time> <LEVEL> <service> <message>  key=value ...`; any other line is returned unchanged. Pure.
 *
 * @param {string} line
 * @returns {string}
 */
export function formatLogLine(line) {
  const text = String(line).replace(/\r$/, '');
  if (!text.startsWith('{')) return text;
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return text;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return text;
  const { time, level, service, message, ...fields } = entry;
  const head = [time ?? '-', String(level ?? '-').padEnd(5), service ?? '-', message ?? ''].join(' ');
  const rest = Object.entries(fields).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ');
  return rest ? `${head}  ${rest}` : head;
}

/**
 * Turns a stream of chunks into whole lines, each formatted and written as it completes.
 *
 * @param {Function} write (text) => void
 * @returns {{push: (chunk: string) => void, end: () => void}}
 */
export function createLineWriter(write) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) write(`${formatLogLine(line)}\n`);
    },
    end() {
      if (pending) write(`${formatLogLine(pending)}\n`);
      pending = '';
    },
  };
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('logs', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    const lines = createLineWriter((text) => ctx.stdout.write(text));
    const result = await ctx.ssh(journalCommand(opts), { onStdout: (chunk) => lines.push(chunk), collect: false });
    lines.end();
    if (result.code !== 0 && !(opts.follow && result.signal)) {
      throw new DevError(`gcloud compute ssh exited with code ${result.code} (its messages are above)`);
    }
    return 0;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
