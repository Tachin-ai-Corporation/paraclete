#!/usr/bin/env node
// agent/cli/work-output-read.mjs: the work-output-read command. Prints one work envelope from the
// root work collection with its complete output, never truncated: the recovery path when an output
// reached the agent cut short somewhere else. It reads only.

import { pathToFileURL } from 'node:url';
import { StoreUnavailable } from '../storage/firestore.mjs';
import { CliError, checkDocId, createCliRuntime } from './cli-runtime.mjs';

const USAGE = `Usage: work-output-read <envelope-id> [--json]

Arguments:
  envelope-id  The work envelope ID to read (required)

Options:
  --json       Output as raw JSON instead of formatted text`;

const str = (v) => (typeof v === 'string' ? v : '');

/** The scalar fields of a map, one level deep, as the formatted view shows source_meta. */
function scalars(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  try {
    let id = '';
    let json = false;
    for (const a of argv) {
      if (a === '--json') json = true;
      else if (a === '--help' || a === '-h') { stdout.write(`${USAGE}\n`); return 0; }
      else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`);
      else if (!id) id = a;
      else throw new CliError(`ERROR: Unexpected argument: ${a}`);
    }
    if (!id) throw new CliError('ERROR: envelope-id is required\nUsage: work-output-read <envelope-id> [--json]');
    checkDocId(id, 'envelope-id');
    const runtime = deps.runtime || createCliRuntime({ stderr });

    const doc = await runtime.db.read(`${runtime.collections.work}/${id}`, { strict: true });
    if (!doc) throw new CliError(`ERROR: Envelope ${id} not found`);
    if (Object.keys(doc).length === 0) throw new CliError(`ERROR: Envelope ${id} has no fields`);

    const env = {
      id,
      status: str(doc.status),
      type: str(doc.type),
      title: str(doc.title),
      created_at: str(doc.created_at),
      completed_at: str(doc.completed_at),
      updated_at: str(doc.updated_at),
      instruction: str(doc.instruction),
      output: str(doc.output),
      accept_criteria: str(doc.accept_criteria),
      project_id: str(doc.project_id),
    };
    if (str(doc.source_channel)) env.source_channel = doc.source_channel;
    const meta = scalars(doc.source_meta);
    if (Object.keys(meta).length) env.source_meta = meta;
    if (str(doc.error)) env.error = doc.error;
    if (Number.isInteger(doc.iteration) && doc.iteration) env.iteration = doc.iteration;
    const children = Array.isArray(doc.children) ? doc.children.filter((c) => typeof c === 'string') : [];
    if (children.length) env.children = children;

    if (json) {
      stdout.write(`${JSON.stringify(env, null, 2)}\n`);
      return 0;
    }
    const lines = [`Status: ${env.status}`, `Type: ${env.type}`, `Title: ${env.title}`, `Created: ${env.created_at}`];
    if (env.completed_at) lines.push(`Completed: ${env.completed_at}`);
    if (env.updated_at) lines.push(`Updated: ${env.updated_at}`);
    if (env.accept_criteria) lines.push(`Accept Criteria: ${env.accept_criteria}`);
    if (env.project_id) lines.push(`Project: ${env.project_id}`);
    if (env.source_channel) lines.push(`Source Channel: ${env.source_channel}`);
    if (env.source_meta) lines.push(`Source Meta: ${JSON.stringify(env.source_meta)}`);
    if (env.error) lines.push(`Error: ${env.error}`);
    if (env.iteration) lines.push(`Iteration: ${env.iteration}`);
    if (env.children) lines.push(`Children: ${env.children.join(', ')}`);
    if (env.instruction) lines.push(`Instruction chars: ${env.instruction.length}`);
    lines.push(`Output chars: ${env.output.length}`, '---');
    // The whole output, untruncated: that is the point of this command.
    stdout.write(`${lines.join('\n')}\n${env.output}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) { stderr.write(`ERROR: the envelope could not be read: ${e.message}\n`); return 1; }
    stderr.write(`ERROR: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
