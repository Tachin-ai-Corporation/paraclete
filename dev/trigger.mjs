#!/usr/bin/env node
// dev/trigger.mjs: runs one of your dev instance's responsibilities now, the way the dashboard's
// "run now" does. It writes a responsibility_triggers document in the exact shape the control service
// writes (agent/services/control/responsibilities.mjs, runResponsibility), requested by your gcloud
// account, then waits for the brain's scheduler to claim it and mark it fired, skipped or error; one
// still unclaimed when the wait runs out is withdrawn. A trigger made here has no command document;
// its command_id is its own id, as a control trigger's id is its command's.

import { COLLECTIONS } from '../agent/storage/collections.mjs';
import { ID_PATTERN } from '../agent/work/work-ids.mjs';
import { DevError, autoId, devContext, isMain, pollUntil, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/trigger.mjs <responsibility-id> [--timeout <seconds>]
Asks the brain on your dev instance to run one responsibility now, as the dashboard's "run now"
does, then waits for it to be fired, skipped or refused (default 120 s). A trigger the brain has
not claimed when the wait runs out is withdrawn, so it cannot fire later.`;

const DEFAULT_TIMEOUT_SECONDS = 120;
const POLL_MS = 3_000;
const OUTCOMES = new Set(['fired', 'skipped', 'error']);

/**
 * The trigger document, field for field what the control service's run_responsibility writes. Pure.
 *
 * @param {object} o
 * @param {string} o.responsibilityId
 * @param {string} o.triggerId    the document id, also recorded as command_id
 * @param {string} o.requestedBy  your account's email
 * @param {string} o.requestedAt  ISO 8601 UTC
 * @returns {object}
 */
export function triggerDoc({ responsibilityId, triggerId, requestedBy, requestedAt }) {
  return {
    responsibility_id: responsibilityId,
    status: 'pending',
    bypass_spacing: true,
    requested_by: requestedBy,
    requested_at: requestedAt,
    command_id: triggerId,
  };
}

function parseArgs(argv) {
  const opts = { id: null, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--timeout') {
      const raw = argv[i += 1] ?? '';
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new DevError(`--timeout must be a whole number of seconds, got '${raw}'`, 2);
      opts.timeoutSeconds = Number(raw);
    } else if (arg.startsWith('-')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
    else if (opts.id) throw new DevError(`One responsibility at a time, got '${opts.id}' and '${arg}'`, 2);
    else opts.id = arg;
  }
  if (opts.help) return opts;
  if (!opts.id) throw new DevError(`Name the responsibility to run.\n${USAGE}`, 2);
  if (!ID_PATTERN.test(opts.id)) {
    throw new DevError(`'${opts.id}' is not a responsibility id (lowercase letters, digits and dashes)`, 2);
  }
  return opts;
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('trigger', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    ctx.instance();
    const requestedBy = await ctx.account();
    const db = ctx.db();
    const triggerId = autoId();
    const path = `${COLLECTIONS.responsibilityTriggers}/${triggerId}`;
    const doc = triggerDoc({ responsibilityId: opts.id, triggerId, requestedBy, requestedAt: new Date(ctx.now()).toISOString() });
    await db.commit([{ path, data: doc, precondition: { exists: false } }]);
    ctx.out(`Trigger ${triggerId} asks the brain to run ${opts.id} now (requested by ${requestedBy}).`);

    let seen = 'pending';
    const outcome = await pollUntil(async () => {
      const current = await db.read(path, { strict: true });
      if (!current) throw new DevError(`${path} disappeared before the brain marked it`);
      if (current.status !== seen) {
        seen = current.status;
        if (!OUTCOMES.has(seen)) ctx.out(`  ${seen}`);
      }
      return OUTCOMES.has(current.status) ? current : undefined;
    }, { timeoutMs: opts.timeoutSeconds * 1000, intervalMs: POLL_MS, sleep: ctx.sleep, now: ctx.now });

    if (!outcome.done) {
      // A trigger nobody claimed would fire whenever the brain next runs, long after you stopped
      // watching. Take it back while it is still unclaimed; a claimed one is the brain's.
      const withdrawn = seen === 'pending' && (await db.read(path, { strict: true }))?.status === 'pending'
        && await db.del(path, { strict: true });
      throw new DevError(`the brain did not mark trigger ${triggerId} within ${opts.timeoutSeconds} s (it is ${seen})`
        + `${withdrawn ? '; it was withdrawn so it cannot fire later' : ''}. Is the brain running? `
        + 'See node dev/status.mjs and node dev/logs.mjs brain.');
    }
    const result = outcome.value;
    ctx.out(`${result.status}${result.detail ? `: ${result.detail}` : ''}${result.fired_at ? ` (at ${result.fired_at})` : ''}`);
    if (result.status !== 'fired') return 1;
    ctx.out(`Its mission: node dev/query.mjs work --where type=M --where source_meta.responsibility_id=${opts.id}`);
    return 0;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
