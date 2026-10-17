#!/usr/bin/env node
// install/vm/launchers.mjs: the command launchers in <install root>/bin/, which let the agent run
// every command by its bare name. bootstrap.sh runs it on the staged release. One launcher per
// agent/cli/<command>.mjs except cli-runtime.mjs (every command starts from it; it is not one), and
// one per command a skill lists in its skill.json whose <command>.mjs sits in that skill's own
// directory (a command listed there without a file is a shared agent/cli command). A launcher is a
// two-line shell script, never a symbolic link: a symlink would break each command's run-directly
// check. The format is install/README.md's.
//
//   node install/vm/launchers.mjs --root <staged release> --install-root /opt/paraclete --role <role>

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The one module in agent/cli/ that is not a command. */
export const CLI_RUNTIME = 'cli-runtime.mjs';

/** The Node.js the launchers and the service units run. */
export const NODE_BINARY = '/usr/bin/node';

/** A command name: kebab-case, safe as a file name and inside a shell script. */
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A repo path a launcher may name: no spaces or shell-special characters. */
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** A role id is one path segment here. Whether it names a real role is config/instance.mjs's rule. */
const ROLE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** The directories that hold skills for an instance of `role`, as repo paths. */
export function skillRoots(role) {
  if (typeof role !== 'string' || !ROLE_SEGMENT.test(role)) {
    throw new Error(`the role must be a role id like 'generic', got ${JSON.stringify(role)}`);
  }
  return [...new Set(['skills', 'roles/generic/skills', `roles/${role}/skills`])];
}

function subdirectories(root, rel) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/**
 * Every command that gets a launcher, sorted by name. Throws when two files claim one name, or a
 * skill.json cannot be read: either would leave the agent running a command nobody chose.
 *
 * @param {string} root the release root (repo, extracted release or staged tree)
 * @param {string} role
 * @returns {Array<{name: string, file: string}>} file is the repo path of the command's module
 */
export function listCommands(root, role) {
  const found = new Map();
  const problems = [];
  const add = (name, file) => {
    if (!COMMAND_NAME.test(name)) problems.push(`'${name}' (${file}) is not a valid command name`);
    else if (!SAFE_PATH.test(file)) problems.push(`${file} is not a path a launcher can name`);
    else if (found.has(name) && found.get(name) !== file) problems.push(`'${name}' is claimed by both ${found.get(name)} and ${file}`);
    else found.set(name, file);
  };

  const cliDir = join(root, 'agent', 'cli');
  if (existsSync(cliDir)) {
    for (const entry of readdirSync(cliDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs') && entry.name !== CLI_RUNTIME) {
        add(entry.name.slice(0, -'.mjs'.length), `agent/cli/${entry.name}`);
      }
    }
  }

  for (const skillsRoot of skillRoots(role)) {
    for (const skill of subdirectories(root, skillsRoot)) {
      const skillDir = posix.join(skillsRoot, skill);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(root, skillDir, 'skill.json'), 'utf8'));
      } catch (err) {
        problems.push(`${skillDir}/skill.json cannot be read: ${err.message}`);
        continue;
      }
      for (const command of Array.isArray(manifest.commands) ? manifest.commands : []) {
        const file = `${skillDir}/${command}.mjs`;
        if (typeof command === 'string' && existsSync(join(root, file))) add(command, file);
      }
    }
  }

  if (problems.length) throw new Error(`cannot build the command launchers:\n- ${problems.join('\n- ')}`);
  return [...found].map(([name, file]) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A launcher's content, exactly as install/README.md gives it.
 *
 * @param {string} installRoot where the release runs, e.g. /opt/paraclete
 * @param {string} file the command's repo path
 */
export function launcherScript(installRoot, file) {
  if (!/^\/[A-Za-z0-9_./-]*$/.test(installRoot) || !SAFE_PATH.test(file)) {
    throw new Error(`a launcher cannot name '${file}' under '${installRoot}': both must be plain absolute and repo paths`);
  }
  return `#!/bin/sh\nexec ${NODE_BINARY} ${posix.join(installRoot, file)} "$@"\n`;
}

/**
 * Writes a launcher for every command into <root>/bin/, mode 0755. The launchers name the install
 * root, not the staging root: they run after the staged release is swapped into place.
 *
 * @param {object} o
 * @param {string} o.root        the staged release
 * @param {string} o.installRoot where it will run
 * @param {string} o.role
 * @returns {Array<{name: string, file: string}>}
 */
export function writeLaunchers({ root, installRoot, role }) {
  const commands = listCommands(root, role);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const { name, file } of commands) {
    const path = join(bin, name);
    writeFileSync(path, launcherScript(installRoot, file), { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  return commands;
}

/**
 * The command line: `--root <dir> --install-root <dir> --role <role>`.
 *
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 * @returns {number} exit code
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { root: { type: 'string' }, 'install-root': { type: 'string' }, role: { type: 'string' } },
    });
    if (!values.root || !values['install-root'] || !values.role) {
      stderr.write('Usage: launchers.mjs --root <staged release> --install-root <install root> --role <role>\n');
      return 2;
    }
    const commands = writeLaunchers({ root: values.root, installRoot: values['install-root'], role: values.role });
    stdout.write(`wrote ${commands.length} launchers: ${commands.map((c) => c.name).join(' ')}\n`);
    return 0;
  } catch (err) {
    stderr.write(`launchers: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
