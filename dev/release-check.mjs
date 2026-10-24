#!/usr/bin/env node
// dev/release-check.mjs: checks main's head on your dev instance, then cuts it as a release. Instances
// install new releases by themselves (dashboard/lib/server/auto-update.mjs, forward only), so a release
// is run on a dev instance first, the way every instance will run it:
//
//   1. release  the preconditions dev/release.mjs enforces (its checkCandidate): a clean main equal to
//               origin, a head whose subject starts with a version newer than every version tag, and
//               every CI check run on the head passed. A head whose version origin has tagged already
//               has nothing to release: it says so and exits 0;
//   2. deploy   `node dev/deploy.mjs <commit>`: the VM through the release upgrader, then the
//               dashboard (`--vm-only`: the VM only, for an instance without a dashboard);
//   3. status   `node dev/status.mjs --json` (with `--vm-only` passed on): every service up, and the
//               VM, agent/instance and the dashboard on the head commit;
//   4. smoke    `node dev/smoke.mjs`: the installed role's smoke request PASSes;
//   5. tag      unless `--no-release`: step 1's checks once more, since the check takes a while (a
//               newer version tagged meanwhile, or a moved main, refuses), then the release, cut as
//               dev/release.mjs cuts it (pushReleaseTag), with this check's summary in the annotated
//               tag's message.
//
// Each step runs as a child process, its output streamed as it comes; a failure stops before the tag
// (exit 1). The summary names the time, the commit, the status and the smoke verdict with its mission,
// never the project, the VM or a URL: the tag is public. `--json` prints the summary as one JSON
// object on stdout, and everything else on stderr. It runs on a maintainer's machine against the dev
// instance in .local/instance.env (DEVELOPING.md sections 7 and 10), and is never installed.

