// dev/harness2/health.mjs: whether the self-improvement loop as a whole is working, and an alarm for
// each way it has been seen to fail quietly. The loop is: a cycle proposes a change and measures it
// (cli.mjs, which records every cycle in .local/harness2/cycles.jsonl), a promotion pull request opens
// on passing evidence (promote.mjs), it merges (merge.mjs), a release carries it (dev/release.mjs), and
// instances install the release. A loop can look busy while doing nothing: every proposal falling back
// to the template, runs that measure nothing, a gain that is the same number on every pull request,
// merges without evidence, promotions waiting for a release, and the self-improvement loop's cycles
// (dev/loop/cycle.mjs) finding no work, cycle after cycle. `loopHealth` names each one it sees.
//
// `loopHealth` is pure. `collectHealthInputs` reads the cycle log, the repository's harness pull
// requests (gh) and its tags (git); `syncHealthIssues` opens a GitHub issue per alarm (label
// `harness-alarm`, one per alarm key) and closes it once the alarm clears, so a person or a coding
// session can pick it up. It changes nothing else. Called by cli.mjs `health`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isVersion } from '../../agent/release/versions.mjs';
import { versionTags } from '../release.mjs';
import { judgeEvidence, parseEvidenceBlock } from './evidence.mjs';
import { pauseState } from './pause.mjs';

/** Where cli.mjs records every cycle, one JSON object per line, relative to the checkout. */
export const CYCLE_LOG = '.local/harness2/cycles.jsonl';

/** The label every alarm issue carries. */
export const ALARM_LABEL = 'harness-alarm';

export const DEFAULT_HEALTH_RULES = Object.freeze({
  /** The window the alarms look at. */
  days: 7,
  /** A loop with no cycle for this long has stopped. */
  stalledHours: 26,
  /** This many proposals, all fallen back to the template, means the proposer is not working. */
  minAttemptsForFallback: 3,
  /** This many promotions claiming the same nonzero gain means the gain is not measured. */
  identicalDeltas: 3,
  /** Promotions on main older than this without a release are stalled. */
  releaseStalledDays: 3,
  /** This many cycles stopped by the spend cap in the window. */
  spendCapCycles: 2,
  /** This many loop cycles in a row that found no work, the last within loopIdleHours, is an idle loop. */
  loopIdleCycles: 3,
  loopIdleHours: 24,
});

const HARNESS_BRANCH = /^(harness2|h2)\//;
const DELTA_IN_TITLE = /ΔS_cap=([+-]?\d+(?:\.\d+)?)/;
const HOUR_MS = 3_600_000;

