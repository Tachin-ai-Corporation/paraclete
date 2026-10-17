// agent/work/deliverable.mjs: composes a mission's deliverable body, so every terminal envelope
// carries a readable summary before any artifact references. A mission never closes with an empty
// body, or with a bare "📎 Artifacts…" line and no context: every terminal state explains itself in
// one read, answer first. Pure: no I/O, no clock. Sending it is the mouth's job. The brain's
// envelope-completion step calls composeDeliverable in place of a blind output assignment.

/**
 * The floor is an empty guard, not a quality gate: any real (non-footer) content is trusted
 * verbatim, and a short answer like "Deployed." is valid. The deterministic summary is composed
 * only when nothing real remains after stripping the artifact footer. Callers raise it by passing
 * the contracts value as `minChars`, to also replace ultra-thin synthesis.
 */
export const DEFAULT_MIN_BODY_CHARS = 1; // default; callers pass the contracts value

// The artifact footer appended at publish time. Matched so an artifact-only body (no real summary)
// is detected rather than delivered as the deliverable.
const ARTIFACT_FOOTER_RE = /\n*📎 Artifacts:[^\n]*/g;

// ---- Pure helpers ----

/** Strip the artifact footer to reveal the real summary text underneath. */
export function stripArtifactFooter(text) {
  return String(text || '').replace(ARTIFACT_FOOTER_RE, '').trim();
}

/**
 * True when `output` carries no real summary: empty, whitespace, or only the artifact footer.
 * These bodies must not be delivered as they are.
 */
export function isEmptyDeliverable(output, minChars = DEFAULT_MIN_BODY_CHARS) {
  return stripArtifactFooter(output).length < minChars;
}

function firstSentence(s, max = 200) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const dot = clean.search(/[.!?](\s|$)/);
  const cut = dot > 0 && dot < max ? dot + 1 : Math.min(clean.length, max);
  return clean.slice(0, cut).trim();
}

function truncate(s, n) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1).trimEnd() + '…' : clean;
}

function cap(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Distill up to 6 concrete findings from the decide loop's prior results: what each organ
 * actually did, successes and failures alike. Every line moves a belief; none is activity theater.
 */
function distillFindings(priorResults) {
  if (!Array.isArray(priorResults)) return [];
  const out = [];
  for (const r of priorResults) {
    if (!r || r.agent === 'system' || r.agent === 'human') continue;
    const raw = typeof r.result === 'string' ? r.result : (r.result?.output || '');
    const clean = stripArtifactFooter(raw);
    if (!clean) continue;
    const mark = r.success === false ? '✗' : '✓';
    const who = r.agent
      ? `${r.agent}${r.checkpoint_step ? ` (CP${r.checkpoint_step})` : ''}: `
      : '';
    out.push(`${mark} ${who}${truncate(clean, 240)}`);
    if (out.length >= 6) break;
  }
  return out;
}

// ---- Core logic ----

/**
 * Deterministically compose a summary from mission state when no synthesis was produced. Never
 * returns empty: this is the floor of the outcome contract.
 *
 * @param {object} envelope
 * @param {object} [ctx]
 * @param {Array}  [ctx.priorResults] - decide-loop results (the richest source)
 * @returns {string}
 */
export function composeFallbackSummary(envelope, ctx = {}) {
  const status = envelope.status || 'complete';
  const headlineSubject = firstSentence(envelope.title || envelope.instruction || 'the mission');
  const lines = [];

  // A headline scaled to the outcome: the answer, first.
  const HEADLINES = {
    complete: `Completed: ${headlineSubject}.`,
    blocked: `Blocked: ${headlineSubject}.`,
    failed: `Could not complete: ${headlineSubject}.`,
    needs_input: `Needs input: ${headlineSubject}.`,
    cancelled: `Cancelled: ${headlineSubject}.`,
  };
  lines.push(HEADLINES[status] || `${cap(status)}: ${headlineSubject}.`);

  // The blocker or failure cause, if any: a failure says what it was.
  if (envelope.blocker) lines.push(`Blocker: ${firstSentence(envelope.blocker)}`);

  // What actually happened, distilled from the work done.
  const findings = distillFindings(ctx.priorResults);
  if (findings.length) {
    lines.push('', 'What happened:');
    for (const f of findings) lines.push(`• ${f}`);
  } else if (envelope.accept_criteria) {
    lines.push('', `Goal: ${firstSentence(envelope.accept_criteria)}`);
  }

  // Honest provenance: mark that this was composed from state, not authored.
  lines.push('', '_(Summary composed from mission state — no synthesis was produced.)_');

  return lines.join('\n').trim();
}

// ---- Public API ----

/**
 * The single composition entry point for envelope completion.
 *
 * Returns the guaranteed-non-empty deliverable body. A real cortex synthesis is used verbatim;
 * otherwise the deterministic floor composes one. The artifact footer, when present, is placed
 * under the summary, never as the whole body.
 *
 * @param {object} envelope
 * @param {object} opts
 * @param {string} [opts.synthesis]      - cortex-authored body (preferred)
 * @param {string} [opts.artifactFooter] - "📎 Artifacts: …" line, or ''
 * @param {Array}  [opts.priorResults]   - decide-loop results for the floor
 * @param {number} [opts.minChars]       - override for the summary threshold
 * @returns {{ body: string, composed: boolean }} composed=true when the deterministic floor was used
 */
export function composeDeliverable(envelope, opts = {}) {
  const { synthesis = '', artifactFooter = '', priorResults, minChars } = opts;
  const threshold = minChars || DEFAULT_MIN_BODY_CHARS;

  const realSummary = stripArtifactFooter(synthesis);
  let body;
  let composed = false;
  if (realSummary.length >= threshold) {
    body = realSummary;
  } else {
    body = composeFallbackSummary(envelope, { priorResults });
    composed = true;
  }

  const footer = String(artifactFooter || '').trim();
  return { body: footer ? `${body}\n\n${footer}` : body, composed };
}
