#!/usr/bin/env node
// dev/status.mjs: what your dev instance runs and whether it is healthy. One SSH call reads the
// installed release (/opt/paraclete/release.json), `systemctl is-active` for the five service units,
// each service's heartbeat file (/var/lib/paraclete/services/<service>/health.json) and the
// gateway's /status (with the gateway token, read on the VM and never put on a command line); then
// Firestore gives agent/instance and the five newest missions. Exits non-zero when a service is
// down or hung, or when the installed commit and agent/instance disagree. It changes nothing. The
// dashboard's commit arrives with build plan phase 6.

import { loadContracts } from '../config/contracts.mjs';
import { COLLECTIONS } from '../agent/storage/collections.mjs';
import { SERVICES, serviceUnit } from '../agent/services/control/systemd.mjs';
import { HEARTBEAT_STALE_SECONDS } from '../agent/services/control/introspection.mjs';
import {
  DevError, VM_PATHS, READINESS_DOC, devContext, isMain, preview, runCommand,
} from './dev-env.mjs';

const USAGE = `Usage: node dev/status.mjs [--json]
Shows the commit your dev instance's VM runs, each service's state and heartbeat, the gateway's
models, agent/instance and the five newest missions. Exits 1 when a service is down or hung, or the
installed commit and agent/instance disagree. --json prints the same as one JSON object.`;

const MISSIONS_SHOWN = 5;

/**
 * The one command status runs on the VM. Each part's output follows a marker line `@@<part>`;
 * parseStatusProbe() splits them again. The gateway token goes from its file into curl's stdin, so
 * it never appears in any process's arguments.
 *
 * @param {string} gatewayUrl the gateway's loopback base URL on the VM
 * @returns {string}
 */
export function statusProbeCommand(gatewayUrl) {
  const parts = [
    'echo @@release', `sudo cat ${VM_PATHS.release}`,
    'echo', 'echo @@units', `systemctl is-active ${SERVICES.map(serviceUnit).join(' ')}`,
    ...SERVICES.flatMap((s) => ['echo', `echo @@health ${s}`, `sudo cat ${VM_PATHS.dataRoot}/services/${s}/health.json 2>/dev/null`]),
    'echo', 'echo @@gateway',
    `sudo sed 's/^/Authorization: Bearer /' ${VM_PATHS.gatewayToken} | curl -s -m 5 -H @- ${gatewayUrl}/status`,
    'echo', 'echo @@now', 'date -u +%Y-%m-%dT%H:%M:%SZ',
  ];
  return parts.join('; ');
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: text.slice(0, 200) };
  }
}

/**
 * Splits the probe's output back into its parts. Pure.
 *
 * @param {string} output
 * @returns {{release: object|null, units: Record<string, string>, health: Record<string, object|null>,
 *   gateway: object|null, now: string|null}}
 */
export function parseStatusProbe(output) {
  const sections = new Map();
  let current = null;
  for (const line of String(output).replace(/\r/g, '').split('\n')) {
    const marker = /^@@(\w+)(?: (\w+))?$/.exec(line);
    if (marker) {
      current = marker[2] ? `${marker[1]} ${marker[2]}` : marker[1];
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
  }
  const text = (name) => (sections.get(name) || []).join('\n').trim();
  const states = text('units').split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    release: parseJson(text('release')),
    units: Object.fromEntries(SERVICES.map((s, i) => [s, states[i] || 'unknown'])),
    health: Object.fromEntries(SERVICES.map((s) => [s, parseJson(text(`health ${s}`))])),
    gateway: parseJson(text('gateway')),
    now: text('now') || null,
  };
}

/** A heartbeat's age and staleness, the way the control service judges it. */
function heartbeat(health, nowMs) {
  if (!health) return null;
  const beat = Date.parse(health.beat_at);
  const age = Number.isFinite(beat) ? Math.max(0, Math.round((nowMs - beat) / 1000)) : null;
  return { beat_at: health.beat_at ?? null, age_sec: age, stale: age === null || age > HEARTBEAT_STALE_SECONDS };
}

/**
 * Puts the probe and the Firestore reads together and lists what is wrong. Pure.
 *
 * @returns {object} the report; `problems` is empty when all is well
 */
