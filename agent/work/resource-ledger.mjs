// agent/work/resource-ledger.mjs: the mission's durable name→id memory for outside resources (a
// Drive folder id, a doc id, a Chat space). Captures ids from tool output and request prose, merges
// them, repairs mistyped ids against them, and renders the ledger for a prompt. Pure: no I/O, no
// clock, no randomness; the caller supplies `now`. Deciding what the brain sees is the
// temporal-memory organ's job (the organ that maintains the agent's memory), which takes the ledger
// as a recall candidate. Called by the checkpoint executor and the brain's planning step.
//
// An outside identifier is a fact about the world that does not change. Re-deriving one by API
// search is pure waste, and the waste is not small: a mission once spent its whole dispatch budget
// re-running the same Drive search six times for a folder it had located two iterations earlier,
// because the plan called it "signed artifacts" while Drive calls it "Executed Advisory Agreements".
//
// Capture is deterministic: identifiers come from the structured JSON the Drive and Docs skills
// already emit, never from a model.

/** Drive and Docs ids are long opaque strings; anything shorter is not an id. */
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Google Chat spaces are addressed by resource name, not a bare id. */
const SPACE_RE = /^spaces\/[A-Za-z0-9_-]{4,}$/;

/** Keys a tool may use for the identifier, in preference order. */
const ID_KEYS = ['docId', 'fileId', 'folderId', 'id', 'spaceId'];

// mimeType or short type → ledger kind. Short types come from the Drive listing and search tools.
//
// `drive_folder`, `doc`, `sheet` and `slides` deliberately match the project context vocabulary:
// one word per concept across the repo. `pdf`, `image`, `file` and `space` are ledger-only and
// carry a route, not just a type: a pdf tells the reading organ it must convert before it can
// read. The ledger is never promoted into project context (it is a mission's working map, not a
// durable reference), so it is free to be more specific there.
const KIND_BY_TYPE = {
  folder: 'drive_folder',
  'application/vnd.google-apps.folder': 'drive_folder',
  doc: 'doc',
  document: 'doc',
  'application/vnd.google-apps.document': 'doc',
  sheet: 'sheet',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  slides: 'slides',
  'application/vnd.google-apps.presentation': 'slides',
  pdf: 'pdf',
  'application/pdf': 'pdf',
  form: 'form',
  drawing: 'drawing',
};

/**
 * Normalize a resource name into a stable ledger key. Case- and punctuation-insensitive, so
 * "Master Templates", "master templates" and "master-templates" collapse to one entry. Deliberately
 * does not resolve aliases (a different name is a different key): alias merging is a judgment call
 * that belongs to memory consolidation, not to capture.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')      // drop a file extension
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Ledger key for an entry. */
export function resourceKey(kind, name) {
  return `${kind}:${normalizeName(name)}`;
}

function kindFor(node) {
  const t = node.type || node.mimeType || '';
  if (KIND_BY_TYPE[t]) return KIND_BY_TYPE[t];
  if (typeof t === 'string' && t.startsWith('image/')) return 'image';
  if (node.docId) return 'doc';
  if (node.spaceId || SPACE_RE.test(String(node.name || ''))) return 'space';
  return 'file';
}

/**
 * Pull every {id, name} pair out of one parsed JSON value, recursively. Handles the three shapes
 * the skills emit: a `files[]` listing, a single created, copied or converted object, and a nested
 * string that is itself JSON, which is how tool results actually arrive
 * (`{"runCommand_response":{"result":"{\"status\":\"downloaded\",...}"}}`).
 *
 * @param {*} node
 * @param {Array} out
 * @param {number} depth
 */
