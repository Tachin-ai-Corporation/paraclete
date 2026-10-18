#!/usr/bin/env node
// install/vm/role-packages.mjs: the packages an instance's role needs, read from the release being
// installed: `setup` of roles/generic/role.json (every instance has the generic role) and of the
// instance's own role, generic's first. bootstrap.sh installs them: the Debian (`apt`) ones with
// apt-get; the `npm` ones globally, as root; the `pip` ones for the paraclete user (install/README.md
// says why). npm and pip packages are pinned to exact versions (`name@1.2.3`, `name==1.2.3`), so an
// upgrade installs what the release was tested with and nothing a registry published since. Anything
// that is not a package name, or not pinned, is refused here before it reaches a package manager's
// command line: a role missing its tools fails later in ways that are hard to trace. Given the list
// of what is installed now (`--installed`), it prints only the pinned packages missing or at another
// version, so a run installs nothing twice. It never installs anything itself.
//
//   node install/vm/role-packages.mjs --root <release dir> --role <role>                 the apt packages, one per line
//   node install/vm/role-packages.mjs --root <release dir> --role <role> --kind npm      the pinned npm packages
//   node install/vm/role-packages.mjs --root <release dir> --role <role> --kind pip      the pinned pip packages
//   ... --kind npm --installed <file>   only those not installed at their version; <file> holds the output
//                                       of `npm ls --global --depth=0 --json`
//   ... --kind pip --installed <file>   the same; <file> holds `python3 -m pip list --user --format=json`

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The package managers a role's `setup` names, in the order bootstrap.sh installs them. */
export const KINDS = Object.freeze(['apt', 'npm', 'pip']);

/** A Debian package name (Debian Policy 5.6.1). Nothing else reaches apt-get's command line. */
const DEBIAN_NAME = /^[a-z0-9][a-z0-9+.-]+$/;

