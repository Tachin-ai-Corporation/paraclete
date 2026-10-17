// Tests for install/lib/run.sh: a dry run prints the exact command and runs nothing; a real run prints
// and runs it, and a failure stops the script; printed commands split back into the same words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bashWith, needsBash, repoRoot, shellWords } from '../harness.mjs';

const lib = join(repoRoot, 'install', 'lib', 'run.sh').replace(/\\/g, '/');

/** Runs a bash snippet after sourcing run.sh; words are "${words[@]}". */
function sh(snippet, { words = [], env = {}, input = '' } = {}) {
  return bashWith(`source "${lib}"; ${snippet}`, words, { env, input });
}

test('shell_quote leaves safe words bare and single-quotes the rest', { skip: needsBash }, () => {
  const words = ['gcloud', '--database=(default)', "it's", '--name=Ada Lovelace', '', '--x=a,b:c/d@e%f+g'];
  const quoted = sh('shell_quote "${words[@]}"', { words }).stdout;
  assert.equal(quoted, "gcloud '--database=(default)' 'it'\\''s' '--name=Ada Lovelace' '' --x=a,b:c/d@e%f+g");
  assert.deepEqual(shellWords(quoted), words);
});

test('the printed line runs the same words in a shell', { skip: needsBash }, () => {
  const words = ["it's", 'two words', '(default)', '$HOME', '*', 'back\\slash'];
  const printed = sh('shell_quote "${words[@]}"', { words }).stdout;
  const echoed = sh(`printf '%s\\n' ${printed}`).stdout;
  assert.deepEqual(echoed.split('\n').slice(0, -1), words);
});

test('a dry run prints the command and does not run it', { skip: needsBash }, () => {
  const result = sh("run printf 'ran %s' x; run_retry printf 'ran %s' y", { env: { DRY_RUN: '1' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "+ printf 'ran %s' x\n+ printf 'ran %s' y\n");
});

test('a real run prints the command, then runs it', { skip: needsBash }, () => {
  const result = sh("run printf 'ran %s\\n' x", { env: { DRY_RUN: '0' } });
  assert.equal(result.stdout, "+ printf 'ran %s\\n' x\nran x\n");
});

test("a command never reads the loop's input it runs in", { skip: needsBash }, () => {
  const result = sh('while read -r line; do run cat; echo "line $line"; done <<<"$(printf "a\\nb")"', { env: { DRY_RUN: '0' } });
  assert.equal(result.stdout, '+ cat\nline a\n+ cat\nline b\n');
});

test('a failed command stops the script and names the command', { skip: needsBash }, () => {
  const result = sh('run false; echo after', { env: { DRY_RUN: '0' } });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /after/);
  assert.match(result.stderr, /this command failed: false/);
});

test('run_retry tries again before giving up', { skip: needsBash }, () => {
  const result = sh('n=0; flaky() { n=$((n + 1)); ((n >= 3)); }; run_retry flaky; echo "tries $n"', {
    env: { DRY_RUN: '0', RETRY_DELAY_SECONDS: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tries 3/);
  const giveUp = sh('run_retry false', { env: { DRY_RUN: '0', RETRY_DELAY_SECONDS: '0', RETRY_ATTEMPTS: '2' } });
  assert.equal(giveUp.status, 1);
  assert.match(giveUp.stderr, /failed 2 times/);
});

test('ask takes the default on an empty answer or no input; confirm needs a yes', { skip: needsBash }, () => {
  assert.equal(sh('ask "Role?" generic', { input: '\n' }).stdout, 'generic\n');
  assert.equal(sh('ask "Role?" generic', { input: '' }).stdout, 'generic\n');
  assert.equal(sh('ask "Role?" generic', { input: 'designer\n' }).stdout, 'designer\n');
  for (const [answer, status] of [['y', 0], ['YES', 0], ['n', 1], ['', 1], ['yes please', 1]]) {
    assert.equal(sh('confirm "Go?"', { input: `${answer}\n` }).status, status, `answer ${JSON.stringify(answer)}`);
  }
});