export function buildReport({ instance, probe, agentInstance, missions, localNow }) {
  const problems = [];
  const vmNow = Date.parse(probe?.now) || localNow;
  const services = Object.fromEntries(SERVICES.map((s) => {
    const active = probe ? probe.units[s] : 'unknown';
    const beat = probe ? heartbeat(probe.health[s], vmNow) : null;
    if (probe && active !== 'active') problems.push(`${s} is ${active}`);
    if (beat?.stale) problems.push(`${s}'s heartbeat is stale (${beat.age_sec === null ? 'no beat_at' : `${beat.age_sec} s old`})`);
    return [s, { unit: serviceUnit(s), active, heartbeat: beat }];
  }));
  const release = probe?.release || null;
  if (probe && !release) problems.push(`${VM_PATHS.release} is missing`);
  if (!agentInstance) problems.push(`${READINESS_DOC} does not exist`);
  else if (agentInstance.status !== 'ready') problems.push(`${READINESS_DOC} is ${agentInstance.status}${agentInstance.error ? `: ${agentInstance.error}` : ''}`);
  if (release?.commit && agentInstance && release.commit !== agentInstance.commit) {
    problems.push(`the VM has ${release.commit} installed but ${READINESS_DOC} reports ${agentInstance.commit || 'no commit'}`);
  }
  return {
    vm: { name: instance.VM, project: instance.PROJECT_ID, zone: instance.ZONE },
    release,
    services,
    gateway: probe?.gateway || null,
    agent_instance: agentInstance,
    missions: missions.map((m) => ({
      id: m.id, status: m.status, created_at: m.created_at, instruction: preview(m.instruction, 200),
    })),
    dashboard: 'not checked: the dashboard arrives with build plan phase 6',
    problems,
  };
}

function formatModels(models) {
  if (!models || typeof models !== 'object') return '';
  return Object.entries(models).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

/** The report as lines of text. */
export function formatReport(report) {
  const lines = [`VM ${report.vm.name} in ${report.vm.project} (${report.vm.zone})`];
  const r = report.release;
  lines.push(r
    ? `  release        ${r.version || '-'}  commit ${r.commit || '-'}  ref ${r.ref || '-'}  repo ${r.repo || '-'}  installed ${r.installed_at || '-'}`
    : '  release        none found');
  const a = report.agent_instance;
  lines.push(a
    ? `  agent/instance ${a.status} on ${a.commit || '-'}${a.ready_at ? ` since ${a.ready_at}` : ''}${a.error ? `: ${a.error}` : ''}`
    : '  agent/instance not written');
  lines.push('  services');
  for (const [name, s] of Object.entries(report.services)) {
    const beat = s.heartbeat
      ? `heartbeat ${s.heartbeat.age_sec === null ? 'unreadable' : `${s.heartbeat.age_sec} s ago`}${s.heartbeat.stale ? ' (STALE)' : ''}`
      : 'no heartbeat file';
    lines.push(`    ${name.padEnd(8)} ${String(s.active).padEnd(10)} ${beat}`);
  }
  const g = report.gateway;
  if (!g) lines.push('  gateway        /status did not answer');
  else if (g.unreadable || g.error) lines.push(`  gateway        /status answered: ${preview(g.unreadable || JSON.stringify(g.error), 120)}`);
  else lines.push(`  gateway        up ${g.uptime_sec ?? '?'} s, ${g.requests ?? '?'} requests, ${Array.isArray(g.sessions) ? g.sessions.length : '?'} sessions; ${formatModels(g.models)}`);
  lines.push(`  dashboard      ${report.dashboard}`);
  lines.push('', `Newest missions (${report.missions.length})`);
  if (!report.missions.length) lines.push('  none');
  for (const m of report.missions) lines.push(`  ${m.id}  ${String(m.status).padEnd(18)} ${m.created_at || '-'}  ${preview(m.instruction, 70)}`);
  lines.push('', report.problems.length ? `PROBLEMS:\n${report.problems.map((p) => `  - ${p}`).join('\n')}` : 'All services up; the installed commit matches agent/instance.');
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('status', ctx, async () => {
    let json = false;
    for (const arg of argv) {
      if (arg === '--help' || arg === '-h') { ctx.out(USAGE); return 0; }
      if (arg === '--json') json = true;
      else throw new DevError(`Unknown argument: ${arg}\n${USAGE}`, 2);
    }
    const instance = ctx.instance();
    const { gateway } = loadContracts();
    const db = ctx.db();

    const [ssh, agentInstance, missions] = await Promise.all([
      ctx.ssh(statusProbeCommand(`http://${gateway.bind}:${gateway.port}`)),
      db.read(READINESS_DOC, { strict: true }),
      db.query('', COLLECTIONS.work, [{ field: 'type', op: 'EQUAL', value: { stringValue: 'M' } }],
        { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: MISSIONS_SHOWN, strict: true }),
    ]);
    const probe = ssh.code === 0 ? parseStatusProbe(ssh.stdout) : null;
    const report = buildReport({ instance, probe, agentInstance, missions, localNow: ctx.now() });
    if (!probe) report.problems.unshift(`the VM could not be reached: gcloud compute ssh exited with code ${ssh.code} (its messages are above)`);

    ctx.out(json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.problems.length ? 1 : 0;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