function walk(node, out, depth = 0) {
  if (depth > 8 || node == null) return;

  if (typeof node === 'string') {
    // A nested JSON payload carried as a string.
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length < 200_000) {
      try { walk(JSON.parse(s), out, depth + 1); } catch { /* not JSON: ignore */ }
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const el of node) walk(el, out, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  // Does this object itself name a resource?
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  if (name) {
    for (const k of ID_KEYS) {
      const raw = node[k];
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (!id) continue;
      if (!ID_RE.test(id) && !SPACE_RE.test(id)) continue;
      out.push({ kind: kindFor(node), name, id });
      break;                                   // one id per object
    }
  }

  for (const v of Object.values(node)) walk(v, out, depth + 1);
}

/**
 * Extract resource identifiers from arbitrary tool output text.
 *
 * Tolerant by design: the text is a motor transcript (motor is the organ that executes tasks with
 * tools) containing JSON in fences, JSON nested inside escaped strings, and prose in between.
 * Anything that does not parse is skipped silently: a miss costs one redundant search, whereas a
 * throw would break the task that produced real work.
 *
 * @param {string} text - raw tool or task output
 * @returns {Array<{kind: string, name: string, id: string}>} de-duplicated by key+id
 */
export function extractResources(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];

  const found = [];
  for (const candidate of scanJsonCandidates(s)) {
    try { walk(JSON.parse(candidate), found, 0); } catch { /* not JSON */ }
  }

  // Escaped-JSON fallback: some transports deliver \"-escaped payloads whose outer wrapper never
  // parses. Unescape once and re-scan rather than lose them.
  if (found.length === 0 && s.includes('\\"')) {
    const unescaped = s.replace(/\\"/g, '"');
    for (const candidate of scanJsonCandidates(unescaped)) {
      try { walk(JSON.parse(candidate), found, 0); } catch { /* ignore */ }
    }
  }

  const seen = new Set();
  const out = [];
  for (const r of found) {
    const dedup = `${resourceKey(r.kind, r.name)}|${r.id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(r);
  }
  return out;
}

/** Nouns that mark the thing an id belongs to, mapped to a ledger kind. */
const PROSE_NOUNS = {
  folder: 'drive_folder', directory: 'drive_folder',
  doc: 'doc', document: 'doc', template: 'doc',
  sheet: 'sheet', spreadsheet: 'sheet',
  deck: 'slides', presentation: 'slides',
  pdf: 'pdf', file: 'file', space: 'space',
};

/**
 * Extract name→id pairs written in prose, e.g. a person's request:
 *   "place them in the In Progress folder (1INPROGRESSFOLDER0000000000000009)"
 *   "the 'Signed Artifacts' folder (1SIGNEDARTIFACTS00000000000000009)"
 *
 * This closes the gap that made the ledger useless on a real mission: the request named all three
 * folders with their ids, and the agent still ran name-based searches for them, one of which
 * returned empty because the folder's real name differs from the one in the request.
 *
 * Deliberately conservative. A wrong name→id mapping is worse than none, because it will be
 * trusted: a pair is emitted only when the name is unambiguous, either quoted or Capitalised words
 * immediately followed by a type noun. A bare id with vague surrounding prose is skipped.
 *
 * @param {string} text - instruction or request prose
 * @returns {Array<{kind: string, name: string, id: string}>}
 */
export function extractResourcesFromProse(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out = [];
  const seen = new Set();

  // Drive ids are long; 25+ avoids matching ordinary words and hashes in prose.
  for (const m of s.matchAll(/\b([A-Za-z0-9_-]{25,})\b/g)) {
    const id = m[1];
    if (!/[0-9]/.test(id) || !/[A-Za-z]/.test(id)) continue;   // must look like an id
    const before = s.slice(Math.max(0, m.index - 120), m.index);

    // Strip the punctuation that sits between the name and the id:
    //   "... folder (", "... folder ID: ", "... doc = "
    const lead = before.replace(/[\s(\[{:=,–—-]*(?:id|ID|folder id|file id)?[\s:=]*$/, '');

    // Shape A: a quoted name then a type noun:  'Signed Artifacts' folder
    let hit = lead.match(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]\s*(folder|directory|doc|document|template|sheet|spreadsheet|deck|presentation|pdf|file|space)?\s*$/i);
    let name = hit && hit[1];
    let noun = hit && hit[2];

    // Shape B: Capitalised words then a type noun:  In Progress folder
    if (!name) {
      hit = lead.match(/((?:[A-Z][\w&.-]*\s+){0,4}[A-Z][\w&.-]*)\s+(folder|directory|doc|document|template|sheet|spreadsheet|deck|presentation|pdf|file|space)\s*$/);
      name = hit && hit[1];
      noun = hit && hit[2];
    }

    // Shape C: a bare quoted name with no noun at all:  "Master Templates" (1Og…)
    if (!name) {
      hit = lead.match(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]\s*$/);
      name = hit && hit[1];
    }

    if (!name) continue;                                  // ambiguous: skip it
    name = name.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2) continue;
    // Reject leading connectives that survive the capitalised-words shape.
    if (/^(The|A|An|This|That|In|At|To|From|And|Of|For)$/i.test(name)) continue;

    const kind = PROSE_NOUNS[String(noun || '').toLowerCase()] || 'file';
    const dedup = `${resourceKey(kind, name)}|${id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ kind, name, id });
  }
  return out;
}

