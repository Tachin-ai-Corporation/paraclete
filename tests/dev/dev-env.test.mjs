// Tests for dev/dev-env.mjs: reading and checking .local/instance.env, the `gcloud compute ssh`
// arguments, starting gcloud on Windows without a shell, the program runner, the developer's token and
// account, a new token when Firestore refuses one, polling, and the run-directly check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DevError, PLACEHOLDERS, REPO_ROOT, INSTANCE_ENV_PATH, autoId, createExec, devContext, isMain, loadInstanceEnv,
  parseEnvFile, pollUntil, sshArgs, windowsGcloud,
} from '../../dev/dev-env.mjs';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { ENV_TEXT, expectedSsh, fakeExec, sink } from './fakes.mjs';

const reading = (text) => ({ readFile: () => text });

test('an env file: comments, blank lines, export, quotes, inline comments and CRLF', () => {
  const values = parseEnvFile([
    '# a comment', '', 'export PROJECT_ID=your-gcp-project', 'REGION = us-central1  # where it runs',
    'ZONE="us-central1-a"', "VM='paraclete'", 'EMPTY=', 'DASHBOARD_URL=https://x.example.com/#frag\r',
  ].join('\n'));
  assert.deepEqual(values, {
    PROJECT_ID: 'your-gcp-project', REGION: 'us-central1', ZONE: 'us-central1-a', VM: 'paraclete', EMPTY: '',
    DASHBOARD_URL: 'https://x.example.com/#frag',
  });
  assert.throws(() => parseEnvFile('PROJECT_ID=p\nnot a pair\n', 'x.env'), /x\.env line 2: expected KEY=value, got: not a pair/);
});

test('the instance env is read from .local/instance.env and returned checked and frozen', () => {
  let asked = null;
  const env = loadInstanceEnv({ readFile: (p) => { asked = p; return ENV_TEXT; } });
  assert.equal(asked, INSTANCE_ENV_PATH);
  assert.equal(INSTANCE_ENV_PATH, join(REPO_ROOT, '.local', 'instance.env'));
  assert.deepEqual(env, { PROJECT_ID: 'your-gcp-project', REGION: 'us-central1', ZONE: 'us-central1-a', VM: 'paraclete', DASHBOARD_URL: null });
  assert.ok(Object.isFrozen(env));
  assert.equal(loadInstanceEnv(reading(`${ENV_TEXT}DASHBOARD_URL=https://dash.example.com\n`)).DASHBOARD_URL, 'https://dash.example.com');
});

