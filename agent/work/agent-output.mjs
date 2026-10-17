// agent/work/agent-output.mjs: reads a motor response (motor is the organ that executes tasks with
// tools) for failure: does it report a failed command, did the motor recover from it, and is the
// task one whose command is the deliverable. Judging whether the checkpoint's milestone was met is
// the cerebellum's job. Called by the checkpoint executor on motor results only.

import { toStr } from '../providers/to-str.mjs';

// Motor failure patterns. The error prefix accepts every form motor output actually uses: shell
// tools emit `[<tool>] [ERROR] …`, tool-runner failures emit `Error: …`, and unhandled throws emit
// `Fatal: …`. The `/i` flag also covers the lowercase and `ERROR:` variants. Anchoring on
// `[ERROR]` alone silently missed `Error:`-prefixed auth failures.
const ERR_PREFIX = String.raw`(?:\[ERROR\]|Error:|Fatal:)`;
const MOTOR_FAILURE_PATTERNS = [
  { pattern: new RegExp(`${ERR_PREFIX}.*DWD token expired`, 'i'), type: 'auth', detail: 'DWD token expired' },
  { pattern: new RegExp(`${ERR_PREFIX}.*Permission denied`, 'i'), type: 'auth', detail: 'Permission denied' },
  { pattern: new RegExp(`${ERR_PREFIX}.*PERMISSION_DENIED`, 'i'), type: 'auth', detail: 'API permission denied' },
  { pattern: new RegExp(`${ERR_PREFIX}.*Authentication error`, 'i'), type: 'auth', detail: 'Authentication error' },
  { pattern: new RegExp(`${ERR_PREFIX}.*exit code [1-9]\\d*`, 'i'), type: 'exit_code', detail: 'Non-zero exit code' },
  { pattern: new RegExp(`${ERR_PREFIX}.*command failed`, 'i'), type: 'exit_code', detail: 'Command failed' },
];

/**
 * Detect motor-specific failures in agent output. Only call it on motor responses.
 *
 * @param {*} output - Agent response text or object
 * @returns {{ failed: boolean, type: 'auth'|'exit_code'|null, detail: string }}
 */
export function detectMotorFailure(output) {
  const text = toStr(output);
  for (const { pattern, type, detail } of MOTOR_FAILURE_PATTERNS) {
    if (pattern.test(text)) {
      return { failed: true, type, detail };
    }
  }
  return { failed: false, type: null, detail: '' };
}

/**
 * Is a detected motor failure the task outcome, or a sub-command error the motor recovered from?
 *
 * A multi-command motor task can have one command emit "command failed" in its tool log and still
 * finish, writing the full deliverable as its prose answer. detectMotorFailure matches the failure
 * pattern anywhere in the combined output, so it flips such a task to failed; the checkpoint then
 * fails and the mission is reported `blocked` with a complete answer inside it. That happened: a
 * discovery that gathered every service account and instance was blocked because one count command
 * printed "command failed".
 *
 * The failure is the outcome only when its marker is in the motor's answer (the prose outside the
 * [TOOL EXECUTION LOG]) or there is no substantive answer. A marker confined to the tool log, with
 * a real deliverable beside it, is a recovered incident: the caller should annotate it and let the
 * cerebellum's checkpoint verification arbitrate, not hard-fail the task.
 *
 * Conservative: returns true (recovered) only when all hold: (1) the output has a tool-log block,
 * (2) a substantive answer sits outside it (>= minAnswerChars), (3) that answer does not itself
 * trip a failure pattern, and (4) the failure pattern is inside the tool-log block. Every other
 * shape returns false, preserving the strict hard-fail.
 *
 * @param {*} output - the motor's full response (prose answer + tool log)
 * @param {{minAnswerChars?: number, requireActionRecovery?: boolean}} [opts]
 *   requireActionRecovery: for a delivery-critical task (deploy, publish, promote), confident prose
 *   is not the deliverable, so the answer-length recovery path is disabled. Recovery then requires
 *   proof the action itself succeeded on a retry (a non-failing tool call after the last failing
 *   one). Without this, a failed deploy with a long narrative soft-passes into a false complete (a
 *   deploy once hit HTTP 404 and the mission still reported success).
 * @returns {boolean}
 */
