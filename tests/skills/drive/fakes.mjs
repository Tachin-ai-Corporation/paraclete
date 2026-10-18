// tests/skills/drive/fakes.mjs: what the drive skill's command tests share. driveRuntime is shaped like
// createCliRuntime()'s (agent/cli/cli-runtime.mjs) over a fresh temp data root, with a fake fetch and
// token and a Firestore stand-in holding config/settings; the commands build their real Drive client
// from it. fakeDriveFetch answers the Drive API by path and records every call. run() calls a
// command's main and collects its exit code and output.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContracts } from '../../../config/contracts.mjs';
import { dataPaths } from '../../../config/instance.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'drive-skill-tests-'));
process.on('exit', () => rmSync(TEMP_ROOT, { recursive: true, force: true }));

export const SA_EMAIL = 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com';
export const WORKSPACE = Object.freeze({ account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' });

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const googleError = (status, reason, message) => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

/** A stand-in for stdout or stderr that keeps what was written. */
export function sink() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

/**
 * A fake Drive API. `files` holds metadata by id; `media` and `exports` the bytes a download or an
 * export returns, by id; `list` answers files.list; `drives` drives.list; `create` an upload.
 */
export function fakeDriveFetch({ files = {}, media = {}, exports = {}, list, drives = [], create } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const call = { url, method, path: u.pathname, params: u.searchParams, headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (u.pathname === '/drive/v3/drives') return json({ drives });
    if (u.pathname === '/drive/v3/files' && method === 'GET') return list ? list(call) : json({ files: [] });
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      return create ? create(call) : json({ id: '1CreatedAbCdEfGhIjKlMnOpQrStUvWx', name: 'created', webViewLink: 'https://drive.google.com/file/d/1CreatedAbCdEfGhIjKlMnOpQrStUvWx/view' });
    }
    const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(u.pathname);
    if (exportMatch) return exports[exportMatch[1]] ? new Response(exports[exportMatch[1]], { status: 200 }) : googleError(404, 'notFound', 'File not found.');
    const id = u.pathname.split('/').pop();
    if (u.searchParams.get('alt') === 'media') return new Response(media[id] ?? Buffer.alloc(0), { status: 200 });
    return files[id] ? json(files[id]) : googleError(404, 'notFound', `File not found: ${id}.`);
  };
  return { fetch, calls };
}

/**
 * A command runtime over a fresh data root.
 *
 * @param {object} [o]
 * @param {object} [o.api]        from fakeDriveFetch()
 * @param {object} [o.settings]   the config/settings document, or an Error to fail its read with
 * @param {object} [o.workspace]  the instance's Workspace account, if any
 * @param {object} [o.files]      overrides for the contracts' `files` section
 */
export function driveRuntime({ api = fakeDriveFetch(), settings = {}, workspace = null, files = {} } = {}) {
  const base = mkdtempSync(join(TEMP_ROOT, 'instance-'));
  const instance = Object.freeze({
    project: 'your-gcp-project', agent_name: 'Paraclete', role: 'generic', install_root: join(base, 'opt'), data_root: join(base, 'data'),
    bucket: 'your-gcp-project-paraclete', workspace, endpoints: {},
  });
  const contracts = loadContracts();
  const reads = [];
  return {
    instance,
    contracts: { ...contracts, files: { ...contracts.files, ...files } },
    paths: { data: dataPaths(instance) },
    collections: COLLECTIONS,
    db: {
      reads,
      async read(path, opts) {
        reads.push({ path, opts });
        if (settings instanceof Error) throw settings;
        return path === `${COLLECTIONS.config}/settings` ? settings : null;
      },
    },
    getAccessToken: async () => 'vm-token',
    fetch: api.fetch,
  };
}

/** Runs a command's main with collected output. */
export async function run(mod, argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await mod.main(argv, { stdout, stderr, ...deps });
  return { code, out: stdout.text(), err: stderr.text() };
}