test('a missing file says how to make one', () => {
  const missing = { readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  assert.throws(() => loadInstanceEnv(missing), (err) => err instanceof DevError
    && /No dev instance is configured/.test(err.message)
    && /Copy dev\/instance\.env\.example to \.local\/instance\.env/.test(err.message)
    && /DEVELOPING\.md section 7/.test(err.message));
  const denied = { readFile: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  assert.throws(() => loadInstanceEnv(denied), /Cannot read .*EACCES/);
});

test('missing keys, placeholders and malformed values are refused, naming each', () => {
  assert.throws(() => loadInstanceEnv(reading('PROJECT_ID=my-dev-project\nVM=paraclete\n')), /is missing REGION, ZONE\. See dev\/instance\.env\.example/);
  assert.throws(() => loadInstanceEnv(reading(ENV_TEXT.replace('your-gcp-project', 'your-dev-project'))), /PROJECT_ID is still the example's placeholder/);
  assert.throws(() => loadInstanceEnv(reading(ENV_TEXT.replace('ZONE=us-central1-a', 'ZONE=central'))), /ZONE must be a zone such as us-central1-a, got 'central'/);
  assert.throws(() => loadInstanceEnv(reading(ENV_TEXT.replace('ZONE=us-central1-a', 'ZONE=europe-west1-b'))), /ZONE europe-west1-b is not in REGION us-central1/);
  assert.throws(() => loadInstanceEnv(reading(ENV_TEXT.replace('VM=paraclete', 'VM=Paraclete VM'))), /VM must be a VM name/);
  assert.throws(() => loadInstanceEnv(reading(`${ENV_TEXT}DASHBOARD_URL=http://dash.example.com\n`)), /DASHBOARD_URL must be an https URL/);
});

test('the placeholders are the ones dev/instance.env.example ships with, and its copy is refused as is', () => {
  const example = readFileSync(join(REPO_ROOT, 'dev', 'instance.env.example'), 'utf8');
  const values = parseEnvFile(example);
  assert.deepEqual(Object.keys(values).sort(), ['DASHBOARD_URL', 'PROJECT_ID', 'REGION', 'VM', 'ZONE']);
  assert.equal(values.PROJECT_ID, PLACEHOLDERS.PROJECT_ID);
  assert.equal(values.DASHBOARD_URL, PLACEHOLDERS.DASHBOARD_URL);
  assert.throws(() => loadInstanceEnv(reading(example)), /placeholder/);
});

test('ssh to the VM is gcloud compute ssh over IAP with the command as one argument', () => {
  const instance = loadInstanceEnv(reading(ENV_TEXT));
  assert.deepEqual(sshArgs(instance, 'sudo journalctl -n 5'), expectedSsh('sudo journalctl -n 5'));
});

test('SSH_USER, when set, is the user gcloud compute ssh logs in as; it is never the agent\'s own', () => {
  const instance = loadInstanceEnv(reading(`${ENV_TEXT}SSH_USER=lab-driver\n`));
  assert.equal(instance.SSH_USER, 'lab-driver');
  const args = sshArgs(instance, 'sudo -n true');
  assert.equal(args[2], 'lab-driver@paraclete');
  assert.deepEqual(args.slice(3), expectedSsh('sudo -n true').slice(3));
  assert.equal('SSH_USER' in loadInstanceEnv(reading(ENV_TEXT)), false, 'unset, gcloud uses your local user name');
  assert.throws(() => loadInstanceEnv(reading(`${ENV_TEXT}SSH_USER=paraclete\n`)), /SSH_USER must not be paraclete, the agent's own user on the VM/);
  assert.throws(() => loadInstanceEnv(reading(`${ENV_TEXT}SSH_USER=Lab Driver\n`)), /SSH_USER must be a user name such as lab-driver/);
});

test('on Windows, gcloud runs as the SDK Python on lib/gcloud.py, found through gcloud.cmd on PATH', () => {
  const files = new Set([
    'C:\\sdk\\bin\\gcloud.cmd', 'C:\\sdk\\lib\\gcloud.py', 'C:\\sdk\\platform\\bundledpython\\python.exe',
  ]);
  const exists = (p) => files.has(p);
  const env = { Path: 'C:\\Windows;"C:\\sdk\\bin\\";C:\\other', PYTHONHOME: 'C:\\py', HOME: 'C:\\Users\\dev' };
  const g = windowsGcloud({ env, exists });
  assert.equal(g.file, 'C:\\sdk\\platform\\bundledpython\\python.exe');
  assert.deepEqual(g.args, ['-S', 'C:\\sdk\\lib\\gcloud.py']);
  assert.equal(g.env.CLOUDSDK_ROOT_DIR, 'C:\\sdk');
  assert.equal(g.env.Path, `C:\\sdk\\bin\\sdk;${env.Path}`, 'the existing PATH key is kept, with the SDK tools first');
  assert.equal(g.env.PATH, undefined);
  assert.equal('PYTHONHOME' in g.env, false, 'gcloud.cmd clears PYTHONHOME; so does this');
  assert.equal(g.env.HOME, 'C:\\Users\\dev');

  const own = windowsGcloud({ env: { ...env, CLOUDSDK_PYTHON: '"C:\\py\\python.exe"', CLOUDSDK_PYTHON_ARGS: '-S -X utf8', CLOUDSDK_PYTHON_SITEPACKAGES: '1' }, exists });
  assert.equal(own.file, 'C:\\py\\python.exe');
  assert.deepEqual(own.args, ['-X', 'utf8', 'C:\\sdk\\lib\\gcloud.py'], 'site packages on: no -S');

  const noBundle = windowsGcloud({ env: { PATH: 'C:\\sdk\\bin' }, exists: (p) => p !== 'C:\\sdk\\platform\\bundledpython\\python.exe' && files.has(p) });
  assert.equal(noBundle.file, 'python');

  const rooted = windowsGcloud({ env: { CLOUDSDK_ROOT_DIR: 'D:\\gcloud' }, exists: (p) => p === 'D:\\gcloud\\lib\\gcloud.py' });
  assert.deepEqual(rooted.args, ['-S', 'D:\\gcloud\\lib\\gcloud.py']);

  assert.throws(() => windowsGcloud({ env: { PATH: 'C:\\Windows' }, exists }), /no gcloud\.cmd on PATH/);
  assert.throws(() => windowsGcloud({ env: { CLOUDSDK_ROOT_DIR: 'C:\\nothing' }, exists }), /is not a Google Cloud SDK/);
});

/** A child process stand-in for createExec's spawn. */
function fakeSpawn(recorded, { stdout = '', stderr = '', code = 0 } = {}) {
  return (file, args, options) => {
    recorded.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
}

test('the runner spawns with an argument array and no shell; on Windows gcloud goes through its Python', async () => {
  const recorded = [];
  const files = new Set(['C:\\sdk\\bin\\gcloud.cmd', 'C:\\sdk\\lib\\gcloud.py']);
  const exec = createExec({ env: { PATH: 'C:\\sdk\\bin' }, platform: 'win32', exists: (p) => files.has(p), spawn: fakeSpawn(recorded, { stdout: 'ok\n' }) });
  const result = await exec('gcloud', ['compute', 'ssh', 'paraclete', '--command', 'echo a; echo b']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(recorded[0].file, 'python');
  assert.deepEqual(recorded[0].args, ['-S', 'C:\\sdk\\lib\\gcloud.py', 'compute', 'ssh', 'paraclete', '--command', 'echo a; echo b']);
  assert.equal(recorded[0].options.shell, undefined);
  assert.deepEqual(recorded[0].options.stdio, ['inherit', 'pipe', 'pipe'], 'stdin stays the terminal, for gcloud and ssh prompts');

  await exec('git', ['ls-remote', 'x']);
  assert.equal(recorded[1].file, 'git', 'only gcloud is redirected on Windows');

  const linux = [];
  await createExec({ env: {}, platform: 'linux', spawn: fakeSpawn(linux) })('gcloud', ['auth', 'print-access-token'], { cwd: '/repo' });
  assert.deepEqual([linux[0].file, linux[0].args, linux[0].options.cwd], ['gcloud', ['auth', 'print-access-token'], '/repo']);
});

test('the real runner streams output as it comes, can skip collecting it, and reports a missing program', async () => {
  const exec = createExec();
  const chunks = [];
  const script = 'process.stdout.write("one\\n"); process.stderr.write("warn\\n"); process.stdout.write("two\\n"); process.exitCode = 3';
  const result = await exec(process.execPath, ['-e', script], { onStdout: (c) => chunks.push(c) });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'one\ntwo\n');
  assert.equal(result.stderr, 'warn\n');
  assert.equal(chunks.join(''), 'one\ntwo\n');

  const uncollected = await exec(process.execPath, ['-e', 'console.log("x")'], { collect: false, onStdout: () => {} });
  assert.equal(uncollected.stdout, '');

  const missing = await exec('no-such-program-for-dev-tests', []);
  assert.equal(missing.missing, true);
  assert.equal(missing.code, 127);
});

test('the token and account come from gcloud; failures say how to log in', async () => {
  let tokenCalls = 0;
  const exec = fakeExec((program, args) => {
    if (args.join(' ') === 'auth print-access-token') { tokenCalls += 1; return { stdout: ' tok-1 \n' }; }
    return undefined;
  });
  let now = 0;
  const ctx = devContext({ exec, readFile: () => ENV_TEXT, now: () => now, stdout: sink(), stderr: sink() });
  assert.equal(await ctx.accessToken(), 'tok-1');
  assert.equal(await ctx.accessToken(), 'tok-1');
  assert.equal(tokenCalls, 1, 'a token is reused');
  now += 31 * 60_000;
  await ctx.accessToken();
  assert.equal(tokenCalls, 2, 'and fetched again after half an hour');
  assert.equal(await ctx.account(), 'dev@example.com');

  const loggedOut = devContext({
    exec: fakeExec(() => ({ code: 1, stdout: '', stderr: 'ERROR: Reauthentication failed.\n' })), readFile: () => ENV_TEXT,
  });
  await assert.rejects(loggedOut.accessToken(), /could not give an access token:\nERROR: Reauthentication failed\.\nLog in with: gcloud auth login/);
  await assert.rejects(devContext({ exec: fakeExec(() => ({ stdout: '' })) }).account(), /No gcloud account is active/);
  await assert.rejects(devContext({ exec: fakeExec(() => ({ code: 127, missing: true })) }).accessToken(), /gcloud was not found/);
});

test('a Firestore 401 asks gcloud for a new token and sends the request once more', async () => {
  const firestore = await startFirestore();
  try {
    await firestore.reset();
    let issued = 0;
    let valid = 'tok-1';
    const exec = fakeExec((program, args) => (args.join(' ') === 'auth print-access-token'
      ? { stdout: `tok-${issued += 1}\n` } : undefined));
    // Firestore as it answers an expired token: 401 for anything but the token now valid.
    const fetch = async (url, init) => (new Headers(init.headers).get('Authorization') === `Bearer ${valid}`
      ? globalThis.fetch(url, init)
      : new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } }), { status: 401 }));
    const ctx = devContext({ exec, fetch, firestoreHost: firestore.origin, readFile: () => ENV_TEXT, now: () => 0, stdout: sink(), stderr: sink() });
    const db = ctx.db();

    await db.write('messages/m-1', { text: 'hi' }, { strict: true });
    assert.equal(issued, 1, 'one token while it is accepted');
    valid = 'tok-2';
    assert.equal((await db.read('messages/m-1', { strict: true })).text, 'hi', 'the read made after the token expired succeeds');
    assert.equal(issued, 2, 'gcloud was asked once more');
    assert.equal(await ctx.accessToken(), 'tok-2', 'and the new token is the one reused');
    assert.deepEqual(firestore.requests.map((r) => r.token), ['tok-1', 'tok-2'], 'the refused request never reached Firestore');

    valid = 'never';
    await assert.rejects(db.read('messages/m-1', { strict: true }), /401/, 'a second 401 for the same request is reported');
    assert.equal(issued, 3, 'one new token per refused request, not a loop');
  } finally {
    await firestore.stop();
  }
});

test('ssh runs gcloud compute ssh for the configured VM and passes its stderr through', async () => {
  const exec = fakeExec(() => ({ stdout: 'hello\n', stderr: 'Warning: Permanently added host key\n' }));
  const stderr = sink();
  const ctx = devContext({ exec, readFile: () => ENV_TEXT, stderr, stdout: sink() });
  const result = await ctx.ssh('uptime');
  assert.equal(result.stdout, 'hello\n');
  assert.deepEqual(exec.calls[0].args, expectedSsh('uptime'));
  assert.equal(stderr.text, 'Warning: Permanently added host key\n');
});

test('polling returns the first answer or gives up at the deadline', async () => {
  let now = 0;
  const clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  let n = 0;
  assert.deepEqual(await pollUntil(async () => ((n += 1) === 3 ? 'yes' : undefined), { timeoutMs: 60_000, intervalMs: 5_000, ...clock }), { done: true, value: 'yes' });
  assert.equal(now, 10_000);
  now = 0;
  assert.deepEqual(await pollUntil(async () => undefined, { timeoutMs: 12_000, intervalMs: 5_000, ...clock }), { done: false });
  assert.equal(now, 12_000, 'the last sleep is cut to the deadline');
});

test('auto ids look like Firestore ids', () => {
  const ids = new Set(Array.from({ length: 50 }, autoId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{20}$/);
});

test('the run-directly check knows the entry point from an import', () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMain(import.meta.url, self), true);
  assert.equal(isMain(pathToFileURL(join(REPO_ROOT, 'dev', 'dev-env.mjs')).href, self), false);
  assert.equal(isMain(import.meta.url, ''), false, 'no entry point (node -e, a REPL) is never this module');
});
