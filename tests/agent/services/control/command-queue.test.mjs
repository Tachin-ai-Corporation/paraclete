// Tests for agent/services/control/command-queue.mjs: pending commands are claimed before they run,
// oldest first, and each runs exactly once; outcomes, results and timestamps land on the command
// document; a command interrupted by a restart is failed, never rerun; a detached command is watched
// until it finishes; a result Firestore refuses still ends the command; and a command whose signature
// is refused is failed without running. Fake Firestore; the signature check is faked here and tested
// for real in tests/agent/auth/command-signature.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { createCommandQueue, detached, thenRun, STATUS } from '../../../../agent/services/control/command-queue.mjs';
import { CommandSignatureError } from '../../../../agent/auth/command-signature.mjs';
import { fakeDb } from './fakes.mjs';

const T0 = new Date('2026-10-17T12:00:00.000Z');
const pending = (type, extra = {}) => ({ type, status: 'pending', created_at: '2026-10-17T11:00:00.000Z', requested_by: 'admin@example.com', ...extra });

/** Accepts every command, as the real check does for one the dashboard signed. */
const acceptSigned = async () => ({});

function queueWith(db, handlers, { lines = [], verifyCommand = acceptSigned } = {}) {
  return createCommandQueue({
    db, collections: COLLECTIONS, handlers, verifyCommand, now: () => T0, log: (level, message) => lines.push({ level, message }),
  });
}

test('a pending command is claimed, run with its params, and recorded as done with its result', async () => {
  const db = fakeDb({ 'commands/c1': pending('echo', { params: { word: 'hi' } }) });
  const seen = [];
  const queue = queueWith(db, {
    echo: { run: async (params, ctx) => { seen.push({ params, id: ctx.id, by: ctx.requestedBy, status: db.get('commands/c1').status }); return { said: params.word }; } },
  });
  await queue.tick();
  assert.deepEqual(seen, [{ params: { word: 'hi' }, id: 'c1', by: 'admin@example.com', status: 'running' }]);
  const doc = db.get('commands/c1');
  assert.equal(doc.status, STATUS.done);
  assert.deepEqual(doc.result, { said: 'hi' });
  assert.equal(doc.error, null);
  assert.equal(doc.started_at, T0.toISOString());
  assert.equal(doc.finished_at, T0.toISOString());
  assert.deepEqual(doc.params, { word: 'hi' }, 'the claim keeps the request fields');
  assert.equal(doc.requested_by, 'admin@example.com');
});

test('commands run oldest first, and finished ones are never picked up again', async () => {
  const db = fakeDb({
    'commands/b': pending('echo', { created_at: '2026-10-17T11:00:02.000Z' }),
    'commands/a': pending('echo', { created_at: '2026-10-17T11:00:01.000Z' }),
    'commands/old': { type: 'echo', status: 'done', created_at: '2026-10-17T10:00:00.000Z' },
    'commands/bad': { type: 'echo', status: 'failed', created_at: '2026-10-17T10:00:00.000Z' },
  });
  const order = [];
  const queue = queueWith(db, { echo: { run: async (_p, ctx) => { order.push(ctx.id); return {}; } } });
  await queue.tick();
  await queue.tick();
  assert.deepEqual(order, ['a', 'b']);
});

test('a command is never run twice: two queues racing for it run it once', async () => {
  const db = fakeDb({ 'commands/c1': pending('once') });
  let runs = 0;
  const handlers = { once: { run: async () => { runs += 1; return {}; } } };
  await Promise.all([queueWith(db, handlers).tick(), queueWith(db, handlers).tick()]);
  assert.equal(runs, 1);
  assert.equal(db.get('commands/c1').status, 'done');
});

test('a claim loses to a writer that changed the command after it was read', async () => {
  const db = fakeDb({ 'commands/c1': pending('once') });
  const queue = queueWith(db, { once: { run: async () => ({}) } });
  const readDoc = db.readDoc;
  db.readDoc = async (path) => {
    const doc = await readDoc(path);
    db.set(path, { ...doc.data, status: 'running' });
    return doc;
  };
  assert.equal(await queue.claim('c1'), null);
});

test('an unknown type or a throwing handler fails the command with the reason; an error result is kept', async () => {
  const db = fakeDb({
    'commands/u': pending('reboot_everything'),
    'commands/t': pending('explode'),
  });
  const queue = queueWith(db, {
    explode: { run: async () => { throw Object.assign(new Error('the gateway is not ready'), { result: { ready: false } }); } },
  });
  await queue.tick();
  assert.equal(db.get('commands/u').status, 'failed');
  assert.match(db.get('commands/u').error, /unknown command type 'reboot_everything' \(expected one of explode\)/);
  assert.equal(db.get('commands/t').status, 'failed');
  assert.equal(db.get('commands/t').error, 'the gateway is not ready');
  assert.deepEqual(db.get('commands/t').result, { ready: false });
});

