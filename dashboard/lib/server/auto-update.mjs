// dashboard/lib/server/auto-update.mjs: installing new releases without anyone pressing Install. A
// Cloud Scheduler job starts the Cloud Run job named by contracts.auto_update.job_name on its schedule;
// the job runs dashboard/jobs/auto-update.mjs, as the dashboard's own account, and that calls
// runAutoUpdate here. A run does nothing the Install button could not: it starts the same upgrade
// (upgrade.mjs startUpgrade: the VM's signed `upgrade` command first, then the dashboard's build and
// deploy) to the newest published release, only forward, and moves it on with readUpgrade, the way
// the System tab's card does while someone watches it. The upgrade is requested by the dashboard's own
// account, so the commands it signs say so.
//
// What a run does is autoUpdateDecision's answer, a pure function of: the admin setting (settings.mjs
// autoUpdateEnabled), the upgrade in progress, what the instance runs (releases.mjs installedVersion),
// the published releases, and whether a mission is active. An instance installed from a branch or a
// commit (a dev instance under test: its agent/instance `release` is not a version) is never moved.
// While a mission is active a run waits, from the first run that found one for at most
// contracts.auto_update.idle_wait_max_hours, then installs anyway: missions resume after the restart.
//
// Each run's outcome is kept in config/auto_update ({checked_at, action, reason, version,
// waiting_since}), which the System tab shows (readAutoUpdateStatus). Called by
// dashboard/jobs/auto-update.mjs and app/api/settings/auto-update/route.js. It never calls GitHub
// itself: releases come from releases.mjs, which keeps GitHub's list for an hour.

import { isNewer, isVersion, newerReleases } from '../../../agent/release/versions.mjs';
import { RUNNING_STATUSES } from '../../../agent/work/work-transitions.mjs';
import { HttpError } from './errors.mjs';
import { loadReleases } from './releases.mjs';
import { autoUpdateEnabled } from './settings.mjs';
import { RUNNING_STATES, UPGRADE_DOC, readUpgrade, startUpgrade } from './upgrade.mjs';

/** config/<this>: what the last run found and did. */
export const AUTO_UPDATE_DOC = 'auto_update';

/** The actions a run takes. */
export const ACTIONS = Object.freeze(['off', 'skip', 'none', 'wait', 'install', 'follow']);

const HOUR_MS = 3_600_000;

/** Who an automatic upgrade is requested by: the dashboard's own account, as an admin. */
export function autoUpdateActor(runtime) {
  return { email: runtime.settings.dashboardAccount || 'paraclete-dashboard', role: 'admin' };
}

/**
 * What a run should do. Pure.
 *
 * @param {object} o
 * @param {boolean} o.enabled              the admin setting
 * @param {object|null} o.upgrade          config/upgrade as stored, or null
 * @param {object} o.installed             releases.mjs installedVersion()
 * @param {object[]} o.releases            the published releases, newest first
 * @param {string|null} [o.checkError]     why the last look at GitHub failed
 * @param {boolean} o.busy                 whether a mission is active
 * @param {string|null} [o.waitingSince]   when a run first found the agent busy, for this version
 * @param {string|null} [o.waitingFor]     the version that wait was for
 * @param {Date} o.now
 * @param {number} o.idleWaitMaxHours
 * @returns {{action: string, reason: string, version: string|null, waiting_since: string|null}}
 */
export function autoUpdateDecision({
  enabled, upgrade, installed, releases, checkError = null, busy, waitingSince = null, waitingFor = null, now, idleWaitMaxHours,
}) {
  const answer = (action, reason, version = null, since = null) => ({ action, reason, version, waiting_since: since });
  if (!enabled) return answer('off', 'automatic updates are off; an admin turns them on on the System tab');
  if (upgrade && RUNNING_STATES.includes(upgrade.state)) {
    return answer('follow', `an upgrade to ${upgrade.version} is running (${upgrade.state}); moving it on`, upgrade.version || null);
  }
  const release = installed?.agent?.release || '';
  if (!isVersion(release)) {
    return answer('skip', `the agent runs ${release || 'an unknown release'}, installed from a branch or commit: only an instance installed from a release updates itself`);
  }
  if (!installed.version) return answer('skip', 'the installed release is not known yet: the agent has not reported ready');

  let target = null;
  let why = '';
  if (installed.repair && releases.some((r) => r.version === installed.repair)) {
    target = installed.repair;
    why = `finishing the upgrade to ${target}: the agent runs it and the dashboard does not`;
  } else {
    const newest = newerReleases(releases, installed.version)[0];
    if (newest) {
      target = newest.version;
      why = `${target} is newer than ${installed.version}`;
    }
  }
  if (!target) {
    const latest = releases[0]?.version;
    if (!latest && checkError) return answer('skip', `the releases are not known: ${checkError}`);
    return answer('none', latest && !isNewer(latest, installed.version)
      ? `${installed.version} is the newest release`
      : `no published release is newer than ${installed.version}`);
  }

  if (busy) {
    const since = waitingFor === target && waitingSince && Number.isFinite(Date.parse(waitingSince)) ? waitingSince : now.toISOString();
    const waited = now.getTime() - Date.parse(since);
    if (waited < idleWaitMaxHours * HOUR_MS) {
      return answer('wait', `${why}; a mission is running, so it waits for the agent to be idle (since ${since}, for at most ${idleWaitMaxHours} h)`, target, since);
    }
    return answer('install', `${why}; the agent stayed busy for ${idleWaitMaxHours} h, so it installs now (missions resume after the restart)`, target);
  }
  return answer('install', why, target);
}

