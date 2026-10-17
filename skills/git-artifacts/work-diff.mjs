#!/usr/bin/env node
// skills/git-artifacts/work-diff.mjs: the work-diff command. Prints the uncommitted changes in a git
// working tree: all of them, the staged ones, one file's, or a summary of files and line counts. It
// changes nothing. Run in a mission's working tree; documented in skills/git-artifacts/SKILL.md.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: work-diff [--dir <path>] [--staged] [--stat] [--file <path>]';

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, dir?: string, staged?: boolean, stat?: boolean, file?: string, error?: string}}
 */
export function parseArgs(argv) {
  const out = { dir: '.', staged: false, stat: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--staged') { out.staged = true; continue; }
    if (arg === '--stat') { out.stat = true; continue; }
    if ((arg === '--dir' || arg === '--file') && argv[i + 1] !== undefined) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  return out;
}

/** The git arguments for a parsed command line. Pure. */
export function diffArgs({ staged, stat, file }) {
  const args = ['diff'];
  if (staged) args.push('--cached');
  if (stat) args.push('--stat');
  if (file) args.push('--', file);
  return args;
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
  const fail = (message) => { stderr.write(`[work-diff] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  const result = run('git', diffArgs(args), { cwd: args.dir });
  if (result.error) return fail(`git did not run: ${result.error.message}`);
  if (result.status !== 0) return fail(String(result.stderr || '').trim() || `git diff exited with code ${result.status}`);
  const text = String(result.stdout || '');
  stdout.write(text || '(no changes)\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
