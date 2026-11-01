// dev/loop/modules.mjs: the modules the repo is split into for the self-improvement loop, read from
// modules.json, and what follows from them: which module owns a path, which model-suite tasks a change
// affects, and whether a change keeps to the module its issue names. A module is a set of files one
// lane owns; a lane is a loop that may change only its module's files (docs/plan/MODULAR_LOOPS.md).
//
// A path belongs to the first module, in the registry's order, one of whose patterns matches it. A
// pattern is a glob: `*` matches within one path segment, `**` any number of segments. A module with
// `each` is a template: one module per directory the glob names, `{name}` in its id and patterns
// standing for that directory's name; one that would own nothing (an organ's skill) is dropped. A test
// belongs to the owner of the path it mirrors (tests/agent/work/verdict.test.mjs mirrors
// agent/work/verdict.mjs), unless a module names it; a new test named after a file of a module,
// `<stem>-<what>.test.mjs`, is that file's (a loop may add tests, never change one, so its tests are new
// files beside the ones that exist).
//
// It changes nothing and runs no model. Called by cycle.mjs and guard.mjs; tests/dev/loop/modules.test.mjs
// checks that every file the repo tracks has exactly one owner.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectModelTasks } from '../harness2/model-suite.mjs';
import { isBehaviourPath } from './config.mjs';

/** The registry, beside this file. */
export const MODULES_FILE = 'dev/loop/modules.json';

/** The hidden marker an issue names its module with; a change for it may touch only that module's files. */
export const MODULE_MARKER = 'loop-module';

const posix = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * A glob as a regular expression over a whole repo-relative path.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  const g = posix(glob);
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // `dir/**` matches anything below dir; `**/x` any depth before x.
      const slash = g[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** The registry as committed. */
export function readRegistry({ readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFile(path.join(here, 'modules.json')));
}

/**
 * The modules, templates expanded over `files` (repo-relative paths: the repo's tracked files, and any a
 * change adds, so a new role or skill has its module), in the registry's order.
 *
 * @param {object} o
 * @param {string[]} o.files
 * @param {object} [o.registry]  readRegistry()'s result
 * @returns {Array<{ id: string, kind: string, lane: boolean, job: string, globs: string[], patterns: RegExp[] }>}
 */
export function loadModules({ files, registry = readRegistry() }) {
  const paths = (files || []).map(posix);
  const out = [];
  for (const entry of registry.modules || []) {
    if (!entry.each) {
      out.push(moduleOf(entry, entry.id, entry.owns, false));
      continue;
    }
    // `roles/*/` names each directory directly under roles/ that holds a file.
    const parent = posix(entry.each).replace(/\*\/?$/, '');
    const names = [...new Set(paths.filter((p) => p.startsWith(parent) && p.slice(parent.length).includes('/'))
      .map((p) => p.slice(parent.length).split('/')[0]))].sort();
    for (const name of names) {
      const fill = (s) => s.replaceAll('{name}', name);
      out.push(moduleOf(entry, fill(entry.id), entry.owns.map(fill), true));
    }
  }
  out.files = new Set(paths);
  const owners = new Set(paths.map((p) => ownerOf(p, out)));
  const kept = out.filter((m) => !m.template || owners.has(m));
  kept.files = out.files;
  return kept;
}

function moduleOf(entry, id, globs, template) {
  return { id, kind: entry.kind, lane: Boolean(entry.lane), job: entry.job || '', template, globs: [...globs], patterns: globs.map(globToRegExp) };
}

/**
 * The module that owns `rel`, or null.
 *
 * @param {string} rel
 * @param {object[]} modules  loadModules()'s result
 * @returns {object|null}
 */
export function ownerOf(rel, modules) {
  const p = posix(rel);
  const direct = modules.find((m) => m.patterns.some((re) => re.test(p)));
  if (direct || !p.startsWith('tests/')) return direct || null;
  const mirror = p.slice('tests/'.length).replace(/\.test\.(m?js)$/, '.$1');
  const known = modules.files;
  if (known && !known.has(mirror)) {
    // A new test named after a file beside it in the mirror: the longest such file's stem wins.
    const slash = mirror.lastIndexOf('/');
    const dir = mirror.slice(0, slash + 1);
    const stem = mirror.slice(slash + 1).replace(/\.[^.]+$/, '');
    const named = [...known]
      .filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
      .filter((f) => stem.startsWith(`${f.slice(dir.length).replace(/\.[^.]+$/, '')}-`))
      .sort((a, b) => b.length - a.length)[0];
    if (named) return ownerOf(named, modules);
  }
  return ownerOf(mirror, modules);
}

/**
 * The model-suite tasks a change to `paths` affects, in the suite's order, by the product's loading rules:
 * a file in `roles/<r>/` other than generic's is read only on an instance of role r, so it affects only
 * r's tasks (none, for a role without tasks of its own, which therefore cannot be measured); anything
 * else the agent reads (isBehaviourPath) affects every task; anything else, none.
 *
 * @param {string[]} paths
 * @param {object[]} [tasks]  the active suite; default selectModelTasks()
 * @returns {string[]}
 */
export function impactedTasks(paths, tasks = selectModelTasks()) {
  const hit = new Set();
  for (const raw of paths || []) {
    const p = posix(raw);
    if (!isBehaviourPath(p)) continue;
    const role = /^roles\/([^/]+)\//.exec(p)?.[1];
    for (const t of tasks) if (!role || role === 'generic' || t.role === role) hit.add(t.id);
  }
  return tasks.map((t) => t.id).filter((id) => hit.has(id));
}

/** The module an issue names (`<!-- loop-module: <id> -->`), or null. */
export function issueModule(body) {
  const m = new RegExp(`<!--\\s*${MODULE_MARKER}:\\s*([a-z0-9:_-]+)\\s*-->`, 'i').exec(String(body || ''));
  return m ? m[1] : null;
}

/**
 * Why a change for module `moduleId` does not keep to it, if it does not: a path (or a renamed path's
 * old name) another module owns, or no module does, or a module the registry does not have or gives no
 * lane. Tests count as their mirror's (ownerOf), so a lane adds tests of its own files only.
 *
 * @param {Array<{ path: string, oldPath?: string }>} changes
 * @param {string} moduleId
 * @param {object[]} modules  loadModules()'s result, over the repo's files and the change's
 * @returns {string[]}
 */
export function moduleProblems(changes, moduleId, modules) {
  const mod = modules.find((m) => m.id === moduleId);
  if (!mod) return [`its issue names the module ${moduleId}, which ${MODULES_FILE} does not have`];
  if (!mod.lane) return [`its issue names the module ${moduleId}, which has no lane: only a person changes it`];
  const outside = [];
  for (const c of changes) {
    for (const p of [c.path, c.oldPath].filter(Boolean)) {
      const owner = ownerOf(p, modules);
      if (owner?.id !== moduleId) outside.push(`${p} (${owner ? owner.id : 'no module'})`);
    }
  }
  return outside.length ? [`it changes files outside its module ${moduleId}: ${outside.join(', ')}`] : [];
}
