// dashboard/components/settings/service-health.js: how the `status` command's answer reads in Settings.
// Pure functions over the result shape in agent/services/control/README.md, shared by the System tab
// and the setup checklist so both call a service healthy for the same reason: systemd runs it and its
// heartbeat is fresh.

/** The order the System tab lists services in, and the checklist names them in. */
export const SERVICE_ORDER = Object.freeze(['gateway', 'brain', 'ears', 'mouth', 'control']);

/**
 * One service's health from its status entry.
 *
 * @param {object|undefined} entry  status.services[<service>]
 * @returns {{level: 'ok'|'info'|'warn'|'danger', label: string, healthy: boolean, detail: string}}
 */
export function serviceHealth(entry) {
  if (!entry) return { level: 'danger', label: 'missing', healthy: false, detail: 'the status check did not report it' };
  if (entry.error) return { level: 'danger', label: 'unknown', healthy: false, detail: entry.error };
  const { active, sub } = entry;
  const beat = entry.heartbeat;
  if (active === 'active' && sub === 'running') {
    if (beat?.stale) {
      const age = Number.isFinite(beat.age_sec) ? `${formatDuration(beat.age_sec)} old` : 'missing its time';
      return { level: 'warn', label: 'stale', healthy: false, detail: `running, but its heartbeat is ${age}: its loop may be stuck` };
    }
    return { level: 'ok', label: 'running', healthy: true, detail: '' };
  }
  if (active === 'activating' || active === 'reloading') return { level: 'info', label: active, healthy: false, detail: `systemd shows ${active} (${sub})` };
  if (active === 'failed') return { level: 'danger', label: 'failed', healthy: false, detail: `systemd shows failed (${entry.result || sub})` };
  return { level: 'warn', label: active || 'unknown', healthy: false, detail: `systemd shows ${active} (${sub})` };
}

/**
 * The services that are not healthy, in SERVICE_ORDER, with why.
 *
 * @param {object} status the status command's result
 * @returns {{service: string, detail: string}[]}
 */
export function unhealthyServices(status) {
  return SERVICE_ORDER
    .map((service) => ({ service, health: serviceHealth(status?.services?.[service]) }))
    .filter(({ health }) => !health.healthy)
    .map(({ service, health }) => ({ service, detail: health.detail || health.label }));
}

/** "45 s", "12 min", "3 h 20 min", "4 d 2 h"; '' for anything that is not a number of seconds. */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.round(s)} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** The first 7 characters of a commit id, or '' without one. */
export function shortCommit(commit) {
  return typeof commit === 'string' ? commit.slice(0, 7) : '';
}

/**
 * The agent's release and the dashboard's build side by side. They should be the same commit: one
 * upgrade moves both.
 *
 * @param {object|null} release  status.release (the VM's release.json)
 * @param {{release?: string, commit?: string}|null} dashboard  GET /api/me's `dashboard`
 * @returns {'same'|'different'|'unknown'}
 */
export function compareBuilds(release, dashboard) {
  const agentCommit = release?.commit || '';
  const dashboardCommit = dashboard?.commit || '';
  if (!agentCommit || !dashboardCommit) return 'unknown';
  return agentCommit.toLowerCase() === dashboardCommit.toLowerCase() ? 'same' : 'different';
}
