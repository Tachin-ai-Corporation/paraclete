// Tests for dev/smoke.mjs: the request each kind of role gets, the verdict on what came back, and a
// whole run against the Firestore fake: the role read from the VM over SSH, the message sent the way
// dev/say.mjs sends one, the real ears taking it in, and PASS or FAIL with the reason. Also a
// Workspace role with no account, a mission that stops to ask, and usage mistakes.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient, firestoreEncode } from '../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { dashboardMessageFields } from '../../agent/providers/channel.mjs';
import { createDashboardInbox } from '../../agent/services/ears/dashboard-inbox.mjs';
import { createInboundHandler } from '../../agent/services/ears/inbound.mjs';
import { createInboundGate } from '../../agent/services/ears/inbound-gate.mjs';
import { SMOKE_REQUESTS, githubRepo, main, smokeRequest, smokeThread, verdict } from '../../dev/smoke.mjs';
import { DEV_EMAIL, START, assertNoShell, devDeps, expectedSsh, fakeExec } from './fakes.mjs';

const ROLES = { generic: { workspace: false }, 'devops-engineer': { workspace: false }, 'executive-assistant': { workspace: true } };
const readRole = (role) => {
  if (!ROLES[role]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return JSON.stringify({ id: role, ...ROLES[role] });
};
const RECORD = { project: 'your-gcp-project', role: 'generic', agent_name: 'Paraclete', source_repo: 'your-org/paraclete' };

let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

/** A gcloud that answers the SSH read of the instance record. */
const vm = (record = RECORD) => fakeExec((program, args) => (program === 'gcloud' && args[1] === 'ssh'
  ? { stdout: JSON.stringify(record) } : undefined));

/** One pass of the real ears over the dashboard's messages. */
async function earsTick() {
  const inbox = createDashboardInbox({ db, collections: COLLECTIONS });
  const handle = createInboundHandler({ db, collections: COLLECTIONS, gate: createInboundGate(), preprocess: async (t) => t, now: () => START });
  for (const msg of await inbox.poll()) await handle(msg, inbox);
}

/** The brain taking the intake in as mission w-1, and the agent's reply in the smoke thread. */
async function brainMakesMission(status = 'active') {
  const [intake] = await db.query('', COLLECTIONS.intake, [], { noOrderBy: true });
  await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'consumed_by'], firestoreEncode({ status: 'consumed', consumed_by: 'w-1' }));
  await db.write(`${COLLECTIONS.work}/w-1`, { id: 'w-1', type: 'M', status, delivery_status: 'pending', blocker: status === 'needs_input' ? 'Which project?' : null });
  return intake;
}
async function agentSays(text, at) {
  const [message] = await db.query('', COLLECTIONS.messages, [], { noOrderBy: true });
  const fields = dashboardMessageFields(text, { thread: message.thread_id, agentName: 'Paraclete', timestamp: new Date(at).toISOString() });
  await db.patch(`${COLLECTIONS.messages}/reply-${at}`, Object.keys(fields), fields);
}

test('each kind of role gets a request in its area that changes nothing', () => {
  assert.deepEqual(smokeRequest({ role: 'generic' }), { ...SMOKE_REQUESTS.generic, expect: ['7540', '9113'] });
  assert.match(smokeRequest({ role: 'devops-engineer' }).text, /^Read only, change nothing: list the Cloud Run services/);
  assert.equal(smokeRequest({ role: 'some-new-role' }).text, SMOKE_REQUESTS.generic.text, 'a role without its own request gets the generic one');
  assert.match(smokeRequest({ role: 'executive-assistant', workspace: true }).text, /your own Google Calendar for today/);
  assert.match(smokeRequest({ role: 'project-manager', workspace: true, doc: 'https://docs.google.com/document/d/abc/edit' }).text,
    /summarize it in three bullet points: https:\/\/docs\.google\.com\/document\/d\/abc\/edit$/);
  assert.match(smokeRequest({ role: 'software-engineer', repo: 'your-org/paraclete' }).text, /clone https:\/\/github\.com\/your-org\/paraclete from GitHub/);
  for (const request of Object.values(SMOKE_REQUESTS)) {
    assert.match(request.text, /change nothing|^Find out/, 'every request is read-only');
    for (const source of request.expect) assert.doesNotThrow(() => new RegExp(source, 'i'));
  }
  assert.equal(githubRepo('git@github.com:your-org/paraclete.git'), 'your-org/paraclete');
  assert.equal(githubRepo('https://example.com/your-org/paraclete'), '');
  assert.equal(smokeThread('generic', new Date(2026, 9, 18, 9, 5, 7)), 'smoke-generic-20261018090507');
});

