// agent/work/verdict.mjs: reads the cerebellum's verdict (the organ that verifies each checkpoint)
// from its tool log. The verdict is the name of the terminal tool it called (report_pass,
// report_fail or request_probe), which is structurally unambiguous; response prose is never parsed
// for control flow. Running the verifier, and deciding what a verdict does to the mission, belong to
// the checkpoint executor and the brain's synthesize step, which call these.

/**
 * Extract a verification verdict from a cerebellum response's tool log.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {'PASS'|'FAIL'|'PROBE'|null} - PASS, FAIL, PROBE, or null if no verdict tool was called
 */
export function extractVerdict(output) {
  if (!output) return null;
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const toolLog = text.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
  if (toolLog.includes('[TOOL] report_pass(')) return 'PASS';
  if (toolLog.includes('[TOOL] report_fail(')) return 'FAIL';
  if (toolLog.includes('[TOOL] request_probe(')) return 'PROBE';
  return null; // no verdict tool called: escalate
}

/**
 * Extract the raw argument string from a report_fail tool-log entry.
 *
 * The tool log formats each call as `[TOOL] report_fail({...}) → {result}`, so this captures
 * everything up to the `) →` result separator. Using that sentinel, not the first `)`, is
 * essential: report_fail arguments routinely contain parentheses (legal text like
 * "Section 3.1 (Grant)"), and a first-paren match truncates the JSON to garbage, dropping the
 * whole failure reason so callers re-plan blind.
 *
 * @param {string} text - The full agent response including tool execution log
 * @returns {string|null} - The raw args substring, or null if no report_fail call is present
 */
