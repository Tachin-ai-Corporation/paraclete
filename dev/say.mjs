#!/usr/bin/env node
// dev/say.mjs: sends your dev instance's agent a chat message from your gcloud account, in the exact
// shape the dashboard writes (the root messages collection: text, timestamp as a Firestore timestamp,
// processed false, sender, sender_name, thread_id, attachments), then follows it: the ears taking it
// in, the mission it becomes, and the agent's replies in the thread, printed as they arrive. It stops
// when that mission has finished and its result was delivered, or when the wait runs out. Never use
// it to answer the agent as if you were its user (DEVELOPING.md section 7).

import { loadContracts } from '../config/contracts.mjs';
import { COLLECTIONS } from '../agent/storage/collections.mjs';
import { AGENT_SENDER } from '../agent/providers/channel.mjs';
import { intakeIdFor } from '../agent/services/ears/intake.mjs';
import { TERMINAL_STATUSES } from '../agent/work/work-schema.mjs';
import { DevError, autoId, devContext, isMain, pollUntil, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/say.mjs "<text>" [--thread <id>] [--wait <seconds>]
Sends the agent on your dev instance a chat message from your gcloud account, then prints what
happens to it and the agent's replies as they arrive.
  --thread  the conversation thread (default dev-<yyyymmdd>, today's date)
  --wait    seconds to follow the conversation (default 180)`;

const DEFAULT_WAIT_SECONDS = 180;
const POLL_MS = 3_000;
const REPLIES_READ = 50;
const THREAD = /^[A-Za-z0-9._-]{1,128}$/;

/** Today's default thread, from your local date: dev-20261017. */
export function defaultThread(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `dev-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * A dashboard message, field for field what the dashboard writes. `timestamp` is a Date, which the
 * Firestore client stores as a Firestore timestamp. Pure.
 *
 * @param {object} o
 * @param {string} o.text
 * @param {string} o.thread
 * @param {string} o.sender      your account's email
 * @param {string} o.senderName
 * @param {Date}   o.at
 * @returns {object}
 */
export function dashboardMessage({ text, thread, sender, senderName, at }) {
  return { text, timestamp: at, processed: false, sender, sender_name: senderName, thread_id: thread, attachments: [] };
}

function parseArgs(argv) {
  const opts = { text: [], thread: null, waitSeconds: DEFAULT_WAIT_SECONDS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--thread') opts.thread = argv[i += 1] ?? '';
    else if (arg === '--wait') {
      const raw = argv[i += 1] ?? '';
      if (!/^\d+$/.test(raw)) throw new DevError(`--wait must be a whole number of seconds, got '${raw}'`, 2);
      opts.waitSeconds = Number(raw);
    } else if (arg.startsWith('--')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
    else opts.text.push(arg);
  }
  if (opts.help) return opts;
  opts.text = opts.text.join(' ');
  if (!opts.text.trim()) throw new DevError(`Say something.\n${USAGE}`, 2);
  if (opts.thread !== null && !THREAD.test(opts.thread)) {
    throw new DevError(`--thread must be letters, digits, '.', '_' or '-', got '${opts.thread}'`, 2);
  }
  return opts;
}

/** Your name as git knows it, or the part of your email before the @. */
async function displayName(ctx, email) {
  const result = await ctx.git(['config', 'user.name']);
  const name = result.code === 0 ? result.stdout.trim() : '';
  return name || email.split('@')[0];
}

/** The agent's newest messages in a thread. Uses the thread_id + timestamp index the installer creates. */
async function agentMessages(db, thread) {
  const rows = await db.query('', COLLECTIONS.messages, [{ field: 'thread_id', op: 'EQUAL', value: { stringValue: thread } }],
    { orderBy: 'timestamp', orderDirection: 'DESCENDING', limit: REPLIES_READ, strict: true });
  return rows.filter((m) => m.sender === AGENT_SENDER)
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('say', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    ctx.instance();
    const sender = await ctx.account();
    const senderName = await displayName(ctx, sender);
    const db = ctx.db();
    const thread = opts.thread || defaultThread(new Date(ctx.now()));

    // The agent's messages already in the thread, so only new ones are printed, whatever the clocks say.
    const seen = new Set((await agentMessages(db, thread)).map((m) => m.id));
    const id = autoId();
    const messagePath = `${COLLECTIONS.messages}/${id}`;
    await db.commit([{
      path: messagePath,
      data: dashboardMessage({ text: opts.text, thread, sender, senderName, at: new Date(ctx.now()) }),
      precondition: { exists: false },
    }]);
    ctx.out(`Sent message ${id} to thread ${thread} as ${sender}. Following it for up to ${opts.waitSeconds} s.`);

    const intakePath = `${COLLECTIONS.intake}/${intakeIdFor('dashboard', id)}`;
    const { ears } = loadContracts();
    const state = { intakeSeen: false, consumedBare: false, workId: null, workStatus: null, replies: 0 };
    const outcome = await pollUntil(async () => {
      let finished = false;
      if (!state.workId) {
        const message = state.intakeSeen ? null : await db.read(messagePath, { strict: true });
        const intake = await db.read(intakePath, { strict: true });
        if (intake && !state.intakeSeen) {
          state.intakeSeen = true;
          ctx.out(`  the ears took it in as ${intakePath}`);
        }
        if (!intake && message?.processed === true) {
          throw new DevError('the ears marked the message processed without taking it in. They drop the same text from '
            + `the same person in the same thread within ${Math.round(ears.dedup_window_ms / 1000)} s, and a message within `
            + `${Math.round(ears.cooldown_ms / 1000)} s of that person's last one.`);
        }
        if (intake?.status === 'failed') throw new DevError(`the brain could not take in ${intakePath}: ${intake.error || 'no error given'}`);
        if (intake?.status === 'consumed' && intake.consumed_by) {
          state.workId = intake.consumed_by;
          ctx.out(`  the brain made it ${COLLECTIONS.work}/${state.workId}`);
        } else if (intake?.status === 'consumed' && !state.consumedBare) {
          state.consumedBare = true;
          ctx.out('  the brain took it without starting or resuming any work');
        }
      }
      if (state.workId) {
        const work = await db.read(`${COLLECTIONS.work}/${state.workId}`, { strict: true });
        if (work && work.status !== state.workStatus) {
          state.workStatus = work.status;
          ctx.out(`  ${state.workId}: ${work.status}`);
        }
        finished = Boolean(work && TERMINAL_STATUSES.includes(work.status) && work.delivery_status !== 'pending');
      }
      for (const reply of await agentMessages(db, thread)) {
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        state.replies += 1;
        ctx.out(`\n--- ${reply.sender_name || AGENT_SENDER} at ${reply.timestamp}\n${reply.text}\n`);
      }
      return finished ? true : undefined;
    }, { timeoutMs: opts.waitSeconds * 1000, intervalMs: POLL_MS, sleep: ctx.sleep, now: ctx.now });

    if (outcome.done) {
      ctx.out(`${state.workId} is ${state.workStatus}; its result was delivered.`);
      return 0;
    }
    const where = state.workId ? `${COLLECTIONS.work}/${state.workId} is ${state.workStatus || 'not readable'}` : 'no mission yet';
    ctx.out(`Stopped following after ${opts.waitSeconds} s (${where}). Follow up with node dev/status.mjs`
      + `${state.workId ? ` or node dev/query.mjs work --doc ${state.workId}` : ''}.`);
    return state.replies > 0 ? 0 : 1;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
