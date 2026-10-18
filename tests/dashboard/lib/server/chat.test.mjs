// Tests for dashboard/lib/server/chat.mjs, against the Firestore fake. The agent's own code reads and
// writes the same documents here (the ears' inbox, the thread ledger, the mouth's delivery), so these
// tests check the two sides agree, not just the dashboard's half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import {
  AGENT_SENDER, MAX_MESSAGE_CHARS, OPEN_STATUSES, earsWouldDrop, ensureThread, listMessages, listNotices, sendMessage,
  threadIdFor, threadPresence,
} from '../../../../dashboard/lib/server/chat.mjs';
import { dashboardMessage } from '../../../../dev/say.mjs';
import { firestoreEncode } from '../../../../agent/storage/firestore.mjs';
import { AGENT_SENDER as CHANNEL_AGENT_SENDER, deliverToAddress, initChannel, makeAddress } from '../../../../agent/providers/channel.mjs';
import { appendTurn, encodeResourceName, threadKeyFor } from '../../../../agent/context/thread-ledger.mjs';
import { createDashboardInbox } from '../../../../agent/services/ears/dashboard-inbox.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { TERMINAL_STATUSES } from '../../../../agent/work/work-schema.mjs';
import { dedupKey } from '../../../../agent/services/ears/inbound-gate.mjs';
import { completeUpload, startUpload } from '../../../../dashboard/lib/server/uploads.mjs';
import { startWithBucket } from './bucket-fakes.mjs';

const ADA = { email: 'ada@example.com', role: 'member' };
const ZOE = { email: 'zoe@example.com', role: 'admin' };
const T0 = new Date('2027-01-15T08:00:00.000Z');
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

/** Writes the agent's reply the way the mouth does: deliverToAddress through the channel module. */
async function agentSays(dash, { thread = null, text, attachments = [], when }) {
  initChannel({
    firestoreUrl: dash.firestore.url, collections: COLLECTIONS, agentName: 'Paraclete', now: () => when.getTime(),
  });
  const ok = await deliverToAddress(makeAddress('dashboard', { thread }), text, { token: 'vm-token', attachments });
  assert.equal(ok, true);
}

test('a thread id is fixed per user, a valid document id, and the id the agent keys its ledger by', () => {
  const id = threadIdFor('ada@example.com');
  assert.match(id, /^user-[0-9a-f]{32}$/);
  assert.equal(threadIdFor('  ADA@Example.com '), id);
  assert.notEqual(threadIdFor('zoe@example.com'), id);
  // Emails that a lossy encoding would merge stay apart.
  assert.notEqual(threadIdFor('a+b@example.com'), threadIdFor('a_b@example.com'));
  // dev/say.mjs accepts it as a thread, and the ledger and the ears use it unchanged.
  assert.match(id, /^[A-Za-z0-9._-]{1,128}$/);
  assert.equal(encodeResourceName(id), id);
  assert.equal(threadKeyFor(makeAddress('dashboard', { thread: id })), id);
  assert.equal(AGENT_SENDER, CHANNEL_AGENT_SENDER);
  assert.throws(() => threadIdFor(''));
});

test("a sent message is stored exactly as dev/say.mjs writes one, and the ears take it in for the user's thread", async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const threadId = threadIdFor(ADA.email);

  const { message } = await sendMessage(runtime, { user: ADA, text: '  Summarize the Q3 numbers  ', now: T0 });
  assert.deepEqual(message, {
    id: message.id, from: 'user', sender: ADA.email, sender_name: 'ada', text: 'Summarize the Q3 numbers',
    timestamp: T0.toISOString(), processed: false, thread_id: threadId, attachments: [],
  });
  assert.match(message.id, /^[A-Za-z0-9]{20}$/);

  const stored = dash.firestore.dump()[`messages/${message.id}`].fields;
  const expected = firestoreEncode(dashboardMessage({
    text: 'Summarize the Q3 numbers', thread: threadId, sender: ADA.email, senderName: 'ada', at: T0,
  }));
  assert.deepEqual(stored, expected);
  assert.deepEqual(stored.timestamp, { timestampValue: T0.toISOString() });

  const inbox = createDashboardInbox({ db: runtime.db, collections: COLLECTIONS });
  const [inbound] = await inbox.poll();
  assert.equal(inbound.id, message.id);
  assert.equal(inbound.text, 'Summarize the Q3 numbers');
  assert.equal(inbound.sender, ADA.email);
  assert.equal(inbound.senderName, 'ada');
  assert.deepEqual(inbound.address, { channel: 'dashboard', thread: threadId });
  await inbox.consume(inbound);
  assert.deepEqual(await inbox.poll(), []);
});