/**
 * Find balanced {...} and [...] substrings. A brace counter beats a regex here because the
 * payloads nest, and a greedy or lazy pattern gets either too much or too little.
 *
 * @param {string} s
 * @returns {string[]}
 */
function scanJsonCandidates(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j;                                // resume after this block
          break;
        }
      }
      if (j - i > 400_000) break;               // pathological input guard
    }
  }
  return out;
}

/**
 * Merge freshly extracted resources into the existing ledger.
 *
 * First write wins on the key, but a changed id updates in place and records the previous value:
 * a renamed or replaced folder must not silently keep resolving to a dead id. Order-independent and
 * idempotent: merging the same batch twice yields the same ledger.
 *
 * @param {Object} existing - current ledger, keyed by resourceKey()
 * @param {Array<{kind,name,id}>} found - output of extractResources()
 * @param {Object} [opts]
 * @param {number} [opts.max=200] - hard cap; oldest entries are kept, new ones dropped
 *   (default; callers pass the contracts value)
 * @param {string} [opts.now] - ISO timestamp supplied by the caller
 * @param {string} [opts.source] - provenance, e.g. a step id
 * @returns {{ledger: Object, added: number, updated: number, dropped: number}}
 */
export function mergeResources(existing, found, opts = {}) {
  const max = opts.max ?? 200;
  const now = opts.now || '';
  const source = opts.source || '';
  const ledger = { ...(existing || {}) };
  let added = 0, updated = 0, dropped = 0;

  for (const r of found || []) {
    if (!r || !r.id || !r.name) continue;
    const key = resourceKey(r.kind, r.name);
    const prior = ledger[key];

    if (!prior) {
      if (Object.keys(ledger).length >= max) { dropped++; continue; }
      ledger[key] = { kind: r.kind, name: r.name, id: r.id, first_seen: now, source };
      added++;
      continue;
    }
    if (prior.id !== r.id) {
      ledger[key] = {
        ...prior,
        id: r.id,
        previous_id: prior.id,
        name: r.name,                  // keep the freshest spelling
        updated_at: now,
        source: source || prior.source,
      };
      updated++;
    }
  }
  return { ledger, added, updated, dropped };
}

/**
 * Seed the ledger from free prose: the request text, a context summary, a brief.
 *
 * Composes extractResourcesFromProse and mergeResources so every caller seeds the same way. Two
 * callers need it at different moments: the planner needs a seeded ledger before it writes a
 * single task (a planner that cannot see a verified id types one from memory, and a one-character
 * slip becomes a pinned task that fails identically forever), and the executor needs it for the
 * resume-from-spine path that never passes through plan structuring.
 *
 * Seeding fills gaps only: an existing entry is never overwritten. Prose states a claim; a tool
 * result reports an observation, so the observation wins. This is also what keeps repeated seeding
 * safe: both callers run on every mission iteration, and without the gap-only rule a stale id in
 * the request would overwrite a tool-corrected one on every pass, then get corrected again,
 * forever. (Tool captures still go through mergeResources directly, where a changed id does
 * update in place: that path is how a moved or replaced resource gets fixed.)
 *
 * @param {Object} existing - current ledger
 * @param {string} text - prose that may state ids
 * @param {Object} [opts] - forwarded to mergeResources (max, now, source)
 * @returns {{ledger: Object, added: number, updated: number, dropped: number}}
 */
export function seedFromProse(existing, text, opts = {}) {
  const ledger = { ...(existing || {}) };
  const fresh = extractResourcesFromProse(text)
    .filter((r) => r && r.kind && r.name && !(resourceKey(r.kind, r.name) in ledger));
  if (fresh.length === 0) return { ledger, added: 0, updated: 0, dropped: 0 };
  return mergeResources(ledger, fresh, opts);
}

