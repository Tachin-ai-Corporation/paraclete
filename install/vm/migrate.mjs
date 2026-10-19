#!/usr/bin/env node
// install/vm/migrate.mjs: runs the data migrations a release carries. A migration is a file
// migrations/<version>-<slug>.mjs at the release root (migrations/README.md has the format) that
// changes data the release reads differently from the one before it: Firestore documents, or files
// under the data root. bootstrap.sh runs this from the staged release, with that release's own
// Firestore client and collection names and the VM's own credentials (the metadata server):
//
//   - while it checks the staged release, before anything is stopped, with --dry-run: every file is
//     named as a migration must be, every migration still to run loads and exports what it must, and
//     Firestore answers. It lists what would run and changes nothing;
//   - after the services stop and before the staged release is swapped in, for real: every migration
//     not yet recorded in Firestore config/migrations runs, oldest version first and by name within a
//     version, each recorded there as soon as it succeeded.
//
// The first failure stops the run and exits non-zero with the reason, which fails the switch: the
// installed release starts again. Firestore is read strictly, and the migrations get a client that
// is strict unless told otherwise: an outage is a failure, never "nothing applied yet" or "nothing to
// change". A release that carries no migration needs nothing from Firestore, so it reads nothing. It
// never runs a migration twice on purpose, but every migration must be safe to run twice: one that
// succeeded and could not be recorded runs again next time.
//
//   node install/vm/migrate.mjs --project <id> --data-root <dir> [--root <release root>] [--dry-run]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, versionFromText } from '../../agent/release/versions.mjs';
import { createClient, firestoreEncode, StoreConflict } from '../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';

/** The release this module belongs to: the staged tree when bootstrap.sh runs it. */
const OWN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Where a release keeps its migrations, relative to its root. */
export const MIGRATIONS_DIR = 'migrations';

/** The record of the migrations applied to this instance's data. */
export const MIGRATIONS_DOC = `${COLLECTIONS.config}/migrations`;

/** A migration's name after its version: lowercase words joined by hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** How many times recording a migration re-reads the record after another writer changed it. */
const RECORD_ATTEMPTS = 3;

/**
 * A migration's id, version and slug from its file name, or null when the name is not
 * `<version>-<slug>.mjs` with a version as agent/release/versions.mjs defines one.
 *
 * @param {string} fileName
 * @returns {{id: string, version: string, slug: string}|null}
 */
export function parseMigrationName(fileName) {
  const name = String(fileName ?? '');
  if (!name.endsWith('.mjs')) return null;
  const id = name.slice(0, -'.mjs'.length);
  const version = versionFromText(id);
  if (!version || !id.startsWith(`${version}-`)) return null;
  const slug = id.slice(version.length + 1);
  return SLUG.test(slug) ? { id, version, slug } : null;
}

/**
 * The migrations a release carries, in the order they run: by version, then by name. Every .mjs file
 * directly in migrations/ is a migration; anything else there (its README) is not. A release with no
 * migrations/ directory carries none.
 *
 * @param {string} root the release root
 * @param {object} [deps]
 * @param {Function} [deps.readDir] (dir) => file names
 * @returns {Array<{id: string, version: string, slug: string, file: string}>}
 * @throws {Error} naming every .mjs file that is not named as a migration must be
 */