test('the first message creates the thread; later ones patch only its activity and keep what the agent wrote', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const threadId = threadIdFor(ADA.email);

  await sendMessage(runtime, { user: ADA, text: 'hello', now: T0 });
  assert.deepEqual(await dash.doc(`threads/${threadId}`), {
    owner: ADA.email, owner_name: 'ada', title: `Conversation with ${ADA.email}`,
    created_at: T0.toISOString(), last_message_at: T0.toISOString(),
  });

  // The brain records the turn in its ledger, keyed by the thread the ears addressed.
  const address = makeAddress('dashboard', { thread: threadId });
  assert.equal(await appendTurn({
    db: runtime.db, threadKey: threadKeyFor(address), turnId: 'm-1', role: 'user', text: 'hello', channelMeta: address,
    clock: () => at(5).getTime(),
  }), true);
  await runtime.db.patch(`threads/${threadId}`, ['summary', 'summary_through_ts'], {
    summary: { stringValue: 'Ada said hello.' }, summary_through_ts: { timestampValue: at(5).toISOString() },
  }, { strict: true });

  await sendMessage(runtime, { user: ADA, text: 'are you there?', now: at(60) });
  assert.deepEqual(await dash.doc(`threads/${threadId}`), {
    owner: ADA.email, owner_name: 'ada', title: `Conversation with ${ADA.email}`, created_at: T0.toISOString(),
    last_message_at: at(60).toISOString(),
    channel: 'dashboard', last_turn_at: at(5).toISOString(), summary: 'Ada said hello.', summary_through_ts: at(5).toISOString(),
  });
  // Every write to the thread was field-masked: none replaced the whole document.
  const threadWrites = dash.firestore.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(`/threads/${threadId}`));
  assert.ok(threadWrites.length >= 3);
  for (const write of threadWrites) assert.match(write.query, /updateMask\.fieldPaths=/);
});

test('a thread the agent touched first gets the dashboard fields added, and its own are kept', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const threadId = threadIdFor(ADA.email);
  await dash.runtime.db.patch(`threads/${threadId}`, ['channel'], { channel: { stringValue: 'dashboard' } }, { strict: true });
  const thread = await ensureThread(dash.runtime, ADA, T0);
  assert.equal(thread.owner, ADA.email);
  assert.equal((await dash.doc(`threads/${threadId}`)).channel, 'dashboard');
  // Already set up: a second call changes nothing.
  assert.deepEqual(await ensureThread(dash.runtime, ADA, at(99)), thread);
});

test('each user reads only their own thread, newest last, with the agent replies and their files', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const adaThread = threadIdFor(ADA.email);

  await sendMessage(runtime, { user: ADA, text: 'Make me a report', now: T0 });
  await sendMessage(runtime, { user: ZOE, text: 'Something private', now: at(1) });
  await agentSays(dash, {
    thread: adaThread, text: 'Here is your **report**.', when: at(30),
    attachments: [
      { name: 'report.docx', size: 2048, gcsPath: 'files/out/w-1/report.docx' },
      { name: 'notes.md', size: 10, gcsPath: 'files/in/u-1/notes.md' },
    ],
  });
  await agentSays(dash, { thread: null, text: 'Nightly memory tidy-up done.', when: at(40) });

  const page = await listMessages(runtime, { user: ADA });
  assert.equal(page.thread_id, adaThread);
  assert.equal(page.has_more, false);
  assert.deepEqual(page.messages.map((m) => [m.from, m.text]), [['user', 'Make me a report'], ['agent', 'Here is your **report**.']]);
  const reply = page.messages[1];
  assert.equal(reply.sender, 'agent');
  assert.equal(reply.sender_name, 'Paraclete');
  assert.equal(reply.processed, true);
  assert.equal(reply.timestamp, at(30).toISOString());
  assert.deepEqual(reply.attachments, [
    { name: 'report.docx', size: 2048, gcsPath: 'files/out/w-1/report.docx', downloadable: true },
    { name: 'notes.md', size: 10, gcsPath: 'files/in/u-1/notes.md', downloadable: true },
  ]);

  assert.deepEqual((await listMessages(runtime, { user: ZOE })).messages.map((m) => m.text), ['Something private']);
});

