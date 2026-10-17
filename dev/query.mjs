#!/usr/bin/env node
// dev/query.mjs: reads your dev instance's Firestore and prints JSON: one document by id, or a query
// over a collection with equality and range filters, an order and a limit. It is read-only by
// construction: the client it works through can only read and query, and options that would write
// are refused. Changing an instance's state by hand to make a test pass is not allowed
// (DEVELOPING.md section 7); a fix is a commit.

import { COLLECTIONS } from '../agent/storage/collections.mjs';
import { DevError, devContext, isMain, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/query.mjs <collection> [--where <field><op><value> ...] [--order <field> [asc|desc]] [--limit N]
       node dev/query.mjs <collection> --doc <id>
Reads your dev instance's Firestore and prints JSON. Read-only.
  <collection>  a root collection (${Object.values(COLLECTIONS).slice(0, 6).join(', ')}, ...) or a
                subcollection path such as work/<id>/history
  --where       <field>=<value>, and !=, <, <=, >, >=. Repeatable; all must hold. Dotted fields reach
                into maps (source_meta.sender). true, false and numbers are typed; anything else is a
                string. Prefix str:, int:, num:, bool: or ts: (a timestamp) to choose the type
  --order       order by a field, ascending unless followed by desc. With --where this may need a
                composite index the instance does not have
  --limit       at most N documents (default 20, at most 1000)
  --doc         read the one document with this id`;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;
const WRITE_OPTIONS = new Set(['--set', '--update', '--patch', '--write', '--create', '--add', '--delete', '--remove', '--merge']);
const OPERATORS = [['!=', 'NOT_EQUAL'], ['<=', 'LESS_THAN_OR_EQUAL'], ['>=', 'GREATER_THAN_OR_EQUAL'], ['==', 'EQUAL'],
  ['=', 'EQUAL'], ['<', 'LESS_THAN'], ['>', 'GREATER_THAN']];
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SEGMENT = /^(?!\.\.?$)[^/\s]{1,1500}$/;

/**
 * A command-line value as a Firestore value. Pure.
 *
 * @param {string} raw
 * @returns {object} an encoded Firestore value
 */
export function typedValue(raw) {
  const typed = /^(str|int|num|bool|ts):(.*)$/s.exec(raw);
  if (typed) {
    const [, type, value] = typed;
    if (type === 'str') return { stringValue: value };
    if (type === 'int' && /^-?\d+$/.test(value)) return { integerValue: value };
    if (type === 'num' && value.trim() !== '' && Number.isFinite(Number(value))) return { doubleValue: Number(value) };
    if (type === 'bool' && (value === 'true' || value === 'false')) return { booleanValue: value === 'true' };
    if (type === 'ts' && Number.isFinite(Date.parse(value))) return { timestampValue: new Date(value).toISOString() };
    throw new DevError(`'${value}' is not a valid ${type}: value`, 2);
  }
  if (raw === 'null') {
    throw new DevError('Firestore matches null only with an IS_NULL filter, which dev/query does not send; use str:null for the text "null"', 2);
  }
  if (raw === 'true' || raw === 'false') return { booleanValue: raw === 'true' };
  if (/^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return { integerValue: raw };
  if (/^-?\d+\.\d+$/.test(raw)) return { doubleValue: Number(raw) };
  return { stringValue: raw };
}

/**
 * One --where argument as a filter for the Firestore client. Pure.
 *
 * @param {string} arg e.g. 'status=complete', 'source_meta.sender!=agent', 'iteration>=3'
 * @returns {{field: string, op: string, value: object}}
 */
export function parseWhere(arg) {
  const at = arg.search(/[!<>=]/);
  if (at <= 0) throw new DevError(`--where needs <field><op><value>, got '${arg}'`, 2);
  const field = arg.slice(0, at);
  const [symbol, op] = OPERATORS.find(([s]) => arg.startsWith(s, at)) || [];
  if (!op) throw new DevError(`--where '${arg}': the operator must be one of =, !=, <, <=, >, >=`, 2);
  if (!FIELD.test(field)) throw new DevError(`--where '${arg}': '${field}' is not a field name`, 2);
  return { field, op, value: typedValue(arg.slice(at + symbol.length)) };
}

/**
 * A collection argument as the client's (parent document path, collection id). Pure.
 *
 * @param {string} path 'work' or 'work/<id>/history'
 * @returns {{parent: string, collection: string}}
 */
export function splitCollectionPath(path) {
  const segments = String(path).split('/');
  if (segments.length % 2 === 0 || !segments.every((s) => SEGMENT.test(s))) {
    throw new DevError(`'${path}' is not a collection: use a name such as work, or a path such as work/<id>/history`, 2);
  }
  return { parent: segments.slice(0, -1).join('/'), collection: segments[segments.length - 1] };
}

function parseArgs(argv) {
  const opts = { collection: null, where: [], order: null, direction: 'ASCENDING', limit: DEFAULT_LIMIT, doc: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new DevError(`${arg} needs a value\n${USAGE}`, 2);
      return argv[i += 1];
    };
    if (WRITE_OPTIONS.has(arg.split('=')[0])) {
      throw new DevError(`there is no ${arg.split('=')[0]}: dev/query only reads. Changing an instance by hand is not allowed `
        + '(DEVELOPING.md section 7): a fix is a commit, deployed with dev/deploy.', 2);
    }
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--where') opts.where.push(parseWhere(value()));
    else if (arg === '--doc') opts.doc = value();
    else if (arg === '--limit') {
      const raw = value();
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LIMIT) throw new DevError(`--limit must be 1 to ${MAX_LIMIT}, got '${raw}'`, 2);
      opts.limit = Number(raw);
    } else if (arg === '--order') {
      const field = value();
      if (!FIELD.test(field)) throw new DevError(`--order: '${field}' is not a field name`, 2);
      opts.order = field;
      if (/^(asc|desc)$/i.test(argv[i + 1] || '')) opts.direction = argv[i += 1].toLowerCase() === 'desc' ? 'DESCENDING' : 'ASCENDING';
    } else if (arg.startsWith('-')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
    else if (opts.collection) throw new DevError(`One collection at a time, got '${opts.collection}' and '${arg}'`, 2);
    else opts.collection = arg;
  }
  if (opts.help) return opts;
  if (!opts.collection) throw new DevError(`Name a collection.\n${USAGE}`, 2);
  if (opts.doc !== null && (opts.where.length || opts.order)) throw new DevError('--doc reads one document; it takes no --where or --order', 2);
  if (opts.doc !== null && !SEGMENT.test(opts.doc)) throw new DevError(`'${opts.doc}' is not a document id`, 2);
  return opts;
}

/**
 * The only Firestore access dev/query has: reading a document and running a query, both strict, so
 * an outage is an error and never an empty answer.
 *
 * @param {object} db a client from agent/storage/firestore.mjs
 */
export function readOnly(db) {
  return Object.freeze({
    read: (path) => db.read(path, { strict: true }),
    query: (parent, collection, filters, opts) => db.query(parent, collection, filters, { ...opts, strict: true }),
  });
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('query', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    const { parent, collection } = splitCollectionPath(opts.collection);
    if (!parent && !Object.values(COLLECTIONS).includes(collection)) {
      ctx.warn(`note: '${collection}' is not a collection paraclete uses (agent/storage/collections.mjs)`);
    }
    const db = readOnly(ctx.db());

    if (opts.doc !== null) {
      const doc = await db.read(`${opts.collection}/${opts.doc}`);
      if (!doc) throw new DevError(`${opts.collection}/${opts.doc} does not exist`);
      ctx.out(JSON.stringify({ id: opts.doc, ...doc }, null, 2));
      return 0;
    }

    const docs = await db.query(parent, collection, opts.where, opts.order
      ? { orderBy: opts.order, orderDirection: opts.direction, limit: opts.limit }
      : { noOrderBy: true, limit: opts.limit });
    ctx.out(JSON.stringify(docs.map(({ id, ...rest }) => ({ id, ...rest })), null, 2));
    if (docs.length === opts.limit) ctx.warn(`(showing the first ${docs.length}; raise --limit for more)`);
    return 0;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
