// agent/services/control/introspection.mjs: the read-only views the dashboard asks the VM for: the
// services' state and heartbeats, the installed and agent-written skills, the instance's
// configuration, and the agent's memory files, organ prompts and workspace listing. It changes
// nothing. Each view becomes the result of one command document, which Firestore caps at 1 MiB, so
// file contents are bounded per file and in total, and a cut is always marked. Called by commands.mjs.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, uptime, loadavg, totalmem, freemem } from 'node:os';
import { SERVICES } from './systemd.mjs';

/** The release record the installer writes under the install root. */
export const RELEASE_FILE = 'release.json';

/**
 * A service that polls rewrites its health file after every poll. A beat older than this means its
 * loop is hung even though systemd still shows it running.
 */
export const HEARTBEAT_STALE_SECONDS = 60;

const MAX_FILE_CHARS = 64 * 1024;
const MAX_TOTAL_CHARS = 700 * 1024;
const MAX_LISTED_ENTRIES = 500;

const readUtf8 = (path) => readFileSync(path, 'utf8');

/**
 * A content budget for one result: each file is cut at MAX_FILE_CHARS, and once the total is spent
 * later files carry no content at all. Either cut is reported on the entry.
 *
 * @param {number} [total]
 * @returns {(text: string) => {content: string|null, truncated: boolean}}
 */
export function contentBudget(total = MAX_TOTAL_CHARS) {
  let used = 0;
  return (text) => {
    const s = String(text ?? '');
    const capped = s.length > MAX_FILE_CHARS ? s.slice(0, MAX_FILE_CHARS) : s;
    if (used + capped.length > total) return { content: null, truncated: true };
    used += capped.length;
    return { content: capped, truncated: capped.length < s.length };
  };
}

/**
 * The installed release, from <installRoot>/release.json, or null when there is none or it is
 * unreadable.
 *
 * @param {string} installRoot
 * @param {{readText?: Function}} [o]
 * @returns {object|null}
 */
export function readRelease(installRoot, { readText = readUtf8 } = {}) {
  try {
    const release = JSON.parse(readText(join(installRoot, RELEASE_FILE)));
    return release && typeof release === 'object' ? release : null;
  } catch {
    return null;
  }
}

/**
 * Where a service writes its health after every poll: <data root>/services/<service>/health.json.
 *
 * @param {string} dataRoot
 * @param {string} service
 * @returns {string}
 */
export function heartbeatFile(dataRoot, service) {
  return join(dataRoot, 'services', service, 'health.json');
}

/**
 * A service's last heartbeat: its health file as written, plus how old the beat is and whether it is
 * stale. Null when the service writes none (the gateway is probed over HTTP instead, and control is
 * the one answering).
 *
 * @param {string} dataRoot
 * @param {string} service
 * @param {{readText?: Function, now?: Function}} [o]
 * @returns {object|null}
 */
export function readHeartbeat(dataRoot, service, { readText = readUtf8, now = () => new Date() } = {}) {
  const file = heartbeatFile(dataRoot, service);
  let text;
  try {
    text = readText(file);
  } catch (err) {
    return err.code === 'ENOENT' ? null : { file, stale: true, error: `the health file could not be read: ${err.message}` };
  }
  let health;
  try {
    health = JSON.parse(text);
  } catch {
    return { file, stale: true, error: 'the health file is not valid JSON' };
  }
  const beat = Date.parse(health?.beat_at);
  const age = Number.isFinite(beat) ? Math.max(0, Math.round((now().getTime() - beat) / 1000)) : null;
  return { ...health, file, age_sec: age, stale: age === null || age > HEARTBEAT_STALE_SECONDS };
}

/**
 * The status view: every paraclete service's systemd state and last heartbeat, the gateway's
 * readiness and models, the installed release, and the host.
 *
 * @param {object}   o
 * @param {object}   o.systemd     from createSystemd()
 * @param {Function} o.probe       async () => the gateway probe (gateway-probe.mjs)
 * @param {string}   o.installRoot
 * @param {string}   o.dataRoot
 * @param {Function} [o.readText]
 * @param {Function} [o.now]       () => Date
 * @returns {Promise<object>}
 */
export async function readStatus({ systemd, probe, installRoot, dataRoot, readText = readUtf8, now = () => new Date() }) {
  const states = await Promise.all(SERVICES.map(async (service) => {
    const heartbeat = readHeartbeat(dataRoot, service, { readText, now });
    try {
      return { ...(await systemd.serviceState(service)), heartbeat };
    } catch (err) {
      return { service, error: err.message, heartbeat };
    }
  }));
  return {
    checked_at: now().toISOString(),
    services: Object.fromEntries(states.map((s) => [s.service, s])),
    gateway: await probe(),
    release: readRelease(installRoot, { readText }),
    host: {
      hostname: hostname(),
      uptime_sec: Math.round(uptime()),
      load_avg: loadavg(),
      memory_total_bytes: totalmem(),
      memory_free_bytes: freemem(),
    },
    control: { pid: process.pid, uptime_sec: Math.round(process.uptime()) },
  };
}

