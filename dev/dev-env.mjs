// dev/dev-env.mjs: what every dev/ command shares. It reads your dev instance's coordinates from
// .local/instance.env, runs gcloud and git with argument lists (never a shell string; on Windows it
// runs gcloud's own Python entry point, because Node cannot start gcloud.cmd without a shell), gets
// your own access token and account from gcloud, builds the `gcloud compute ssh` call to the
// instance's VM, and gives Firestore clients (agent/storage/firestore.mjs) that act as you, asking gcloud
// for a new token when Firestore refuses the one in hand. It runs on your machine (Windows Git Bash,
// macOS or Linux), never on an instance, and is not a command itself.
// Used by deploy.mjs, status.mjs, logs.mjs, query.mjs, trigger.mjs and say.mjs.

import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../agent/storage/collections.mjs';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Your dev instance's coordinates. Gitignored; copied from dev/instance.env.example. */
export const INSTANCE_ENV_PATH = join(REPO_ROOT, '.local', 'instance.env');

/** Paths on the VM, fixed by the install contract in install/README.md. */
export const VM_PATHS = Object.freeze({
  installRoot: '/opt/paraclete',
  release: '/opt/paraclete/release.json',
  upgrade: '/opt/paraclete/install/upgrade.sh',
  dataRoot: '/var/lib/paraclete',
  gatewayToken: '/etc/paraclete/gateway-token',
});

/** The readiness document bootstrap.sh writes when the services are up (install/README.md). */
export const READINESS_DOC = `${COLLECTIONS.agent}/instance`;

/** The values dev/instance.env.example ships with, which a filled-in copy must have replaced. */
export const PLACEHOLDERS = Object.freeze({
  PROJECT_ID: 'your-dev-project',
  DASHBOARD_URL: 'https://paraclete-xxxxxxxxxx-uc.a.run.app',
});

const REQUIRED_KEYS = ['PROJECT_ID', 'REGION', 'ZONE', 'VM'];

const FORMATS = {
  PROJECT_ID: [/^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'a Google Cloud project id'],
  REGION: [/^[a-z]+-[a-z]+[0-9]+$/, 'a region such as us-central1'],
  ZONE: [/^[a-z]+-[a-z]+[0-9]+-[a-z]$/, 'a zone such as us-central1-a'],
  VM: [/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/, 'a VM name such as paraclete'],
  DASHBOARD_URL: [/^https:\/\/\S+$/, 'an https URL'],
};

/**
 * How long a token from `gcloud auth print-access-token` is reused before asking again. gcloud may hand
 * out a token with only minutes left, so a Firestore 401 also asks again (devContext's db()).
 */
const TOKEN_REUSE_MS = 30 * 60_000;

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A failure a dev command reports and exits on. `code` is the exit code: 2 for a usage mistake,
 * 1 for everything else.
 */
export class DevError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'DevError';
    this.code = code;
  }
}

/**
 * Parses an env file: KEY=value lines, `#` comments, blank lines, an optional `export ` prefix, and
 * values optionally wrapped in single or double quotes. An unquoted value ends at ` #`.
 *
 * @param {string} text
 * @param {string} [source] how errors name the file
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text, source = 'instance.env') {
  const values = {};
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new DevError(`${source} line ${i + 1}: expected KEY=value, got: ${line}`);
    const quoted = /^(['"])(.*)\1$/.exec(m[2]);
    values[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim();
  });
  return values;
}

/**
 * Reads and checks your dev instance's coordinates. Refuses, saying what to do, when the file is
 * missing, a required key is missing or malformed, or a value is still the example's placeholder.
 * DASHBOARD_URL is optional until the dashboard exists (build plan phase 6); its placeholder counts as
 * unset.
 *
 * @param {object}   [o]
 * @param {Function} [o.readFile] (path) => string
 * @param {string}   [o.path]
 * @returns {Readonly<{PROJECT_ID: string, REGION: string, ZONE: string, VM: string, DASHBOARD_URL: string|null}>}
 */
