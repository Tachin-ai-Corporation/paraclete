// Tests for install/vm/migrate.mjs, the runner of a release's data migrations: which files are
// migrations and in what order they run; that only those config/migrations does not record run, each
// recorded as soon as it succeeds; that the first failure stops the run with its reason; that a dry
// run changes nothing; and that Firestore is read strictly, so an outage is a failure and never
// "nothing applied". Migrations are scratch modules run against the in-memory Firestore fake. The
// repo's own migrations/ is checked the same way. How bootstrap.sh calls it is tested in
// tests/install/bootstrap.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../repo/repo-files.mjs';
import {
  MIGRATIONS_DOC, listMigrations, main, parseMigrationName, readApplied, recordApplied, releaseOf, runMigrations,
  strictClient,
} from '../../../install/vm/migrate.mjs';
import { createClient, StoreConflict, StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';
import { start as startFirestore } from '../../fakes/firestore-server.mjs';

const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const COMMIT = 'a'.repeat(40);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'paraclete-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sink() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, text: () => text };
}

/** A migration that notes it ran in <data root>/ran.txt and in Firestore, or throws `fail`. */
function migrationSource(slug, { fail, description = `Test migration ${slug}.` } = {}) {
  return `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export const description = ${JSON.stringify(description)};
export async function migrate({ db, collections, dataRoot, log }) {
  appendFileSync(join(dataRoot, 'ran.txt'), ${JSON.stringify(`${slug}\n`)});
  ${fail ? `throw new Error(${JSON.stringify(fail)});` : ''}
  await db.write(\`\${collections.config}/marker-${slug}\`, { by: ${JSON.stringify(slug)} });
  log('changed what it changes');
}
`;
}

/**
 * A release root with these migration files (name -> source) and a release.json, and a data root.
 *
 * @returns {{root: string, dataRoot: string, ran: () => string[]}}
 */
function release(t, files, { version = 'v2026.10.20.1.1' } = {}) {
  const dir = scratch(t);
  const root = join(dir, 'release');
  const dataRoot = join(dir, 'data');
  mkdirSync(join(root, 'migrations'), { recursive: true });
  mkdirSync(dataRoot);
  writeFileSync(join(root, 'migrations', 'README.md'), '# migrations/\n');
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, 'migrations', name), source);
  writeFileSync(join(root, 'release.json'), JSON.stringify({ version, commit: COMMIT }));
  const ranFile = join(dataRoot, 'ran.txt');
  return { root, dataRoot, ran: () => (existsSync(ranFile) ? readFileSync(ranFile, 'utf8').trim().split('\n') : []) };
}

async function firestore(t) {
  const fake = await startFirestore();
  t.after(() => fake.stop());
  const db = createClient({ projectId: fake.projectId, firestoreHost: fake.origin, getAccessToken: async () => 'vm-token', logger: () => {} });
  return { fake, db };
}