function defaultExec(file) {
  return (args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * One cycle's record, from runCli's result: what ran, what each proposal did, the evidence's verdict
 * and the pull request. Small and free of file contents, so the log stays readable.
 *
 * @param {object} p
 * @param {string} p.command
 * @param {object} p.flags
 * @param {object} p.result   runCli's result
 * @param {string} p.commit
 * @param {Date} [p.now]
 * @returns {object}
 */
export function cycleRecord({ command, flags = {}, result = {}, commit, now = new Date() }) {
  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  const notEvaluated = {};
  const sources = {};
  for (const a of attempts) {
    const src = a.proposal?.source || 'unknown';
    sources[src] = (sources[src] || 0) + 1;
    if (a.evaluated === false && a.revertReason) {
      const key = String(a.revertReason).replace(/:.*$/, '');
      notEvaluated[key] = (notEvaluated[key] || 0) + 1;
    }
  }
  const fallbackReasons = attempts.map((a) => a.proposal?.fallbackReason).filter(Boolean);
  const evidence = result.readiness?.evidence || null;
  return {
    at: now.toISOString(),
    command,
    commit: commit || null,
    unit: result.curriculumUnit?.id || flags.unit || null,
    realModel: Boolean(flags['real-model']),
    ok: Boolean(result.ok),
    paused: Boolean(result.paused),
    spendCapReached: Boolean(result.spendCapReached),
    reason: result.reason || null,
    spend: result.spend || null,
    attempts: {
      total: attempts.length,
      evaluated: attempts.filter((a) => a.evaluated).length,
      accepted: attempts.filter((a) => a.accepted).length,
      notEvaluated,
      sources,
      fallbackReasons: [...new Set(fallbackReasons)].slice(0, 3),
    },
    evidence: evidence
      ? {
          ok: Boolean(evidence.verdict?.ok),
          problems: (evidence.verdict?.problems || []).slice(0, 5),
          measured: Boolean(evidence.measured),
          delta: evidence.capability?.delta ?? null,
          noise: evidence.capability?.noise ?? null,
          trials: evidence.trials ?? null,
          calibration: evidence.calibration ? { ok: Boolean(evidence.calibration.ok), problems: evidence.calibration.problems || [] } : null,
        }
      : null,
    pullRequest: result.pullRequest?.prUrl || result.readiness?.pullRequest?.prUrl || null,
  };
}

/**
 * Appends one cycle record to the log.
 *
 * @param {object} record
 * @param {object} [o]
 * @param {string} [o.repoRoot]
 * @param {string} [o.path]   the log, relative to repoRoot
 */
export function appendCycleRecord(record, { repoRoot = process.cwd(), path: rel = CYCLE_LOG } = {}) {
  const file = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** The cycle records in the log, oldest first; a line that is not JSON is skipped. */
export function readCycleRecords({ repoRoot = process.cwd(), path: rel = CYCLE_LOG } = {}) {
  const file = path.join(repoRoot, rel);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * The alarms on the loop, and its numbers. Pure.
 *
 * @param {object} p
 * @param {object[]} [p.cycles]        cycle records, any order
 * @param {object[]} [p.pullRequests]  harness pull requests: number, title, state, headRefName, createdAt, mergedAt, body
 * @param {object} [p.release]         { latestTag, promotionsSinceTag: [{subject, at}] }
 * @param {object} [p.pause]           pause.mjs pauseState()
 * @param {Date} [p.now]
 * @param {object} [p.rules]
 * @returns {{ ok: boolean, alarms: object[], notes: string[], stats: object }}
 */
export function loopHealth({ cycles = [], pullRequests = [], release = null, pause = null, now = new Date(), rules = {} } = {}) {
  const r = { ...DEFAULT_HEALTH_RULES, ...rules };
  const since = now.getTime() - r.days * 24 * HOUR_MS;
  const inWindow = (iso) => Number.isFinite(Date.parse(iso)) && Date.parse(iso) >= since;
  const recent = cycles.filter((c) => inWindow(c.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const alarms = [];
  const notes = [];
  const alarm = (key, summary, detail = []) => alarms.push({ key, summary, detail });

  if (pause?.paused) notes.push(`The harness is paused (${pause.reason}); no cycle starts until dev/harness2/PAUSED is gone.`);

  const last = cycles.length ? cycles.reduce((a, b) => (Date.parse(a.at) >= Date.parse(b.at) ? a : b)) : null;
  if (!pause?.paused && !last) {
    alarm('stalled', 'No harness cycle is recorded', [`The cycle log (${CYCLE_LOG}) is empty or missing: no cycle has run in this checkout.`]);
  } else if (!pause?.paused && now.getTime() - Date.parse(last.at) > r.stalledHours * HOUR_MS) {
    const hours = Math.round((now.getTime() - Date.parse(last.at)) / HOUR_MS);
    alarm('stalled', `No harness cycle has run for ${hours} hours`, [`The last one was ${last.command} at ${last.at}.`]);
  }

  // The harness's own cycles; the loop's (dev/loop/cycle.mjs, command 'loop') measure only behaviour
  // changes and propose nothing through the harness, so the harness's alarms leave them out.
  const working = recent.filter((c) => !c.paused && c.command !== 'loop');
  const loopCycles = recent.filter((c) => c.command === 'loop' && c.loop && !c.loop.dryRun);
  if (working.length && !working.some((c) => c.realModel)) {
    alarm('unmeasured', `None of the last ${working.length} cycles measured a change`, [
      'Only a --real-model run sends a side\'s own prompts to the model, so no other cycle can open a promotion.',
      'Add --real-model to the cycle the driver runs.',
    ]);
  }

  const attempts = working.reduce((n, c) => n + (c.attempts?.total || 0), 0);
  const fallbacks = working.reduce((n, c) => n + (c.attempts?.sources?.fallback || 0) + (c.attempts?.sources?.template || 0), 0);
  if (attempts >= r.minAttemptsForFallback && fallbacks === attempts) {
    const reasons = [...new Set(working.flatMap((c) => c.attempts?.fallbackReasons || []))].slice(0, 3);
    alarm('all-fallback', `Every one of the last ${attempts} proposals fell back to the template`, [
      'A fallback is never evaluated or promoted, so the loop is idle.',
      ...reasons.map((x) => `Reason given: ${x}`),
    ]);
  }

  const capped = working.filter((c) => c.spendCapReached);
  if (capped.length >= r.spendCapCycles) {
    alarm('spend-cap', `${capped.length} cycles stopped at their spend cap`, [
      ...new Set(capped.map((c) => c.reason).filter(Boolean)),
      'A capped cycle promotes nothing. Fewer tasks or trials, or a higher cap, is a decision for a person.',
    ]);
  }

  const calibrated = working.filter((c) => c.evidence?.calibration);
  const lastCalibration = calibrated.at(-1)?.evidence.calibration;
  if (lastCalibration && !lastCalibration.ok) {
    alarm('calibration-failed', 'The last calibration failed: the measurement cannot be trusted', lastCalibration.problems || []);
  }

  // Identical scores and no tokens spent: the runs did not reach the model. (A suite every run solves
  // also has no variance, but it spends tokens.)
  const flat = working.filter((c) => c.evidence?.measured && c.evidence.noise === 0 && (c.evidence.trials?.candidate ?? 0) >= 3
    && !((c.spend?.tokens ?? 0) > 0));
  if (flat.length >= 2) {
    alarm('zero-variance', `${flat.length} measured cycles had no run-to-run variance and spent no tokens`, [
      'Real-model runs vary and spend tokens. Identical scores with no tokens mean the runs are not reaching the model.',
    ]);
  }

  const harnessPrs = pullRequests.filter((p) => HARNESS_BRANCH.test(p.headRefName || ''));
  const recentPrs = harnessPrs.filter((p) => inWindow(p.createdAt) || inWindow(p.mergedAt));
  const deltas = new Map();
  for (const p of recentPrs) {
    const m = DELTA_IN_TITLE.exec(p.title || '');
    if (m && Number(m[1]) !== 0) deltas.set(m[1], [...(deltas.get(m[1]) || []), p.number]);
  }
  const repeated = [...deltas].filter(([, numbers]) => numbers.length >= r.identicalDeltas);
  if (repeated.length) {
    const [delta, numbers] = repeated[0];
    alarm('identical-deltas', `${numbers.length} promotions claimed the same gain, ΔS_cap=${delta}`, [
      ...repeated.map(([d, ns]) => `ΔS_cap=${d}: pull requests ${ns.map((n) => `#${n}`).join(', ')}.`),
      'A measured gain differs from change to change; the same number every time means it was not measured.',
    ]);
  }

  const unproven = recentPrs.filter((p) => p.state === 'MERGED' && inWindow(p.mergedAt)).filter((p) => {
    const evidence = parseEvidenceBlock(p.body);
    return !evidence || !judgeEvidence(evidence).ok;
  });
  if (unproven.length) {
    alarm('merged-without-evidence', `${unproven.length} harness promotions merged without passing evidence`, [
      `Pull requests ${unproven.map((p) => `#${p.number}`).join(', ')}.`,
      'Only the in-repo merger (merge.mjs) should merge a promotion, and it re-judges the evidence block.',
    ]);
  }

  // The loop runs and does nothing: its last cycles all found no issue to take (and the planner planned
  // none), and none of them released. A pause or the day's cap is a different action, and a loop that
  // stopped running is `stalled`.
  const idle = [];
  for (const c of [...loopCycles].reverse()) {
    if (c.loop.action !== 'no-work' || c.loop.released) break;
    idle.push(c);
  }
  if (idle.length >= r.loopIdleCycles && now.getTime() - Date.parse(idle[0].at) <= r.loopIdleHours * HOUR_MS) {
    const first = idle.at(-1);
    alarm('loop-idle', `The loop's last ${idle.length} cycles found no work`, [
      `Every cycle since ${first.at} found no loop issue to take, planned none and released nothing.`,
      ...[...new Set(idle.slice(0, 3).map((c) => c.reason).filter(Boolean))].map((x) => `Reason given: ${x}`),
      'When no issue waits, the planner (dev/loop/planner.mjs) opens one from docs/plan/OPEN_ITEMS.md; its reason says why it did not. With every item planned, the loop needs new items or issues.',
    ]);
  }

  const waiting = release?.promotionsSinceTag || [];
  const oldest = waiting.length ? Math.min(...waiting.map((w) => Date.parse(w.at)).filter(Number.isFinite)) : null;
  if (oldest && now.getTime() - oldest > r.releaseStalledDays * 24 * HOUR_MS) {
    alarm('release-stalled', `${waiting.length} promotions on main wait for a release`, [
      `The oldest merged ${new Date(oldest).toISOString()}; the latest release is ${release.latestTag || 'none'}.`,
      'Instances only receive promotions in a release (dev/release-check.mjs, then dev/release.mjs).',
    ]);
  }

  const stats = {
    window_days: r.days,
    cycles: recent.length,
    measured_cycles: working.filter((c) => c.realModel).length,
    paused_cycles: recent.filter((c) => c.paused).length,
    proposals: attempts,
    evaluated: working.reduce((n, c) => n + (c.attempts?.evaluated || 0), 0),
    accepted: working.reduce((n, c) => n + (c.attempts?.accepted || 0), 0),
    evidence_passed: working.filter((c) => c.evidence?.ok).length,
    pull_requests_opened: recentPrs.filter((p) => inWindow(p.createdAt)).length,
    pull_requests_merged: recentPrs.filter((p) => p.state === 'MERGED' && inWindow(p.mergedAt)).length,
    tokens: working.reduce((n, c) => n + (c.spend?.tokens || 0), 0),
    rollouts: working.reduce((n, c) => n + (c.spend?.rollouts || 0), 0),
    latest_release: release?.latestTag || null,
    promotions_waiting_for_release: waiting.length,
    last_cycle_at: last?.at || null,
    loop_cycles: loopCycles.filter((c) => c.loop.action !== 'paused' && c.loop.action !== 'no-work' && c.loop.action !== 'capped').length,
    loop_pull_requests: loopCycles.filter((c) => c.loop.action === 'opened').length,
    loop_refused: loopCycles.filter((c) => ['proposer-failed', 'no-change', 'refused-paths', 'untested', 'tests-failed', 'unreviewed', 'rejected', 'unmeasured', 'regressed', 'unimproved'].includes(c.loop.action)).length,
  };
  return { ok: alarms.length === 0, alarms, notes, stats };
}

/**
 * What loopHealth reads: the cycle log, the repository's harness pull requests, and the promotions on
 * main since the newest version tag.
 *
 * @param {object} [o]
 * @param {string} [o.repoRoot]
 * @param {string} [o.repo]        owner/name for gh; default the checkout's own
 * @param {Function} [o.execGh]    (args, cwd) => stdout
 * @param {Function} [o.execGit]   (args, cwd) => stdout
 * @param {string} [o.cyclePath]
 * @param {object} [o.env]
 * @returns {{ cycles: object[], pullRequests: object[], release: object, pause: object, problems: string[] }}
 */
export function collectHealthInputs({
  repoRoot = process.cwd(), repo, execGh = defaultExec('gh'), execGit = defaultExec('git'), cyclePath = CYCLE_LOG, env = process.env,
} = {}) {
  const problems = [];
  const cycles = readCycleRecords({ repoRoot, path: cyclePath });
  let pullRequests = [];
  try {
    const out = execGh(['pr', 'list', ...(repo ? ['--repo', repo] : []), '--state', 'all', '--limit', '100',
      '--json', 'number,title,state,headRefName,createdAt,mergedAt,body'], repoRoot);
    pullRequests = JSON.parse(out || '[]');
  } catch (err) {
    problems.push(`could not list pull requests: ${String(err.message || err).split('\n')[0]}`);
  }
  let release = { latestTag: null, promotionsSinceTag: [] };
  try {
    const tags = versionTags(execGit(['tag', '--list', 'v*'], repoRoot).split('\n').map((t) => t.trim()).filter(Boolean));
    const latestTag = tags[0] || null;
    const range = latestTag ? `${latestTag}..origin/main` : 'origin/main';
    const log = execGit(['log', '--first-parent', '--format=%s%x09%cI', range], repoRoot);
    const promotionsSinceTag = log.split('\n').filter(Boolean).map((line) => {
      const [subject, at] = line.split('\t');
      return { subject, at };
    }).filter((c) => /paraclete-h2\(/.test(c.subject) && isVersion(c.subject.split(':')[0]));
    release = { latestTag, promotionsSinceTag };
  } catch (err) {
    problems.push(`could not read the tags and main: ${String(err.message || err).split('\n')[0]}`);
  }
  return { cycles, pullRequests, release, pause: pauseState({ repoRoot, env }), problems };
}

const issueTitle = (key) => `Harness alarm: ${key}`;

function issueBody(a, now) {
  return [
    `**${a.summary}**`,
    '',
    ...a.detail.map((d) => `- ${d}`),
    '',
    `Seen by \`node dev/harness2/cli.mjs health\` at ${now.toISOString()}. This issue closes itself when the alarm clears.`,
  ].join('\n');
}

/**
 * One open issue per alarm, labelled ALARM_LABEL and titled by its key; an issue whose alarm cleared
 * gets a comment and is closed. With `dryRun` it only says what it would do.
 *
 * @param {object} p
 * @param {object[]} p.alarms
 * @param {string} [p.repoRoot]
 * @param {string} [p.repo]
 * @param {Function} [p.execGh]
 * @param {boolean} [p.dryRun]
 * @param {boolean} [p.closeCleared]  false when the inputs could not all be read: an alarm missing
 *                                     because its input failed has not cleared
 * @param {Date} [p.now]
 * @returns {{ opened: string[], updated: string[], closed: number[], dryRun: boolean }}
 */
export function syncHealthIssues({
  alarms, repoRoot = process.cwd(), repo, execGh = defaultExec('gh'), dryRun = false, closeCleared = true, now = new Date(),
}) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const open = JSON.parse(execGh(['issue', 'list', ...repoArgs, '--label', ALARM_LABEL, '--state', 'open', '--json', 'number,title', '--limit', '100'], repoRoot) || '[]');
  const byTitle = new Map(open.map((i) => [i.title, i.number]));
  const result = { opened: [], updated: [], closed: [], dryRun };
  if (!dryRun && alarms.length) {
    execGh(['label', 'create', ALARM_LABEL, ...repoArgs, '--force', '--color', 'B60205', '--description', 'The harness health check found a problem with the self-improvement loop'], repoRoot);
  }
  const seen = new Set();
  for (const a of alarms) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    const number = byTitle.get(issueTitle(a.key));
    if (number) {
      result.updated.push(a.key);
      if (!dryRun) execGh(['issue', 'comment', String(number), ...repoArgs, '--body', `Still seen at ${now.toISOString()}: ${a.summary}`], repoRoot);
    } else {
      result.opened.push(a.key);
      if (!dryRun) execGh(['issue', 'create', ...repoArgs, '--title', issueTitle(a.key), '--label', ALARM_LABEL, '--body', issueBody(a, now)], repoRoot);
    }
  }
  const live = new Set(alarms.map((a) => issueTitle(a.key)));
  for (const i of closeCleared ? open : []) {
    if (!live.has(i.title)) {
      result.closed.push(i.number);
      if (!dryRun) execGh(['issue', 'close', String(i.number), ...repoArgs, '--comment', `The alarm cleared at ${now.toISOString()}.`], repoRoot);
    }
  }
  return result;
}

/** The health report as markdown. */
export function formatHealthMarkdown(health) {
  const s = health.stats;
  return [
    `# Harness loop health: ${health.ok ? 'no alarms' : `${health.alarms.length} alarm(s)`}`,
    '',
    ...health.notes.map((n) => `> ${n}`),
    ...(health.notes.length ? [''] : []),
    ...health.alarms.flatMap((a) => [`## ${a.key}: ${a.summary}`, '', ...a.detail.map((d) => `- ${d}`), '']),
    `## The last ${s.window_days} days`,
    '',
    `- Cycles: ${s.cycles} (${s.measured_cycles} measured, ${s.paused_cycles} refused while paused); the last at ${s.last_cycle_at || 'never'}`,
    `- Loop: ${s.loop_cycles ?? 0} cycle(s) took an issue, ${s.loop_pull_requests ?? 0} opened a pull request, ${s.loop_refused ?? 0} stopped with a reason on the issue`,
    `- Proposals: ${s.proposals}, evaluated ${s.evaluated}, accepted ${s.accepted}; evidence passed in ${s.evidence_passed} cycle(s)`,
    `- Pull requests: ${s.pull_requests_opened} opened, ${s.pull_requests_merged} merged`,
    `- Spend: ${s.rollouts} model rollouts, ${s.tokens} tokens`,
    `- Release: ${s.latest_release || 'none'}; ${s.promotions_waiting_for_release} promotion(s) on main wait for the next`,
    '',
  ].join('\n');
}