export function isRecoveredToolError(output, { minAnswerChars = 200, requireActionRecovery = false } = {}) {
  const text = toStr(output);
  const logRe = /\[TOOL EXECUTION LOG\][\s\S]*?(?:\[END TOOL LOG\]|$)/;
  const logMatch = text.match(logRe);
  if (!logMatch) return false;                              // no tool log: any failure is the answer
  const answer = text.replace(new RegExp(logRe, 'g'), '').trim();
  if (detectMotorFailure(answer).failed) return false;      // the answer itself declares failure
  if (!detectMotorFailure(logMatch[0]).failed) return false; // the failure isn't in the tool log
  // Recovered when either a substantive deliverable sits outside the log (a discovery's prose
  // answer), or the tool log shows the motor retried past the failure: a non-failing tool call
  // after the last failing one means the failed command was superseded (an action task's
  // deliverable is the successful action, so its prose answer is legitimately short). In both
  // cases the task is not hard-failed; checkpoint verification still arbitrates the milestone
  // against its criteria, so this only spares the wasteful hard-fail and re-plan. A
  // delivery-critical task never recovers on prose length alone, only on proven action recovery.
  if (!requireActionRecovery && answer.length >= minAnswerChars) return true;
  return toolLogShowsRetryRecovery(logMatch[0]);
}

/**
 * Does the tool log show recovery by retry: a successful tool call after the last failing one?
 * Entries render as `[TOOL] name(args) → result`; a failing entry's result trips
 * detectMotorFailure. If the last failing entry is followed by a non-failing entry, the motor
 * retried and the retry stuck. Fewer than two entries, or a failure at the terminal entry, returns
 * false (no evidence of recovery).
 *
 * @param {string} log - the [TOOL EXECUTION LOG] block
 * @returns {boolean}
 */
export function toolLogShowsRetryRecovery(log) {
  const entries = toStr(log).split(/(?=\[TOOL\]\s)/).map((s) => s.trim()).filter((e) => e.startsWith('[TOOL]'));
  if (entries.length < 2) return false;
  let lastFail = -1, lastOk = -1;
  entries.forEach((e, i) => { if (detectMotorFailure(e).failed) lastFail = i; else lastOk = i; });
  return lastFail >= 0 && lastOk > lastFail;
}

/**
 * Is a task's core action a publish, deploy, promote or release: one where the command is the
 * deliverable? For such a task a motor-reported command failure is the outcome, not a recovered
 * sub-command incident: there is no deliverable if the publish itself failed. The recovered-tool-
 * error soft pass must not spare it, because a failed deploy that still produced confident prose is
 * exactly how a false complete slips through.
 *
 * Matches distinctive delivery verbs as word-boundary tokens and errs toward true (a task that
 * merely mentions deploy, publish or promote is treated as delivery-critical). That only costs a
 * benign task the prose-length soft pass on a genuine motor failure, never correctness, so the
 * strict side is the safe side.
 *
 * @param {string} instruction - the task instruction text
 * @returns {boolean}
 */
export function isDeliveryCriticalIntent(instruction) {
  const text = toStr(instruction).toLowerCase();
  if (!text) return false;
  const patterns = [
    /\bdeploy(?:ing|ed|ment|s)?\b/,
    /\bpublish(?:ing|ed|es)?\b/,
    /\bpromot(?:e|ing|ed|ion)\b/,
    /\brelease(?:d|s|ing)?\b/,
    /\brollout\b/,
    /\broll\s+out\b/,
    /\bgo\s+live\b/,
    /\bpush\s+to\s+(?:prod|production|live|staging)\b/,
    /\bfirebase\s+(?:deploy|hosting)\b/,
    /\bhosting:channel\b/,
  ];
  return patterns.some((re) => re.test(text));
}
