#!/usr/bin/env node
// skills/git-artifacts/work-commit.mjs: the work-commit command. Commits the staged changes in a git
// working tree, or every change with --add-all, and prints the commit as JSON. It does not push (that is
// work-sync) and never commits when nothing is staged. Run in a mission's working tree; documented in
// skills/git-artifacts/SKILL.md.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: work-commit "<message>" [--dir <path>] [--add-all]';

// Used only when the tree has no committer configured; the brain sets its own on the commits it makes.
const FALLBACK_NAME = 'paraclete';
const FALLBACK_EMAIL = 'paraclete@localhost';

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, message?: string, dir?: string, addAll?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  const out = { message: null, dir: '.', addAll: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--add-all') { out.addAll = true; continue; }
    if (arg === '--dir' && argv[i + 1] !== undefined) { out.dir = argv[i + 1]; i += 1; continue; }
    if (out.message === null && !arg.startsWith('--')) { out.message = arg; continue; }
    return { error: `unknown argument: ${arg}` };
  }
  if (!out.message || !out.message.trim()) return { error: 'a commit message is required' };
  return out;
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
  const fail = (message) => { stderr.write(`[work-commit] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  const git = (...a) => run('git', a, { cwd: args.dir });
  const text = (result) => String(result.stdout || '').trim();
  const why = (result, what) => String(result.stderr || '').trim() || `${what} exited with code ${result.status}`;

  const top = git('rev-parse', '--show-toplevel');
  if (top.error || top.status !== 0) {
    return fail(`not inside a git repository (${args.dir}). Run work-commit in the mission's working tree, or pass --dir.`);
  }

  if (args.addAll) {
    const added = git('add', '-A');
    if (added.status !== 0) return fail(why(added, 'git add'));
  }
  const staged = text(git('diff', '--cached', '--name-only'));
  if (!staged) {
    return fail('nothing is staged to commit. Stage your files with git add <path>, or pass --add-all once work-diff --stat shows only your changes.');
  }

  if (!text(git('config', 'user.email'))) {
    git('config', 'user.name', FALLBACK_NAME);
    git('config', 'user.email', FALLBACK_EMAIL);
  }

  const committed = git('commit', '-m', args.message);
  if (committed.status !== 0) return fail(why(committed, 'git commit'));

  const sha = text(git('rev-parse', 'HEAD'));
  // --root also lists the files of a repository's first commit.
  const files = text(git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n').filter(Boolean);
  stdout.write(`${JSON.stringify({ sha, message: args.message, filesChanged: files.length })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
