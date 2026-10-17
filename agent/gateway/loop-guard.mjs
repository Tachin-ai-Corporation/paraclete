// agent/gateway/loop-guard.mjs: detects an organ stuck in a tool-calling loop within one turn, and
// decides when to warn it and when to stop it. Pure: it sees each tool call and its result and returns
// an action; turn-loop.mjs injects the warnings and ends the turn.
//
// Four signals, each with a warning threshold and a stop threshold:
//   identical   the same call returned a byte-identical result again: a proven no-op, so the
//               tightest bound
//   duplicate   the same tool with the same arguments, whatever it returned (polling a status
//               legitimately repeats, so this bound is looser)
//   errors      consecutive calls whose results look like errors
//   semantic    the same tool called many times with varying arguments, never converging
// Each warning fires once per turn. A stopped turn gets one tool-less step to answer from what it
// already gathered (turn-loop.mjs, `synthesize`).

/** Thresholds. Defaults; callers pass the contracts values. */
export const DEFAULT_LOOP_GUARD = Object.freeze({
  identicalNudge: 2,
  identicalTerminate: 3,
  duplicateNudge: 3,
  duplicateTerminate: 4,
  errorNudge: 5,
  errorTerminate: 8,
  semanticNudge: 8,
  semanticTerminate: 16,
});

const ERROR_PATTERNS = ['ERROR:', 'No such file', 'command not found', 'Permission denied', 'not found', 'ENOENT'];

export class LoopGuard {
  /**
   * @param {object} [thresholds] any of DEFAULT_LOOP_GUARD's keys; positive integers
   */
  constructor(thresholds = {}) {
    this.limits = { ...DEFAULT_LOOP_GUARD };
    for (const [key, value] of Object.entries(thresholds || {})) {
      if (key in DEFAULT_LOOP_GUARD && Number.isInteger(value) && value > 0) this.limits[key] = value;
    }
    this.callCounts = new Map();
    this.toolNameCounts = new Map();
    this.identicalCounts = new Map();
    this.lastFingerprint = new Map();
    this.consecutiveErrors = 0;
    this.nudged = { identical: false, duplicate: false, errors: false, semantic: false };
    this.terminated = false;
  }

  /**
   * Records one tool call and says what to do next.
   *
   * @param {string} toolName
   * @param {object} args
   * @param {*}      result
   * @returns {{action: 'ok'} | {action: 'nudge'|'terminate', message: string}}
   */
  check(toolName, args, result) {
    const L = this.limits;
    const argsStr = JSON.stringify(args ?? {});
    const sig = `${toolName}:${argsStr}`;
    const count = (this.callCounts.get(sig) || 0) + 1;
    this.callCounts.set(sig, count);
    const nameCount = (this.toolNameCounts.get(toolName) || 0) + 1;
    this.toolNameCounts.set(toolName, nameCount);

    const resultStr = typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
    if (ERROR_PATTERNS.some((p) => resultStr.includes(p))) {
      this.consecutiveErrors++;
    } else {
      this.consecutiveErrors = 0;
      this.nudged.errors = false;
    }

    // Length plus a leading slice: cheap, deterministic, and precise enough that two results that
    // collide are the same for this purpose. Compared per call signature, so a repeat whose result
    // changed (legitimate polling) is left alone, while a repeat that provably learned nothing is
    // stopped early. One run spent its whole time budget on the same search returning the same empty
    // list six times.
    const fingerprint = `${resultStr.length}:${resultStr.slice(0, 300)}`;
    let identical = 1;
    if (this.lastFingerprint.get(sig) === fingerprint) {
      identical = (this.identicalCounts.get(sig) || 1) + 1;
      this.identicalCounts.set(sig, identical);
    } else {
      this.lastFingerprint.set(sig, fingerprint);
      this.identicalCounts.set(sig, 1);
    }

    if (identical >= L.identicalTerminate) {
      return this.#terminate(
        `[LOOP DETECTED] ${toolName} returned a byte-identical result ${identical} times for the same arguments. Repeating it cannot produce new information.\n`
        + 'If the answer is "nothing found", that IS the finding: the target may exist under a different name, or the search terms may be wrong. Report what you observed and what you tried, so the next attempt can start from a different angle.\n'
        + `[STUCK REPORT] ${JSON.stringify({ stuck_tool: toolName, stuck_args: argsStr.slice(0, 200), identical_results: identical, total_calls: this.totalCalls() })}`);
    }
    if (identical >= L.identicalNudge && !this.nudged.identical) {
      this.nudged.identical = true;
      return { action: 'nudge',
        message: `[WARNING] ${toolName} just returned the exact same result as last time for identical arguments. Running it again will return the same thing. Change the arguments (broaden the name, drop a filter, list the parent instead of searching) or accept the result and move on.` };
    }

