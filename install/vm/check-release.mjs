#!/usr/bin/env node
// install/vm/check-release.mjs: the validation gate a staged release must pass before bootstrap.sh
// swaps it into place. It runs from the staged tree, with that release's own code and npm packages,
// and checks that the contracts load and validate (config/contracts.mjs), that every service has its
// systemd unit and its main.mjs loads with everything it imports, and that every launcher in bin/
// names a command module that exists and loads. Loading never starts anything: each entry point runs
// only when it is the program Node was started with. A release that fails here is never installed,
// and the release already running keeps running. It changes nothing on disk.
//
//   node <staged release>/install/vm/check-release.mjs --install-root /opt/paraclete

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NODE_BINARY } from './launchers.mjs';

/** The release this module belongs to: the staged tree when bootstrap.sh runs it. */
const OWN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The service directories: those under agent/services/ that hold a main.mjs or a unit. */
function serviceDirectories(root) {
  const dir = join(root, 'agent', 'services');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(dir, name, 'main.mjs')) || existsSync(join(dir, name, `paraclete-${name}.service`)))
    .sort();
}

/**
 * Every problem with a staged release, as readable strings. Empty means it may be installed.
 *
 * @param {object}   o
 * @param {string}   o.root          the staged release
 * @param {string}   o.installRoot   where it will run; launchers name paths under it
 * @param {string}   [o.binDir]      the launchers (default <root>/bin)
 * @param {Function} [o.importModule] (absolute path) => Promise<module>
 * @returns {Promise<{problems: string[], services: string[], commands: string[]}>}
 */
export async function checkRelease({
  root,
  installRoot,
  binDir = join(root, 'bin'),
  importModule = (path) => import(pathToFileURL(path).href),
}) {
  const problems = [];
  const load = async (rel, what) => {
    try {
      return await importModule(join(root, rel));
    } catch (err) {
      problems.push(`${what} (${rel}) does not load: ${String(err?.message || err).split('\n')[0]}`);
      return null;
    }
  };

  const contracts = await load('config/contracts.mjs', 'the contracts loader');
  if (contracts) {
    try {
      contracts.loadContracts();
    } catch (err) {
      problems.push(`the contracts do not validate: ${err.message}`);
    }
  }

  const services = serviceDirectories(root);
  if (!services.length) problems.push('the release has no services under agent/services/');
  for (const service of services) {
    if (!existsSync(join(root, 'agent', 'services', service, `paraclete-${service}.service`))) {
      problems.push(`service ${service} has no unit agent/services/${service}/paraclete-${service}.service`);
    }
    if (!existsSync(join(root, 'agent', 'services', service, 'main.mjs'))) {
      problems.push(`service ${service} has a unit but no main.mjs`);
    } else {
      await load(`agent/services/${service}/main.mjs`, `service ${service}`);
    }
  }

  const commands = [];
  const launcher = new RegExp(`^#!/bin/sh\\nexec ${escape(NODE_BINARY)} ${escape(installRoot.replace(/\/+$/, ''))}/(\\S+\\.mjs) "\\$@"\\n$`);
  if (!existsSync(binDir)) {
    problems.push('the release has no bin/ launchers');
  } else {
    for (const name of readdirSync(binDir).sort()) {
      const match = launcher.exec(readFileSync(join(binDir, name), 'utf8'));
      if (!match) {
        problems.push(`bin/${name} is not a launcher for a command under ${installRoot}`);
        continue;
      }
      const rel = posix.normalize(match[1]);
      if (rel.startsWith('../') || !existsSync(join(root, rel))) {
        problems.push(`bin/${name} runs ${rel}, which the release does not have`);
        continue;
      }
      if (await load(rel, `command ${name}`)) commands.push(name);
    }
  }
  return { problems, services, commands };
}

/**
 * The command line: `--install-root <dir>`. Checks the release this file belongs to. Exits 0 when
 * the release may be installed, 1 naming every problem.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, { root = OWN_ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { 'install-root': { type: 'string' } } });
    if (!values['install-root']) {
      stderr.write('Usage: check-release.mjs --install-root <install root>\n');
      return 2;
    }
    const { problems, services, commands } = await checkRelease({ root, installRoot: values['install-root'] });
    if (problems.length) {
      stderr.write(`check-release: the release at ${root} must not be installed:\n- ${problems.join('\n- ')}\n`);
      return 1;
    }
    stdout.write(`release checks passed: contracts, ${services.length} services (${services.join(' ')}), ${commands.length} commands\n`);
    return 0;
  } catch (err) {
    stderr.write(`check-release: ${err.message}\n`);
    return 1;
  }
}

// Exits explicitly: a module the check loaded must not keep the process waiting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
