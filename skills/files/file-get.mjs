#!/usr/bin/env node
// skills/files/file-get.mjs: the file-get command. Brings a file into a mission's inbox
// (<mission tree>/missions/<id>/inbox/) from where it was shared: a file uploaded with a chat message,
// an object in Cloud Storage, an http(s) link, a git repository (shallow clone, private ones with a
// token kept in Secret Manager), or a Google Drive link or id (Google Docs, Sheets and Slides exported).
// Prints a JSON record: path, name, type, size, sha256 and source. The fetching is
// agent/files/sources.mjs, the Drive calls agent/providers/drive.mjs. Documented in skills/files/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { missionInbox, missionTreeExists } from '../../agent/files/mission-paths.mjs';
import { createRunner } from '../../agent/files/runner.mjs';
import { createFetcher, SOURCE_KINDS } from '../../agent/files/sources.mjs';
import { createDriveClient } from '../../agent/providers/drive.mjs';

export const USAGE = [
  'Usage: file-get --mission <mission id> <source> [--name <name>] [--kind upload|gcs|http|git|drive]',
  '                [--export <format>] [--branch <branch or tag>] [--token-secret <secret id>]',
].join('\n');

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Secret Manager's own id grammar. Checking it keeps a name from reshaping the request path. */
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const SECRET_TIMEOUT_MS = 15_000;

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { mission, source, name, kind, exportFormat, branch, tokenSecret }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        mission: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, export: { type: 'string' },
        branch: { type: 'string' }, 'token-secret': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.mission === undefined) return { error: "--mission <mission id> is required: this mission's id, the last part of its working tree's path" };
  if (!MISSION_ID.test(values.mission)) return { error: `'${values.mission}' is not a mission id` };
  if (positionals.length !== 1) return { error: positionals.length ? `one source at a time, got ${positionals.length}` : 'the source to fetch is required' };
  if (values.kind !== undefined && !SOURCE_KINDS.includes(values.kind)) return { error: `--kind must be one of ${SOURCE_KINDS.join(', ')}` };
  if (values.name !== undefined && !values.name.trim()) return { error: '--name needs a name' };
  if (values['token-secret'] !== undefined && !SECRET_NAME.test(values['token-secret'])) {
    return { error: `'${values['token-secret']}' is not a secret id: use the full Secret Manager id (letters, digits, - and _)` };
  }
  return {
    mission: values.mission, source: positionals[0], name: values.name, kind: values.kind,
    exportFormat: values.export, branch: values.branch, tokenSecret: values['token-secret'],
  };
}

/**
 * A secret's value from Secret Manager, for one git clone. It goes to git through the clone's
 * environment and nowhere else.
 */
async function readSecret(name, runtime) {
  const token = await runtime.getAccessToken();
  const url = `https://secretmanager.googleapis.com/v1/projects/${runtime.instance.project}/secrets/${name}/versions/latest:access`;
  const response = await runtime.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(SECRET_TIMEOUT_MS) });
  if (response.status === 403) throw new Error(`access denied to secret '${name}': a dashboard admin must grant the agent's service account the Secret Accessor role on it`);
  if (response.status === 404) throw new Error(`secret '${name}' not found: use the full secret id exactly as stored`);
  if (!response.ok) throw new Error(`Secret Manager returned HTTP ${response.status} for secret '${name}'`);
  const data = (await response.json().catch(() => null))?.payload?.data;
  if (typeof data !== 'string') throw new Error(`Secret Manager returned no value for secret '${name}'`);
  return Buffer.from(data, 'base64').toString('utf8').trim();
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): contracts, instance, paths, getAccessToken, fetch, storageHost
 * @param {object} [deps.runner]  agent/files/runner.mjs's
 * @param {object} [deps.drive]   a Drive client (createDriveClient); default: one for the instance
 * @returns {Promise<number>} 0; 1 when the source could not be fetched; 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`file-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { contracts, instance } = runtime;
    const missionsRoot = runtime.paths.data.missions;
    if (!missionTreeExists(missionsRoot, args.mission)) {
      return fail(`there is no running mission '${args.mission}' (no tree at ${missionsRoot}/${args.mission}): use this mission's id, the last part of its working tree's path`, 2);
    }
    const runner = deps.runner || createRunner({ timeoutSeconds: contracts.files.tool_timeout_seconds });
    const drive = deps.drive || createDriveClient({ instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const fetcher = createFetcher({
      bucket: instance.bucket,
      prefix: contracts.files.prefix,
      maxBytes: contracts.files.fetch_max_mb * 1024 * 1024,
      uploadMaxBytes: contracts.files.max_upload_mb * 1024 * 1024,
      timeoutSeconds: contracts.files.tool_timeout_seconds,
      getAccessToken: runtime.getAccessToken,
      fetch: runtime.fetch,
      storageHost: runtime.storageHost,
      runner,
      drive,
    });
    const gitToken = args.tokenSecret ? await readSecret(args.tokenSecret, runtime) : undefined;
    const record = await fetcher.fetchInto(args.source, missionInbox(missionsRoot, args.mission), {
      kind: args.kind, name: args.name, branch: args.branch, gitToken, exportFormat: args.exportFormat,
    });
    stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