test('a type that names an inherited property is unknown, not a handler', async () => {
  const db = fakeDb({ 'commands/p': pending('constructor') });
  await queueWith(db, {}).tick();
  assert.equal(db.get('commands/p').status, 'failed');
});

test('params that are not an object reach the handler as {}', async () => {
  const db = fakeDb({ 'commands/c1': pending('echo', { params: 'x' }) });
  let got;
  await queueWith(db, { echo: { run: async (params) => { got = params; return {}; } } }).tick();
  assert.deepEqual(got, {});
});

test('a command found running at startup was interrupted: it is failed, not run again', async () => {
  const db = fakeDb({
    'commands/c1': { type: 'restart_service', status: 'running', started_at: '2026-10-17T11:59:00.000Z' },
    'commands/up': { type: 'upgrade', status: 'running', detached: { unit: 'paraclete-upgrade-up.service' } },
  });
  let runs = 0;
  const watched = [];
  const queue = queueWith(db, {
    restart_service: { run: async () => { runs += 1; return {}; } },
    upgrade: { run: async () => ({}), watch: async (record, ctx) => { watched.push([ctx.id, record.unit]); return { finished: false }; } },
  });
  await queue.tick();
  await queue.tick();
  assert.equal(runs, 0);
  const doc = db.get('commands/c1');
  assert.equal(doc.status, 'failed');
  assert.match(doc.error, /^interrupted: the control service stopped while this command ran.*it was not run again$/);
  assert.equal(db.get('commands/up').status, 'running', 'a detached command is watched, not failed');
  assert.deepEqual(watched, [['up', 'paraclete-upgrade-up.service'], ['up', 'paraclete-upgrade-up.service']]);
});

test('a detached command stays running with its record until its watcher says it finished', async () => {
  const db = fakeDb({ 'commands/up': pending('upgrade') });
  let finished = false;
  const queue = queueWith(db, {
    upgrade: {
      run: async (_params, ctx) => { await ctx.detach({ unit: 'paraclete-upgrade-up.service', ref: 'v2026.10.17.1.1' }); return detached(); },
      watch: async (record) => (finished ? { finished: true, ok: true, result: { ref: record.ref, exit_status: 0 } } : { finished: false }),
    },
  });
  await queue.tick();
  assert.equal(db.get('commands/up').status, 'running');
  assert.deepEqual(db.get('commands/up').detached, { unit: 'paraclete-upgrade-up.service', ref: 'v2026.10.17.1.1' });
  await queue.tick();
  assert.equal(db.get('commands/up').status, 'running');
  finished = true;
  await queue.tick();
  assert.equal(db.get('commands/up').status, 'done');
  assert.deepEqual(db.get('commands/up').result, { ref: 'v2026.10.17.1.1', exit_status: 0 });
});

test('a failed detached command, or one nothing watches, ends as failed', async () => {
  const db = fakeDb({
    'commands/up': { type: 'upgrade', status: 'running', detached: { unit: 'u' } },
    'commands/odd': { type: 'status', status: 'running', detached: { unit: 'v' } },
  });
  const queue = queueWith(db, {
    upgrade: { run: async () => ({}), watch: async () => ({ finished: true, ok: false, error: 'exit status 2', result: { output: 'boom' } }) },
    status: { run: async () => ({}) },
  });
  await queue.tick();
  assert.equal(db.get('commands/up').status, 'failed');
  assert.equal(db.get('commands/up').error, 'exit status 2');
  assert.deepEqual(db.get('commands/up').result, { output: 'boom' });
  assert.match(db.get('commands/odd').error, /no handler watches 'status' commands/);
});

test('a watcher that cannot read the unit leaves the command running for the next tick', async () => {
  const db = fakeDb({ 'commands/up': { type: 'upgrade', status: 'running', detached: { unit: 'u' } } });
  const lines = [];
  const queue = queueWith(db, { upgrade: { run: async () => ({}), watch: async () => { throw new Error('dbus timeout'); } } }, { lines });
  await queue.tick();
  assert.equal(db.get('commands/up').status, 'running');
  assert.ok(lines.some((l) => /could not read how it stands: dbus timeout/.test(l.message)));
});

test('thenRun records the command as done before its last action runs', async () => {
  const db = fakeDb({ 'commands/c1': pending('restart_self') });
  let statusWhenActing;
  const queue = queueWith(db, {
    restart_self: { run: async () => thenRun({ restarting: true }, async () => { statusWhenActing = db.get('commands/c1').status; }) },
  });
  await queue.tick();
  assert.equal(statusWhenActing, 'done');
  assert.deepEqual(db.get('commands/c1').result, { restarting: true });
});

