// install/lib/indexes.mjs: the Firestore indexes and TTL policies in install/firestore.indexes.json, and
// which of them a database already has. An index is identified by its signature (collection group,
// query scope, and its fields in order with their directions), so an index created by hand or by an
// earlier install counts as present, whatever Firestore appends to its listing (`__name__`) and however
// it spells the scope. install/lib/indexes.sh runs this file as a small command-line program for
// install.sh and uninstall.sh; dev/harness2/live-runner.mjs imports it to give the lab's projects the
// same indexes. It reads JSON and prints; it never calls gcloud.
//
//   node install/lib/indexes.mjs plan <file>  per composite index in the file:
//                                             <signature> TAB <collection group> TAB <query scope> TAB <field-path>=<order>[;...]
//   node install/lib/indexes.mjs ttls <file>  per TTL policy in the file: <collection group> TAB <field>
//   node install/lib/indexes.mjs ids          reads `gcloud firestore indexes composite list --format=json`
//                                             on stdin; prints <signature> TAB <index id> per index
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One index's signature, from the file's fields or from a listing's. */
export function indexSignature(group, scope, fields) {
  return [
    group,
    String(scope || 'COLLECTION').toLowerCase(),
    fields
      .filter((f) => f.fieldPath !== '__name__')
      .map((f) => `${f.fieldPath}:${String(f.order || f.arrayConfig).toLowerCase()}`)
      .join(','),
  ].join('|');
}

/**
 * The composite indexes an indexes file lists, with what `gcloud firestore indexes composite create`
 * takes: the scope as its flag spells it, and each field's path and order in lower case.
 *
 * @param {object} file  the parsed firestore.indexes.json
 * @returns {{signature: string, group: string, scope: string, fields: {path: string, order: string}[]}[]}
 */
export function indexPlan(file) {
  return (file.indexes || []).map((index) => ({
    signature: indexSignature(index.collectionGroup, index.queryScope, index.fields),
    group: index.collectionGroup,
    scope: String(index.queryScope || 'COLLECTION').toLowerCase().replace(/_/g, '-'),
    fields: index.fields.map((f) => ({ path: f.fieldPath, order: String(f.order).toLowerCase() })),
  }));
}

/** The TTL policies an indexes file lists: the fields marked `ttl: true`. */
export function ttlPlan(file) {
  return (file.fieldOverrides || []).filter((f) => f.ttl === true).map((f) => ({ group: f.collectionGroup, field: f.fieldPath }));
}

/**
 * The indexes a database has, from `gcloud firestore indexes composite list --format=json`.
 *
 * @param {object[]} listing
 * @returns {{signature: string, id: string}[]}
 */
export function indexIds(listing) {
  const ids = [];
  for (const index of listing || []) {
    const match = /\/collectionGroups\/([^/]+)\/indexes\/([^/]+)$/.exec(index.name || '');
    if (match) ids.push({ signature: indexSignature(match[1], index.queryScope, index.fields || []), id: match[2] });
  }
  return ids;
}

/**
 * The TTL state of one field (ACTIVE, CREATING, ...), from `gcloud firestore fields ttls list
 * --format=json`, or null when the database has no TTL on it.
 */
export function ttlState(listing, group, field) {
  const suffix = `/collectionGroups/${group}/fields/${field}`;
  return (listing || []).find((f) => String(f.name || '').endsWith(suffix))?.ttlConfig?.state || null;
}

function main([mode, file]) {
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  if (mode === 'plan') {
    for (const i of indexPlan(read())) {
      console.log([i.signature, i.group, i.scope, i.fields.map((f) => `${f.path}=${f.order}`).join(';')].join('\t'));
    }
  } else if (mode === 'ttls') {
    for (const t of ttlPlan(read())) console.log(`${t.group}\t${t.field}`);
  } else if (mode === 'ids') {
    const text = readFileSync(0, 'utf8').trim();
    for (const i of indexIds(text ? JSON.parse(text) : [])) console.log(`${i.signature}\t${i.id}`);
  } else {
    console.error(`indexes: unknown mode ${mode}`);
    process.exitCode = 2;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (path) => {
    try { return realpathSync(path); } catch { return path; }
  };
  const norm = (path) => (process.platform === 'win32' ? real(path).toLowerCase() : real(path));
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) main(process.argv.slice(2));