describe('which files are migrations', () => {
  test('a migration is named <version>-<slug>.mjs', () => {
    assert.deepEqual(parseMigrationName('v2026.10.18.1.1-move-settings.mjs'),
      { id: 'v2026.10.18.1.1-move-settings', version: 'v2026.10.18.1.1', slug: 'move-settings' });
    assert.deepEqual(parseMigrationName('v2026.12.31.12.3-x2.mjs'), { id: 'v2026.12.31.12.3-x2', version: 'v2026.12.31.12.3', slug: 'x2' });
    for (const bad of ['v2026.10.18.1.1.mjs', 'v2026.10.18.1.1-.mjs', 'v2026.10.18.1.1-Move.mjs', 'v2026.10.18.1.1-move_settings.mjs',
      'v2026.10.18.1.1-move-.mjs', 'v2026.10.18.1.1--move.mjs', 'v2026.13.18.1.1-move.mjs', 'v2026.10.18.1-move.mjs',
      '2026.10.18.1.1-move.mjs', 'v2026.10.18.1.1-move.js', 'v2026.10.18.1.1-move', 'move.mjs', '', undefined]) {
      assert.equal(parseMigrationName(bad), null, String(bad));
    }
  });

  test('they run by version, then by name; anything that is not a .mjs file is not one', (t) => {
    const { root } = release(t, {
      'v2026.10.18.10.1-later-index.mjs': '',
      'v2026.10.18.9.1-b.mjs': '',
      'v2026.10.18.9.1-a.mjs': '',
      'v2026.09.30.1.1-oldest.mjs': '',
      'notes.txt': '',
    });
    assert.deepEqual(listMigrations(root).map((m) => m.id),
      ['v2026.09.30.1.1-oldest', 'v2026.10.18.9.1-a', 'v2026.10.18.9.1-b', 'v2026.10.18.10.1-later-index']);
    assert.equal(listMigrations(root)[0].file, join(root, 'migrations', 'v2026.09.30.1.1-oldest.mjs'));
    assert.deepEqual(listMigrations(scratch(t)), [], 'a release without migrations/ carries none');
  });

  test('a .mjs file not named as a migration stops the run, naming each', (t) => {
    const { root } = release(t, { 'helpers.mjs': '', 'v2026.10.18.1.1-Upper.mjs': '', 'v2026.10.18.1.1-fine.mjs': '' });
    assert.throws(() => listMigrations(root), (err) => /migrations\/helpers\.mjs/.test(err.message)
      && /migrations\/v2026\.10\.18\.1\.1-Upper\.mjs/.test(err.message) && !/fine/.test(err.message)
      && /is named <version>-<slug>\.mjs/.test(err.message));
  });

  test("the repo's own migrations are named and shaped as the runner requires", async () => {
    for (const migration of listMigrations(repoRoot)) {
      const mod = await import(new URL(`../../../migrations/${migration.id}.mjs`, import.meta.url).href);
      assert.equal(typeof mod.description, 'string', migration.id);
      assert.ok(mod.description.trim(), `${migration.id} describes itself`);
      assert.equal(typeof mod.migrate, 'function', migration.id);
    }
  });
});