// Mirrors the id shape extractResourcesFromProse looks for: long enough that ordinary words and
// hashes cannot match, and mixed letters and digits. Keep the two in step.
const ID_SHAPE_G = /\b([A-Za-z0-9_-]{25,})\b/g;
const looksLikeId = (t) => /[0-9]/.test(t) && /[A-Za-z]/.test(t);

/**
 * True when `a` and `b` differ by exactly one substitution, insertion, or deletion. Bounded at 1,
 * so it walks the strings once instead of building a DP table.
 */
export function isEditDistanceOne(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff === 1;
  }

  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;                 // consume one char of the longer string
  }
  return true;
}

/**
 * Correct mistyped identifiers against the ledger.
 *
 * An id is not the kind of thing that can be almost right, and asking a model to transcribe a
 * 44-character opaque string is asking for a defect: one plan copied three ids out of the ledger
 * block in its own prompt and got one of them wrong by a single character, which is enough to fail
 * the checkpoint on every retry forever. Telling the planner to copy carefully does not fix that;
 * nothing informational does. Repair is therefore deterministic and lives in code.
 *
 * The rule is deliberately timid: a token is corrected only when it is id-shaped, is not already a
 * known id, and is edit distance 1 from exactly one ledger id. Zero candidates means it is simply
 * an id we have not seen (possibly a real one the ledger has not captured yet), and more than one
 * means we would be guessing. Both are left exactly as written and reported instead. Two genuine
 * Drive ids differing by one character does not happen, so a unique distance-1 hit is a typo, not
 * a coincidence.
 *
 * @param {string} text
 * @param {Object} ledger - keyed by resourceKey(), values carry {id, name, kind}
 * @returns {{text: string, repairs: Array<{from,to,name,kind}>, unknown: string[]}}
 */
export function repairIds(text, ledger) {
  const s = typeof text === 'string' ? text : '';
  const byId = new Map();
  for (const v of Object.values(ledger || {})) {
    if (v && typeof v.id === 'string' && v.id) byId.set(v.id, v);
  }
  if (!s || byId.size === 0) return { text: s, repairs: [], unknown: [] };

  const repairs = [];
  const unknown = [];
  const out = s.replace(ID_SHAPE_G, (tok) => {
    if (!looksLikeId(tok) || byId.has(tok)) return tok;
    const hits = [];
    for (const id of byId.keys()) {
      if (isEditDistanceOne(tok, id)) {
        hits.push(id);
        if (hits.length > 1) break;             // ambiguous: stop, never guess
      }
    }
    if (hits.length !== 1) {
      if (!unknown.includes(tok)) unknown.push(tok);
      return tok;
    }
    const to = hits[0];
    const e = byId.get(to);
    repairs.push({ from: tok, to, name: e.name, kind: e.kind });
    return to;
  });
  return { text: out, repairs, unknown };
}

/**
 * Render the ledger as the compact block handed to temporal-memory. One line per resource, so an
 * id is never wrapped or truncated mid-token.
 *
 * @param {Object} ledger
 * @param {Object} [opts]
 * @param {number} [opts.limit=40]
 * @param {string[]} [opts.cues] - when present, prefer entries matching a cue
 * @returns {string} markdown block, or '' when the ledger is empty
 */
export function renderResources(ledger, opts = {}) {
  const limit = opts.limit ?? 40;
  const cues = (opts.cues || []).map((c) => String(c).toLowerCase()).filter(Boolean);
  const rows = Object.entries(ledger || {}).map(([key, v]) => ({ key, ...v }));
  if (rows.length === 0) return '';

  if (cues.length > 0) {
    // Cue-matching entries first; the rest still ride along (the ledger is small and a near-miss
    // cue must not hide the id the task actually needs).
    const score = (r) => {
      const hay = `${r.name} ${r.kind}`.toLowerCase();
      return cues.reduce((n, c) => n + (hay.includes(c) ? 1 : 0), 0);
    };
    rows.sort((a, b) => score(b) - score(a));
  }

  const lines = rows.slice(0, limit).map((r) =>
    `- ${r.kind}: "${r.name}" = ${r.id}${r.previous_id ? ` (was ${r.previous_id})` : ''}`,
  );
  const more = rows.length > limit ? `\n- …${rows.length - limit} more` : '';
  return `## Known Resources (already resolved — do NOT search for these again)\n${lines.join('\n')}${more}`;
}