import { join } from 'node:path';
import { REMOTE, checkCandidate, pushReleaseTag, showNotes } from './release.mjs';
import { readSmokeVerdict } from './smoke.mjs';
import { DevError, REPO_ROOT, devContext, isMain, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/release-check.mjs [--vm-only] [--no-release] [--wait <seconds>] [--json]
Checks main's head on your dev instance before it is released: the checks dev/release.mjs makes, then
node dev/deploy.mjs <commit>, node dev/status.mjs and node dev/smoke.mjs. When every step passes, it
cuts the release as dev/release.mjs does, with the check's summary in the tag's message.
  --vm-only     the instance has no dashboard: move and check its VM only
  --no-release  check, and tag nothing
  --wait        seconds the smoke test waits for its result (dev/smoke.mjs's own default unless given)
  --json        print the summary as one JSON object on stdout; everything else goes to stderr`;

/** How many steps a check has, for the progress lines. */
const STEPS = 5;

function parseArgs(argv) {
  const opts = { vmOnly: false, release: true, waitSeconds: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--vm-only') opts.vmOnly = true;
    else if (arg === '--no-release') opts.release = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--wait') {
      const raw = argv[i += 1];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new DevError(`--wait must be a whole number of seconds, got '${raw ?? ''}'\n${USAGE}`, 2);
      }
      opts.waitSeconds = Number(raw);
    } else throw new DevError(`Unknown argument: ${arg}\n${USAGE}`, 2);
  }
  return opts;
}

/**
 * The lines of a passed check, for the annotated tag's message and the end of the output. Names no
 * project, VM or URL: the tag is public. Pure.
 *
 * @param {object} o
 * @param {string} o.checkedAt   when the smoke test passed, ISO
 * @param {string} o.commit
 * @param {boolean} o.vmOnly
 * @param {{role: string, about: string, mission: string|null}} o.smoke
 * @returns {string[]}
 */
export function checkSummary({ checkedAt, commit, vmOnly, smoke }) {
  return [
    `- time: ${checkedAt}`,
    `- commit: ${commit}`,
    vmOnly ? '- deploy: the VM moved to the commit (--vm-only: the instance has no dashboard)' : '- deploy: the VM, then the dashboard, moved to the commit',
    `- status: ok; every service up, the VM and agent/instance${vmOnly ? '' : ' and the dashboard'} on the commit`,
    `- smoke: PASS, role ${smoke.role} (${smoke.about}), ${smoke.mission ? `mission ${smoke.mission}` : 'answered without a mission'}`,
  ];
}

/**
 * The annotated tag's message: dev/release.mjs's own first line, then the check's summary. Pure.
 *
 * @param {string} version
 * @param {string[]} summary checkSummary()
 * @returns {string}
 */
export function tagMessage(version, summary) {
  return [`Release ${version}`, '', 'Checked on a dev instance before release (dev/release-check.mjs):', ...summary].join('\n');
}

/**
 * What status reported against the commit the check deployed. Pure.
 *
 * @param {object} report    dev/status.mjs --json
 * @param {string} commit
 * @param {boolean} vmOnly
 * @returns {{vm: string|null, agent: string|null, dashboard: string|null, problems: string[]}}
 */
export function statusAgainst(report, commit, vmOnly) {
  const vm = report?.release?.commit || null;
  const agent = report?.agent_instance?.commit || null;
  const dashboard = report?.dashboard?.commit || null;
  const problems = Array.isArray(report?.problems) ? [...report.problems] : ['the report lists no problems field'];
  if (vm !== commit) problems.push(`the VM has ${vm || 'no commit'} installed, not ${commit}`);
  if (agent !== commit) problems.push(`agent/instance reports ${agent || 'no commit'}, not ${commit}`);
  if (!vmOnly && dashboard !== commit) problems.push(`the dashboard runs ${dashboard || 'no commit'}, not ${commit}`);
  return { vm, agent, dashboard: vmOnly ? null : dashboard, problems };
}

/** Runs one dev/ command as a child of this node, its stderr (and stdout, when `show`) streamed. */
async function runDevCommand(view, script, args, { show = true } = {}) {
  const result = await view.exec(process.execPath, [join(REPO_ROOT, 'dev', script), ...args], {
    cwd: REPO_ROOT,
    onStdout: show ? (chunk) => view.stdout.write(chunk) : undefined,
    onStderr: (chunk) => view.stderr.write(chunk),
  });
  if (result.missing) throw new DevError(`node could not start dev/${script}: ${result.stderr || 'no reason given'}`);
  return result;
}

/** The check, step by step, filling `summary` as it goes. */
async function check(view, opts, summary) {
  view.out(`Step 1 of ${STEPS}: is main's head a release? The checks dev/release.mjs makes:`);
  const candidate = await checkCandidate(view);
  const { version, head } = candidate;
  Object.assign(summary, { version, commit: head });
  if (candidate.released) {
    summary.outcome = 'nothing_to_release';
    view.out(`${version} is already tagged at this commit on ${REMOTE}: there is nothing to release, so nothing to check. The release: ${candidate.url}`);
    return 0;
  }
  summary.steps.release = { ok: true, previous: candidate.previous };
  await showNotes(view, candidate);

  const instance = view.instance();
  const vmOnly = opts.vmOnly ? ['--vm-only'] : [];
  view.out(`Checking ${version} on your dev instance, VM ${instance.VM} in ${instance.PROJECT_ID}${opts.vmOnly ? ', the VM only' : ''}.`);

  view.out(`\nStep 2 of ${STEPS}: node dev/deploy.mjs ${[head, ...vmOnly].join(' ')}`);
  const deployed = await runDevCommand(view, 'deploy.mjs', [head, ...vmOnly]);
  summary.steps.deploy = { ok: deployed.code === 0, code: deployed.code };
  if (deployed.code !== 0) throw new DevError(`dev/deploy.mjs exited with code ${deployed.code} (its output is above). ${version} is not released.`);

  view.out(`\nStep 3 of ${STEPS}: node dev/status.mjs ${['--json', ...vmOnly].join(' ')}`);
  const status = await runDevCommand(view, 'status.mjs', ['--json', ...vmOnly], { show: false });
  let report = null;
  try { report = JSON.parse(status.stdout); } catch { /* reported below */ }
  if (!report || typeof report !== 'object') {
    summary.steps.status = { ok: false, code: status.code, problems: ['no report'] };
    throw new DevError(`dev/status.mjs exited with code ${status.code} and printed no report (its messages are above). ${version} is not released.`);
  }
  const seen = statusAgainst(report, head, opts.vmOnly);
  summary.steps.status = {
    ok: status.code === 0 && seen.problems.length === 0, code: status.code,
    vm_commit: seen.vm, agent_commit: seen.agent, dashboard_commit: seen.dashboard, problems: seen.problems,
  };
  const services = Object.entries(report.services || {}).map(([name, s]) => `${name} ${s?.active || 'unknown'}`).join(', ');
  view.out(`  the VM:         release ${report.release?.version || '-'}, commit ${seen.vm || '-'}`);
  view.out(`  agent/instance: ${report.agent_instance?.status || 'not written'} on ${seen.agent || '-'}`);
  view.out(`  services:       ${services || 'none reported'}`);
  if (!opts.vmOnly) view.out(`  dashboard:      ${seen.dashboard || '-'}`);
  if (!summary.steps.status.ok) {
    throw new DevError(`dev/status.mjs found problems:\n${seen.problems.map((p) => `  - ${p}`).join('\n')}\n${version} is not released.`);
  }
  view.out(`  ok: every service up, on ${head}.`);

  view.out(`\nStep 4 of ${STEPS}: node dev/smoke.mjs${opts.waitSeconds ? ` --wait ${opts.waitSeconds}` : ''}`);
  const smoked = await runDevCommand(view, 'smoke.mjs', opts.waitSeconds ? ['--wait', String(opts.waitSeconds)] : []);
  const verdict = readSmokeVerdict(smoked.stdout);
  summary.steps.smoke = {
    ok: smoked.code === 0 && verdict?.pass === true, code: smoked.code,
    role: verdict?.role ?? null, mission: verdict?.mission ?? null, reason: verdict?.reason ?? null,
  };
  if (!summary.steps.smoke.ok) {
    throw new DevError(verdict
      ? `the smoke test of role ${verdict.role} failed: ${verdict.reason}. ${version} is not released.`
      : `dev/smoke.mjs exited with code ${smoked.code} without a verdict (its output is above). ${version} is not released.`);
  }

  summary.checked_at = new Date(view.now()).toISOString();
  const lines = checkSummary({ checkedAt: summary.checked_at, commit: head, vmOnly: opts.vmOnly, smoke: verdict });
  view.out(`\nThe check passed:\n${lines.join('\n')}`);

  view.out(`\nStep 5 of ${STEPS}: the release`);
  if (!opts.release) {
    summary.outcome = 'checked';
    view.out(`Nothing was tagged (--no-release). To release ${version}: run this again without --no-release, which checks it `
      + 'again and records the check in the tag, or node dev/release.mjs, which tags it without recording the check.');
    return 0;
  }
  // The check took a while: main, origin or the tags may have moved since step 1, so look again.
  view.out("The checks dev/release.mjs makes, once more, since the check took a while:");
  const current = await checkCandidate(view);
  if (current.head !== head) {
    throw new DevError(`main's head moved during the check, from ${head.slice(0, 12)} to ${current.head.slice(0, 12)}. `
      + `${version} is not released; run this again to check the new head.`);
  }
  if (current.released) {
    summary.outcome = 'nothing_to_release';
    view.out(`${version} was tagged at this commit on ${REMOTE} while the check ran: there is nothing left to release. ${current.url}`);
    return 0;
  }
  if (current.tagged) view.out(`This clone has the tag ${version} from a push that failed; it is pushed with the message it was made with.`);
  await pushReleaseTag(view, current, {
    message: tagMessage(version, lines),
    again: 'node dev/release.mjs pushes it, or run this again to check it again first',
  });
  summary.outcome = 'released';
  summary.tag = version;
  return 0;
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs; `exec` runs git, gh and the dev/ commands
 * @returns {Promise<number>} exit code: 0 checked (and released), 1 a step failed, 2 a usage mistake
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('release-check', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    // With --json, stdout holds the summary alone.
    const view = opts.json ? { ...ctx, stdout: ctx.stderr, out: (line = '') => ctx.stderr.write(`${line}\n`) } : ctx;
    const summary = {
      outcome: 'failed', version: null, commit: null, vm_only: opts.vmOnly, release: opts.release, checked_at: null, steps: {}, tag: null, error: null,
    };
    try {
      return await check(view, opts, summary);
    } catch (err) {
      summary.error = err.message;
      throw err;
    } finally {
      if (opts.json) ctx.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
