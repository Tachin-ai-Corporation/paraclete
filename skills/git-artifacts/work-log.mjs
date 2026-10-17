#!/usr/bin/env node
// skills/git-artifacts/work-log.mjs: the work-log command. Prints a git working tree's commit history,
// newest first: full hash, date and subject, or one line each. It changes nothing. Run in a mission's
// working tree; documented in skills/git-artifacts/SKILL.md.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: work-log [--dir <path>] [--count <n>] [--oneline]';

const DEFAULT_COUNT = 10;

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, dir?: string, count?: number, oneline?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  const out = { dir: '.', count: DEFAULT_COUNT, oneline: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--oneline') { out.oneline = true; continue; }
    if (arg === '--dir' && argv[i + 1] !== undefined) { out.dir = argv[i + 1]; i += 1; continue; }
    if (arg === '--count' && argv[i + 1] !== undefined) {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) return { error: '--count must be a positive whole number' };
      out.count = n;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  return out;
}

/** The git arguments for a parsed command line. Pure. */
export function logArgs({ count, oneline }) {
  return ['log', '-n', String(count), oneline ? '--oneline' : '--format=%H %ai %s'];
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
  const fail = (message) => { stderr.write(`[work-log] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  const result = run('git', logArgs(args), { cwd: args.dir });
  if (result.error) return fail(`git did not run: ${result.error.message}`);
  if (result.status !== 0) {
    const reason = String(result.stderr || '').trim();
    // A repository with no commits yet is not an error worth failing a task over.
    if (/does not have any commits yet/.test(reason)) { stdout.write('(no commits yet)\n'); return 0; }
    return fail(reason || `git log exited with code ${result.status}`);
  }
  stdout.write(String(result.stdout || ''));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
