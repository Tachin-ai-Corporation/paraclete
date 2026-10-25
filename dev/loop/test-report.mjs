// dev/loop/test-report.mjs: which tests failed, read from the output of node's test runner, which ends
// a failing run with a "✖ failing tests:" block. When a loop cycle refuses a change for failing the
// suite, it names these tests on the issue and in its cycle record, so the next attempt knows what
// broke. It reads text only and runs nothing. Called by cycle.mjs.

/** How much of a report is kept: failures listed, and the length of each name and message. */
export const REPORT_LIMITS = Object.freeze({ failures: 10, name: 200, message: 300 });

const MESSAGE_LINES = 3;
const DURATION = /\s+\([\d.]+m?s\)$/;
const LOCATION = /^test at (.+):(\d+):\d+$/;

/**
 * The failing tests in a run's output, in the order the runner printed them. `file` and `line` are null
 * when it printed no location; `message` is the start of what the failure printed.
 *
 * @param {string} output  the run's stdout and stderr
 * @returns {{ file: string|null, line: number|null, name: string, message: string }[]}
 */
export function failingTests(output) {
  const text = String(output || '').replace(/\r\n/g, '\n');
  const at = text.lastIndexOf('✖ failing tests:');
  if (at < 0) return [];
  const failures = [];
  let location = null;
  let current = null;
  let lines = [];
  const close = () => {
    if (current) current.message = lines.join(' / ').slice(0, REPORT_LIMITS.message);
  };
  for (const line of text.slice(at).split('\n').slice(1)) {
    const where = LOCATION.exec(line.trim());
    if (where) {
      location = { file: where[1].replace(/\\/g, '/'), line: Number(where[2]) };
      continue;
    }
    if (line.startsWith('✖ ')) {
      close();
      current = { file: location?.file ?? null, line: location?.line ?? null, name: line.slice(2).replace(DURATION, '').slice(0, REPORT_LIMITS.name), message: '' };
      failures.push(current);
      location = null;
      lines = [];
      continue;
    }
    if (current && line.trim() && lines.length < MESSAGE_LINES) lines.push(line.trim());
  }
  close();
  return failures;
}

/**
 * The failures as Markdown list lines, at most `max` of them and a line for the rest.
 *
 * @param {object[]} failures  from failingTests
 * @param {number} [max]
 * @returns {string[]}
 */
export function failureLines(failures, max = REPORT_LIMITS.failures) {
  const shown = (failures || []).slice(0, max).map((f) => {
    const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : '';
    return `- ${where}${f.name}${f.message ? `: ${f.message}` : ''}`;
  });
  const rest = (failures || []).length - shown.length;
  return rest > 0 ? [...shown, `- and ${rest} more`] : shown;
}