export function listMigrations(root, { readDir = (dir) => readdirSync(dir) } = {}) {
  const dir = join(root, MIGRATIONS_DIR);
  let names;
  try {
    names = readDir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const migrations = [];
  const misnamed = [];
  for (const name of names) {
    if (!name.endsWith('.mjs')) continue;
    const parsed = parseMigrationName(name);
    if (parsed) migrations.push({ ...parsed, file: join(dir, name) });
    else misnamed.push(`${MIGRATIONS_DIR}/${name}`);
  }
  if (misnamed.length) {
    throw new Error(`${misnamed.join(', ')}: a migration is named <version>-<slug>.mjs, `
      + 'such as v2026.10.18.1.1-move-settings.mjs (lowercase words joined by hyphens after the version)');
  }
  return migrations.sort((a, b) => compareVersions(a.version, b.version) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The migrations already applied, from config/migrations. A missing document means none; a document
 * that cannot be read, or whose `applied` is not a map, is an error: never guess what ran.
 *
 * @param {object} db a client from agent/storage/firestore.mjs
 * @returns {Promise<{applied: object, updateTime: string|null}>}
 * @throws {StoreUnavailable} when Firestore cannot answer
 */
export async function readApplied(db) {
  const doc = await db.readDoc(MIGRATIONS_DOC);
  if (!doc) return { applied: {}, updateTime: null };
  const { applied = {} } = doc.data;
  if (!applied || typeof applied !== 'object' || Array.isArray(applied)) {
    throw new Error(`${MIGRATIONS_DOC} is malformed: its applied field is not a map of migration ids`);
  }
  return { applied, updateTime: doc.updateTime };
}

/**
 * Records one migration as applied: `applied.<id> = { applied_at, release }` in config/migrations,
 * keeping every other entry and field. A migration id holds dots, which the client's field paths read
 * as nesting, so the whole `applied` map is written back, guarded by the update time it was read at;
 * another writer in between means read again and retry.
 *
 * @param {object} db
 * @param {string} id
 * @param {{applied_at: string, release: string|null}} entry
 */
export async function recordApplied(db, id, entry) {
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
    const { applied, updateTime } = await readApplied(db);
    const next = { ...applied, [id]: entry };
    try {
      await db.patch(MIGRATIONS_DOC, ['applied'], firestoreEncode({ applied: next }), {
        strict: true,
        precondition: updateTime ? { updateTime } : { exists: false },
      });
      return;
    } catch (err) {
      if (!(err instanceof StoreConflict) || attempt === RECORD_ATTEMPTS) throw err;
    }
  }
}

/**
 * The client a migration gets: every read and write is strict unless the migration passes
 * `{ strict: false }`, so a Firestore failure fails the migration instead of reading as an empty
 * collection or a missing document. readDoc and commit are always strict.
 *
 * @param {object} db
 * @returns {object}
 */
export function strictClient(db) {
  const strict = (opts) => ({ strict: true, ...opts });
  return {
    ...db,
    read: (path, opts) => db.read(path, strict(opts)),
    write: (path, data, opts) => db.write(path, data, strict(opts)),
    query: (parentPath, collectionId, filters, opts) => db.query(parentPath, collectionId, filters, strict(opts)),
    patch: (path, fieldPaths, fields, opts) => db.patch(path, fieldPaths, fields, strict(opts)),
    del: (path, opts) => db.del(path, strict(opts)),
  };
}

/** Loads one migration and checks its exports. */
async function loadMigration(migration, importModule) {
  let mod;
  try {
    mod = await importModule(migration.file);
  } catch (err) {
    throw new Error(`${migration.id} does not load: ${String(err?.message || err).split('\n')[0]}`);
  }
  const description = typeof mod.description === 'string' ? mod.description.replace(/\s+/g, ' ').trim() : '';
  if (!description || typeof mod.migrate !== 'function') {
    throw new Error(`${migration.id} must export description (one sentence) and an async function migrate`);
  }
  return { ...migration, description, migrate: mod.migrate };
}

/**
 * The release a migration is recorded under: release.json's version, else its commit, else null.
 *
 * @param {string} root
 * @param {Function} [readText]
 * @returns {string|null}
 */
export function releaseOf(root, readText = (path) => readFileSync(path, 'utf8')) {
  try {
    const record = JSON.parse(readText(join(root, 'release.json')));
    return record?.version || record?.commit || null;
  } catch {
    return null;
  }
}

/**
 * Runs, or with dryRun lists, the migrations of the release at `root` that config/migrations does not
 * record. Stops at the first failure.
 *
 * @param {object}   o
 * @param {object}   o.db            a client from agent/storage/firestore.mjs
 * @param {string}   o.root          the release root
 * @param {string}   o.dataRoot      the instance's data root, handed to each migration
 * @param {boolean}  [o.dryRun]
 * @param {string|null} [o.release] what each is recorded under; default releaseOf(root)
 * @param {Function} [o.log]         (line) => void
 * @param {Function} [o.now]         () => ms
 * @param {Function} [o.importModule] (absolute path) => Promise<module>
 * @param {Function} [o.readDir]
 * @returns {Promise<{carried: number, applied: string[], pending: string[], ran: string[]}>}
 * @throws {Error} with the reason, at the first migration that cannot be listed, loaded, run or recorded
 */
export async function runMigrations({
  db,
  root,
  dataRoot,
  dryRun = false,
  release,
  log = () => {},
  now = Date.now,
  importModule = (path) => import(pathToFileURL(path).href),
  readDir,
}) {
  const migrations = listMigrations(root, readDir ? { readDir } : {});
  if (!migrations.length) {
    // Nothing could run, so the record is not read: an upgrade without migrations needs no Firestore here.
    log('no migrations in this release');
    return { carried: 0, applied: [], pending: [], ran: [] };
  }
  const { applied } = await readApplied(db);
  const done = migrations.filter((m) => Object.hasOwn(applied, m.id)).map((m) => m.id);
  const todo = migrations.filter((m) => !Object.hasOwn(applied, m.id));
  const result = { carried: migrations.length, applied: done, pending: todo.map((m) => m.id), ran: [] };
  log(`${migrations.length} migration${migrations.length === 1 ? '' : 's'} in this release, ${done.length} applied already`);

  const loaded = [];
  for (const migration of todo) loaded.push(await loadMigration(migration, importModule));
  if (dryRun) {
    for (const m of loaded) log(`would run ${m.id}: ${m.description}`);
    if (!loaded.length) log('nothing to run');
    return result;
  }

  const recordAs = release === undefined ? releaseOf(root) : release;
  const client = strictClient(db);
  for (const [index, m] of loaded.entries()) {
    const after = loaded.length - index - 1;
    const notRun = after ? `, and the ${after} after it did not run` : '';
    log(`running ${m.id}: ${m.description}`);
    const started = now();
    try {
      await m.migrate({ db: client, collections: COLLECTIONS, dataRoot, log: (line) => log(`${m.id}: ${line}`) });
    } catch (err) {
      throw new Error(`${m.id} failed: ${err?.message || err}; it is not recorded as applied${notRun}`);
    }
    try {
      await recordApplied(db, m.id, { applied_at: new Date(now()).toISOString(), release: recordAs });
    } catch (err) {
      throw new Error(`${m.id} ran, but could not be recorded in ${MIGRATIONS_DOC} (${err.message}), so it runs again next time${notRun}`);
    }
    result.ran.push(m.id);
    log(`${m.id} applied in ${((now() - started) / 1000).toFixed(1)}s`);
  }
  if (!loaded.length) log('nothing to run');
  return result;
}

/**
 * The command line. Exits 0 when every migration ran (or, with --dry-run, could run), 1 with the
 * reason on stderr when one could not, 2 on a usage error.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {string}   [deps.root]            the release root when --root is not given
 * @param {Function} [deps.getAccessToken]
 * @param {Function} [deps.fetch]
 * @param {string}   [deps.firestoreHost]
 * @param {Function} [deps.now]
 * @param {Function} [deps.importModule]
 * @returns {Promise<number>}
 */
export async function main(argv, {
  root: ownRoot = OWN_ROOT,
  getAccessToken,
  fetch,
  firestoreHost,
  now,
  importModule,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let v;
  try {
    ({ values: v } = parseArgs({
      args: argv,
      options: {
        project: { type: 'string' },
        root: { type: 'string' },
        'data-root': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    }));
  } catch (err) {
    stderr.write(`migrate: ${err.message}\n`);
    return 2;
  }
  if (!v.project || !v['data-root']) {
    stderr.write('Usage: migrate.mjs --project <id> --data-root <dir> [--root <release root>] [--dry-run]\n');
    return 2;
  }
  const log = (line) => stdout.write(`migrate: ${line}\n`);
  try {
    const db = createClient({
      projectId: v.project,
      ...(getAccessToken ? { getAccessToken } : {}),
      ...(fetch ? { fetch } : {}),
      ...(firestoreHost ? { firestoreHost } : {}),
      logger: (level, ...args) => log(`firestore ${level}: ${args.join(' ')}`),
    });
    await runMigrations({
      db,
      root: v.root || ownRoot,
      dataRoot: v['data-root'],
      dryRun: Boolean(v['dry-run']),
      log,
      ...(now ? { now } : {}),
      ...(importModule ? { importModule } : {}),
    });
    return 0;
  } catch (err) {
    stderr.write(`migrate: ${err?.message || err}\n`);
    return 1;
  }
}

// Exits explicitly: an idle connection to Firestore, or a timer a migration left, must not hold the
// switch up.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
