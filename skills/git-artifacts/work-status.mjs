#!/usr/bin/env node
// skills/git-artifacts/work-status.mjs: the work-status command. Prints a git working tree's state as
// JSON: its branch, whether it is clean, and its staged, modified and untracked files. It changes
// nothing. Run in a mission's working tree; documented in skills/git-artifacts/SKILL.md.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: work-status [--dir <path>]';

/** Each list is cut here, so a tree full of generated files cannot flood the output. */
const LIST_LIMIT = 50;

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.run] (cmd, args, {cwd}) => {status, stdout, stderr}, like spawnSync
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const run = deps.run || defaultRun;
  const fail = (message) => { stderr.write(`[work-status] ${message}\n`); return 1; };

  let dir = '.';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { stdout.write(`${USAGE}\n`); return 0; }
    if (argv[i] === '--dir' && argv[i + 1] !== undefined) { dir = argv[i + 1]; i += 1; continue; }
    return fail(`unknown argument: ${argv[i]}\n${USAGE}`);
  }

  const git = (...args) => run('git', args, { cwd: dir });
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.error || inside.status !== 0) return fail(`not inside a git working tree: ${dir}`);

  const lines = (result) => (result.status === 0 ? String(result.stdout || '') : '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  // symbolic-ref also names the branch of a repository with no commits yet; it fails only when detached.
  const branch = lines(git('symbolic-ref', '--short', '-q', 'HEAD'))[0] || 'detached';
  const staged = lines(git('diff', '--cached', '--name-only'));
  const modified = lines(git('diff', '--name-only'));
  const untracked = lines(git('ls-files', '--others', '--exclude-standard'));

  const status = {
    branch,
    clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
    staged: staged.slice(0, LIST_LIMIT),
    modified: modified.slice(0, LIST_LIMIT),
    untracked: untracked.slice(0, LIST_LIMIT),
  };
  stdout.write(`${JSON.stringify(status)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
