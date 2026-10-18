#!/usr/bin/env node
// dev/smoke.mjs: one smoke test of your dev instance's role. It reads the role the VM runs (its
// /etc/paraclete/instance.json, over IAP SSH), picks a request in that role's area that changes
// nothing (SMOKE_REQUESTS), sends it the way dev/say.mjs does (a dashboard message from your gcloud
// account, in a new thread of its own), follows it to the end, and says PASS or FAIL: the mission
// finished and its result was delivered, and the answer says what a correct one must. A question back,
// an approval gate or a failure is a FAIL. It exists for the build plan's role check (an install of
// generic, a Workspace role and one other role each passing a smoke mission), after a move between
// roles with install/install.sh --role (install/README.md). Never use it on an instance someone relies
// on (DEVELOPING.md section 7).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from '../agent/storage/collections.mjs';
import { AGENT_SENDER } from '../agent/providers/channel.mjs';
import { intakeIdFor } from '../agent/services/ears/intake.mjs';
import { TERMINAL_STATUSES } from '../agent/work/work-schema.mjs';
import { dashboardMessage } from './say.mjs';
import { DevError, REPO_ROOT, autoId, devContext, isMain, pollUntil, preview, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/smoke.mjs [--role <id>] [--doc <Google Doc link>] [--request "<text>" [--expect <regex>]] [--wait <seconds>]
Sends the agent on your dev instance one request in its role's area that changes nothing, follows it,
and says PASS or FAIL. The role is the one the VM runs, unless --role names one.
  --role     the role whose request to send (default: read from the VM)
  --doc      a Workspace role: summarize this Google Doc instead of listing today's calendar
  --request  send this instead of the role's request; --expect then says what the answer must match
  --wait     seconds to wait for the result (default 900)`;

const DEFAULT_WAIT_SECONDS = 900;
const POLL_MS = 5_000;
const REPLIES_READ = 50;
const ROLE_ID = /^[a-z][a-z0-9-]*$/;
/** A mission that stops here waits on a person: a smoke request must never need one. */
const WAITING_ON_A_PERSON = new Set(['needs_input', 'blocked', 'awaiting_approval']);

/**
 * The smoke request per role: read-only, answerable on any instance, and checkable. `expect` lists
 * what a correct answer must contain (case-insensitive regex sources, all of them). Workspace roles
 * share one (a Workspace account at work); a role not listed here gets the generic request, or the
 * Workspace one when its role.json sets `workspace`.
 */
export const SMOKE_REQUESTS = Object.freeze({
  generic: {
    about: 'a short research answer',
    text: 'Find out which RFC numbers define HTTP/2 (the original one and the one that replaced it) and answer in two sentences, naming both RFCs.',
    expect: ['7540', '9113'],
  },
  'devops-engineer': {
    about: 'a read-only look at Cloud Run',
    text: 'Read only, change nothing: list the Cloud Run services in this project with their regions and URLs.',
    expect: ['paraclete'],
  },
  'security-engineer': {
    about: 'a read-only IAM review',
    text: 'Read only, change nothing: list the service accounts in this project and the project roles each one holds.',
    expect: ['paraclete-agent'],
  },
  'data-engineer': {
    about: 'a read-only look at BigQuery',
    text: 'Read only, change nothing: list the BigQuery datasets in this project with their locations, or say plainly that there are none.',
    expect: ['dataset'],
  },
  'software-engineer': {
    about: 'a read-only look at a repository',
    text: 'Read only, change nothing: clone {repo} from GitHub and tell me in two sentences what it is and which language most of its code is in.',
    expect: ['javascript|node'],
  },
  'qa-engineer': {
    about: 'a read-only check of the test tools',
    text: 'Read only, change nothing: run node --version and python3 --version on your VM and report both versions exactly as printed.',
    expect: ['v\\d+\\.\\d+', 'python 3\\.'],
  },
  'web-master': {
    about: 'a read-only site check',
    text: 'Read only, change nothing: fetch https://example.com and report its HTTP status code and its page title.',
    expect: ['200', 'example domain'],
  },
});

/** What a Workspace role is asked: its own calendar, or a Doc when one is given. */
const WORKSPACE_REQUEST = Object.freeze({
  about: "a read of the agent's own calendar",
  text: 'Read only, change nothing: list the events on your own Google Calendar for today with their times. If there are none, say so plainly.',
  expect: [],
});
const DOC_REQUEST = Object.freeze({
  about: 'a summary of a Google Doc',
  text: 'Read only, change nothing: read this Google Doc and summarize it in three bullet points: {doc}',
  expect: [],
});

/**
 * The request for one role. Pure.
 *
 * @param {object}  o
 * @param {string}  o.role
 * @param {boolean} [o.workspace] whether the role's role.json sets `workspace`
 * @param {string}  [o.doc]       a Google Doc link, for a Workspace role
 * @param {string}  [o.repo]      owner/name of the repository the instance was installed from (the
 *   software-engineer request reads it)
 * @returns {{about: string, text: string, expect: string[]}}
 */
export function smokeRequest({ role, workspace = false, doc = '', repo = '' }) {
  let chosen;
  if (workspace) chosen = doc ? DOC_REQUEST : WORKSPACE_REQUEST;
  else chosen = SMOKE_REQUESTS[role] || SMOKE_REQUESTS.generic;
  return {
    about: chosen.about,
    text: chosen.text.replaceAll('{doc}', doc).replaceAll('{repo}', `https://github.com/${repo}`),
    expect: [...chosen.expect],
  };
}

