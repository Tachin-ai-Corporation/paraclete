#!/usr/bin/env node
// install/vm/role-packages.mjs: the Debian packages an instance's role needs, read from the release
// being installed: `setup.apt` of roles/generic/role.json (every instance has the generic role) and of
// the instance's own role. bootstrap.sh installs them with apt-get. A role that declares pip or npm
// packages is refused: this bootstrap does not install them yet (build plan phase 8 adds roles that
// may), and a role missing its tools fails later in ways that are hard to trace.
//
//   node install/vm/role-packages.mjs --root <release dir> --role <role>     prints one package per line

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** A Debian package name (Debian Policy 5.6.1). Nothing else reaches apt-get's command line. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/;

/** A role id is one path segment here. Whether it names a real role is config/instance.mjs's rule. */
const ROLE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The apt packages for an instance of `role`, generic's first, without duplicates.
 *
 * @param {string} root the release
 * @param {string} role
 * @returns {string[]}
 */
export function rolePackages(root, role) {
  if (typeof role !== 'string' || !ROLE_SEGMENT.test(role)) {
    throw new Error(`the role must be a role id like 'generic', got ${JSON.stringify(role)}`);
  }
  const problems = [];
  const packages = [];
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
    for (const kind of ['pip', 'npm']) {
      if (Array.isArray(setup[kind]) && setup[kind].length) {
        problems.push(`role '${id}' declares setup.${kind} packages, which this bootstrap does not install`);
      }
    }
    for (const name of Array.isArray(setup.apt) ? setup.apt : []) {
      if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) problems.push(`role '${id}': ${JSON.stringify(name)} is not a Debian package name`);
      else if (!packages.includes(name)) packages.push(name);
    }
  }
  if (problems.length) throw new Error(`cannot read the role's packages:\n- ${problems.join('\n- ')}`);
  return packages;
}

/**
 * The command line: `--root <release dir> --role <role>`.
 *
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 * @returns {number} exit code
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, role: { type: 'string' } } });
    if (!values.root || !values.role) {
      stderr.write('Usage: role-packages.mjs --root <release dir> --role <role>\n');
      return 2;
    }
    const packages = rolePackages(values.root, values.role);
    if (packages.length) stdout.write(`${packages.join('\n')}\n`);
    return 0;
  } catch (err) {
    stderr.write(`role-packages: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