test('a long conversation pages back in time', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const thread = threadIdFor(ADA.email);
  const docs = {};
  for (let i = 0; i < 7; i += 1) {
    docs[`messages/m${i}`] = {
      text: `message ${i}`, timestamp: at(i * 60), processed: true, sender: i % 2 ? AGENT_SENDER : ADA.email,
      sender_name: i % 2 ? 'Paraclete' : 'ada', thread_id: thread, attachments: [],
    };
  }
  await dash.seed(docs);

  const newest = await listMessages(runtime, { user: ADA, limit: 3 });
  assert.deepEqual(newest.messages.map((m) => m.text), ['message 4', 'message 5', 'message 6']);
  assert.equal(newest.has_more, true);
  const older = await listMessages(runtime, { user: ADA, limit: '3', before: newest.messages[0].timestamp });
  assert.deepEqual(older.messages.map((m) => m.text), ['message 1', 'message 2', 'message 3']);
  assert.equal(older.has_more, true);
  const oldest = await listMessages(runtime, { user: ADA, limit: 3, before: older.messages[0].timestamp });
  assert.deepEqual(oldest.messages.map((m) => m.text), ['message 0']);
  assert.equal(oldest.has_more, false);

  // A nonsense limit falls back to the default page; a nonsense cursor is refused.
  assert.equal((await listMessages(runtime, { user: ADA, limit: 'lots' })).messages.length, 7);
  await assert.rejects(listMessages(runtime, { user: ADA, before: 'yesterday-ish' }), (err) => err.status === 400);
  await assert.rejects(listMessages(runtime, { user: ADA, since: 'soon' }), (err) => err.status === 400);
  await assert.rejects(listMessages(runtime, { user: ADA, since: at(0).toISOString(), before: at(60).toISOString() }), (err) => err.status === 400);
});

test('a poll reads only what is new since a time, and says when more came than it holds', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const { message: first } = await sendMessage(runtime, { user: ADA, text: 'one', now: T0 });
  await agentSays(dash, { thread: threadIdFor(ADA.email), text: 'two', when: at(10) });

  // From the newest message on: it again, and nothing older.
  const newest = (await listMessages(runtime, { user: ADA })).messages.at(-1);
  const idle = await listMessages(runtime, { user: ADA, since: newest.timestamp });
  assert.equal(idle.since, at(10).toISOString());
  assert.deepEqual(idle.messages.map((m) => m.text), ['two']);
  assert.equal(idle.has_more, false);

  // From a message still waiting for the ears: it, and everything after.
  await sendMessage(runtime, { user: ADA, text: 'three', now: at(20) });
  assert.deepEqual((await listMessages(runtime, { user: ADA, since: first.timestamp })).messages.map((m) => m.text), ['one', 'two', 'three']);
  const crowded = await listMessages(runtime, { user: ADA, since: first.timestamp, limit: 2 });
  assert.deepEqual(crowded.messages.map((m) => m.text), ['two', 'three']);
  assert.equal(crowded.has_more, true);
  assert.equal((await listMessages(runtime, { user: ADA })).since, null);
});

test('empty, oversized and non-text messages are refused, and nothing is written', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  for (const text of ['', '   \n ', null, 42, { text: 'hi' }]) {
    await assert.rejects(sendMessage(runtime, { user: ADA, text, now: T0 }), (err) => err.status === 400);
  }
  await assert.rejects(sendMessage(runtime, { user: ADA, text: 'x'.repeat(MAX_MESSAGE_CHARS + 1), now: T0 }), (err) => err.status === 400 && /most/.test(err.message));
  assert.deepEqual(Object.keys(dash.firestore.dump()), []);
});

test('a message the ears would drop unread is refused up front, with why', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const ears = runtime.contracts.ears;
  await sendMessage(runtime, { user: ADA, text: 'Yes', now: T0 });

  // Sent within the ears' per-person cooldown of the last one.
  await assert.rejects(sendMessage(runtime, { user: ADA, text: 'and another thing', now: new Date(T0.getTime() + ears.cooldown_ms - 500) }), (err) => err.status === 429);
  // The same words again inside the ears' dedup window: a double send.
  await assert.rejects(sendMessage(runtime, { user: ADA, text: '  yes ', now: at(10) }), (err) => err.status === 409 && /10 s ago/.test(err.message));
  // Someone else may say the same thing at once, and so may Ada once the window has passed.
  await sendMessage(runtime, { user: ZOE, text: 'Yes', now: at(1) });
  await sendMessage(runtime, { user: ADA, text: 'and another thing', now: at(20) });
  await sendMessage(runtime, { user: ADA, text: 'yes', now: new Date(T0.getTime() + ears.dedup_window_ms + 1000) });
  assert.equal((await listMessages(runtime, { user: ADA })).messages.length, 3);
});