/**
 * The verdict on a followed request. Pure.
 *
 * @param {object}   o
 * @param {object}   [o.work]     the mission, when the request became one
 * @param {boolean}  o.responded  the brain answered without a mission
 * @param {string[]} o.replies    the agent's replies in the thread
 * @param {string[]} o.expect     regex sources the answer must all match
 * @returns {{pass: boolean, reason: string}}
 */
export function verdict({ work = null, responded = false, replies = [], expect = [] }) {
  if (work && WAITING_ON_A_PERSON.has(work.status)) {
    const why = work.blocker || work.output || work.error || '';
    return { pass: false, reason: `the mission stopped as ${work.status}${why ? `: ${preview(why, 200)}` : ''}; a smoke request must need no one` };
  }
  if (work && work.status !== 'complete') {
    return { pass: false, reason: `the mission ended ${work.status}${work.error ? `: ${preview(work.error, 200)}` : ''}` };
  }
  if (!work && !responded) return { pass: false, reason: 'the request never became a mission or an answer' };
  if (replies.length === 0) return { pass: false, reason: 'the agent said nothing in the thread' };
  const answer = [...replies, work?.output || ''].join('\n');
  const missing = expect.filter((source) => !new RegExp(source, 'i').test(answer));
  if (missing.length) return { pass: false, reason: `the answer does not mention ${missing.map((m) => `/${m}/`).join(', ')}` };
  return { pass: true, reason: work ? 'the mission completed and its result was delivered' : 'the agent answered at once' };
}

function parseArgs(argv) {
  const opts = { role: null, doc: '', request: '', expect: [], waitSeconds: DEFAULT_WAIT_SECONDS, help: false };
  const value = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new DevError(`${name} needs a value\n${USAGE}`, 2);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--role') opts.role = value(i += 1, '--role');
    else if (arg === '--doc') opts.doc = value(i += 1, '--doc');
    else if (arg === '--request') opts.request = value(i += 1, '--request');
    else if (arg === '--expect') opts.expect.push(value(i += 1, '--expect'));
    else if (arg === '--wait') {
      const raw = value(i += 1, '--wait');
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new DevError(`--wait must be a whole number of seconds, got '${raw}'`, 2);
      opts.waitSeconds = Number(raw);
    } else throw new DevError(`Unknown argument: ${arg}\n${USAGE}`, 2);
  }
  if (opts.help) return opts;
  if (opts.role !== null && !ROLE_ID.test(opts.role)) throw new DevError(`'${opts.role}' is not a role id`, 2);
  if (opts.doc && !/^https:\/\/docs\.google\.com\/document\/\S+$/.test(opts.doc)) {
    throw new DevError(`--doc must be a Google Doc link (https://docs.google.com/document/...), got '${opts.doc}'`, 2);
  }
  if (opts.expect.length && !opts.request) throw new DevError('--expect goes with --request', 2);
  for (const source of opts.expect) {
    try { new RegExp(source, 'i'); } catch (err) { throw new DevError(`--expect ${source}: ${err.message}`, 2); }
  }
  return opts;
}

