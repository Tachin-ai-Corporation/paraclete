// agent/work/task-outcome.mjs: reads one task's dispatch result before the checkpoint executor
// records it: whether a motor failure is the task's outcome or an error the motor recovered from,
// what the retry should be told after a reply cut at the token limit or a timeout, and the evidence
// warnings a suspiciously thin success earns. Pure; the patterns that spot a failed command live in
// agent-output.mjs, and judging the checkpoint's milestone is the cerebellum's job. Called by the
// checkpoint executor.
//
// A dispatch result is the brain's callAgent shape: { success, output, error, durationMs,
// finishReason?, timedOut? }. Every function here returns a new result and never mutates its input.

import { toStr } from '../providers/to-str.mjs';
import { detectMotorFailure, isRecoveredToolError, isDeliveryCriticalIntent } from './agent-output.mjs';

const TOOL_LOG = /\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/;

// A durable change the agent made: a file written, a commit, a file handed back or stored, a
// memory write. A thin success that made one of these is not suspicious, whatever its speed.
const DURABLE_WRITE = /\bwriteFile\b|\bwriteMemoryFile\b|\bmemoryCommand\b|\bgit\s+(?:commit|push)\b|\bgit-store\s+push\b|\bdrive-(?:put|update)\b|\bfile-(?:make|convert|share)\b|\bcore-memory-(?:write|retire)\b|\bupdate-deep-truths\b/i;

// Errors a tool log can carry while the organ still reports success.
const LOG_ERRORS = /ERROR:|No such file|command not found|Permission denied/i;

// The evidence floor: a motor success faster than this, with this few tool calls and no durable
// write, did very little. Defaults; no contracts key carries them.
const FLOOR_MAX_MS = 8000;
const FLOOR_MAX_TOOLS = 2;

const TRUNCATION_NUDGE = '\n\n[TRUNCATION] Your previous reply hit the token limit. Do NOT paste large content (logs, full file contents, big JSON) into your response — write it to a file in your workspace and return only a concise summary plus the file path.';

// A timeout is not a wrong-argument failure. The generic "investigate why it failed" frame sends the
// organ hunting for a bug that isn't there when the real problem is batch size, and some of the work
// may already have landed, so blind repetition duplicates it: one retry downloaded every contract a
// second time under a new name after the first attempt was aborted.
const TIMEOUT_NUDGE = '\n\n[TIMEOUT] The previous attempt did not finish inside its time budget — treat its outcome as UNKNOWN, not failed. Work may already be partly done: re-check current state first (list the folder, check whether the output already exists) and skip what is already there. Then do the remainder in smaller batches — one file or id per command, never a loop over many.';

/**
 * True when a tool log shows a durable write.
 *
 * @param {string} toolLog
 * @returns {boolean}
 */
export function isDurableWrite(toolLog) {
  return DURABLE_WRITE.test(toStr(toolLog));
}

/**
 * Applies the motor failure check. A failed command in a motor result is the task's outcome (the
 * task fails) unless the motor recovered from it and still produced the deliverable: then it is an
 * incident, annotated for the cerebellum to weigh, and the task stands. Without this, a discovery
 * that gathered everything was reported blocked because one command in its tool log printed
 * "command failed".
 *
 * A delivery-critical task (deploy, publish, promote) never recovers on the length of its prose: a
 * failed deploy is a real failure. It recovers only when the tool log shows the action itself
 * succeeding on a later attempt. One deploy hit HTTP 404 and the mission still reported success.
 *
 * Other organs pass through untouched.
 *
 * @param {object} result - a dispatch result
 * @param {object} p
 * @param {string} p.organ    - the organ that ran the task
 * @param {string} p.taskText - the task instruction
 * @returns {{result: object, recoveredFrom: string|null}}
 */
export function applyMotorCheck(result, { organ, taskText }) {
  if (organ !== 'motor') return { result, recoveredFrom: null };
  const check = detectMotorFailure(result.output || result.error || '');
  if (!check.failed) return { result, recoveredFrom: null };
  const requireActionRecovery = isDeliveryCriticalIntent(taskText);
  if (isRecoveredToolError(result.output || '', { requireActionRecovery })) {
    return {
      result: {
        ...result,
        output: `${result.output || ''}\n[EVIDENCE WARNING: a tool call reported "${check.detail}" during this task; the motor recovered and produced a result. Verify the final answer is complete and accounts for that error.]`,
      },
      recoveredFrom: check.detail,
    };
  }
  return { result: { ...result, success: false, error: check.detail }, recoveredFrom: null };
}

/**
 * Readies a first attempt for its one retry. A reply cut at the token limit (finishReason 'length')
 * counts as failed, so the retry fires, and is told to write large content to a file; a timeout is
 * told its outcome is unknown and to continue in smaller batches. Only the first attempt is read
 * this way: a retry's own truncation is left for the cerebellum to judge.
 *
 * @param {object} result - the first attempt's dispatch result
 * @returns {{result: object, nudges: string}} the result to judge, and text for the retry instruction
 */
export function prepareRetry(result) {
  let next = result;
  let nudges = '';
  if (result.finishReason === 'length') {
    next = {
      ...result,
      success: false,
      error: `${result.error ? `${result.error} ` : ''}[OUTPUT TRUNCATED AT TOKEN LIMIT]`,
    };
    nudges += TRUNCATION_NUDGE;
  }
  if (/timed?\s?out/i.test(next.error || '')) nudges += TIMEOUT_NUDGE;
  return { result: next, nudges };
}

/**
 * Appends the evidence warnings a motor success earns: one for a task that finished very quickly
 * with almost no tool use and no durable write, and one for a tool log that carries errors the
 * organ did not acknowledge. The cerebellum reads them; they never fail a task by themselves.
 *
 * @param {object} result - a dispatch result
 * @param {object} p
 * @param {string} p.organ
 * @returns {{result: object, warnings: string[]}}
 */
export function withEvidenceWarnings(result, { organ }) {
  if (!result.success || organ !== 'motor') return { result, warnings: [] };
  const text = toStr(result.output) || result.text || '';
  const toolLog = text.match(TOOL_LOG)?.[1] || '';
  const toolCount = (toolLog.match(/\[TOOL\]/g) || []).length;
  const warnings = [];
  if ((result.durationMs || 0) < FLOOR_MAX_MS && toolCount <= FLOOR_MAX_TOOLS && !isDurableWrite(toolLog)) {
    warnings.push('[EVIDENCE WARNING: Task completed very quickly with minimal tool usage and no write operations. Verify that meaningful work was performed.]');
  }
  if (LOG_ERRORS.test(toolLog) && !/\[WARNING: One or more tool calls returned errors/.test(text)) {
    warnings.push('[EVIDENCE WARNING: Tool execution log contains errors despite SUCCESS status.]');
  }
  if (warnings.length === 0) return { result, warnings };
  return { result: { ...result, output: `${result.output || ''}\n${warnings.join('\n')}` }, warnings };
}