/** An npm package, optionally scoped, at one exact semver version: `name@1.2.3`, `@scope/name@1.2.3-rc.1`. */
const NPM_PIN = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** A Python distribution at one exact PEP 440 version: `name==1.2.3`, `name==2.0rc1`, `name==1.0.post1`. */
const PIP_PIN = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==((?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?(?:\.dev[0-9]+)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?)$/;

/** A role id is one path segment here. Whether it names a real role is config/instance.mjs's rule. */
const ROLE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** A Python distribution's name as pip compares it (PEP 503): lowercase, runs of `-`, `_` and `.` as one `-`. */
export function normalizePipName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * One `setup` entry, checked: `{ name, version }` for an npm or pip pin, `{ name }` for a Debian
 * package, or null when it is not one of those.
 *
 * @param {'apt'|'npm'|'pip'} kind
 * @param {unknown} spec
 * @returns {{name: string, version?: string}|null}
 */
export function parsePackage(kind, spec) {
  if (typeof spec !== 'string') return null;
  if (kind === 'apt') return DEBIAN_NAME.test(spec) ? { name: spec } : null;
  const match = (kind === 'npm' ? NPM_PIN : kind === 'pip' ? PIP_PIN : null)?.exec(spec);
  return match ? { name: match[1], version: match[2] } : null;
}

/** The key two pins of one package share, whatever the version. */
function packageKey(kind, name) {
  return kind === 'pip' ? normalizePipName(name) : name;
}

const WHAT = {
  apt: 'a Debian package name',
  npm: 'an npm package pinned to an exact version, like name@1.2.3',
  pip: 'a pip package pinned to an exact version, like name==1.2.3',
};

/**
 * Every package the role's instance needs, by package manager: generic's first, then the role's, each
 * once. Throws, naming every problem, when a role is missing or unreadable, an entry is not a package
 * name or not pinned, or the two roles pin one package at different versions.
 *
 * @param {string} root the release
 * @param {string} role
 * @returns {{apt: string[], npm: string[], pip: string[]}}
 */
export function roleSetup(root, role) {
  if (typeof role !== 'string' || !ROLE_SEGMENT.test(role)) {
    throw new Error(`the role must be a role id like 'generic', got ${JSON.stringify(role)}`);
  }
  const problems = [];
  const lists = { apt: [], npm: [], pip: [] };
  const pinned = { npm: new Map(), pip: new Map() };
  for (const id of [...new Set(['generic', role])]) {
    const file = join(root, 'roles', id, 'role.json');
    if (!existsSync(file)) {
      problems.push(`role '${id}' is not in this release (no roles/${id}/role.json)`);
      continue;
    }
    let setup;
    try {
      setup = JSON.parse(readFileSync(file, 'utf8')).setup || {};
    } catch (err) {
      problems.push(`roles/${id}/role.json cannot be read: ${err.message}`);
      continue;
    }
    for (const kind of KINDS) {
      if (setup[kind] !== undefined && !Array.isArray(setup[kind])) {
        problems.push(`role '${id}': setup.${kind} must be a list`);
        continue;
      }
      for (const spec of setup[kind] || []) {
        const parsed = parsePackage(kind, spec);
        if (!parsed) {
          problems.push(`role '${id}': setup.${kind} ${JSON.stringify(spec)} is not ${WHAT[kind]}`);
          continue;
        }
        if (kind !== 'apt') {
          const key = packageKey(kind, parsed.name);
          const earlier = pinned[kind].get(key);
          if (earlier && earlier.version !== parsed.version) {
            problems.push(`role '${id}': setup.${kind} pins ${spec}, but ${earlier.spec} is pinned already`);
          }
          if (earlier) continue;
          pinned[kind].set(key, { spec, version: parsed.version });
        }
        if (!lists[kind].includes(spec)) lists[kind].push(spec);
      }
    }
  }
  if (problems.length) throw new Error(`cannot read the role's packages:\n- ${problems.join('\n- ')}`);
  return lists;
}

/**
 * The packages of one kind for an instance of `role`, generic's first, without duplicates.
 *
 * @param {string} root the release
 * @param {string} role
 * @param {'apt'|'npm'|'pip'} [kind]
 * @returns {string[]}
 */
export function rolePackages(root, role, kind = 'apt') {
  if (!KINDS.includes(kind)) throw new Error(`the kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
  return roleSetup(root, role)[kind];
}

/**
 * What is installed now, by package key, read from the package manager's own listing. A listing that
 * is empty or cannot be parsed counts as nothing installed: the run then installs every pin, which
 * changes nothing for a package already at its version.
 *
 * @param {'npm'|'pip'} kind
 * @param {string} text `npm ls --global --depth=0 --json`, or `pip list --user --format=json`
 * @returns {Map<string, string>} key → installed version
 */
export function installedVersions(kind, text) {
  const installed = new Map();
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').trim() || 'null');
  } catch {
    return installed;
  }
  if (kind === 'npm') {
    for (const [name, entry] of Object.entries(parsed?.dependencies || {})) {
      if (typeof entry?.version === 'string') installed.set(name, entry.version);
    }
  } else if (kind === 'pip') {
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      if (typeof entry?.name === 'string' && typeof entry?.version === 'string') {
        installed.set(normalizePipName(entry.name), entry.version);
      }
    }
  }
  return installed;
}

/**
 * The pins not installed at exactly their version, in the order given.
 *
 * @param {'npm'|'pip'} kind
 * @param {string[]} pins
 * @param {string} installedText the package manager's listing (see installedVersions)
 * @returns {string[]}
 */
export function missingPins(kind, pins, installedText) {
  const installed = installedVersions(kind, installedText);
  return pins.filter((spec) => {
    const { name, version } = parsePackage(kind, spec) || {};
    return installed.get(packageKey(kind, name)) !== version;
  });
}

/**
 * The command line, as the header gives it.
 *
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}, readText?: Function}} [deps]
 * @returns {number} exit code
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  const usage = 'Usage: role-packages.mjs --root <release dir> --role <role> [--kind apt|npm|pip] [--installed <file>]\n';
  try {
    const { values } = parseArgs({
      args: argv,
      options: { root: { type: 'string' }, role: { type: 'string' }, kind: { type: 'string' }, installed: { type: 'string' } },
    });
    const kind = values.kind ?? 'apt';
    if (!values.root || !values.role || !KINDS.includes(kind) || (values.installed !== undefined && kind === 'apt')) {
      stderr.write(usage);
      return 2;
    }
    let packages = rolePackages(values.root, values.role, kind);
    if (values.installed !== undefined && packages.length) {
      let listing = '';
      try { listing = readText(values.installed); } catch { /* nothing readable is nothing installed */ }
      packages = missingPins(kind, packages, listing);
    }
    if (packages.length) stdout.write(`${packages.join('\n')}\n`);
    return 0;
  } catch (err) {
    stderr.write(`role-packages: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
