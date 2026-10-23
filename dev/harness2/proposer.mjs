// dev/harness2/proposer.mjs: the model side of a harness proposal. Builds the request a model answers
// (the lens, its focus and rules, the judge's prescriptions, this generation's earlier attempts, and
// the current text of the files the lens may change), the default generator that sends it to a Gemini
// model on Vertex AI through the brain's utility client (agent/providers/vertex-text.mjs `transform`),
// and the reader that checks the model's answer and writes its edits into a candidate workspace, all
// or nothing.
//
// It does not fall back, evaluate or promote. live-runner.mjs `proposeVertexMutation` calls it and,
// when anything here throws, records the error's message as the proposal's `fallbackReason`;
// recursion.mjs then skips evaluating that candidate.

import fs from 'node:fs';
import path from 'node:path';
import { createVertexText } from '../../agent/providers/vertex-text.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { loadInstance } from '../../config/instance.mjs';
import { resolveVertexAccessToken } from './judge.mjs';
import {
  BASE_PROMPT_FILES,
  CONTRACTS_HARD_CEILINGS,
  CONTRACTS_TUNABLE_PATHS,
  ORGANS_ALLOWLIST,
  classifySurfacePath,
  rolesForStage,
} from './surface.mjs';

/** Characters of current file text a request carries; files past it are named, not shown. */
export const PROPOSAL_CONTEXT_CHARS = 120_000;

const PROPOSER_TIMEOUT_MS = 240_000;
const PROPOSER_MAX_TOKENS = 32_768;

const ESCALATION_GUIDANCE = {
  initial_targeted_patch: 'a targeted change aimed at the most likely cause',
  refined_root_cause_patch: 'the earlier attempt did not help: go after the root cause instead of repeating it',
  structural_escalation: 'two attempts did not help: make a structural change, such as rewriting one section or retuning several related limits together',
};

const toRel = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * The files a proposal may change and the model is shown: the curriculum unit's target file when the
 * lens may change it, then the lens's usual files (INV: contracts and the base organ prompts; DOM: the
 * role's organ prompts), each only when it is on the lens's components.
 *
 * @param {object} spec        buildMutationProposalSpec's result, maybe with targetMutablePath
 * @param {string} targetRoot  the candidate workspace
 * @returns {string[]} repo-relative paths; the target may not exist yet
 */
export function proposalContextPaths(spec = {}, targetRoot) {
  const exists = (rel) => fs.existsSync(path.join(targetRoot, rel));
  const target = toRel(spec.targetMutablePath);
  const usual =
    spec.lens === 'DOM'
      ? (spec.role ? [spec.role] : rolesForStage(spec.stage || 'stage1', { repoRoot: targetRoot }))
          .flatMap((role) => ORGANS_ALLOWLIST.map((organ) => `roles/${role}/prompts/${organ}.md`))
          .filter(exists)
      : ['config/contracts.json', ...BASE_PROMPT_FILES.map((f) => `prompts/${f}`)].filter(exists);
  const allowed = Array.isArray(spec.allowedComponents) ? spec.allowedComponents : null;
  const onLens = (rel) => {
    const c = classifySurfacePath(rel, { stage: spec.stage });
    return c.allowed && (!allowed || allowed.includes(c.component));
  };
  return [...new Set([...(target ? [target] : []), ...usual])].filter(onLens);
}

/**
 * The request a model answers with one proposal.
 *
 * @param {object} p
 * @param {object} p.spec
 * @param {string} p.targetRoot
 * @param {number} [p.maxContextChars]
 * @returns {{ prompt: string, shownPaths: string[] }}
 */