test('earsWouldDrop reads the cooldown and the dedup window from the contracts values', () => {
  const ears = { cooldown_ms: 2000, dedup_window_ms: 30_000 };
  const said = (text, seconds, attachments = []) => ({ text, timestamp: at(seconds).toISOString(), attachments });
  assert.equal(earsWouldDrop('hi', [], T0.getTime(), ears, 'Paraclete'), null);
  assert.equal(earsWouldDrop('hi', [said('hello', 0)], at(2).getTime(), ears, 'Paraclete'), null);
  assert.equal(earsWouldDrop('hi', [said('hello', 0)], at(1).getTime(), ears, 'Paraclete').status, 429);
  assert.equal(earsWouldDrop('Hello', [said('hello', 0), said('later', 20)], at(29).getTime(), ears, 'Paraclete').status, 409);
  assert.equal(earsWouldDrop('hello', [said('hello', 0)], at(31).getTime(), ears, 'Paraclete'), null);
  // A message that carried files is a different message to the ears, and so is one carrying other files.
  const pdf = { gcsPath: 'files/in/u-1-0a1b2c3d/a.pdf' };
  const csv = { gcsPath: 'files/in/u-2-0a1b2c3d/b.csv' };
  assert.equal(earsWouldDrop('hello', [said('hello', 0, [pdf])], at(10).getTime(), ears, 'Paraclete'), null);
  assert.equal(earsWouldDrop('hello', [said('hello', 0)], at(10).getTime(), ears, 'Paraclete', [pdf]), null);
  assert.equal(earsWouldDrop('hello', [said('hello', 0, [pdf])], at(10).getTime(), ears, 'Paraclete', [csv]), null);
  // The same text with the same files, in any order, is the ears' duplicate: their own dedup key agrees.
  assert.equal(earsWouldDrop('Hello', [said('hello', 0, [pdf, csv])], at(10).getTime(), ears, 'Paraclete', [csv, pdf]).status, 409);
  const msg = (attachments) => ({ sender: 'ada@example.com', address: { channel: 'dashboard', thread: 't' }, text: 'hello', attachments });
  assert.equal(dedupKey(msg([pdf, csv])), dedupKey(msg([csv, pdf])));
  assert.notEqual(dedupKey(msg([pdf])), dedupKey(msg([csv])));
  assert.equal(earsWouldDrop('', [said('', 0, [pdf])], at(10).getTime(), ears, 'Paraclete', [pdf]).status, 409);
});

/** A dashboard on the bucket fake, and a completed upload by `user` of a file with `body`. */
async function withUploads(t) {
  const env = await startWithBucket(t);
  async function upload(user, name, body) {
    const started = await startUpload(env.runtime, { user, name, size: Buffer.byteLength(body), now: T0 });
    await env.put(started.gcs_path, body, started.headers['Content-Type']);
    return completeUpload(env.runtime, { user, id: started.upload_id, gcs_path: started.gcs_path, now: T0 });
  }
  return { ...env, upload };
}

test('a message carries the files its sender uploaded: stored as the ears read them, and each upload marked used by it', async (t) => {
  const { runtime, dash, upload } = await withUploads(t);
  const brief = await upload(ADA, 'brief.pdf', '%PDF-1.7 brief');
  const data = await upload(ADA, 'Q3 data.csv', 'a,b\n1,2\n');

  const { message } = await sendMessage(runtime, {
    user: ADA, text: 'Turn these into a report', now: at(1),
    // The browser's copy of name and size is ignored; the records say what the files are.
    attachments: [{ ...brief, name: 'other.exe' }, { gcsPath: data.gcsPath }],
  });
  assert.deepEqual(message.attachments, [{ ...brief, downloadable: true }, { ...data, downloadable: true }]);
  const stored = await dash.doc(`messages/${message.id}`);
  assert.deepEqual(stored.attachments, [brief, data]);
  for (const file of [brief, data]) {
    const uploadId = file.gcsPath.split('/')[2];
    assert.equal((await dash.doc(`files/${uploadId}`)).message_id, message.id);
  }

  const inbox = createDashboardInbox({ db: runtime.db, collections: COLLECTIONS });
  const [inbound] = await inbox.poll();
  assert.equal(inbound.text, 'Turn these into a report');
  assert.deepEqual(inbound.attachments, [brief, data]);

  // Sent once, an upload cannot ride on another message.
  await assert.rejects(sendMessage(runtime, { user: ADA, text: 'again', attachments: [brief], now: at(10) }), (err) => err.status === 409);
});

