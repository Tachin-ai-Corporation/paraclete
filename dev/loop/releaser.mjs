// dev/loop/releaser.mjs: cuts a release of main once the loop's merges since the last release have run
// healthy on the lab. Instances install new releases by themselves (dashboard/lib/server/auto-update.mjs),
// so this is how the loop's changes reach them. It runs at the start of a cycle on the lab driver, which
// is itself an instance that follows main's head (dev/harness2/lab-follow-main.sh), as the user the
// cycle runs as, so the pushed tag starts .github/workflows/release.yml. Main's head is released only
// when all of these hold:
//
//   - releasing is turned on (`release.enabled` in the developer's local settings);
//   - dev/release.mjs checkCandidate passes: this checkout is a clean main equal to origin, the head's
//     version is newer than every version tag, and every CI check on the head passed;
//   - at least one loop merge (merger.mjs's squash message) landed since the previous release;
//   - the previous release is `release.minHoursBetween` hours old or more;
//   - the lab ran it healthy: this machine's installed release is the head commit, installed
//     `release.soakHours` or more ago, every agent service active, and every heartbeat it writes fresh
//     (gateway and control write none, and are judged by their units, as dev/status.mjs judges them).
//
// The tag is cut as dev/release.mjs cuts it (pushReleaseTag), with a summary in its message naming the
// commit, the soak and the loop merges it carries; never the project, the VM or a URL (the tag is
// public). A canary in a project of its own, with a smoke mission (dev/release-check.mjs), checks more;
// this checks what the driver can read of itself. Called by cycle.mjs; reads and changes nothing else.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SERVICES, serviceUnit } from '../../agent/services/control/systemd.mjs';
import { HEARTBEAT_STALE_SECONDS, RELEASE_FILE } from '../../agent/services/control/introspection.mjs';
import { checkCandidate, pushReleaseTag } from '../release.mjs';
import { loopMergeOf } from './sentinel.mjs';

/** Where this machine's install and its services' heartbeats are, when it is an instance. */
export const LAB_PATHS = Object.freeze({ installRoot: '/opt/paraclete', dataRoot: '/var/lib/paraclete' });

const HOUR_MS = 3_600_000;

/**
 * Whether the lab ran `head` healthy for long enough. Pure.
 *
 * @param {object} p
 * @param {string} p.head          main's head commit
 * @param {object|null} p.release  this machine's installed release ({ commit, installed_at })
 * @param {Object<string, string>} p.units       each service's `systemctl is-active` answer
 * @param {Object<string, object|null>} p.health each service's heartbeat ({ beat_at })
 * @param {Date} p.now
 * @param {number} p.soakHours
 * @returns {{ ok: boolean, problems: string[], hours: number|null }}
 */
export function labHealth({ head, release, units, health, now, soakHours }) {
  const problems = [];
  if (!release?.commit) return { ok: false, problems: ['this machine runs no paraclete release: it is not a lab instance'], hours: null };
  if (release.commit !== head) problems.push(`the lab runs ${String(release.commit).slice(0, 12)}, not main's head ${head.slice(0, 12)}`);
  const since = Date.parse(release.installed_at || '');
  const hours = Number.isFinite(since) ? (now.getTime() - since) / HOUR_MS : null;
  if (hours === null) problems.push('the lab does not say when it installed its release');
  else if (hours < soakHours) problems.push(`the lab has run it ${hours.toFixed(1)} h, under the ${soakHours} h soak`);
  for (const s of SERVICES) {
    if (units?.[s] !== 'active') problems.push(`${s} is ${units?.[s] || 'unknown'}`);
    if (!health?.[s]) continue;
    const beat = Date.parse(health[s].beat_at || '');
    if (!Number.isFinite(beat)) problems.push(`${s}'s heartbeat has no time`);
    else if ((now.getTime() - beat) / 1000 > HEARTBEAT_STALE_SECONDS) problems.push(`${s}'s heartbeat is ${Math.round((now.getTime() - beat) / 1000)} s old`);
  }
  return { ok: problems.length === 0, problems, hours };
}