test('the verdict: a delivered, complete mission whose answer says what it must passes; anything else fails, saying why', () => {
  const done = { id: 'w-1', status: 'complete', delivery_status: 'delivered', output: 'RFC 7540, replaced by RFC 9113.' };
  assert.deepEqual(verdict({ work: done, replies: ['HTTP/2 is RFC 7540, now RFC 9113.'], expect: ['7540', '9113'] }),
    { pass: true, reason: 'the mission completed and its result was delivered' });
  assert.match(verdict({ work: done, replies: ['It is RFC 7540.'], expect: ['7540', 'nope'] }).reason, /does not mention \/nope\//);
  assert.equal(verdict({ work: { ...done, output: '' }, replies: [], expect: [] }).reason, 'the agent said nothing in the thread');
  assert.match(verdict({ work: { status: 'needs_input', blocker: 'Which project?' }, replies: ['Which project?'] }).reason,
    /stopped as needs_input: Which project\?; a smoke request must need no one/);
  assert.match(verdict({ work: { status: 'awaiting_approval' }, replies: [] }).reason, /awaiting_approval/);
  assert.match(verdict({ work: { status: 'failed', error: 'gcloud: permission denied' }, replies: ['Sorry'] }).reason, /ended failed: gcloud: permission denied/);
  assert.deepEqual(verdict({ responded: true, replies: ['Hi!'], expect: [] }), { pass: true, reason: 'the agent answered at once' });
  assert.equal(verdict({ replies: [] }).reason, 'the request never became a mission or an answer');
});

test('a whole run: the role from the VM, the message sent like say, the result followed to PASS', async () => {
  const exec = vm();
  const deps = devDeps({
    firestore,
    exec,
    onSleep: async (n) => {
      if (n === 1) await earsTick();
      if (n === 2) await brainMakesMission();
      if (n === 3) {
        await agentSays('HTTP/2 was RFC 7540, and RFC 9113 replaced it in 2022.', START + 60_000);
        await db.write(`${COLLECTIONS.work}/w-1`, { id: 'w-1', type: 'M', status: 'complete', delivery_status: 'delivered', output: 'RFC 7540; RFC 9113.' });
      }
    },
  });
  assert.equal(await main([], { ...deps, readRole }), 0, deps.stderr.text);

  const [message] = await db.query('', COLLECTIONS.messages, [{ field: 'sender', op: 'EQUAL', value: { stringValue: DEV_EMAIL } }], { noOrderBy: true });
  assert.equal(message.text, SMOKE_REQUESTS.generic.text);
  assert.equal(message.sender_name, 'smoke test');
  assert.match(message.thread_id, /^smoke-generic-\d{14}$/);
  assert.equal(message.processed, true, 'the ears took it in');

  const out = deps.stdout.text;
  assert.match(out, /^Smoke test of role generic \(a short research answer\), as dev@example\.com in thread smoke-generic-\d{14}:$/m);
  assert.match(out, /the answer must match \/7540\/i and \/9113\/i/);
  assert.match(out, /the brain made it work\/w-1/);
  assert.match(out, /HTTP\/2 was RFC 7540/);
  assert.match(out, /^PASS: role generic, a short research answer: the mission completed and its result was delivered\.$/m);
  assert.deepEqual(exec.callsTo('gcloud')[0].args, expectedSsh('cat /etc/paraclete/instance.json'));
  assertNoShell(exec.calls);
});

test('a mission that stops to ask a question fails at once, with the question', async () => {
  const deps = devDeps({
    firestore,
    exec: vm(),
    onSleep: async (n) => {
      if (n === 1) await earsTick();
      if (n === 2) await brainMakesMission('needs_input');
    },
  });
  assert.equal(await main(['--role', 'devops-engineer'], { ...deps, readRole }), 1);
  assert.match(deps.stdout.text, /FAIL: role devops-engineer, a read-only look at Cloud Run: the mission stopped as needs_input: Which project\?/);
  assert.equal(deps.exec.callsTo('gcloud').filter((c) => c.args[1] === 'ssh').length, 0, '--role skips reading the VM');
});

test('a Workspace role with no Workspace account yet is refused before anything is sent', async () => {
  const deps = devDeps({ firestore, exec: vm({ ...RECORD, role: 'executive-assistant', workspace: null }) });
  assert.equal(await main([], { ...deps, readRole }), 1);
  assert.match(deps.stderr.text, /executive-assistant is a Workspace role, and the instance has no Workspace account yet/);
  assert.deepEqual(await db.query('', COLLECTIONS.messages, [], { noOrderBy: true }), []);
});

test('no result in time is a FAIL that says where things stand', async () => {
  const deps = devDeps({ firestore, exec: vm(), onSleep: async (n) => { if (n === 1) await earsTick(); } });
  assert.equal(await main(['--wait', '12', '--request', 'hello', '--expect', 'hi'], { ...deps, readRole }), 1);
  assert.match(deps.stdout.text, /FAIL: role generic, your request: no result within 12 s \(no mission yet\)\./);
});

test('usage mistakes are refused before anything is read or sent', async () => {
  for (const argv of [['--role', 'Bad Role'], ['--wait', 'soon'], ['--expect', 'x'], ['--doc', 'https://example.com/doc'],
    ['--request'], ['--request', 'hi', '--expect', '(']]) {
    const exec = fakeExec();
    assert.equal(await main(argv, { ...devDeps({ firestore, exec }), readRole }), 2, argv.join(' '));
    assert.equal(exec.calls.length, 0);
  }
  const exec = vm();
  assert.equal(await main(['--doc', 'https://docs.google.com/document/d/abc/edit'], { ...devDeps({ firestore, exec }), readRole }), 2,
    '--doc on a role without Workspace');
  assert.deepEqual(await db.query('', COLLECTIONS.messages, [], { noOrderBy: true }), []);
});