/** The instance record the VM runs with, read over IAP SSH. */
async function vmInstance(ctx) {
  // /etc/paraclete is root and the agent's only (bootstrap.sh); the developer's SSH user reads it with sudo.
  const result = await ctx.ssh('sudo -n cat /etc/paraclete/instance.json');
  let record = null;
  try { record = JSON.parse(result.stdout); } catch { /* reported below */ }
  if (result.code !== 0 || !record || typeof record.role !== 'string') {
    throw new DevError(`could not read /etc/paraclete/instance.json on the VM (exit ${result.code}). Is it running? See node dev/status.mjs.`);
  }
  return record;
}

/** owner/name of a GitHub remote URL (https or ssh), or '' when it is not one. */
export function githubRepo(url) {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? m[1] : '';
}

/** Whether this clone's role.json for `role` sets `workspace`; null when the clone has no such role. */
function roleIsWorkspace(role, readRole) {
  try {
    return JSON.parse(readRole(role)).workspace === true;
  } catch {
    return null;
  }
}

/** The agent's messages in a thread, oldest first. */
async function agentMessages(db, thread) {
  const rows = await db.query('', COLLECTIONS.messages, [{ field: 'thread_id', op: 'EQUAL', value: { stringValue: thread } }],
    { orderBy: 'timestamp', orderDirection: 'DESCENDING', limit: REPLIES_READ, strict: true });
  return rows.filter((m) => m.sender === AGENT_SENDER).sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
}

