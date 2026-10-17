// Tests for dev/say.mjs: the message is stored in the dashboard's exact shape (a Firestore timestamp,
// processed false, the developer's account as sender), the real ears pick it up into an intake
// addressed to its thread, and the command follows it: the intake, the mission it becomes, and only
// the agent's new replies, until the result is delivered. Also a message the ears drop, and a wait
// that runs out.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient, firestoreEncode } from '../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { dashboardMessageFields } from '../../agent/providers/channel.mjs';
import { createDashboardInbox } from '../../agent/services/ears/dashboard-inbox.mjs';
import { createInboundHandler } from '../../agent/services/ears/inbound.mjs';
import { createInboundGate } from '../../agent/services/ears/inbound-gate.mjs';
import { intakeIdFor } from '../../agent/services/ears/intake.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { dashboardMessage, defaultThread, main } from '../../dev/say.mjs';
import { DEV_EMAIL, START, assertNoShell, devDeps, fakeExec } from './fakes.mjs';

const THREAD = defaultThread(new Date(START));

let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

/** One pass of the real ears over the dashboard's messages. */
async function earsTick() {
  const inbox = createDashboardInbox({ db, collections: COLLECTIONS });
  const handle = createInboundHandler({ db, collections: COLLECTIONS, gate: createInboundGate(), preprocess: async (t) => t, now: () => START });
  for (const msg of await inbox.poll()) await handle(msg, inbox);
}

/** The mouth writing an agent message into a dashboard thread, with its own field builder. */
async function agentSays(id, text, at, thread = THREAD) {
  const fields = dashboardMessageFields(text, { thread, agentName: 'Paraclete', timestamp: new Date(at).toISOString() });
  await db.patch(`${COLLECTIONS.messages}/${id}`, Object.keys(fields), fields);
}

const messagePaths = () => Object.keys(firestore.dump()).filter((p) => p.startsWith(`${COLLECTIONS.messages}/`));

test('the message is the dashboard\'s shape, the ears take it in, and the conversation is followed to the delivered result', async () => {
  await agentSays('old-reply', 'An answer from this morning', START - 3_600_000);
  let stored = null;
  const exec = fakeExec();
  const deps = devDeps({
    firestore,
    exec,
    onSleep: async (n) => {
      if (n === 1) {
        stored = structuredClone(firestore.dump());
        await earsTick();
      }
      if (n === 2) {
        const [intake] = await db.query('', COLLECTIONS.intake, [], { noOrderBy: true });
        await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'consumed_by'], firestoreEncode({ status: 'consumed', consumed_by: 'w-1' }));
        await db.write(`${COLLECTIONS.work}/w-1`, { id: 'w-1', type: 'M', status: 'active', delivery_status: 'pending' });
        await agentSays('ack', 'On it.', START + 5_000);
      }
      if (n === 3) {
        await agentSays('result', 'The report is ready.', START + 9_000);
        await db.write(`${COLLECTIONS.work}/w-1`, { id: 'w-1', type: 'M', status: 'complete', delivery_status: 'delivered' });
      }
    },
  });
  assert.equal(await main(['Please', 'write the report'], deps), 0, deps.stderr.text);

  const id = messagePaths().map((p) => p.split('/')[1]).find((m) => !['old-reply', 'ack', 'result'].includes(m));
  assert.match(id, /^[A-Za-z0-9]{20}$/);
  assert.deepEqual(stored[`${COLLECTIONS.messages}/${id}`].fields, {
    text: { stringValue: 'Please write the report' },
    timestamp: { timestampValue: '2026-10-17T12:00:00.000Z' },
    processed: { booleanValue: false },
    sender: { stringValue: DEV_EMAIL },
    sender_name: { stringValue: 'Dev Person' },
    thread_id: { stringValue: THREAD },
    attachments: { arrayValue: { values: [] } },
  });

  const intake = await db.read(`${COLLECTIONS.intake}/${intakeIdFor('dashboard', id)}`);
  assert.equal(intake.text, 'Please write the report');
  assert.equal(intake.source, 'dashboard');
  assert.deepEqual(intake.source_meta.address, { channel: 'dashboard', thread: THREAD });
  assert.equal(intake.source_meta.sender, DEV_EMAIL);
  assert.equal(intake.source_meta.sender_name, 'Dev Person');
  assert.equal((await db.read(`${COLLECTIONS.messages}/${id}`)).processed, true, 'the ears consumed it');

  const out = deps.stdout.text;
  assert.match(out, new RegExp(`^Sent message ${id} to thread ${THREAD} as ${DEV_EMAIL}\\. Following it for up to 180 s\\.$`, 'm'));
  const order = ['the ears took it in as intake/', 'the brain made it work/w-1', 'w-1: active', 'On it.', 'w-1: complete', 'The report is ready.', 'w-1 is complete; its result was delivered.'];
  let at = -1;
  for (const piece of order) {
    const next = out.indexOf(piece);
    assert.ok(next > at, `${piece} comes next in:\n${out}`);
    at = next;
  }
  assert.match(out, /--- Paraclete at 2026-10-17T12:00:05\.000Z\nOn it\.\n/);
  assert.doesNotMatch(out, /An answer from this morning/, 'replies from before the message are not printed');
  assert.deepEqual(exec.calls.map((c) => [c.program, c.args.join(' ')]), [
    ['gcloud', 'config get-value account'], ['git', 'config user.name'], ['gcloud', 'auth print-access-token'],
  ]);
  assertNoShell(exec.calls);
});