export function buildProposalPrompt({ spec = {}, targetRoot, maxContextChars = PROPOSAL_CONTEXT_CHARS } = {}) {
  const lens = spec.lens === 'DOM' ? 'DOM' : 'INV';
  const list = (items) => items.map((s) => `- ${s}`);

  const shown = [];
  const omitted = [];
  const fresh = [];
  let used = 0;
  for (const rel of proposalContextPaths(spec, targetRoot)) {
    const abs = path.join(targetRoot, rel);
    if (!fs.existsSync(abs)) {
      fresh.push(rel);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (used + text.length > maxContextChars) {
      omitted.push(rel);
      continue;
    }
    used += text.length;
    shown.push({ rel, text });
  }

  const components = (spec.allowedSurfaceDetails || []).map(
    (c) => `${c.id}: ${c.description}${c.paths?.length ? ` (${c.paths.join(', ')})` : ''}`,
  );
  const ceilings = Object.entries(CONTRACTS_HARD_CEILINGS).map(([k, b]) => `${k} ${b.min}..${b.max}`);
  const prior = (spec.priorAttemptsSummary || []).map(
    (a) =>
      `${a.attempt}: ${a.hypothesis || '(no hypothesis)'} (capability delta ${a.deltaCapability ?? 'not measured'}; ${a.revertReason || 'kept'})`,
  );

  const lines = [
    'You are improving Paraclete, a general-purpose AI agent, by changing its harness: the instructions its organs read (prompts), its role packages and skills, and the tunable limits in config/contracts.json. The agent works for many organizations, so a change must help any of them; never fit it to one task.',
    '',
    'Propose ONE change that you expect to raise capability (the share of missions completed and verified correctly) without lowering reliability. Keep it small and specific.',
    '',
    `## Lens: ${lens}, ${spec.lensName || ''}`.trimEnd(),
    `Escalation: ${spec.escalationMode || 'initial_targeted_patch'}, ${ESCALATION_GUIDANCE[spec.escalationMode] || ESCALATION_GUIDANCE.initial_targeted_patch}.`,
    ...(spec.focus?.length ? ['Focus:', ...list(spec.focus)] : []),
    ...(components.length ? ['Components you may change:', ...list(components)] : []),
    'Rules:',
    ...list([
      ...(spec.constraints || []),
      `In config/contracts.json change only these keys: ${CONTRACTS_TUNABLE_PATHS.join(', ')}. Bounds: ${ceilings.join(', ')}.`,
      'Text you add to a prompt is read by the agent while it works. Write it for that agent: never mention benchmarks, evaluations, candidates, lenses or tiers.',
    ]),
    '',
    '## What the evaluation found',
    ...(spec.feedbackPrompt ? [spec.feedbackPrompt] : []),
    ...(spec.judgePrescriptions?.length
      ? ['Judge prescriptions:', ...list(spec.judgePrescriptions)]
      : ['The judge recorded no prescriptions for this run.']),
    ...(prior.length ? ['Earlier attempts in this generation, not kept; do something different:', ...list(prior)] : []),
    '',
    '## Files you may change',
    ...shown.flatMap(({ rel, text }) => [`===== BEGIN ${rel} =====`, text.replace(/\n$/, ''), `===== END ${rel} =====`]),
    ...(shown.length ? [] : ['(none shown)']),
    ...(fresh.length ? [`Not created yet (create with "patches"): ${fresh.join(', ')}`] : []),
    ...(omitted.length ? [`Not shown, over the size limit (do not edit): ${omitted.join(', ')}`] : []),
    '',
    '## Answer',
    'Return only a JSON object, no prose:',
    '{"hypothesis":"<one sentence: the change and why it should raise capability>","edits":[{"path":"<a path shown above>","find":"<text copied exactly from that file, occurring once in it>","replace":"<the new text>"}],"patches":{"<path of a new file>":"<its full content>"}}',
    'Use "edits" for the files shown above and "patches" only for a new file. Leave out what you do not use.',
  ];
  return { prompt: lines.join('\n'), shownPaths: shown.map((s) => s.rel) };
}

/**
 * The model's answer as `{ hypothesis, edits, patches }`. Throws, with the reason, on anything else.
 *
 * @param {string|object} raw
 */
export function parseProposal(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?[^\n]*\n/i, '').replace(/\n?```$/, '').trim();
    try {
      obj = JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      try {
        obj = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
      } catch {
        throw new Error(`the model's answer is not a JSON object: ${oneLine(text).slice(0, 200) || '(empty)'}`);
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error("the model's answer is not a JSON object");
  const edits = obj.edits ?? [];
  const patches = obj.patches ?? {};
  if (!Array.isArray(edits)) throw new Error('"edits" in the model\'s answer is not a list');
  if (typeof patches !== 'object' || Array.isArray(patches)) throw new Error('"patches" in the model\'s answer is not a map of path to content');
  return { hypothesis: typeof obj.hypothesis === 'string' ? obj.hypothesis.trim() : '', edits, patches };
}

/**
 * Writes a parsed proposal into the workspace, or nothing when any part of it is wrong: a path off
 * the mutable surface, an edit whose `find` text is missing or not unique, or a JSON file left
 * invalid. Line endings follow each file's own.
 *
 * @param {object} p
 * @param {{ edits: object[], patches: object }} p.proposal  parseProposal's result
 * @param {string} p.targetRoot
 * @param {string} [p.stage]
 * @returns {{ touchedPaths: string[] }} the files whose text changed
 */
export function applyProposal({ proposal, targetRoot, stage } = {}) {
  const next = new Map();
  const current = (rel) => {
    if (next.has(rel)) return next.get(rel);
    const abs = path.join(targetRoot, rel);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    const text = raw.replace(/\r\n/g, '\n');
    return { text, original: text, eol: raw.includes('\r\n') ? '\r\n' : '\n' };
  };
  const checkPath = (p, where) => {
    const rel = toRel(p);
    if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
      throw new Error(`${where}: '${p}' is not a repo-relative path`);
    }
    const surface = classifySurfacePath(rel, { stage });
    if (!surface.allowed) throw new Error(`${where}: ${surface.reason || `${rel} is off the mutable surface`}`);
    return rel;
  };

  proposal.edits.forEach((edit, i) => {
    const where = `edit ${i + 1}`;
    const rel = checkPath(edit?.path, where);
    if (typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string') {
      throw new Error(`${where} (${rel}): needs "find" and "replace" text`);
    }
    const file = current(rel);
    if (!file) throw new Error(`${where}: ${rel} does not exist; a new file goes in "patches"`);
    const find = edit.find.replace(/\r\n/g, '\n');
    const at = file.text.indexOf(find);
    if (at < 0) throw new Error(`${where}: its "find" text is not in ${rel}`);
    if (file.text.indexOf(find, at + 1) >= 0) throw new Error(`${where}: its "find" text occurs more than once in ${rel}`);
    next.set(rel, { ...file, text: file.text.slice(0, at) + edit.replace.replace(/\r\n/g, '\n') + file.text.slice(at + find.length) });
  });
  for (const [p, content] of Object.entries(proposal.patches)) {
    const rel = checkPath(p, `patch ${p}`);
    if (typeof content !== 'string') throw new Error(`patch ${rel}: its content is not text`);
    const file = current(rel);
    next.set(rel, { text: content.replace(/\r\n/g, '\n'), original: file?.original ?? null, eol: file?.eol || '\n' });
  }

  const changed = [...next].filter(([, f]) => f.text !== f.original);
  for (const [rel, f] of changed) {
    if (rel.endsWith('.json')) {
      try {
        JSON.parse(f.text);
      } catch (err) {
        throw new Error(`the proposal leaves ${rel} invalid JSON: ${err.message}`);
      }
    }
  }
  for (const [rel, f] of changed) {
    const abs = path.join(targetRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.eol === '\n' ? f.text : f.text.replace(/\n/g, f.eol), 'utf8');
  }
  return { touchedPaths: changed.map(([rel]) => rel) };
}

