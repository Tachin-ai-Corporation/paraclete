// dashboard/components/settings/release-update.js: how the System tab's version and update card reads.
// Pure functions over GET /api/releases (what the instance runs, the newer releases with their notes)
// and GET /api/upgrade (the upgrade in progress or the last one), both shaped by lib/server/releases.mjs
// and lib/server/upgrade.mjs. The server compares versions; this only decides what to say and offer.
// UpdateCard.jsx renders it.

/** How many lines of a release's notes show before "Show all". */
export const NOTE_LINES_SHOWN = 12;

/** How long the card waits for the new dashboard to answer before it offers a reload by hand. */
export const RELOAD_WAIT_MS = 180_000;

/** How recent a finished upgrade must be for a page opened after it to wait for the new dashboard. */
const RECENT_DONE_MS = 10 * 60_000;

/**
 * A release's notes (Markdown from GitHub) as plain lines: headings, list items and text, with the
 * Markdown marks taken off. Shown as text, never as HTML.
 *
 * @param {string} markdown
 * @param {number} [max]  lines kept; `more` counts the rest
 * @returns {{lines: {kind: 'heading'|'item'|'text', text: string}[], more: number}}
 */
export function noteLines(markdown, max = Infinity) {
  const all = [];
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(-{3,}|\*{3,}|_{3,}|```.*)$/.test(line)) continue;
    let kind = 'text';
    let body = line;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      kind = 'heading';
      body = heading[1];
    } else if (item) {
      kind = 'item';
      body = item[1];
    }
    const plain = body
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
    if (plain) all.push({ kind, text: plain });
  }
  const kept = all.slice(0, max);
  return { lines: kept, more: all.length - kept.length };
}

/** The first 7 characters of a commit, or ''. */
function short(commit) {
  return typeof commit === 'string' ? commit.slice(0, 7) : '';
}

/** What one half runs, for a line of the card: its release, or its commit when that is all there is. */
export function runsText(half) {
  if (!half) return '';
  const release = half.release || '';
  const commit = short(half.commit);
  if (release && commit && release.toLowerCase() !== String(half.commit).toLowerCase()) return `${release} (commit ${commit})`;
  return release || (commit ? `commit ${commit}` : 'not recorded');
}

const VM_DETAIL = {
  sending: 'Sending the upgrade to the agent.',
  pending: "Waiting for the agent's control service to pick it up; it looks every few seconds.",
  running: "The agent's VM is installing it and restarting its services. This takes a few minutes.",
  done: 'The agent runs it.',
};

const BUILD_DETAIL = {
  starting: 'Starting the build.',
  QUEUED: 'Queued in Cloud Build.',
  PENDING: 'Queued in Cloud Build.',
  WORKING: 'Cloud Build is building the dashboard. This takes a few minutes.',
  SUCCESS: 'Built.',
};

/**
 * The three steps of an upgrade and where each stands.
 *
 * @param {object|null} upgrade  GET /api/upgrade's `upgrade`
 * @returns {{key: string, label: string, state: 'done'|'active'|'waiting', detail: string}[]}
 */
export function upgradeSteps(upgrade) {
  const order = ['vm', 'build', 'deploy'];
  const at = upgrade?.state === 'done' ? order.length : order.indexOf(upgrade?.state);
  const steps = [
    { key: 'vm', label: `The agent moves to ${upgrade?.version || 'the release'}`, detail: VM_DETAIL[upgrade?.vm?.status] || '' },
    { key: 'build', label: 'Cloud Build builds the dashboard at the same commit', detail: BUILD_DETAIL[upgrade?.build?.status] || '' },
    { key: 'deploy', label: 'Cloud Run switches the dashboard to it', detail: 'Starting the new dashboard; this page reloads once it answers.' },
  ];
  return steps.map((step, i) => {
    const state = i < at ? 'done' : i === at ? 'active' : 'waiting';
    return { ...step, state, detail: state === 'active' ? step.detail : '' };
  });
}

/**
 * The card's badge and its one-line summary.
 *
 * @param {object|null} releases  GET /api/releases
 * @param {object|null} upgrade   GET /api/upgrade's `upgrade`
 * @param {{awaiting?: boolean}} [o]  the page waits for the new dashboard (shouldAwaitReload)
 * @returns {{level: 'ok'|'info'|'warn'|'danger'|'neutral', label: string, summary: string}}
 */
export function cardStatus(releases, upgrade, { awaiting = false } = {}) {
  // Done, while the previous dashboard still answers: it reports its own commit, which would make the
  // upgrade look half-done.
  if (awaiting) return { level: 'ok', label: 'updated', summary: `${upgrade.version} is installed; the new dashboard is starting.` };
  if (upgrade?.running) return { level: 'info', label: 'updating', summary: `Installing ${upgrade.version}, started by ${upgrade.requested_by || 'an admin'}.` };
  if (!releases) return { level: 'neutral', label: 'checking', summary: 'Reading which release this instance runs.' };
  const { installed } = releases;
  if (!installed?.version) {
    return {
      level: 'neutral',
      label: 'not a release',
      summary: `This instance runs ${runsText(installed?.agent) || 'something unrecorded'}, which is not a published release, so it is offered no updates. `
        + 'Install a release with install/install.sh --ref <version>; from then on they appear here.',
    };
  }
  if (releases.repair) {
    return {
      level: 'warn',
      label: 'half installed',
      summary: `The agent runs ${releases.repair}, but this dashboard runs ${runsText(installed.dashboard)}. Install ${releases.repair} again to finish.`,
    };
  }
  if (showsFailure(releases, upgrade)) return { level: 'danger', label: 'update failed', summary: `Installing ${upgrade.version} failed.` };
  const newer = releases.newer || [];
  if (newer.length) {
    return { level: 'info', label: 'update available', summary: `${newer[0].version} is available; this instance runs ${installed.version}.` };
  }
  if (releases.error && !releases.latest) return { level: 'warn', label: 'unknown', summary: `Runs ${installed.version}. Whether a newer release exists is not known.` };
  return { level: 'ok', label: 'up to date', summary: `Runs ${installed.version}, the newest release.` };
}

/**
 * The versions an admin may install now: the release left half-done first, then the newer ones,
 * newest first. None while an upgrade runs, or while the page waits for the dashboard it installed.
 *
 * @param {object|null} releases
 * @param {object|null} upgrade
 * @param {{awaiting?: boolean}} [o]
 * @returns {string[]}
 */
export function installChoices(releases, upgrade, { awaiting = false } = {}) {
  if (!releases || upgrade?.running || awaiting) return [];
  const versions = [];
  if (releases.repair) versions.push(releases.repair);
  for (const r of releases.newer || []) if (!versions.includes(r.version)) versions.push(r.version);
  return versions;
}

/**
 * Whether a failed upgrade is still worth showing: its release can still be installed (it is newer
 * than what runs, or the one left half-done). An old failure, overtaken since, is not news.
 *
 * @param {object|null} releases
 * @param {object|null} upgrade
 * @returns {boolean}
 */
export function showsFailure(releases, upgrade) {
  if (upgrade?.state !== 'failed' || !releases) return false;
  return releases.repair === upgrade.version || (releases.newer || []).some((r) => r.version === upgrade.version);
}

/**
 * Whether the page should wait for the dashboard on the upgrade's commit and then reload: the upgrade
 * is done, this page runs another commit, and the card saw it running or it finished moments ago.
 *
 * @param {object|null} upgrade
 * @param {string} pageCommit  the commit this page was served by (GET /api/me when it loaded)
 * @param {{sawRunning: boolean, now?: number}} o
 * @returns {boolean}
 */
export function shouldAwaitReload(upgrade, pageCommit, { sawRunning, now = Date.now() }) {
  if (upgrade?.state !== 'done' || !upgrade.commit) return false;
  if (String(pageCommit || '').toLowerCase() === upgrade.commit.toLowerCase()) return false;
  const finished = Date.parse(upgrade.updated_at);
  return sawRunning || (Number.isFinite(finished) && now - finished < RECENT_DONE_MS);
}

/** Whether the dashboard now answering runs the upgrade's commit. */
export function isNewDashboard(me, upgrade) {
  const commit = me?.dashboard?.commit;
  return Boolean(commit && upgrade?.commit && commit.toLowerCase() === upgrade.commit.toLowerCase());
}
