// agent/work/role-packages.mjs: reads the defaults the installed role packages ship: each package's
// responsibilities.json and the process playbooks in its processes/. The generic role is the base of
// every role and is read first; the instance's role, when it is another, comes after it. The caller
// passes the package directories: reading installed package files is reading data, not
// configuration. Layering these defaults under the agent's own store is responsibility-store.mjs's
// and process-registry.mjs's job, not this file's. Called by the brain service and by the
// responsibility-manage and process-ops commands.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the installed role packages are.
 *
 * @typedef {object} RoleDirs
 * @property {string} genericDir the generic role's package directory, the base of every role
 * @property {string} role       the instance's role id
 * @property {string} roleDir    the instance's role package directory
 */

const readUtf8 = (path) => readFileSync(path, 'utf8');

/** The packages to read, base first: generic, then the instance's role when it is another. */
function rolePackages({ genericDir, role, roleDir }) {
  const packages = [{ source: 'generic', dir: genericDir }];
  if (role && role !== 'generic' && roleDir !== genericDir) packages.push({ source: role, dir: roleDir });
  return packages;
}

/**
 * The responsibilities.json of each installed role package, parsed, generic first, in the shape
 * collectDefaults() in responsibility-store.mjs takes. A package without the file contributes
 * nothing; an unreadable one is reported through onError and skipped.
 *
 * @param {RoleDirs} roles
 * @param {object}   [opts]
 * @param {Function} [opts.onError]  (file, error) => void
 * @param {Function} [opts.readText] (path) => string (default: read the file)
 * @param {Function} [opts.exists]   (path) => boolean (default: existsSync)
 * @returns {Array<{source: string, responsibilities: object[]}>}
 */
export function readInstalledResponsibilities(roles, { onError = () => {}, readText = readUtf8, exists = existsSync } = {}) {
  const out = [];
  for (const { source, dir } of rolePackages(roles)) {
    const file = join(dir, 'responsibilities.json');
    if (!exists(file)) continue;
    try {
      const parsed = JSON.parse(readText(file));
      out.push({ source, responsibilities: Array.isArray(parsed?.responsibilities) ? parsed.responsibilities : [] });
    } catch (e) {
      onError(file, e);
    }
  }
  return out;
}

/**
 * The installed process playbooks (one JSON file each, in each role package's processes/), generic
 * first, in file-name order within a package. The first playbook with an id wins, so the base stays
 * authoritative and a role only adds its own. A playbook without an id is skipped; an unreadable file
 * is reported through onError and skipped. Each carries `_source`, the package it came from.
 *
 * @param {RoleDirs} roles
 * @param {object}   [opts]
 * @param {Function} [opts.onError]  (file, error) => void
 * @param {Function} [opts.readText] (path) => string (default: read the file)
 * @param {Function} [opts.exists]   (path) => boolean (default: existsSync)
 * @param {Function} [opts.listDir]  (dir) => string[] (default: readdirSync)
 * @returns {object[]}
 */
export function readInstalledProcesses(roles, { onError = () => {}, readText = readUtf8, exists = existsSync, listDir = readdirSync } = {}) {
  const seen = new Set();
  const out = [];
  for (const { source, dir } of rolePackages(roles)) {
    const processesDir = join(dir, 'processes');
    if (!exists(processesDir)) continue;
    for (const name of listDir(processesDir).filter((n) => n.endsWith('.json')).sort()) {
      const file = join(processesDir, name);
      try {
        const p = JSON.parse(readText(file));
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({ ...p, _source: source });
      } catch (e) {
        onError(file, e);
      }
    }
  }
  return out;
}
