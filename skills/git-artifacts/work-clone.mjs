#!/usr/bin/env node
// skills/git-artifacts/work-clone.mjs: the work-clone command. Clones a repository from the git artifact
// store into a local directory through `git-store clone`, always naming the branch and the directory so
// the order of the flags can never be misread. For reading another project's artifacts: a mission's own
// tree is cloned by the brain. Documented in skills/git-artifacts/SKILL.md.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContracts } from '../../config/contracts.mjs';

export const USAGE = 'Usage: work-clone <repoId> [--ref <branch>] [--dir <path>]';

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, repoId?: string, ref?: string|null, dir?: string|null, error?: string}}
 */
export function parseArgs(argv) {
  const out = { repoId: null, ref: null, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--ref' || arg === '--dir') {
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
 * @param {Function} [deps.run] (cmd, args, opts) => {status, stdout, stderr}, like spawnSync
 * @param {string}   [deps.defaultBranch] default: the contracts' git.default_branch
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const run = deps.run || defaultRun;
  const fail = (message) => { stderr.write(`[work-clone] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  let ref = args.ref || deps.defaultBranch;
  try {
    if (!ref) ref = loadContracts().git.default_branch;
  } catch (err) {
    return fail(err.message);
  }
  const dir = resolve(args.dir || args.repoId);

  const cloned = run('git-store', ['clone', args.repoId, '--ref', ref, '--dir', dir], {});
  if (cloned.error) return fail(`git-store did not run: ${cloned.error.message}`);
  if (cloned.stderr) stderr.write(String(cloned.stderr));
  stdout.write(String(cloned.stdout || ''));
  return cloned.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