export function loadInstanceEnv({ readFile = (p) => readFileSync(p, 'utf8'), path = INSTANCE_ENV_PATH } = {}) {
  let text;
  try {
    text = readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new DevError(`No dev instance is configured: ${path} does not exist. Copy dev/instance.env.example `
        + 'to .local/instance.env and fill in your dev instance (DEVELOPING.md section 7).');
    }
    throw new DevError(`Cannot read ${path}: ${err.message}`);
  }
  const values = parseEnvFile(text, path);
  const missing = REQUIRED_KEYS.filter((key) => !values[key]);
  if (missing.length) {
    throw new DevError(`${path} is missing ${missing.join(', ')}. See dev/instance.env.example for every key.`);
  }
  if (values.PROJECT_ID === PLACEHOLDERS.PROJECT_ID) {
    throw new DevError(`${path}: PROJECT_ID is still the example's placeholder; set it to your dev project.`);
  }
  const dashboardUrl = values.DASHBOARD_URL && values.DASHBOARD_URL !== PLACEHOLDERS.DASHBOARD_URL ? values.DASHBOARD_URL : null;
  const checked = { ...values, DASHBOARD_URL: dashboardUrl };
  const problems = Object.entries(FORMATS)
    .filter(([key, [pattern]]) => checked[key] != null && !pattern.test(checked[key]))
    .map(([key, [, what]]) => `${key} must be ${what}, got '${checked[key]}'`);
  if (!problems.length && !checked.ZONE.startsWith(`${checked.REGION}-`)) {
    problems.push(`ZONE ${checked.ZONE} is not in REGION ${checked.REGION}`);
  }
  if (problems.length) throw new DevError(`${path}:\n- ${problems.join('\n- ')}`);
  return Object.freeze({
    PROJECT_ID: checked.PROJECT_ID,
    REGION: checked.REGION,
    ZONE: checked.ZONE,
    VM: checked.VM,
    DASHBOARD_URL: dashboardUrl,
  });
}

/**
 * How to start gcloud on Windows without a shell: the SDK's Python running lib/gcloud.py, with the
 * environment gcloud.cmd would set up. Node refuses to spawn a .cmd file without a shell, and a shell
 * would re-parse every argument.
 *
 * @param {object}   o
 * @param {object}   o.env      the process environment
 * @param {Function} [o.exists] (path) => boolean
 * @returns {{file: string, args: string[], env: object}} the program, the arguments before gcloud's own, the environment
 */
export function windowsGcloud({ env, exists = existsSync }) {
  const unquote = (s) => String(s).trim().replace(/^"(.*)"$/, '$1');
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  let root = env.CLOUDSDK_ROOT_DIR ? unquote(env.CLOUDSDK_ROOT_DIR) : null;
  if (!root) {
    const binDir = String(env[pathKey] || '').split(';').map(unquote).filter(Boolean)
      .find((dir) => exists(win32.join(dir, 'gcloud.cmd')));
    if (!binDir) {
      throw new DevError('gcloud was not found: no gcloud.cmd on PATH. Install the Google Cloud CLI, or set '
        + 'CLOUDSDK_ROOT_DIR to its google-cloud-sdk directory.');
    }
    root = win32.dirname(binDir.replace(/[\\/]+$/, ''));
  }
  const script = win32.join(root, 'lib', 'gcloud.py');
  if (!exists(script)) throw new DevError(`${script} does not exist: ${root} is not a Google Cloud SDK`);
  const bundled = win32.join(root, 'platform', 'bundledpython', 'python.exe');
  const python = env.CLOUDSDK_PYTHON ? unquote(env.CLOUDSDK_PYTHON) : (exists(bundled) ? bundled : 'python');
  const pythonArgs = String(env.CLOUDSDK_PYTHON_ARGS || '').split(/\s+/).filter((a) => a && a !== '-S');
  if (!env.CLOUDSDK_PYTHON_SITEPACKAGES) pythonArgs.push('-S');
  const childEnv = { ...env, CLOUDSDK_ROOT_DIR: root, [pathKey]: `${win32.join(root, 'bin', 'sdk')};${env[pathKey] || ''}` };
  delete childEnv.PYTHONHOME;
  return { file: python, args: [...pythonArgs, script], env: childEnv };
}