describe('running them', () => {
  test('those not recorded run in order, each recorded as it succeeds, with what they need', async (t) => {
    const { fake, db } = await firestore(t);
    const { root, dataRoot, ran } = release(t, {
      'v2026.10.20.1.1-second.mjs': migrationSource('second'),
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
    });
    const lines = [];
    const result = await runMigrations({ db, root, dataRoot, log: (line) => lines.push(line), now: () => NOW });

    assert.deepEqual(ran(), ['first', 'second']);
    assert.deepEqual(result, { carried: 2, applied: [], pending: ['v2026.10.19.1.1-first', 'v2026.10.20.1.1-second'],
      ran: ['v2026.10.19.1.1-first', 'v2026.10.20.1.1-second'] });
    assert.equal((await db.read(`${COLLECTIONS.config}/marker-first`)).by, 'first', 'a migration gets the Firestore client and the collections');
    assert.deepEqual((await db.read(MIGRATIONS_DOC)).applied, {
      'v2026.10.19.1.1-first': { applied_at: '2026-10-20T10:00:00.000Z', release: 'v2026.10.20.1.1' },
      'v2026.10.20.1.1-second': { applied_at: '2026-10-20T10:00:00.000Z', release: 'v2026.10.20.1.1' },
    });
    const stored = fake.dump()[MIGRATIONS_DOC].fields.applied.mapValue.fields;
    assert.ok('v2026.10.19.1.1-first' in stored, 'an id with dots is one key, not a nested path');
    assert.deepEqual(lines, [
      '2 migrations in this release, 0 applied already',
      'running v2026.10.19.1.1-first: Test migration first.',
      'v2026.10.19.1.1-first: changed what it changes',
      'v2026.10.19.1.1-first applied in 0.0s',
      'running v2026.10.20.1.1-second: Test migration second.',
      'v2026.10.20.1.1-second: changed what it changes',
      'v2026.10.20.1.1-second applied in 0.0s',
    ]);

    const again = [];
    const second = await runMigrations({ db, root, dataRoot, log: (line) => again.push(line), now: () => NOW });
    assert.deepEqual(second.ran, [], 'a second run runs nothing');
    assert.deepEqual(ran(), ['first', 'second']);
    assert.deepEqual(again, ['2 migrations in this release, 2 applied already', 'nothing to run']);
  });

  test('recording keeps every other entry and field, including ones this release does not carry', async (t) => {
    const { db } = await firestore(t);
    await db.write(MIGRATIONS_DOC, {
      applied: {
        'v2026.10.19.1.1-first': { applied_at: '2026-10-19T08:00:00.000Z', release: 'v2026.10.19.1.1' },
        'v2026.12.01.1.1-from-a-newer-release': { applied_at: '2026-12-01T08:00:00.000Z', release: 'v2026.12.01.1.1' },
      },
      note: 'kept',
    });
    const { root, dataRoot, ran } = release(t, {
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
      'v2026.10.20.1.1-second.mjs': migrationSource('second'),
    });
    const result = await runMigrations({ db, root, dataRoot, now: () => NOW });
    assert.deepEqual(ran(), ['second'], 'the recorded one does not run again');
    assert.deepEqual(result.applied, ['v2026.10.19.1.1-first']);
    const doc = await db.read(MIGRATIONS_DOC);
    assert.equal(doc.note, 'kept');
    assert.deepEqual(Object.keys(doc.applied).sort(),
      ['v2026.10.19.1.1-first', 'v2026.10.20.1.1-second', 'v2026.12.01.1.1-from-a-newer-release']);
    assert.equal(doc.applied['v2026.10.19.1.1-first'].applied_at, '2026-10-19T08:00:00.000Z');
  });

  test('the first failure stops the run: what ran before it stays recorded, it and what follows do not', async (t) => {
    const { db } = await firestore(t);
    const { root, dataRoot, ran } = release(t, {
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
      'v2026.10.20.1.1-broken.mjs': migrationSource('broken', { fail: 'the old shape is unreadable' }),
      'v2026.10.20.1.1-zlast.mjs': migrationSource('zlast'),
      'v2026.10.21.1.1-later.mjs': migrationSource('later'),
    });
    await assert.rejects(runMigrations({ db, root, dataRoot, now: () => NOW }),
      { message: 'v2026.10.20.1.1-broken failed: the old shape is unreadable; it is not recorded as applied, and the 2 after it did not run' });
    assert.deepEqual(ran(), ['first', 'broken']);
    assert.deepEqual(Object.keys((await db.read(MIGRATIONS_DOC)).applied), ['v2026.10.19.1.1-first']);

    // The next release fixes it: it runs, and so do the ones after it; the one recorded does not.
    const next = release(t, {
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
      'v2026.10.20.1.1-broken.mjs': migrationSource('broken'),
      'v2026.10.20.1.1-zlast.mjs': migrationSource('zlast'),
      'v2026.10.21.1.1-later.mjs': migrationSource('later'),
    });
    const result = await runMigrations({ db, root: next.root, dataRoot: next.dataRoot, now: () => NOW });
    assert.deepEqual(result.ran, ['v2026.10.20.1.1-broken', 'v2026.10.20.1.1-zlast', 'v2026.10.21.1.1-later']);
    assert.deepEqual(next.ran(), ['broken', 'zlast', 'later']);
  });

  test('every migration to run must load and export what it must before the first one runs', async (t) => {
    const { db } = await firestore(t);
    const { root, dataRoot, ran } = release(t, {
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
      'v2026.10.20.1.1-no-description.mjs': 'export async function migrate() {}\n',
    });
    await assert.rejects(runMigrations({ db, root, dataRoot }),
      { message: 'v2026.10.20.1.1-no-description must export description (one sentence) and an async function migrate' });
    assert.deepEqual(ran(), [], 'nothing ran');

    const broken = release(t, { 'v2026.10.20.1.1-syntax.mjs': 'export const description = ;\n' });
    await assert.rejects(runMigrations({ db, root: broken.root, dataRoot: broken.dataRoot }), /^Error: v2026\.10\.20\.1\.1-syntax does not load: /);
  });

  test('a dry run lists what would run and changes nothing', async (t) => {
    const { fake, db } = await firestore(t);
    await db.write(MIGRATIONS_DOC, { applied: { 'v2026.10.19.1.1-first': { applied_at: '2026-10-19T08:00:00.000Z', release: null } } });
    const { root, dataRoot, ran } = release(t, {
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
      'v2026.10.20.1.1-second.mjs': migrationSource('second', { description: 'Moves  the\nsetting.' }),
    });
    const writes = () => fake.requests.filter((r) => r.method !== 'GET').length;
    const before = writes();
    const lines = [];
    const result = await runMigrations({ db, root, dataRoot, dryRun: true, log: (line) => lines.push(line) });
    assert.deepEqual(lines, ['2 migrations in this release, 1 applied already', 'would run v2026.10.20.1.1-second: Moves the setting.']);
    assert.deepEqual(result.pending, ['v2026.10.20.1.1-second']);
    assert.deepEqual(result.ran, []);
    assert.deepEqual(ran(), []);
    assert.equal(writes(), before, 'nothing written');
  });

  test('when Firestore cannot answer, nothing runs: an outage is never "nothing applied"', async (t) => {
    const { root, dataRoot, ran } = release(t, { 'v2026.10.20.1.1-second.mjs': migrationSource('second') });
    const down = createClient({
      projectId: 'your-gcp-project', getAccessToken: async () => 't', logger: () => {},
      fetch: async () => new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 }),
    });
    for (const dryRun of [true, false]) {
      await assert.rejects(runMigrations({ db: down, root, dataRoot, dryRun }), StoreUnavailable);
    }
    assert.deepEqual(ran(), []);

    // A release that carries none has nothing to look up, so an upgrade does not wait on Firestore for it.
    const none = release(t, {});
    for (const dryRun of [true, false]) {
      const lines = [];
      assert.deepEqual(await runMigrations({ db: down, root: none.root, dataRoot: none.dataRoot, dryRun, log: (line) => lines.push(line) }),
        { carried: 0, applied: [], pending: [], ran: [] });
      assert.deepEqual(lines, ['no migrations in this release']);
    }
  });

  test('a malformed record is refused, not read as empty', async (t) => {
    const { db } = await firestore(t);
    await db.write(MIGRATIONS_DOC, { applied: ['v2026.10.19.1.1-first'] });
    await assert.rejects(readApplied(db), /config\/migrations is malformed/);
    assert.deepEqual(await readApplied(createClient({ projectId: 'p', getAccessToken: async () => 't', fetch: async () => new Response('', { status: 404 }) })),
      { applied: {}, updateTime: null }, 'no document: nothing applied');
  });

  test('a migration that ran but could not be recorded fails the run, and says it runs again', async (t) => {
    const { db } = await firestore(t);
    const { root, dataRoot, ran } = release(t, {
      'v2026.10.19.1.1-first.mjs': migrationSource('first'),
      'v2026.10.20.1.1-second.mjs': migrationSource('second'),
    });
    const refusing = { ...db, patch: async () => { throw new StoreUnavailable('patch', MIGRATIONS_DOC, 403, 'PERMISSION_DENIED'); } };
    await assert.rejects(runMigrations({ db: refusing, root, dataRoot }),
      /^Error: v2026\.10\.19\.1\.1-first ran, but could not be recorded in config\/migrations \(.*\), so it runs again next time, and the 1 after it did not run$/);
    assert.deepEqual(ran(), ['first']);
  });

  test('recording reads again after another writer changed the record', async (t) => {
    const { db } = await firestore(t);
    let conflicts = 1;
    const racing = {
      ...db,
      async patch(...args) {
        if (conflicts-- > 0) {
          await db.write(MIGRATIONS_DOC, { applied: { 'v2026.10.18.1.1-other': { applied_at: '2026-10-18T00:00:00.000Z', release: null } } });
          throw new StoreConflict(MIGRATIONS_DOC, 'FAILED_PRECONDITION');
        }
        return db.patch(...args);
      },
    };
    await recordApplied(racing, 'v2026.10.20.1.1-second', { applied_at: '2026-10-20T10:00:00.000Z', release: 'v2026.10.20.1.1' });
    assert.deepEqual(Object.keys((await db.read(MIGRATIONS_DOC)).applied), ['v2026.10.18.1.1-other', 'v2026.10.20.1.1-second']);

    const alwaysRacing = { ...db, patch: async () => { throw new StoreConflict(MIGRATIONS_DOC, 'FAILED_PRECONDITION'); } };
    await assert.rejects(recordApplied(alwaysRacing, 'v2026.10.20.1.1-x', { applied_at: 'x', release: null }), StoreConflict);
  });

  test("a migration's client is strict unless it says otherwise", async () => {
    const calls = [];
    const record = (name) => (...args) => { calls.push([name, args.at(-1)]); return null; };
    const db = { read: record('read'), write: record('write'), query: record('query'), patch: record('patch'), del: record('del'), readDoc: () => 'readDoc' };
    const client = strictClient(db);
    await client.read('a/b');
    await client.write('a/b', {});
    await client.query('', 'a', [], { limit: 5 });
    await client.patch('a/b', ['x'], {}, { strict: false });
    await client.del('a/b');
    assert.deepEqual(calls, [['read', { strict: true }], ['write', { strict: true }], ['query', { strict: true, limit: 5 }],
      ['patch', { strict: false }], ['del', { strict: true }]]);
    assert.equal(client.readDoc(), 'readDoc', 'the rest of the client is the same');
  });

  test("each is recorded under release.json's version, else its commit", (t) => {
    const dir = scratch(t);
    assert.equal(releaseOf(dir), null, 'no release.json');
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ version: null, commit: COMMIT }));
    assert.equal(releaseOf(dir), COMMIT);
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ version: 'v2026.10.20.1.1', commit: COMMIT }));
    assert.equal(releaseOf(dir), 'v2026.10.20.1.1');
    writeFileSync(join(dir, 'release.json'), '{ not json');
    assert.equal(releaseOf(dir), null);
  });
});

