#!/usr/bin/env node
// skills/git-artifacts/work-sync.mjs: the work-sync command. Pushes a working tree's commits on its
// branch to the git artifact store through `git-store push`, which fetches and rebases when the branch
// moved. It refuses to push the default branch: work reaches it only through the merge at mission
// completion, which honors the project's merge policy. Documented in skills/git-artifacts/SKILL.md.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContracts } from '../../config/contracts.mjs';

export const USAGE = 'Usage: work-sync <repoId> [--branch <branch>] [--dir <path>] [--actor <id>]';

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, repoId?: string, branch?: string|null, dir?: string, actor?: string, error?: string}}
 */
export function parseArgs(argv) {
  const out = { repoId: null, branch: null, dir: '.', actor: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (['--branch', '--dir', '--actor'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      out[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (out.repoId === null && !arg.startsWith('-')) { out.repoId = arg; continue; }
    return { error: `unknown argument: ${arg}` };
  }
  if (!out.repoId) return { error: '<repoId> is required' };
  return out;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.run] (cmd, args, {cwd}) => {status, stdout, stderr}, like spawnSync
 * @param {string}   [deps.defaultBranch] default: the contracts' git.default_branch
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const run = deps.run || defaultRun;
  const fail = (message) => { stderr.write(`[work-sync] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  let defaultBranch = deps.defaultBranch;
  try {
    if (!defaultBranch) defaultBranch = loadContracts().git.default_branch;
  } catch (err) {
    return fail(err.message);
  }

  const dir = resolve(args.dir);
  let branch = args.branch;
  if (!branch) {
    const head = run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir });
    branch = head.status === 0 ? String(head.stdout || '').trim() : '';
    if (!branch) return fail(`${dir} is not on a branch; check out the mission branch, or pass --branch`);
  }
  if (branch === defaultBranch) {
    return fail(`refusing to push '${defaultBranch}': work reaches it only through the merge when the mission completes. Commit on the mission branch.`);
  }

  // Without --actor, git-store records the agent's own name on the ref.
  const pushArgs = ['push', args.repoId, branch, dir, ...(args.actor ? [args.actor] : [])];
  const pushed = run('git-store', pushArgs, {});
  if (pushed.error) return fail(`git-store did not run: ${pushed.error.message}`);
  if (pushed.stderr) stderr.write(String(pushed.stderr));
  stdout.write(String(pushed.stdout || ''));
  return pushed.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