/** Whether any mission or task is running now (its envelope's status is a running one). */
export async function isAgentBusy(runtime) {
  const docs = await runtime.db.query('', runtime.collections.work, [
    { field: 'status', op: 'IN', value: { arrayValue: { values: RUNNING_STATUSES.map((s) => ({ stringValue: s })) } } },
  ], { noOrderBy: true, limit: 1, strict: true });
  return docs.length > 0;
}

const statusPath = (runtime) => `${runtime.collections.config}/${AUTO_UPDATE_DOC}`;

/**
 * What the last run found and did, for the System tab: config/auto_update, or null before any run.
 *
 * @param {object} runtime
 * @returns {Promise<object|null>}
 */
export async function readAutoUpdateStatus(runtime) {
  const doc = await runtime.db.read(statusPath(runtime), { strict: true });
  if (!doc) return null;
  const pick = (k) => (doc[k] === undefined ? null : doc[k]);
  return {
    checked_at: pick('checked_at'), action: pick('action'), reason: pick('reason'), version: pick('version'),
    waiting_since: pick('waiting_since'), waiting_for: pick('waiting_for'), upgrade_state: pick('upgrade_state'),
  };
}

async function writeStatus(runtime, fields) {
  await runtime.db.write(statusPath(runtime), fields, { strict: true });
}

/**
 * One run of the update job: decides, starts an upgrade when it should, and follows any upgrade in
 * progress until it ends or the run's time is up (a later run picks up the rest: every step of the
 * upgrade is claimed with a precondition, so two runs never take the same step).
 *
 * @param {object} runtime
 * @param {object} [o]
 * @param {() => Date} [o.clock]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {number} [o.budgetMs]  how long this run may follow an upgrade; default job_timeout_seconds less a minute
 * @param {Function} [o.sign]     tests pass the command signer
 * @returns {Promise<{action: string, reason: string, version: string|null, upgrade: object|null}>}
 */
export async function runAutoUpdate(runtime, { clock = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), budgetMs, sign } = {}) {
  const rules = runtime.contracts.auto_update;
  const started = clock();
  const deadline = started.getTime() + (budgetMs ?? (rules.job_timeout_seconds - 60) * 1000);
  const actor = autoUpdateActor(runtime);

  const settings = (await runtime.db.read(`${runtime.collections.config}/settings`, { strict: true })) || {};
  const enabled = autoUpdateEnabled(runtime, settings);
  const upgrade = await runtime.db.read(`${runtime.collections.config}/${UPGRADE_DOC}`, { strict: true });
  const previous = (await runtime.db.read(statusPath(runtime), { strict: true })) || {};
  let releases = [];
  let checkError = null;
  let installed = null;
  if (enabled) {
    const loaded = await loadReleases(runtime, { now: started });
    releases = loaded.releases;
    checkError = loaded.problem || loaded.check?.error || null;
    installed = loaded.installed;
  }
  const busy = enabled && !(upgrade && RUNNING_STATES.includes(upgrade.state)) ? await isAgentBusy(runtime) : false;
  const decision = autoUpdateDecision({
    enabled, upgrade, installed, releases, checkError, busy,
    waitingSince: previous.waiting_since || null, waitingFor: previous.waiting_for || null,
    now: started, idleWaitMaxHours: rules.idle_wait_max_hours,
  });
  runtime.log('INFO', `auto-update: ${decision.action}: ${decision.reason}`);

  let view = null;
  if (decision.action === 'install') {
    try {
      view = (await startUpgrade(runtime, { version: decision.version, user: actor, now: started, sign })).upgrade;
    } catch (err) {
      const reason = err instanceof HttpError ? err.message : String(err?.message || err);
      runtime.log('WARN', `auto-update: could not start the upgrade to ${decision.version}: ${reason}`);
      await writeStatus(runtime, {
        checked_at: started.toISOString(), action: 'skip', reason: `could not start the upgrade to ${decision.version}: ${reason}`,
        version: decision.version, waiting_since: null, waiting_for: null, upgrade_state: null,
      });
      return { action: 'skip', reason, version: decision.version, upgrade: null };
    }
  }
  await writeStatus(runtime, {
    checked_at: started.toISOString(), action: decision.action, reason: decision.reason, version: decision.version,
    waiting_since: decision.action === 'wait' ? decision.waiting_since : null,
    waiting_for: decision.action === 'wait' ? decision.version : null,
    upgrade_state: view?.state || (decision.action === 'follow' ? upgrade.state : null),
  });

  if (decision.action === 'install' || decision.action === 'follow') {
    view = await follow(runtime, { actor, clock, sleep, deadline, interval: rules.advance_interval_seconds * 1000 });
    await writeStatus(runtime, {
      checked_at: started.toISOString(), action: decision.action, reason: decision.reason, version: decision.version,
      waiting_since: null, waiting_for: null, upgrade_state: view?.state || null,
    });
  }
  return { ...decision, upgrade: view };
}

/** Moves the upgrade in progress on until it is done, failed, or the run's time is up. */
async function follow(runtime, { actor, clock, sleep, deadline, interval }) {
  let view = (await readUpgrade(runtime, { user: actor, now: clock() })).upgrade;
  while (view && RUNNING_STATES.includes(view.state) && clock().getTime() + interval < deadline) {
    await sleep(interval);
    view = (await readUpgrade(runtime, { user: actor, now: clock() })).upgrade;
  }
  if (view) runtime.log('INFO', `auto-update: the upgrade to ${view.version} is ${view.state}${view.error ? `: ${view.error}` : ''}`);
  return view;
}