test('a message the ears drop without taking it in is reported with the reason', async () => {
  const deps = devDeps({
    firestore,
    exec: fakeExec(),
    onSleep: async () => {
      for (const path of messagePaths()) await db.patch(path, ['processed'], { processed: { booleanValue: true } });
    },
  });
  assert.equal(await main(['hello again'], deps), 1);
  const { ears } = loadContracts();
  assert.match(deps.stderr.text, new RegExp('the ears marked the message processed without taking it in\\. They drop the same text from the same '
    + `person in the same thread within ${Math.round(ears.dedup_window_ms / 1000)} s, and a message within ${Math.round(ears.cooldown_ms / 1000)} s`));
});

test('a wait that runs out says where things stand; --thread and a missing git name are honored', async () => {
  const exec = fakeExec((program, args) => (program === 'git' ? { code: 1 } : undefined));
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['ping', '--thread', 'dev-check', '--wait', '6'], deps), 1);
  assert.match(deps.stdout.text, /Stopped following after 6 s \(no mission yet\)\. Follow up with node dev\/status\.mjs\./);
  const [path] = messagePaths();
  const message = await db.read(path);
  assert.equal(message.thread_id, 'dev-check');
  assert.equal(message.sender_name, 'dev', 'without a git name, the part of the email before the @');
});

test('usage mistakes are refused before anything is sent', async () => {
  for (const argv of [[], ['  '], ['hi', '--thread', 'a/b'], ['hi', '--wait', 'soon'], ['hi', '--attach', 'x']]) {
    const exec = fakeExec();
    assert.equal(await main(argv, devDeps({ firestore, exec })), 2, argv.join(' '));
    assert.equal(exec.calls.length, 0);
  }
  assert.deepEqual(messagePaths(), []);
});

test('the builders: the message shape and today\'s thread', () => {
  const at = new Date(2026, 0, 5, 9, 30);
  assert.equal(defaultThread(at), 'dev-20260105');
  assert.deepEqual(dashboardMessage({ text: 't', thread: 'th', sender: DEV_EMAIL, senderName: 'Dev', at }), {
    text: 't', timestamp: at, processed: false, sender: DEV_EMAIL, sender_name: 'Dev', thread_id: 'th', attachments: [],
  });
});
