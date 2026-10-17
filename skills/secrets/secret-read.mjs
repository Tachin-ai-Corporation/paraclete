#!/usr/bin/env node
// skills/secrets/secret-read.mjs: the secret-read command. Prints one Secret Manager secret's value to
// stdout and nothing else, so it can sit inside command substitution. It never logs the value and
// never writes it anywhere but stdout. Authenticates as the VM's service account; the agent reads only
// secrets an admin granted it. Documented in skills/secrets/SKILL.md.

import { pathToFileURL } from 'node:url';
import { getAccessToken as metadataToken } from '../../agent/auth/metadata-token.mjs';
import { loadInstance } from '../../config/instance.mjs';

export const USAGE = 'Usage: secret-read --name <secret-id> [--version latest]';

// Secret Manager's own id grammar. Checking it here keeps a name from reshaping the request path.
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const VERSION_PATTERN = /^(latest|[1-9][0-9]*)$/;
const TIMEOUT_MS = 15_000;

/**
 * @param {string[]} argv
 * @returns {{help?: true, name?: string, version?: string, error?: string}}
 */
export function parseArgs(argv) {
  const out = { version: 'latest' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--name' || arg === '--version') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      out[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  if (!out.name) return { error: '--name <secret-id> is required' };
  if (!NAME_PATTERN.test(out.name)) return { error: `invalid secret name '${out.name}': use the full secret id (letters, digits, - and _)` };
  if (!VERSION_PATTERN.test(out.version)) return { error: `invalid version '${out.version}': use latest or a version number` };
  return out;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.getAccessToken]
 * @param {string}   [deps.project] the Google Cloud project; default: the instance record's
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const getAccessToken = deps.getAccessToken || metadataToken;
  const fail = (message) => { stderr.write(`[secret-read] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  let project = deps.project;
  try {
    if (!project) project = loadInstance().project;
  } catch (err) {
    return fail(`cannot find the project: ${err.message}`);
  }

  let response;
  try {
    const token = await getAccessToken();
    const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${args.name}/versions/${args.version}:access`;
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`the request to Secret Manager failed: ${err.message}`);
  }

  if (response.status === 403) {
    return fail(`Access denied to secret '${args.name}'. A dashboard admin must grant the agent's service account the Secret Accessor role on it.`);
  }
  if (response.status === 404) {
    return fail(`Secret '${args.name}' (version ${args.version}) not found in project ${project}. Use the full secret id exactly as stored.`);
  }
  if (!response.ok) return fail(`Secret Manager returned HTTP ${response.status}`);

  let data;
  try {
    data = (await response.json())?.payload?.data;
  } catch {
    data = undefined;
  }
  if (typeof data !== 'string') return fail('Secret Manager returned no payload');
  // Straight from the decoded bytes to stdout: never through a log line or a variable that is printed.
  stdout.write(Buffer.from(data, 'base64'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