describe('the command line', () => {
  test('runs through the given Firestore, logging to stdout, and exits 0', async (t) => {
    const { fake, db } = await firestore(t);
    const { root, dataRoot, ran } = release(t, { 'v2026.10.20.1.1-second.mjs': migrationSource('second') });
    const deps = { firestoreHost: fake.origin, getAccessToken: async () => 'vm-token', now: () => NOW };
    const args = [`--project=${fake.projectId}`, `--root=${root}`, `--data-root=${dataRoot}`];

    const dry = sink();
    assert.equal(await main([...args, '--dry-run'], { ...deps, stdout: dry, stderr: sink() }), 0);
    assert.match(dry.text(), /^migrate: 1 migration in this release, 0 applied already\nmigrate: would run v2026\.10\.20\.1\.1-second: Test migration second\.\n$/);
    assert.deepEqual(ran(), []);

    const out = sink();
    const errors = sink();
    assert.equal(await main(args, { ...deps, stdout: out, stderr: errors }), 0, errors.text());
    assert.deepEqual(ran(), ['second']);
    assert.match(out.text(), /^migrate: running v2026\.10\.20\.1\.1-second: Test migration second\.$/m);
    assert.equal(errors.text(), '');
    assert.equal((await db.read(MIGRATIONS_DOC)).applied['v2026.10.20.1.1-second'].release, 'v2026.10.20.1.1');
    assert.ok(fake.requests.every((r) => r.token === 'vm-token'), "with the VM's credentials");
  });

  test('a failure exits 1 with only the reason on stderr', async (t) => {
    const { fake } = await firestore(t);
    const { root, dataRoot } = release(t, { 'v2026.10.20.1.1-broken.mjs': migrationSource('broken', { fail: 'boom' }) });
    const errors = sink();
    const code = await main([`--project=${fake.projectId}`, `--root=${root}`, `--data-root=${dataRoot}`],
      { firestoreHost: fake.origin, getAccessToken: async () => 't', stdout: sink(), stderr: errors });
    assert.equal(code, 1);
    assert.equal(errors.text(), 'migrate: v2026.10.20.1.1-broken failed: boom; it is not recorded as applied\n');
  });

  test('a missing or unknown argument is a usage error', async () => {
    for (const argv of [[], ['--project=p'], ['--data-root=/d'], ['--project=p', '--data-root=/d', '--force']]) {
      assert.equal(await main(argv, { stdout: sink(), stderr: sink() }), 2, argv.join(' '));
    }
  });
});
