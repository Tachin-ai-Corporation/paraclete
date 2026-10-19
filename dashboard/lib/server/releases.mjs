// dashboard/lib/server/releases.mjs: which release the instance runs and which newer ones it could
// install, for the System tab's update card. A release is a version tag of the repository the instance
// was installed from (PARACLETE_REPO), published on GitHub with notes (agent/release/versions.mjs
// defines it and reads GitHub's answer).
//
// GitHub answers 60 unauthenticated requests an hour per address, and Cloud Run shares its addresses,
// so the release list is asked for at most once per `dashboard.release_check_ttl_seconds` (contracts)
// and kept in Firestore `config/release_check` as `{ repo, checked_at, releases, error }`. A failed
// check keeps the releases it had and says why. An admin may ask GitHub again sooner, at most every
// five minutes.
//
// What the instance runs: the VM's release as `agent/instance` reports it (bootstrap.sh writes it at
// the end of every install or upgrade), when that is a ready version; otherwise this dashboard's own
// (PARACLETE_RELEASE). Branches and bare commits are not releases: an instance installed from one is
// offered nothing. The upgrade itself is upgrade.mjs; this module only reads.
// Called by the /api/releases route and by upgrade.mjs.

import { isNewer, isVersion, newerReleases, releasesFromGitHub, releasesUrl } from '../../../agent/release/versions.mjs';
import { StoreConflict, StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { HttpError } from './errors.mjs';

/** The cached release list, under `config`. */
export const RELEASE_CHECK_DOC = 'release_check';

/** The shortest time between two checks an admin asks for. */
export const REFRESH_FLOOR_SECONDS = 300;

/** A release's notes are kept up to this many characters; the rest is on GitHub. */
export const MAX_NOTES_CHARS = 16_000;

const TIMEOUT_MS = 15_000;

/** GitHub's REST API asks for a user agent and names its media type. */
const GITHUB_HEADERS = Object.freeze({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'paraclete-dashboard',
});

/** GitHub did not answer as hoped. The message is for an admin. */
export class GitHubError extends Error {
  constructor(message, { status = null, retryAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryAt = retryAt;
  }
}

/**
 * GETs a GitHub API URL, unauthenticated, and answers its JSON. Throws GitHubError with a sentence
 * that says what happened: unreachable, the hourly limit used up (and until when), not found, or
 * GitHub's own message.
 *
 * @param {object} runtime
 * @param {string} url
 * @param {string} what   what was asked for, for the messages ("the releases of your-org/paraclete")
 * @returns {Promise<unknown>}
 */
export async function githubJson(runtime, url, what) {
  let response;
  try {
    response = await runtime.fetch(url, { headers: { ...GITHUB_HEADERS }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new GitHubError(`GitHub could not be reached for ${what}: ${err.message}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // no JSON: the status says enough
  }
  if (response.ok) return body;
  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  if ((response.status === 403 || response.status === 429) && (remaining === '0' || response.status === 429)) {
    const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
    const retryAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
    throw new GitHubError(`GitHub's limit of 60 requests an hour from the dashboard's address is used up${retryAt ? ` until ${retryAt}` : ''}, so ${what} could not be read`,
      { status: response.status, retryAt });
  }
  if (response.status === 404) throw new GitHubError(`GitHub has no ${what}`, { status: 404 });
  throw new GitHubError(`GitHub answered ${response.status} for ${what}: ${body?.message || 'no reason given'}`, { status: response.status });
}

async function guarded(runtime, what, call) {
  try {
    return await call();
  } catch (err) {
    if (err instanceof StoreUnavailable) {
      runtime.log('WARN', `${what}: ${err.message}`);
      throw new HttpError(503, 'the dashboard could not read or write its database just now; try again in a moment');
    }
    throw err;
  }
}

const text = (value) => (typeof value === 'string' && value ? value : null);

function versionOf(value) {
  return isVersion(value) ? String(value).trim() : null;
}

/**
 * What the instance runs, from the VM's report and this dashboard's own build. `version` is the one
 * an upgrade compares against: the VM's, when it reports a ready release (it moves first), else the
 * dashboard's, when that is a release (a failed VM run names the release it tried, not the one it
 * kept). `matched` says whether both halves run the same commit; `repair` names the release an
 * upgrade left half-done: the VM runs it, ready, and the dashboard another commit.
 *
 * @param {object|null} agent      agent/instance: { status, release, commit }
 * @param {{release?: string, commit?: string}} dashboard  this dashboard's PARACLETE_RELEASE and PARACLETE_COMMIT
 * @returns {{version: string|null, source: 'agent'|'dashboard'|null, matched: boolean, repair: string|null,
 *   agent: object, dashboard: object}}
 */
export function installedVersion(agent, dashboard) {
  const ready = agent?.status === 'ready';
  const agentView = {
    status: text(agent?.status) || 'unknown',
    release: text(agent?.release),
    commit: text(agent?.commit),
    version: ready ? versionOf(agent?.release) : null,
  };
  const dashboardView = { release: text(dashboard?.release), commit: text(dashboard?.commit), version: versionOf(dashboard?.release) };
  const version = agentView.version || dashboardView.version;
  const matched = Boolean(agentView.commit && dashboardView.commit && agentView.commit.toLowerCase() === dashboardView.commit.toLowerCase());
  return {
    version,
    source: agentView.version ? 'agent' : dashboardView.version ? 'dashboard' : null,
    matched,
    repair: agentView.version && !matched ? agentView.version : null,
    agent: agentView,
    dashboard: dashboardView,
  };
}

/** A release as stored and shown: notes cut at MAX_NOTES_CHARS, saying so. */
function keptRelease(release) {
  const notes = String(release.notes || '');
  return {
    version: release.version,
    name: release.name,
    notes: notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}\n\n(The notes go on at the release's page on GitHub.)` : notes,
    url: release.url,
    published_at: release.published_at,
  };
}

/** Releases as read back from Firestore: only well-formed ones, newest first as stored. */
function storedReleases(value) {
  return (Array.isArray(value) ? value : [])
    .filter((r) => r && typeof r === 'object' && isVersion(r.version))
    .map((r) => ({
      version: r.version,
      name: text(r.name) || r.version,
      notes: typeof r.notes === 'string' ? r.notes : '',
      url: text(r.url),
      published_at: text(r.published_at),
    }));
}

function ageSeconds(at, now) {
  const then = Date.parse(at);
  return Number.isFinite(then) ? Math.max(0, (now.getTime() - then) / 1000) : Infinity;
}

/**
 * Asks GitHub for the repository's releases. Never throws: a failure keeps `previous` releases and
 * says why in `error`.
 */
async function checkGitHub(runtime, { repo, previous, now }) {
  try {
    const json = await githubJson(runtime, releasesUrl(repo), `the releases of ${repo}`);
    return { repo, checked_at: now.toISOString(), releases: releasesFromGitHub(json).map(keptRelease), error: null };
  } catch (err) {
    runtime.log('WARN', `release check: ${err.message}`);
    return { repo, checked_at: now.toISOString(), releases: storedReleases(previous?.releases), error: err.message };
  }
}

/**
 * The release check to show: the stored one while it is fresh and for this repository, otherwise a
 * new one from GitHub, stored. Two dashboards checking at once keep whichever was stored first.
 *
 * @param {object} runtime
 * @param {{repo: string, refresh: boolean, now: Date}} o
 */
async function currentCheck(runtime, { repo, refresh, now }) {
  const path = `${runtime.collections.config}/${RELEASE_CHECK_DOC}`;
  const stored = await guarded(runtime, 'release check: read', () => runtime.db.readDoc(path));
  const data = stored?.data?.repo === repo ? stored.data : null;
  const age = data ? ageSeconds(data.checked_at, now) : Infinity;
  if (refresh && age < REFRESH_FLOOR_SECONDS) {
    const wait = Math.ceil(REFRESH_FLOOR_SECONDS - age);
    throw new HttpError(429, `GitHub was asked ${Math.floor(age)} s ago; ask again in ${wait} s (it answers 60 requests an hour)`);
  }
  if (!refresh && age < runtime.contracts.dashboard.release_check_ttl_seconds) return data;

  const next = await checkGitHub(runtime, { repo, previous: data, now });
  try {
    await runtime.db.commit([{ path, data: next, precondition: stored ? { updateTime: stored.updateTime } : { exists: false } }]);
  } catch (err) {
    if (err instanceof StoreConflict) {
      const again = await guarded(runtime, 'release check: read back', () => runtime.db.readDoc(path));
      if (again?.data?.repo === repo) return again.data;
    } else {
      // Showing what GitHub said beats failing; the next look asks again.
      runtime.log('WARN', `release check: could not store it: ${err.message}`);
    }
  }
  return next;
}

/**
 * What the instance runs, read from agent/instance and this dashboard's environment.
 *
 * @param {object} runtime
 */
export async function readInstalled(runtime) {
  const agent = await guarded(runtime, 'release check: agent/instance', () => runtime.db.read(`${runtime.collections.agent}/instance`, { strict: true }));
  return installedVersion(agent, { release: runtime.settings.release, commit: runtime.settings.commit });
}

/**
 * The release view from a check and what is installed. Pure.
 *
 * @param {object} o
 * @param {string|null} o.repo
 * @param {object} o.installed       installedVersion()
 * @param {object|null} o.check      { checked_at, releases, error }
 * @param {Date} o.now
 * @param {boolean} [o.admin]
 * @param {string|null} [o.problem]  why there is no check at all
 */
export function releasesView({ repo, installed, check, now, admin = false, problem = null }) {
  const releases = storedReleases(check?.releases);
  const checkedAt = text(check?.checked_at);
  const age = checkedAt ? ageSeconds(checkedAt, now) : Infinity;
  const refreshAt = checkedAt && age < REFRESH_FLOOR_SECONDS
    ? new Date(Date.parse(checkedAt) + REFRESH_FLOOR_SECONDS * 1000).toISOString()
    : null;
  const published = (version) => releases.find((r) => r.version === version) || null;
  return {
    repo,
    installed,
    checked_at: checkedAt,
    error: problem || text(check?.error),
    latest: releases[0] || null,
    newer: newerReleases(releases, installed.version),
    current: installed.version ? published(installed.version) : null,
    // The release an upgrade left half-done, when it is still published: installing it again finishes it.
    repair: installed.repair && published(installed.repair) ? installed.repair : null,
    ...(admin ? { refresh_at: refreshAt } : {}),
  };
}

/**
 * The releases for the System tab: what is installed, the newer published releases with their notes,
 * and when GitHub was last asked. `refresh` (admins only) asks GitHub now, at most every five minutes.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {{email: string, role: string}} o.user
 * @param {boolean} [o.refresh]
 * @param {Date} [o.now]
 */
export async function readReleases(runtime, { user, refresh = false, now = new Date() }) {
  const admin = user?.role === 'admin';
  if (refresh && !admin) throw new HttpError(403, 'only a dashboard admin can ask GitHub for releases now');
  const { repo, installed, check, problem } = await loadReleases(runtime, { refresh, now });
  return releasesView({ repo, installed, check, now, admin, problem });
}

/** Why there is no release check on a dashboard that does not know its repository. */
const NO_REPO = 'the dashboard does not know which repository it was installed from (PARACLETE_REPO, which install/install.sh sets)';

/**
 * What is installed and the release check (stored, or asked for now), unshaped: readReleases shows
 * it; upgrade.mjs checks a version against it.
 *
 * @param {object} runtime
 * @param {{refresh?: boolean, now?: Date}} [o]
 * @returns {Promise<{repo: string|null, installed: object, check: object|null, releases: object[], problem: string|null}>}
 */
export async function loadReleases(runtime, { refresh = false, now = new Date() } = {}) {
  const installed = await readInstalled(runtime);
  const { repo } = runtime.settings;
  if (!repo) return { repo: null, installed, check: null, releases: [], problem: NO_REPO };
  const check = await currentCheck(runtime, { repo, refresh, now });
  return { repo, installed, check, releases: storedReleases(check?.releases), problem: null };
}

/**
 * Whether `version` may be installed over what runs now: a newer release, or the same one again, which
 * finishes an upgrade left half-done. Null when it may; otherwise why not, for the admin.
 *
 * @param {string} version
 * @param {string|null} installedVersionText
 * @returns {string|null}
 */
export function installRefusal(version, installedVersionText) {
  if (!installedVersionText) {
    return 'this instance does not run a release (it was installed from a branch or a commit), so it cannot be upgraded from here; install a release with install/install.sh --ref <version>';
  }
  if (version === installedVersionText || isNewer(version, installedVersionText)) return null;
  return `${version} is older than ${installedVersionText}, which this instance runs; the dashboard only installs newer releases (going back is install/install.sh --ref ${version})`;
}
