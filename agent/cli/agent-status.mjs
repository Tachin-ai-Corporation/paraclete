#!/usr/bin/env node
// agent/cli/agent-status.mjs: the agent-status command. Reports this instance as one JSON object:
// the agent's name, its role and project, the release it runs (when the instance record names one),
// its Workspace account if it has one, and the state of each of its services as systemd reports it.
// It reads only. What the agent is working on lives in its missions: work-log-read shows them.

import { pathToFileURL } from 'node:url';
import { CliError, createCliRuntime, runProgram } from './cli-runtime.mjs';

/** The services an instance runs, each as the systemd unit paraclete-<service>.service. */
export const SERVICES = ['brain', 'ears', 'mouth', 'control', 'gateway'];

const USAGE = `Usage: agent-status [get] [--field <name>]
Prints this instance's status as JSON: agent_name, role, project, release, workspace_account,
services (each service's systemd state: active, inactive, failed, ...) and checked_at.
--field prints one of them.`;

/**
 * Each service's state from `systemctl is-active`, which prints one line per unit in the order given
 * and exits non-zero when any is not active.
 *
 * @param {Function} run - runProgram
 * @returns {Promise<Record<string, string>>}
 */
export async function serviceStates(run) {
  const result = await run('systemctl', ['is-active', ...SERVICES.map((s) => `paraclete-${s}.service`)]);
  const lines = result.code === 127 ? [] : result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return Object.fromEntries(SERVICES.map((s, i) => [s, lines[i] || 'unknown']));
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr, now, run (runProgram)
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const run = deps.run || runProgram;
  try {
    const args = argv[0] === 'get' ? argv.slice(1) : argv;
    if (argv[0] === 'set') {
      throw new CliError('agent-status set is gone: the services report their own state, and agent-status reads it');
    }
    let field = '';
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--help' || args[i] === '-h') { stdout.write(`${USAGE}\n`); return 0; }
      if (args[i] !== '--field') throw new CliError(`Unknown option: ${args[i]}\n${USAGE}`);
      if (i + 1 >= args.length) throw new CliError('--field needs a name');
      field = args[i += 1];
    }
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { instance } = runtime;

    const status = {
      agent_name: instance.agent_name,
      role: instance.role,
      project: instance.project,
      release: instance.release || null,
      workspace_account: instance.workspace?.account || null,
      services: await serviceStates(run),
      checked_at: now().toISOString(),
    };

    if (field) {
      if (!Object.hasOwn(status, field)) throw new CliError(`Unknown field: ${field} (one of ${Object.keys(status).join(', ')})`);
      const value = status[field];
      stdout.write(`${value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : value}\n`);
      return 0;
    }
    stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  } catch (e) {
    stderr.write(`agent-status: ${e.message}\n`);
    return e instanceof CliError ? e.code : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