/**
 * Every skill on the instance, in the gateway's catalog order: the base skills, the generic role's, the
 * chosen role's, then the ones the agent wrote. A directory with a skill.json or a SKILL.md is a skill.
 *
 * @param {object} o
 * @param {object} o.paths    the service runtime's paths
 * @param {object} o.instance
 * @returns {{skills: object[]}}
 */
export function readSkills({ paths, instance }) {
  const sources = [['base', paths.skills], ['role:generic', join(paths.genericRole, 'skills')]];
  if (instance.role !== 'generic') sources.push([`role:${instance.role}`, join(paths.role, 'skills')]);
  sources.push(['agent', paths.data.skills]);
  const budget = contentBudget();
  const skills = [];
  for (const [origin, dir] of sources) {
    for (const name of listDir(dir).filter((e) => e.kind === 'dir').map((e) => e.name)) {
      const skillDir = join(dir, name);
      const manifestText = readOrNull(join(skillDir, 'skill.json'));
      const skillMd = readOrNull(join(skillDir, 'SKILL.md'));
      if (manifestText === null && skillMd === null) continue;
      let manifest = {};
      let manifestError = null;
      if (manifestText !== null) {
        try { manifest = JSON.parse(manifestText); } catch (err) { manifestError = `skill.json is not valid JSON: ${err.message}`; }
      }
      const md = skillMd === null ? { content: null, truncated: false } : budget(skillMd);
      skills.push({
        id: manifest.id || name,
        name: manifest.name || manifest.id || name,
        version: manifest.version || '',
        when_to_use: manifest.when_to_use || '',
        organs: Array.isArray(manifest.organs) ? manifest.organs : [],
        commands: Array.isArray(manifest.commands) ? manifest.commands : [],
        origin,
        path: skillDir,
        skill_md: md.content,
        skill_md_truncated: md.truncated,
        ...(skillMd === null ? { problem: 'no SKILL.md' } : {}),
        ...(manifestError ? { problem: manifestError } : {}),
      });
    }
  }
  return { skills };
}

/**
 * The configuration view: the instance record, the installed release, the admin settings and the
 * contracts. None of it is secret: the gateway token is a file the record names, never its content.
 *
 * @param {object} o
 * @param {object} o.contracts
 * @param {object} o.instance
 * @param {object} o.settings  from readSettingsView() in models.mjs
 * @param {object|null} o.release
 * @returns {object}
 */
export function readConfig({ contracts, instance, settings, release }) {
  return { instance: { ...instance }, release, settings, contracts };
}

/**
 * The workspace view: the agent's memory files with their content, the organ prompts the gateway
 * loads (base, then the role's appends), and a listing of the motor organ's workspace without content.
 * Memory comes first, so the content budget never pushes it out.
 *
 * @param {object} o
 * @param {object} o.paths
 * @param {object} o.instance
 * @returns {{memory: object[], prompts: object[], workspace: object[], workspace_truncated: boolean}}
 */
export function readWorkspace({ paths, instance }) {
  const budget = contentBudget();
  const markdown = (dir) => listDir(dir).filter((e) => e.kind === 'file' && e.name.endsWith('.md'));
  const withContent = (dir, entry, extra = {}) => {
    const text = readOrNull(join(dir, entry.name));
    const cut = text === null ? { content: null, truncated: false } : budget(text);
    return { name: entry.name, ...extra, size_bytes: entry.size_bytes, modified_at: entry.modified_at, content: cut.content, truncated: cut.truncated };
  };
  const memory = markdown(paths.data.memory).map((e) => withContent(paths.data.memory, e));
  const rolePrompts = join(paths.role, 'prompts');
  const prompts = [
    ...markdown(paths.prompts).map((e) => withContent(paths.prompts, e, { source: 'base' })),
    ...markdown(rolePrompts).map((e) => withContent(rolePrompts, e, { source: `role:${instance.role}` })),
  ];
  const listing = listDir(paths.data.workspace);
  return {
    memory,
    prompts,
    workspace: listing.slice(0, MAX_LISTED_ENTRIES),
    workspace_truncated: listing.length > MAX_LISTED_ENTRIES,
  };
}

/** A directory's entries, sorted by name; [] when it does not exist or cannot be read. */
function listDir(dir) {
  let names;
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const entries = [];
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      entries.push({
        name,
        kind: st.isDirectory() ? 'dir' : 'file',
        size_bytes: st.isDirectory() ? null : st.size,
        modified_at: st.mtime.toISOString(),
      });
    } catch { /* removed between the listing and the stat */ }
  }
  return entries;
}

function readOrNull(path) {
  try { return readUtf8(path); } catch { return null; }
}