/** A thread of its own for each run: smoke-<role>-<yyyymmddhhmmss>, from your local time. */
export function smokeThread(role, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `smoke-${role}-${stamp}`.slice(0, 128);
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs, plus:
 * @param {Function} [deps.readRole] (role) => the text of roles/<role>/role.json in this clone
 * @returns {Promise<number>} exit code: 0 PASS, 1 FAIL, 2 a usage mistake
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  const readRole = deps.readRole || ((role) => readFileSync(join(REPO_ROOT, 'roles', role, 'role.json'), 'utf8'));
  return runCommand('smoke', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    ctx.instance();

    let role = opts.role;
    let record = null;
    if (!role) {
      record = await vmInstance(ctx);
      role = record.role;
    }
    const workspace = roleIsWorkspace(role, readRole);
    if (workspace === null && !opts.request) {
      throw new DevError(`this clone has no role '${role}' (roles/${role}/role.json); pull the branch the instance runs, or pass --request`);
    }
    if (workspace && record && !record.workspace && !opts.request) {
      throw new DevError(`${role} is a Workspace role, and the instance has no Workspace account yet. Set it up in the `
        + "dashboard's Workspace setup first, then run this again.");
    }
    if (opts.doc && !workspace && !opts.request) throw new DevError(`--doc is for a Workspace role; ${role} is not one`, 2);
    let repo = record?.source_repo || '';
    const needsRepo = !opts.request && !workspace && SMOKE_REQUESTS[role]?.text.includes('{repo}');
    if (needsRepo && !repo) {
      const origin = await ctx.git(['remote', 'get-url', 'origin']);
      repo = origin.code === 0 ? githubRepo(origin.stdout) : '';
      if (!repo) throw new DevError(`the ${role} request names the repository the instance came from, and neither the VM nor this clone's origin says which; pass --request`);
    }
    const request = opts.request
      ? { about: 'your request', text: opts.request, expect: opts.expect }
      : smokeRequest({ role, workspace: Boolean(workspace), doc: opts.doc, repo });

    const sender = await ctx.account();
    const db = ctx.db();
    const thread = smokeThread(role, new Date(ctx.now()));
    const id = autoId();
    const messagePath = `${COLLECTIONS.messages}/${id}`;
    await db.commit([{
      path: messagePath,
      data: dashboardMessage({ text: request.text, thread, sender, senderName: 'smoke test', at: new Date(ctx.now()) }),
      precondition: { exists: false },
    }]);
    ctx.out(`Smoke test of role ${role} (${request.about}), as ${sender} in thread ${thread}:`);
    ctx.out(`  "${request.text}"`);
    if (request.expect.length) ctx.out(`  the answer must match ${request.expect.map((e) => `/${e}/i`).join(' and ')}`);

    const intakePath = `${COLLECTIONS.intake}/${intakeIdFor('dashboard', id)}`;
    const state = { intakeSeen: false, responded: false, workId: null, work: null, replies: [], seen: new Set() };
    const outcome = await pollUntil(async () => {
      for (const reply of await agentMessages(db, thread)) {
        if (state.seen.has(reply.id)) continue;
        state.seen.add(reply.id);
        state.replies.push(String(reply.text || ''));
        ctx.out(`\n--- ${reply.sender_name || AGENT_SENDER} at ${reply.timestamp}\n${reply.text}\n`);
      }
      if (!state.workId) {
        const intake = await db.read(intakePath, { strict: true });
        if (intake && !state.intakeSeen) {
          state.intakeSeen = true;
          ctx.out(`  the ears took it in as ${intakePath}`);
        }
        if (!intake && (await db.read(messagePath, { strict: true }))?.processed === true) {
          throw new DevError('the ears marked the message processed without taking it in (a duplicate, or one too soon after your last)');
        }
        if (intake?.status === 'failed') return 'done';
        if (intake?.status === 'consumed' && intake.consumed_by) {
          state.workId = intake.consumed_by;
          ctx.out(`  the brain made it ${COLLECTIONS.work}/${state.workId}`);
        } else if (intake?.status === 'consumed' && !state.responded) {
          state.responded = true;
          ctx.out('  the brain answered it without a mission');
        }
        if (state.responded && state.replies.length > 0) return 'done';
      }
      if (state.workId) {
        const work = await db.read(`${COLLECTIONS.work}/${state.workId}`, { strict: true });
        if (work && work.status !== state.work?.status) ctx.out(`  ${state.workId}: ${work.status}`);
        state.work = work;
        if (work && WAITING_ON_A_PERSON.has(work.status)) return 'done';
        if (work && TERMINAL_STATUSES.includes(work.status) && work.delivery_status !== 'pending') {
          // The delivered result is a reply in the thread; read once more so it is in the verdict.
          for (const reply of await agentMessages(db, thread)) {
            if (state.seen.has(reply.id)) continue;
            state.seen.add(reply.id);
            state.replies.push(String(reply.text || ''));
            ctx.out(`\n--- ${reply.sender_name || AGENT_SENDER} at ${reply.timestamp}\n${reply.text}\n`);
          }
          return 'done';
        }
      }
      return undefined;
    }, { timeoutMs: opts.waitSeconds * 1000, intervalMs: POLL_MS, sleep: ctx.sleep, now: ctx.now });

    let result;
    if (!outcome.done) {
      result = { pass: false, reason: `no result within ${opts.waitSeconds} s (${state.workId ? `${state.workId} is ${state.work?.status || 'unreadable'}` : 'no mission yet'})` };
    } else if (!state.workId && !state.responded) {
      const intake = await db.read(intakePath, { strict: true });
      result = { pass: false, reason: `the brain could not take the request in: ${intake?.error || 'no error given'}` };
    } else {
      result = verdict({ work: state.work, responded: state.responded, replies: state.replies, expect: request.expect });
    }
    ctx.out(`${result.pass ? 'PASS' : 'FAIL'}: role ${role}, ${request.about}: ${result.reason}.`);
    if (state.workId) ctx.out(`The mission: node dev/query.mjs work --doc ${state.workId}`);
    return result.pass ? 0 : 1;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
