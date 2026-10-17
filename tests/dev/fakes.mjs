// tests/dev/fakes.mjs: what the dev/ command tests run against. A fake program runner that records
// every call (program, argument array, options) and answers from a script; the developer's
// instance.env; a clock whose sleep moves time and can run a step of the simulated instance; and
// output sinks. Firestore is the in-memory fake in tests/fakes/, reached through the real client, so a
// test sees exactly what a command wrote.
import assert from 'node:assert/strict';
import { basename } from 'node:path';

export const DEV_EMAIL = 'dev@example.com';
export const DEV_TOKEN = 'dev-token';
export const START = Date.parse('2026-10-17T12:00:00.000Z');

/** A filled-in .local/instance.env; the project is the Firestore fake's. */
export const ENV_TEXT = [
  '# my dev instance',
  'PROJECT_ID=your-gcp-project',
  'REGION=us-central1',
  'ZONE=us-central1-a',
  'VM=paraclete',
  'DASHBOARD_URL=https://paraclete-xxxxxxxxxx-uc.a.run.app',
  '',
].join('\n');

/** The `gcloud compute ssh` arguments every command must build for ENV_TEXT's instance. */
export function expectedSsh(remoteCommand) {
  return ['compute', 'ssh', 'paraclete', '--zone', 'us-central1-a', '--project', 'your-gcp-project',
    '--tunnel-through-iap', '--command', remoteCommand];
}

/** Collects what a command writes. */
export function sink() {
  return { text: '', write(chunk) { this.text += chunk; return true; } };
}

/**
 * A fake program runner. `script(program, args, opts)` answers a call with { code, stdout, stderr }
 * (or undefined for the defaults below); stdout is also handed to opts.onStdout, split in two so line
 * handling across chunks is exercised.
 */
export function fakeExec(script = () => undefined) {
  const calls = [];
  async function exec(program, args, opts = {}) {
    calls.push({ program, args: [...args], opts });
    const answer = (await script(program, args, opts)) ?? defaults(program, args);
    const result = { code: 0, stdout: '', stderr: '', ...answer };
    if (result.stdout && opts.onStdout) {
      const half = Math.ceil(result.stdout.length / 2);
      opts.onStdout(result.stdout.slice(0, half));
      opts.onStdout(result.stdout.slice(half));
    }
    if (result.stderr && opts.onStderr) opts.onStderr(result.stderr);
    return result;
  }
  exec.calls = calls;
  /** The calls to one program. */
  exec.callsTo = (program) => calls.filter((c) => c.program === program);
  return exec;
}

function defaults(program, args) {
  const line = args.join(' ');
  if (program === 'gcloud' && line === 'auth print-access-token') return { stdout: `${DEV_TOKEN}\n` };
  if (program === 'gcloud' && line === 'config get-value account') return { stdout: `${DEV_EMAIL}\n` };
  if (program === 'git' && line === 'config user.name') return { stdout: 'Dev Person\n' };
  if (program === 'git' && line === 'remote get-url origin') return { stdout: 'https://github.com/your-org/paraclete.git\n' };
  return undefined;
}

/** Every call ran a bare program with an argument array, never a shell string. */
export function assertNoShell(calls) {
  for (const call of calls) {
    assert.ok(['gcloud', 'git'].includes(call.program), `unexpected program ${call.program}`);
    assert.ok(Array.isArray(call.args) && call.args.every((a) => typeof a === 'string'), 'arguments are an array of strings');
    assert.equal(call.opts.shell, undefined, 'no shell');
  }
}

/**
 * The deps a dev command takes, wired to the fakes.
 *
 * @param {object}   o
 * @param {object}   o.firestore from tests/fakes/firestore-server.mjs
 * @param {Function} [o.exec]
 * @param {Function} [o.onSleep] async (sleeps so far) => void; runs before each sleep returns
 * @param {string}   [o.envText]
 */
export function devDeps({ firestore, exec = fakeExec(), onSleep = async () => {}, envText = ENV_TEXT }) {
  let now = START;
  let sleeps = 0;
  const stdout = sink();
  const stderr = sink();
  return {
    exec,
    stdout,
    stderr,
    env: {},
    fetch: globalThis.fetch,
    firestoreHost: firestore?.origin,
    readFile: (path) => {
      if (basename(path) === 'instance.env') return envText;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      sleeps += 1;
      await onSleep(sleeps);
    },
  };
}
