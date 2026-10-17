// agent/work/project-context.mjs: the one validator for what a project's context may hold. A
// project's context is the high-level view of a working area: durable resource references and
// working conventions, never a mission's particulars, history, transient state or process steps
// (those belong in the mission record, an artifact or a process). It does not store anything; every
// writer of project context applies it: the mission-to-project promotion in projects.mjs, the
// mission synthesis, and the agent's project command.

// A context key is a stable, human-meaningful slug for a durable resource.
const SEMANTIC_KEY = /^[a-z][a-z0-9_-]{2,63}$/i;

// Keys whose very name marks them as the wrong layer: a moment-in-time snapshot, a remembered
// failure, a specific mission, or an embedded plan or task. These are history, particulars or
// process steps, not facts about the working area.
const OFF_LAYER_KEY = /(^|[_-])(state|history|failure|failures|failure[_-]?mode|repo[_-]?state|log|logs|snapshot|attempt|attempts|debug|todo|task|tasks|step|steps|plan[_-]?file|workflow|procedure|process)([_-]|$)/i;

// A durable resource reference: an object carrying a kind and at least one pointer or summary. A
// summary-only convention is allowed (a durable working convention is a legitimate fact about the
// area); a bare value is not.
const RESOURCE_KINDS = new Set([
  'drive_folder', 'doc', 'sheet', 'slides', 'url', 'repo', 'git', 'resource', 'convention',
]);

/**
 * The most keys a project's context may hold: it is a curated map, not a mission ledger. A project
 * pushing past this is accumulating particulars, so the extras are dropped and a person curates.
 */
export const MAX_CONTEXT_KEYS = 24; // default; callers pass the contracts value

function isEmptyEntry(v) {
  return v == null
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
    || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validates one project-context entry.
 *
 * @param {string} key
 * @param {*} value
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateContextEntry(key, value) {
  if (!SEMANTIC_KEY.test(key)) return { ok: false, reason: 'key is not a semantic slug' };
  if (OFF_LAYER_KEY.test(key)) return { ok: false, reason: 'key names history/state/particulars/process — belongs in the mission record or a process, not project context' };
  if (isEmptyEntry(value)) return { ok: false, reason: 'empty entry' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'value must be a resource packet {kind, ref|url|summary}, not a bare scalar/array' };
  }
  if (!value.kind || !RESOURCE_KINDS.has(value.kind)) {
    return { ok: false, reason: `kind must be one of ${[...RESOURCE_KINDS].join('|')}` };
  }
  if (!(value.ref || value.url || value.summary)) return { ok: false, reason: 'packet needs a ref, url, or summary' };
  return { ok: true };
}

/**
 * Filters a context map to the conforming entries and enforces the key cap. The cap drops the
 * lexically last extras, so the result is stable across runs.
 *
 * @param {object} contextMap
 * @param {number} [maxKeys=MAX_CONTEXT_KEYS]
 * @returns {{context: object, dropped: Array<{key: string, reason: string}>}}
 */
export function filterProjectContext(contextMap, maxKeys = MAX_CONTEXT_KEYS) {
  const context = {};
  const dropped = [];
  for (const [k, v] of Object.entries(contextMap || {})) {
    const { ok, reason } = validateContextEntry(k, v);
    if (ok) context[k] = v; else dropped.push({ key: k, reason });
  }
  const keys = Object.keys(context);
  if (keys.length > maxKeys) {
    for (const k of keys.sort().slice(maxKeys)) {
      dropped.push({ key: k, reason: `exceeds MAX_CONTEXT_KEYS(${maxKeys})` });
      delete context[k];
    }
  }
  return { context, dropped };
}