test('a result Firestore refuses still ends the command, without the result and saying why', async () => {
  const db = fakeDb({ 'commands/c1': pending('big') });
  db.failOnce('patch', new StoreUnavailable('patch', 'commands/c1', 400, 'Document exceeds the maximum size'), 'commands/c1');
  const queue = queueWith(db, { big: { run: async () => ({ huge: 'x' }) } });
  await queue.tick();
  const doc = db.get('commands/c1');
  assert.equal(doc.status, 'done');
  assert.equal(doc.result, null);
  assert.match(doc.error, /the result could not be stored: .*maximum size/);
});

test('a store outage propagates from the tick, so the caller logs it and tries again', async () => {
  const db = fakeDb({ 'commands/c1': pending('echo') });
  db.failOnce('query', new StoreUnavailable('query', 'commands', 503, 'unavailable'));
  let runs = 0;
  const queue = queueWith(db, { echo: { run: async () => { runs += 1; return {}; } } });
  await assert.rejects(queue.tick(), /HTTP 503/);
  await queue.tick();
  assert.equal(runs, 1);
  assert.equal(db.get('commands/c1').status, 'done');
});

test('running commands are queried at startup and then only while a detached command runs', async () => {
  const db = fakeDb({});
  let finished = false;
  const queue = queueWith(db, {
    upgrade: {
      run: async (_p, ctx) => { await ctx.detach({ unit: 'u' }); return detached(); },
      watch: async () => (finished ? { finished: true, ok: true, result: {} } : { finished: false }),
    },
  });
  const runningQueries = () => db.calls.filter((c) => c.op === 'query' && c.filters[0].value.stringValue === 'running').length;
  await queue.tick();
  await queue.tick();
  assert.equal(runningQueries(), 1, 'nothing detached: one look at startup only');

  db.set('commands/up', pending('upgrade'));
  await queue.tick();
  await queue.tick();
  assert.equal(runningQueries(), 2);
  finished = true;
  await queue.tick();
  assert.equal(db.get('commands/up').status, 'done');
  await queue.tick();
  assert.equal(runningQueries(), 3, 'watching stops once the detached command finished');
});

test('every queue query is a strict single-field filter on the root commands collection', async () => {
  const db = fakeDb({});
  await queueWith(db, {}).tick();
  const queries = db.calls.filter((c) => c.op === 'query');
  assert.ok(queries.length >= 2);
  for (const q of queries) {
    assert.equal(q.collectionId, 'commands');
    assert.equal(q.filters.length, 1);
    assert.equal(q.filters[0].field, 'status');
    assert.equal(q.opts.strict, true);
    assert.equal(q.opts.noOrderBy, true);
  }
});

test('a queue cannot be built without a signature check', () => {
  assert.throws(() => createCommandQueue({ db: fakeDb(), collections: COLLECTIONS, handlers: {} }), /verifyCommand is required/);
});

test('a command whose signature is refused is failed as refused, and never runs', async () => {
  const db = fakeDb({ 'commands/c1': pending('echo') });
  const lines = [];
  let ran = false;
  const verifyCommand = async (command, id) => {
    assert.equal(id, 'c1');
    assert.equal(command.type, 'echo');
    throw new CommandSignatureError('the command is not signed');
  };
  const queue = queueWith(db, { echo: { run: async () => { ran = true; } } }, { lines, verifyCommand });
  await queue.tick();
  assert.equal(ran, false);
  const doc = db.get('commands/c1');
  assert.equal(doc.status, STATUS.failed);
  assert.equal(doc.error, 'refused: the command is not signed');
  assert.ok(lines.some((l) => l.level === 'WARN' && /command c1 echo refused: the command is not signed/.test(l.message)));
});

test('a command whose signature cannot be checked yet stays pending for the next tick', async () => {
  const db = fakeDb({ 'commands/c1': pending('echo') });
  const lines = [];
  let reachable = false;
  const verifyCommand = async () => {
    if (!reachable) throw new Error('could not fetch the signing keys (503)');
    return {};
  };
  const queue = queueWith(db, { echo: { run: async () => ({ ok: 1 }) } }, { lines, verifyCommand });
  await queue.tick();
  assert.equal(db.get('commands/c1').status, STATUS.pending);
  assert.ok(lines.some((l) => l.level === 'WARN' && /could not be checked .*stays pending/.test(l.message)));
  reachable = true;
  await queue.tick();
  assert.equal(db.get('commands/c1').status, STATUS.done);
});