/** This machine's install and services, as labHealth reads them; nothing when it is not an instance. */
export function readLab({ paths = LAB_PATHS, readFile = (p) => fs.readFileSync(p, 'utf8'), unitState } = {}) {
  const json = (p) => {
    try {
      return JSON.parse(readFile(p));
    } catch {
      return null;
    }
  };
  const state = unitState || ((unit) => {
    try {
      return execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (err) {
      return String(err.stdout || '').trim() || 'unknown';
    }
  });
  return {
    release: json(path.posix.join(paths.installRoot, RELEASE_FILE)),
    units: Object.fromEntries(SERVICES.map((s) => [s, state(serviceUnit(s))])),
    health: Object.fromEntries(SERVICES.map((s) => [s, json(path.posix.join(paths.dataRoot, 'services', s, 'health.json'))])),
  };
}

/** The loop merges among commit messages: [{ pr, issue }]. */
export function loopMergesIn(messages) {
  return (messages || []).map(loopMergeOf).filter(Boolean).map(({ pr, issue }) => ({ pr, issue }));
}

/** The annotated tag's message: what was checked, and the loop merges the release carries. */
export function releaseMessage({ version, head, hours, merges, previous, now }) {
  return [
    `${version}: released by the self-improvement loop (dev/loop/releaser.mjs)`,
    '',
    `At ${now.toISOString()}: CI passed on ${head}, and the lab ran it ${hours.toFixed(1)} h with every agent service active and every heartbeat fresh.`,
    `Loop merges since ${previous || 'the first commit'}: ${merges.map((m) => `#${m.pr} (for #${m.issue})`).join(', ')}.`,
  ].join('\n');
}

/**
 * Releases main's head when it is due (see the header).
 *
 * @param {object} o
 * @param {object} o.settings   the loop's settings (release: { enabled, soakHours, minHoursBetween })
 * @param {object} o.ctx        dev-env.mjs devContext: git, gh and out, in this checkout
 * @param {Function} [o.check]  dev/release.mjs checkCandidate, for tests
 * @param {Function} [o.push]   dev/release.mjs pushReleaseTag, for tests
 * @param {Function} [o.lab]    () => readLab()'s answer, for tests
 * @param {Date} [o.now]
 * @param {boolean} [o.dryRun]  say what it would do, and tag nothing
 * @returns {Promise<{ action: 'released'|'not-due', reason: string|null, version?: string }>}
 */
export async function releaseIfDue({ settings, ctx, check = checkCandidate, push = pushReleaseTag, lab = readLab, now = new Date(), dryRun = false }) {
  const r = settings.release;
  if (!r?.enabled) return { action: 'not-due', reason: 'releasing is off (release.enabled in the local settings)' };
  let candidate;
  try {
    candidate = await check(ctx);
  } catch (err) {
    return { action: 'not-due', reason: String(err.message || err).split('\n')[0] };
  }
  if (candidate.released) return { action: 'not-due', reason: `${candidate.version} is released already` };
  const range = candidate.previousCommit ? `${candidate.previousCommit}..${candidate.head}` : candidate.head;
  const log = await ctx.git(['log', '--format=%B%x00', range]);
  const merges = loopMergesIn(String(log.stdout || '').split('\0'));
  if (!merges.length) return { action: 'not-due', reason: `no loop merge since ${candidate.previous || 'the first commit'}` };
  if (candidate.previous) {
    const at = await ctx.git(['log', '-1', '--format=%cI', `refs/tags/${candidate.previous}`]);
    const hours = (now.getTime() - Date.parse(String(at.stdout || '').trim())) / HOUR_MS;
    if (Number.isFinite(hours) && hours < r.minHoursBetween) {
      return { action: 'not-due', reason: `${candidate.previous} is ${hours.toFixed(1)} h old, under the ${r.minHoursBetween} h between releases` };
    }
  }
  const health = labHealth({ head: candidate.head, ...lab(), now, soakHours: r.soakHours });
  if (!health.ok) return { action: 'not-due', reason: `the lab has not run it healthy long enough: ${health.problems.join('; ')}` };
  if (dryRun) return { action: 'not-due', reason: `a dry run: ${candidate.version} would be released`, version: candidate.version };
  await push(ctx, candidate, {
    message: releaseMessage({ version: candidate.version, head: candidate.head, hours: health.hours, merges, previous: candidate.previous, now }),
    again: 'the next cycle pushes it',
  });
  return { action: 'released', reason: null, version: candidate.version };
}