    if (count >= L.duplicateTerminate) {
      const report = JSON.stringify({
        stuck_tool: toolName,
        stuck_args: argsStr.length > 200 ? `${argsStr.substring(0, 200)}…` : argsStr,
        total_calls: this.totalCalls(),
        unique_signatures: this.callCounts.size,
      });
      return this.#terminate(
        `[LOOP DETECTED] You called ${toolName} with the same arguments ${count} times. The result is not changing. Stopping: report FAILURE with what you observed.\n[STUCK REPORT] ${report}`);
    }
    if (count >= L.duplicateNudge && !this.nudged.duplicate) {
      this.nudged.duplicate = true;
      return { action: 'nudge',
        message: `[WARNING] You've called ${toolName} with identical arguments ${count} times and the result hasn't changed. Stop retrying and either try a different approach or report FAILURE.` };
    }

    if (this.consecutiveErrors >= L.errorTerminate) {
      return this.#terminate(
        `[LOOP DETECTED] ${this.consecutiveErrors} consecutive tool calls returned errors. Stopping: report FAILURE with what you observed.`);
    }
    if (this.consecutiveErrors >= L.errorNudge && !this.nudged.errors) {
      this.nudged.errors = true;
      return { action: 'nudge',
        message: `[WARNING] ${this.consecutiveErrors} consecutive tool calls have returned errors. If the task cannot be completed, report FAILURE with what you've observed.` };
    }

    // The semantic warning alone is easy to ignore: one run made 20 more searches after it. So it has
    // a stop threshold too.
    if (nameCount >= L.semanticTerminate) {
      return this.#terminate(
        `[LOOP DETECTED] You have called ${toolName} ${nameCount} times this turn with varying arguments and have not converged. Stopping.\n`
        + 'Report what you established and what remains unknown: a partial, honest result is worth more than another variation on the same search.\n'
        + `[STUCK REPORT] ${JSON.stringify({ stuck_tool: toolName, distinct_calls: this.callCounts.size, total_calls: this.totalCalls() })}`);
    }
    if (nameCount >= L.semanticNudge && !this.nudged.semantic) {
      this.nudged.semantic = true;
      return { action: 'nudge',
        message: `[WARNING] You have called ${toolName} ${nameCount} times this turn (with varying arguments). You may be stuck in a semantic loop. Consider a completely different strategy or report FAILURE.` };
    }
    return { action: 'ok' };
  }

  totalCalls() {
    let n = 0;
    for (const c of this.callCounts.values()) n += c;
    return n;
  }

  getMetrics() {
    let duplicateCalls = 0;
    for (const c of this.callCounts.values()) if (c > 1) duplicateCalls += c;
    return {
      totalCalls: this.totalCalls(),
      uniqueSignatures: this.callCounts.size,
      duplicateCalls,
      consecutiveErrors: this.consecutiveErrors,
      terminated: this.terminated,
    };
  }

  #terminate(message) {
    this.terminated = true;
    return { action: 'terminate', message };
  }
}