test('a message may be files alone; only the sender\'s own completed uploads may go with it', async (t) => {
  const { runtime, dash, upload } = await withUploads(t);
  const mine = await upload(ADA, 'photo.png', 'PNG');
  const zoes = await upload(ZOE, 'zoe.txt', 'private');

  const { message } = await sendMessage(runtime, { user: ADA, text: null, attachments: [mine], now: at(1) });
  assert.equal(message.text, '');
  assert.deepEqual((await dash.doc(`messages/${message.id}`)).attachments, [mine]);
  const inbox = createDashboardInbox({ db: runtime.db, collections: COLLECTIONS });
  assert.deepEqual((await inbox.poll()).map((m) => [m.text, m.attachments.length]), [['', 1]], 'the ears take a files-only message in');

  await assert.rejects(sendMessage(runtime, { user: ADA, text: 'look', attachments: [zoes], now: at(10) }), (err) => err.status === 403);
  await assert.rejects(sendMessage(runtime, { user: ADA, text: '   ', attachments: [], now: at(20) }), (err) => err.status === 400 && /empty/.test(err.message));
  await assert.rejects(sendMessage(runtime, { user: ADA, text: 42, attachments: [mine], now: at(30) }), (err) => err.status === 400);
  await assert.rejects(sendMessage(runtime, { user: ADA, text: 'x', attachments: [{ gcsPath: 'files/out/w-1/report.docx' }], now: at(40) }), (err) => err.status === 400);
  // Nothing was written for the refused sends, and Zoe's upload is still hers to send.
  assert.equal((await listMessages(runtime, { user: ADA })).messages.length, 1);
  assert.equal((await dash.doc(`files/${zoes.gcsPath.split('/')[2]}`)).message_id, null);
});