function instanceProject() {
  try {
    return loadInstance().project || null;
  } catch {
    return null;
  }
}

/**
 * The default generator: one call to a Gemini model on Vertex AI through the brain's utility client.
 * The model is the contracts' strong tier when that is a Gemini model, else the utility model. Throws
 * when no project is known; the generator it returns throws with the client's logged error when the
 * call fails or the model returns no text.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]          default GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, then the VM's instance.json
 * @param {string} [opts.model]
 * @param {string} [opts.location]
 * @param {object} [opts.contracts]
 * @param {Function} [opts.getAccessToken]   default the metadata server, then `gcloud auth print-access-token`
 * @param {Function} [opts.fetch]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @returns {(prompt: string) => Promise<string>}
 */
export function createVertexProposalGenerator(opts = {}) {
  const projectId = opts.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || instanceProject();
  if (!projectId) {
    throw new Error('no Google Cloud project for the model proposer: set GOOGLE_CLOUD_PROJECT, or run on an instance VM');
  }
  const contracts = opts.contracts || loadContracts();
  const strong = String(contracts.vertex?.models?.strong || '');
  const model = opts.model || (strong.startsWith('vertex-google/') ? strong.slice('vertex-google/'.length) : contracts.utility?.model);
  let lastProblem = null;
  const client = createVertexText({
    projectId,
    location: opts.location || contracts.vertex?.location || contracts.utility?.location,
    model,
    timeoutMs: opts.timeoutMs || PROPOSER_TIMEOUT_MS,
    getAccessToken: opts.getAccessToken || (() => resolveVertexAccessToken()),
    fetch: opts.fetch,
    logger: (level, msg) => {
      if (level === 'ERROR' || level === 'WARN') lastProblem = msg;
    },
  });
  return async function generate(prompt) {
    lastProblem = null;
    const text = await client.transform(prompt, 'Answer the request below with the JSON object it asks for, and nothing else.', {
      maxTokens: opts.maxTokens || PROPOSER_MAX_TOKENS,
      temperature: 0.4,
    });
    if (!text) throw new Error(`${model} returned no proposal${lastProblem ? `: ${lastProblem}` : ''}`);
    return text;
  };
}