/**
 * Runs one program with an argument array: stdin stays your terminal (so gcloud and ssh can ask you
 * things), stdout and stderr are read, handed to the callbacks as they arrive, and collected.
 */
function runProcess(spawnImpl, file, args, { cwd, env, onStdout, onStderr, collect = true }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawnImpl(file, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: 127, stdout, stderr: err.message, missing: true });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (collect) stdout += chunk; onStdout?.(chunk); });
    child.stderr.on('data', (chunk) => { if (collect) stderr += chunk; onStderr?.(chunk); });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}`, missing: err.code === 'ENOENT' }));
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal: signal || null, stdout, stderr }));
  });
}

/**
 * The real program runner the commands get as `deps.exec`:
 * exec(program, args, { cwd, env, onStdout, onStderr, collect }) => Promise<{ code, stdout, stderr }>.
 * `gcloud` on Windows is started through windowsGcloud().
 *
 * @param {object}   [o]
 * @param {object}   [o.env]       the process environment
 * @param {string}   [o.platform]
 * @param {Function} [o.exists]
 * @param {Function} [o.spawn]
 */
export function createExec({ env = process.env, platform = process.platform, exists = existsSync, spawn: spawnImpl = spawn } = {}) {
  return function exec(program, args, opts = {}) {
    const childEnv = opts.env || env;
    if (program === 'gcloud' && platform === 'win32') {
      const g = windowsGcloud({ env: childEnv, exists });
      return runProcess(spawnImpl, g.file, [...g.args, ...args], { ...opts, env: g.env });
    }
    return runProcess(spawnImpl, program, args, { ...opts, env: childEnv });
  };
}

/** The tail of a failed program's stderr, for an error message. */
export function failureDetail(result) {
  const text = String(result?.stderr || '').trim().split('\n').slice(-5).join('\n').trim();
  return text ? `:\n${text}` : '';
}

/**
 * The arguments of `gcloud compute ssh` that run one command on your dev instance's VM over IAP.
 *
 * @param {{VM: string, ZONE: string, PROJECT_ID: string}} instance
 * @param {string} remoteCommand run by the VM's login shell
 * @returns {string[]}
 */
export function sshArgs(instance, remoteCommand) {
  return ['compute', 'ssh', instance.VM, '--zone', instance.ZONE, '--project', instance.PROJECT_ID,
    '--tunnel-through-iap', '--command', remoteCommand];
}

/** A Firestore-style document id: 20 letters and digits, like the ones the dashboard gets. */
export function autoId() {
  let id = '';
  for (let i = 0; i < 20; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** One line of text at most `max` characters long, for listings. */
export function preview(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Repeats `step` until it returns something other than undefined, sleeping between tries, or the
 * time runs out.
 *
 * @returns {Promise<{done: boolean, value?: *}>}
 */
export async function pollUntil(step, { timeoutMs, intervalMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined) return { done: true, value };
    if (now() >= deadline) return { done: false };
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
}

/**
 * True when this module is the program node was asked to run, not an import. Compares real paths
 * (and on Windows, ignoring case), so a drive letter typed in lower case still counts.
 *
 * @param {string} metaUrl import.meta.url of the module asking
 * @param {string} [argv1]
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const norm = (p) => {
    let real = p;
    try { real = realpathSync(p); } catch { /* compare the path as given */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(fileURLToPath(metaUrl)) === norm(argv1);
}

/**
 * Everything a dev command needs, from its injectable deps. Nothing here touches the cloud until a
 * command calls it.
 *
 * @param {object}   [deps]
 * @param {Function} [deps.exec]          (program, args, opts) => Promise<{code, stdout, stderr}>
 * @param {Function} [deps.fetch]         fetch for Firestore
 * @param {object}   [deps.stdout]        { write }
 * @param {object}   [deps.stderr]        { write }
 * @param {object}   [deps.env]           the process environment
 * @param {Function} [deps.readFile]      (path) => string, for .local/instance.env
 * @param {string}   [deps.firestoreHost] Firestore API origin; tests point it at tests/fakes/
 * @param {Function} [deps.sleep]         (ms) => Promise
 * @param {Function} [deps.now]           () => milliseconds
 */
export function devContext(deps = {}) {
  const env = deps.env || process.env;
  const exec = deps.exec || createExec({ env });
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const fetchImpl = deps.fetch || globalThis.fetch;
  let instance = null;
  let token = null;

  async function gcloud(args, opts = {}) {
    const result = await exec('gcloud', args, opts);
    if (result.missing) {
      throw new DevError('gcloud was not found: install the Google Cloud CLI and log in with `gcloud auth login`.');
    }
    return result;
  }

  const ctx = {
    env,
    exec,
    stdout,
    stderr,
    now,
    sleep,
    gcloud,
    out: (line = '') => stdout.write(`${line}\n`),
    warn: (line) => stderr.write(`${line}\n`),
    /** Your dev instance's coordinates, read once. */
    instance() {
      if (!instance) instance = loadInstanceEnv(deps.readFile ? { readFile: deps.readFile } : {});
      return instance;
    },
    /** git in this clone. */
    git: (args, opts = {}) => exec('git', args, { cwd: REPO_ROOT, ...opts }),
    /**
     * Your access token, from the gcloud account you are logged in with. It is reused for a while;
     * `{ fresh: true }` asks gcloud again, for when the one in hand was refused.
     */
    async accessToken({ fresh = false } = {}) {
      if (!fresh && token && now() - token.at < TOKEN_REUSE_MS) return token.value;
      const result = await gcloud(['auth', 'print-access-token']);
      const value = result.stdout.trim();
      if (result.code !== 0 || !value) {
        throw new DevError(`gcloud could not give an access token${failureDetail(result)}\nLog in with: gcloud auth login`);
      }
      token = { value, at: now() };
      return value;
    },
    /** The email of the gcloud account you are logged in with. */
    async account() {
      const result = await gcloud(['config', 'get-value', 'account']);
      const email = result.stdout.trim();
      if (result.code !== 0 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
        throw new DevError('No gcloud account is active. Log in with: gcloud auth login');
      }
      return email;
    },
    /**
     * Runs one command on the VM over IAP. Its stderr (gcloud's and ssh's own notes and prompts
     * included) goes straight to yours.
     */
    ssh(remoteCommand, opts = {}) {
      return gcloud(sshArgs(ctx.instance(), remoteCommand), { onStderr: (chunk) => stderr.write(chunk), ...opts });
    },
    /**
     * A Firestore client for your dev instance's project, acting as you. Callers pass
     * `{ strict: true }`, so a failure is an error and never an empty answer. A request Firestore
     * refuses with 401 (the token expired during a long follow) is sent once more with a token gcloud
     * gives afresh; a second 401 is the client's error to report.
     */
    db() {
      return createClient({
        projectId: ctx.instance().PROJECT_ID,
        getAccessToken: () => ctx.accessToken(),
        fetch: async (url, init = {}) => {
          const resp = await fetchImpl(url, init);
          if (resp.status !== 401) return resp;
          await resp.body?.cancel();
          const headers = new Headers(init.headers);
          headers.set('Authorization', `Bearer ${await ctx.accessToken({ fresh: true })}`);
          return fetchImpl(url, { ...init, headers });
        },
        firestoreHost: deps.firestoreHost,
        logger: () => {},
      });
    },
  };
  return ctx;
}

/**
 * Runs a command's body and turns its failures into a message and an exit code.
 *
 * @param {string}   name the command, for messages
 * @param {object}   ctx  from devContext()
 * @param {Function} body async () => exit code
 * @returns {Promise<number>}
 */
export async function runCommand(name, ctx, body) {
  try {
    return await body();
  } catch (err) {
    ctx.stderr.write(`dev/${name}: ${err.message}\n`);
    return err instanceof DevError ? err.code : 1;
  }
}
