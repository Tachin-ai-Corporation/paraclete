// Tests for the development role's harness commands added for the loop: `harness-cycle --action health`
// hands its flags to the harness CLI's `health`, `harness-promote --action release-check` runs the
// repo's own release check without a dashboard, and both pass `--real-model` through where it applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as harnessCycle } from '../../../roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs';
import { main as harnessPromote } from '../../../roles/paraclete-h2/skills/harness-release/harness-promote.mjs';

function sink() {
  let text = '';
  return { write: (s) => { text += s; }, get text() { return text; } };
}

test('harness-cycle --action health runs the CLI health check with its flags', async () => {
  const calls = [];
  const h2 = { cli: { runCli: async (argv, deps) => { calls.push({ argv, deps }); return { ok: false, alarms: [{ key: 'stalled' }], markdown: '# Harness loop health: 1 alarm(s)\n' }; } } };
  const stdout = sink();
  const code = await harnessCycle(['--action', 'health', '--repo', '.', '--days', '3', '--open-issues', '--dry-run'], { h2, stdout, stderr: sink() });
  assert.equal(code, 1, 'an alarm is a failed check');
  assert.deepEqual(calls[0].argv, ['health', '--days', '3', '--open-issues', '--dry-run', '--markdown']);
  assert.match(stdout.text, /1 alarm\(s\)/);
});

test('harness-cycle --action curriculum passes --real-model and its caps to the CLI', async () => {
  const calls = [];
  const h2 = { cli: { runCli: async (argv) => { calls.push(argv); return { ok: true, curriculumUnit: { id: 'u' } }; } } };
  await harnessCycle(['--action', 'curriculum', '--repo', '.', '--real-model', '--max-rollouts', '40', '--push-pr'], { h2, stdout: sink(), stderr: sink() });
  assert.ok(calls[0].includes('--real-model'));
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--max-rollouts'), calls[0].indexOf('--max-rollouts') + 2), ['--max-rollouts', '40']);
});

test("harness-promote --action release-check runs the repo's release check without a dashboard", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-release-check-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const stderr = sink();
  assert.equal(await harnessPromote(['--action', 'release-check', '--repo', repo], { stdout: sink(), stderr }), 1);
  assert.match(stderr.text, /has no release check/);

  fs.mkdirSync(path.join(repo, 'dev'));
  fs.writeFileSync(path.join(repo, 'dev', 'release-check.mjs'), '');
  const runs = [];
  const spawn = (file, args, opts) => {
    runs.push({ args, cwd: opts.cwd });
    return { status: 0, stdout: '{"ok":true,"released":"v2027.01.21.1.1"}\n' };
  };
  const stdout = sink();
  assert.equal(await harnessPromote(['--action', 'release-check', '--repo', repo, '--dry-run'], { spawn, stdout, stderr: sink() }), 0);
  assert.deepEqual(runs[0].args.slice(1), ['--vm-only', '--json', '--no-release']);
  assert.equal(runs[0].cwd, repo);
  assert.match(stdout.text, /"released"/);
});