function extractReportFailArgs(text) {
  const m = text.match(/\[TOOL\] report_fail\(([\s\S]*?)\)\s*→/)
    || text.match(/\[TOOL\] report_fail\(([\s\S]*)\)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Extract the fail recommendation from a report_fail tool call in the log.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {string} - The recommendation text, or a default message
 */
export function extractFailRecommendation(output) {
  if (!output) return 'No recommendation available';
  const text = typeof output === 'string' ? output : JSON.stringify(output);

  // The report_fail args, up to the `) →` sentinel so internal parentheses survive.
  const rawArgs = extractReportFailArgs(text);
  if (rawArgs) {
    try {
      const args = JSON.parse(rawArgs);
      return args.recommendation || args.reasoning || 'No recommendation available';
    } catch {
      // Regex fallback for truncated JSON
      const recMatch = rawArgs.match(/"recommendation"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (recMatch) {
        return recMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }
      const reasoningMatch = rawArgs.match(/"reasoning"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (reasoningMatch) {
        return reasoningMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }
    }
  }

  // Fallback: look for a recommendation in any JSON in the output
  try {
    const jsonMatch = text.match(/\{[\s\S]*"recommendation"[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      return obj.recommendation || obj.reasoning || 'No recommendation available';
    }
  } catch { /* fall through */ }

  return 'No recommendation available';
}

/**
 * Extract the failed checks summary from a report_fail tool call.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {string} - Formatted summary of failed checks
 */
export function extractFailSummary(output) {
  if (!output) return '';
  const text = typeof output === 'string' ? output : JSON.stringify(output);

  const rawArgs = extractReportFailArgs(text);
  if (rawArgs) {
    try {
      const args = JSON.parse(rawArgs);
      const failedChecks = (args.checks || []).filter((c) => !c.pass);
      if (failedChecks.length > 0) {
        return failedChecks.map((c) => `- ${c.criterion}: ${c.evidence}`).join('\n');
      }
      return args.reasoning || '';
    } catch {
      // Regex fallback for truncated JSON
      const reasoningMatch = rawArgs.match(/"reasoning"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (reasoningMatch) {
        return reasoningMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }
    }
  }

  return '';
}

/**
 * Extract the optional caveat from a report_pass tool-log entry: the graded verdict.
 *
 * A verdict is met, met with a caveat, or not met. "Met with a caveat" is a PASS that carries a
 * `caveat` field: the milestone's intent is achieved, but a listed criterion is partially met or
 * deferred in a way that does not defeat the deliverable (a value that resolves at runtime, an
 * optional enrichment left undone). The verdict is still structurally a PASS (extractVerdict
 * returns 'PASS' and the flow is unchanged); this reads the caveat so the brain can show it to the
 * person rather than swallow it.
 *
 * Same `) →` sentinel as extractReportFailArgs: a caveat sentence can contain parentheses, so a
 * first-paren match would truncate the JSON to garbage. Returns '' for a clean pass, no caveat, or
 * any parse failure (a caveat is additive; its absence is never a control-flow signal).
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {string} - The caveat text, or '' when the pass is clean or unparseable
 */
export function extractPassCaveat(output) {
  if (!output) return '';
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const m = text.match(/\[TOOL\] report_pass\(([\s\S]*?)\)\s*→/)
    || text.match(/\[TOOL\] report_pass\(([\s\S]*)\)\s*$/m);
  if (!m) return '';
  const rawArgs = m[1];
  try {
    const args = JSON.parse(rawArgs);
    return typeof args.caveat === 'string' ? args.caveat.trim() : '';
  } catch {
    // Regex fallback for a truncated pass payload: recover the caveat string if it is intact.
    const cav = rawArgs.match(/"caveat"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    return cav ? cav[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim() : '';
  }
}

/**
 * Parse the probes array from a request_probe tool-log entry.
 * Returns [] on any parse failure.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {Array<{claim: string, instruction: string}>}
 */
export function extractProbes(output) {
  if (!output) return [];
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  try {
    const toolLog = text.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
    const probeMatch = toolLog.match(/\[TOOL\] request_probe\((.*?)\) → /)
      || toolLog.match(/\[TOOL\] request_probe\((.*)\)\s*$/m);
    if (!probeMatch) return [];
    const args = JSON.parse(probeMatch[1]);
    if (!Array.isArray(args.probes)) return [];
    return args.probes
      .filter((p) => p && typeof p.claim === 'string' && typeof p.instruction === 'string')
      .map((p) => ({ claim: String(p.claim), instruction: String(p.instruction) }));
  } catch {
    return [];
  }
}

/**
 * Did this FAIL reason say "the work is wrong", or "I could not see the work"?
 *
 * These are different verdicts wearing the same label, and conflating them destroys finished
 * work. A real mission edited three documents correctly; the verifier had under 3,000 characters
 * of evidence for all three, passed the first clause outright, then failed the second because
 * "the ops.json content for the second addendum is not fully visible in the provided transcript".
 * Nothing was wrong with the work. That FAIL then counted as an unresolved hard failure, blocked
 * the synthesis the cortex had correctly chosen, and the mission was reported blocked with three
 * finished documents inside it.
 *
 * A verifier that cannot see the evidence is asking for more, not condemning the work. Detection
 * is textual because the verdict arrives as prose, and deliberately narrow: every phrase here is
 * about the verifier's view of the evidence, never about the artifact's content. "The document is
 * missing a signature block" must not match: that is a genuine finding about the work.
 *
 * @param {string} reason - the FAIL summary or reason text
 * @returns {boolean} true when the failure is about absent evidence, not wrong work
 */
export function isMissingEvidenceFail(reason) {
  const s = typeof reason === 'string' ? reason : '';
  if (!s) return false;
  return /\b(?:not|isn'?t|is not|was not|wasn'?t|cannot be|can'?t be|could not be|couldn'?t be)\s+(?:fully\s+|entirely\s+|clearly\s+)?(?:visible|shown|displayed|included|present)\s+in\s+the\s+(?:provided\s+|given\s+|supplied\s+)?(?:transcript|output|outputs|evidence|log|logs|context)\b/i.test(s)
    || /\b(?:truncat\w+|elided|cut off|clipped)\b[^.]{0,60}\b(?:evidence|output|transcript|content|log)\b/i.test(s)
    || /\b(?:evidence|output|transcript|content|log)\b[^.]{0,60}\b(?:truncat\w+|elided|cut off|clipped)\b/i.test(s)
    || /\b(?:cannot|can'?t|could not|couldn'?t|unable to)\s+(?:fully\s+)?(?:see|read|verify|confirm|determine|assess)\b[^.]{0,80}\b(?:because|since|as)\b[^.]{0,80}\b(?:not (?:provided|included|shown|visible)|truncat\w+|missing from the (?:transcript|output|evidence))\b/i.test(s)
    || /\b(?:insufficient|inadequate|no)\s+evidence\s+(?:was\s+)?(?:provided|included|available|present)\b/i.test(s)
    || /\bevidence\s+(?:for [^.]{0,40})?(?:is|was)\s+(?:not (?:provided|included|available)|missing|absent)\b/i.test(s);
}

/**
 * Ordinal stakes comparison.
 * stakesAtLeast('consequential', 'routine') === true means the first meets or exceeds the second.
 * An unknown stakes value counts as routine; an unknown minimum counts as consequential.
 *
 * @param {string} stakes - The stakes level to check
 * @param {string} minimum - The minimum required level
 * @returns {boolean}
 */
export function stakesAtLeast(stakes, minimum) {
  const ord = { routine: 0, consequential: 1, irreversible: 2 };
  return (ord[stakes] ?? 0) >= (ord[minimum] ?? 1);
}
