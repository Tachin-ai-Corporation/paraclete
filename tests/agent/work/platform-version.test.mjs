// Tests for agent/work/platform-version.mjs: the release version read from <install root>/release.json
// (null, said once, when there is none to read), and the brain's Firestore client stamping it on the
// work envelopes created since the brain started, never on older ones, never twice, and never on
// anything that is not an envelope. The brain's wiring is tested in
// tests/agent/services/brain/main.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPlatformVersion, stampPlatformVersion, RELEASE_FILE } from '../../../agent/work/platform-version.mjs';

const START = Date.parse('2026-10-20T10:00:00.000Z');
const AT_START = '2026-10-20T10:00:00.000Z';
const BEFORE = '2026-10-19T23:59:59.999Z';

function logger() {
  const lines = [];
  return { log: (level, message) => lines.push({ level, message }), lines };
}

/** A Firestore client stand-in that records what reaches it. */
function recordingDb() {
  const writes = [];
  return {
    writes,
    read: async (path) => ({ path }),
    write: async (path, data, opts) => { writes.push({ path, data: structuredClone(data), opts }); return { ok: true }; },
    patch: async (...args) => args,
  };
}

test("the version is release.json's, read from the install root", () => {
  const read = [];
  const readText = (path) => { read.push(path.replace(/\\/g, '/')); return JSON.stringify({ version: 'v2026.10.20.1.1', commit: 'a'.repeat(40) }); };
  const { log, lines } = logger();
  assert.equal(readPlatformVersion('/opt/paraclete', { readText, log }), 'v2026.10.20.1.1');
  assert.deepEqual(read, [`/opt/paraclete/${RELEASE_FILE}`]);
  assert.deepEqual(lines, []);
});

test('no file, an unreadable one, or one naming no version gives null, said once', () => {
  const cases = [
    [() => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); }, /release\.json cannot be read \(ENOENT\)/],
    [() => '{ not json', /release\.json cannot be read/],
    [() => JSON.stringify({ version: null, commit: 'a'.repeat(40) }), /names no release version/],
    [() => JSON.stringify({ version: 'main' }), /names no release version/],
    [() => 'null', /names no release version/],
  ];
  for (const [readText, said] of cases) {
    const { log, lines } = logger();
    assert.equal(readPlatformVersion('/opt/paraclete', { readText, log }), null);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'WARN');
    assert.match(lines[0].message, said);
  }
});

test('an envelope created since the brain started is stamped on its first write, in place', async () => {
  const db = recordingDb();
  const client = stampPlatformVersion(db, { version: 'v2026.10.20.1.1', since: START });
  const envelope = { id: 'w-1', type: 'M', status: 'queued', created_at: AT_START };
  assert.deepEqual(await client.write('work/w-1', envelope, { strict: true }), { ok: true });
  assert.equal(envelope.platform_version, 'v2026.10.20.1.1', 'the caller holds what was stored');
  assert.deepEqual(db.writes, [{ path: 'work/w-1', data: { ...envelope }, opts: { strict: true } }]);
});

test('a stamped envelope keeps its version, and one from before the brain started gets none', async () => {
  const db = recordingDb();
  const client = stampPlatformVersion(db, { version: 'v2026.10.20.1.1', since: START });
  await client.write('work/w-2', { id: 'w-2', created_at: AT_START, platform_version: 'v2026.10.19.1.1' });
  await client.write('work/w-3', { id: 'w-3', created_at: AT_START, platform_version: null });
  await client.write('work/w-4', { id: 'w-4', created_at: BEFORE, status: 'archived' });
  await client.write('work/w-5', { id: 'w-5' });
  assert.deepEqual(db.writes.map((w) => w.data.platform_version), ['v2026.10.19.1.1', null, undefined, undefined]);
  assert.ok(!('platform_version' in db.writes[2].data), 'an older envelope saved again stays as it was');
});

test('only work envelopes are stamped: not their history, not other collections', async () => {
  const db = recordingDb();
  const client = stampPlatformVersion(db, { version: 'v2026.10.20.1.1', since: START });
  for (const path of ['work/w-1/history/h-1', 'intake/i-1', 'messages/m-1', 'workers/w-1']) {
    await client.write(path, { id: 'x', created_at: AT_START });
  }
  assert.ok(db.writes.every((w) => !('platform_version' in w.data)));
});

test('with no version known, new envelopes are stamped null; the rest of the client is unchanged', async () => {
  const db = recordingDb();
  const client = stampPlatformVersion(db, { version: null, since: START });
  await client.write('work/w-1', { id: 'w-1', created_at: AT_START });
  assert.equal(db.writes[0].data.platform_version, null);
  assert.ok(Object.hasOwn(db.writes[0].data, 'platform_version'), 'stamped null, so it is never stamped later');
  assert.deepEqual(await client.read('work/w-1'), { path: 'work/w-1' });
  assert.deepEqual(await client.patch('work/w-1', ['a'], {}), ['work/w-1', ['a'], {}]);
});