test('two sends racing for the same upload: one carries it, the other is refused and writes nothing', async (t) => {
  const { runtime, upload } = await withUploads(t);
  const file = await upload(ADA, 'once.pdf', '%PDF once');
  // Both read the upload unused before either commits: the second commit's precondition fails.
  const results = await Promise.allSettled([
    sendMessage(runtime, { user: ADA, text: 'first', attachments: [file], now: at(1) }),
    sendMessage(runtime, { user: ADA, text: 'second', attachments: [file], now: at(60) }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal((await listMessages(runtime, { user: ADA })).messages.length, 1);
});

test('an upload taken by someone else between the check and the send fails the whole send, and writes nothing', async (t) => {
  const { runtime, dash, upload } = await withUploads(t);
  const file = await upload(ADA, 'once.pdf', '%PDF once');
  const record = `files/${file.gcsPath.split('/')[2]}`;
  // The read of recent messages comes after the uploads were checked: a mission takes the file in then.
  const db = {
    ...runtime.db,
    query: async (...args) => {
      await dash.seed({ [record]: { ...(await dash.doc(record)), mission_id: 'w-1' } });
      return runtime.db.query(...args);
    },
  };
  await assert.rejects(sendMessage({ ...runtime, db }, { user: ADA, text: 'here', attachments: [file], now: at(1) }),
    (err) => err.status === 409 && /changed/.test(err.message));
  assert.equal((await listMessages(runtime, { user: ADA })).messages.length, 0);
  assert.equal((await dash.doc(record)).message_id, null);
});

test("presence shows the unfinished missions this thread asked for, and nobody else's", async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const adaThread = threadIdFor(ADA.email);
  const zoeThread = threadIdFor(ZOE.email);
  const meta = (thread) => ({ address: { channel: 'dashboard', thread }, sender: 'x@example.com', channel_msg_id: 'm' });
  const envelope = (id, fields) => ({
    id, type: 'M', parent_id: null, intent: 'decide', instruction: `do ${id}`, source_channel: 'dashboard',
    created_at: at(Number(id.slice(2))).toISOString(), updated_at: at(Number(id.slice(2))).toISOString(), ...fields,
  });
  await dash.seed({
    'work/w-1': envelope('w-1', {
      status: 'active', title: 'Quarterly report', source_meta: meta(adaThread), started_at: at(2).toISOString(),
      _cp_spine: [{ n: 1, outcome: 'Gather the numbers', status: 'complete' }, { n: 2, outcome: 'Write the report', status: 'pending' }],
    }),
    'work/w-2': envelope('w-2', { status: 'awaiting_approval', title: 'Send the invoices', source_meta: meta(adaThread) }),
    'work/w-3': envelope('w-3', { status: 'blocked', blocker: 'The sheet is not shared with me', source_meta: meta(adaThread) }),
    'work/w-4': envelope('w-4', { status: 'complete', title: 'Done already', source_meta: meta(adaThread), completed_at: at(9).toISOString() }),
    'work/w-5': envelope('w-5', { status: 'active', title: "Zoe's work", source_meta: meta(zoeThread) }),
    'work/w-6': envelope('w-6', { type: 'C', parent_id: 'w-1', status: 'active', source_meta: meta(adaThread) }),
    'work/w-7': envelope('w-7', { status: 'queued', title: 'Scheduled', source_channel: 'schedule', source_meta: { responsibility_id: 'r-1' } }),
    'work/w-8': envelope('w-8', { status: 'waiting', title: 'Check back later', wait_resume_at: at(3600).toISOString(), source_meta: meta(adaThread) }),
  });

  const { thread_id: threadId, missions } = await threadPresence(dash.runtime, { user: ADA });
  assert.equal(threadId, adaThread);
  assert.deepEqual(missions.map((m) => `${m.id}:${m.status}`), ['w-8:waiting', 'w-3:blocked', 'w-2:awaiting_approval', 'w-1:active']);
  assert.deepEqual(missions[3], {
    id: 'w-1', title: 'Quarterly report', status: 'active', created_at: at(1).toISOString(), started_at: at(2).toISOString(),
    updated_at: at(1).toISOString(), blocker: null, waiting_until: null,
    progress: { done: 1, total: 2, current: 'Write the report' },
  });
  assert.equal(missions[1].blocker, 'The sheet is not shared with me');
  assert.equal(missions[1].title, 'do w-3');
  assert.equal(missions[0].waiting_until, at(3600).toISOString());
  assert.deepEqual((await threadPresence(dash.runtime, { user: ZOE })).missions.map((m) => m.id), ['w-5']);
  assert.deepEqual(OPEN_STATUSES.filter((s) => TERMINAL_STATUSES.includes(s)), []);
});

test("notices are the agent's messages with no thread, newest first, the same for every user", async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  await sendMessage(runtime, { user: ADA, text: 'hi', now: T0 });
  await agentSays(dash, { thread: threadIdFor(ADA.email), text: 'Hello Ada', when: at(10) });
  await agentSays(dash, { text: 'Memory consolidated.', when: at(20) });
  await agentSays(dash, {
    text: 'Weekly report attached.', when: at(30), attachments: [{ name: 'week.pdf', size: 99, gcsPath: 'files/out/w-9/week.pdf' }],
  });

  const stored = Object.entries(dash.firestore.dump()).filter(([path]) => path.startsWith('messages/')).map(([, doc]) => doc.fields);
  assert.equal(stored.filter((fields) => !('thread_id' in fields)).length, 2, 'the mouth leaves thread_id out of unaddressed messages');

  const { notices } = await listNotices(runtime);
  assert.deepEqual(notices.map((n) => n.text), ['Weekly report attached.', 'Memory consolidated.']);
  assert.equal(notices[0].thread_id, null);
  assert.equal(notices[0].from, 'agent');
  assert.deepEqual(notices[0].attachments, [{ name: 'week.pdf', size: 99, gcsPath: 'files/out/w-9/week.pdf', downloadable: true }]);
  assert.deepEqual((await listNotices(runtime, { limit: 1 })).notices.map((n) => n.text), ['Weekly report attached.']);
  assert.equal((await listNotices(runtime, { limit: 'many' })).notices.length, 2);
});

test('an outage reads as an error, never as an empty conversation', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  await dash.firestore.stop();
  await assert.rejects(listMessages(dash.runtime, { user: ADA }));
  await assert.rejects(threadPresence(dash.runtime, { user: ADA }));
  await assert.rejects(listNotices(dash.runtime));
  await assert.rejects(sendMessage(dash.runtime, { user: ADA, text: 'hello', now: T0 }));
});
