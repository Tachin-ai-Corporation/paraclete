// dev/loop/command.mjs: runs a headless coding-agent command named in the developer's local settings
// (config.mjs LOCAL_SETTINGS), so the repo names no tool. It runs in a checkout with a prompt, within a
// wall-clock budget, and returns what the command printed. It decides nothing about the output: the
// proposer (proposer.mjs) and the reviewer (reviewer.mjs) read it. Called by those two.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The last line a command printed, to say why it failed. */
export function lastLine(output) {
  return String(output || '').trim().split('\n').pop()?.trim().slice(0, 300) || '';
}

/**
 * Runs `settings.command` with `settings.args` in `cwd`. In `args`, `{briefFile}` (the prompt written
 * to a temporary file), `{brief}`, `{worktree}`, `{maxTurns}` and `{maxTokens}` are replaced. With
 * `briefVia: 'stdin'` the prompt is written to the command's input. It is stopped after `wallMinutes`.
 *
 * @param {object} settings  { command, args, briefVia, env }
 * @param {object} run       { cwd, prompt, wallMinutes, maxTurns, maxTokens, who }: `who` names the
 *                           command in reasons ("the proposer")
 * @param {object} [deps]    { spawnFn } for tests
 * @returns {Promise<{ ok: boolean, exitCode: number|null, timedOut: boolean, output: string, reason: string|null }>}
 */
export async function runAgentCommand(settings, { cwd, prompt, wallMinutes, maxTurns, maxTokens, who }, { spawnFn = spawn } = {}) {
  const briefFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paraclete-loop-brief-')), 'brief.md');
  fs.writeFileSync(briefFile, prompt, 'utf8');
  const fill = (a) => String(a)
    .replaceAll('{briefFile}', briefFile)
    .replaceAll('{brief}', prompt)
    .replaceAll('{worktree}', cwd)
    .replaceAll('{maxTurns}', String(maxTurns))
    .replaceAll('{maxTokens}', String(maxTokens));
  const args = (settings.args || []).map(fill);
  try {
    return await new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      const child = spawnFn(settings.command, args, {
        cwd,
        env: { ...process.env, ...(settings.env || {}) },
        stdio: [settings.briefVia === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      const keep = (chunk) => {
        output = (output + chunk).slice(-200_000);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      if (settings.briefVia === 'stdin') child.stdin?.end(prompt);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, wallMinutes * 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, exitCode: null, timedOut: false, output, reason: `${who} command could not start: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          exitCode: code,
          timedOut,
          output,
          reason: timedOut
            ? `${who} ran past its ${wallMinutes} minutes`
            : code === 0 ? null : `${who} exited ${code}${lastLine(output) ? `: ${lastLine(output)}` : ''}`,
        });
      });
    });
  } finally {
    fs.rmSync(path.dirname(briefFile), { recursive: true, force: true });
  }
}
