// Tests for agent/work/agent-output.mjs. detectMotorFailure matches a failure pattern anywhere in
// the motor's output, which over-fires when a multi-command task has one sub-command error but the
// motor recovers and produces the full deliverable. isRecoveredToolError tells that recovered
// incident (annotate, let the cerebellum arbitrate) from a real outcome failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMotorFailure, isRecoveredToolError, toolLogShowsRetryRecovery, isDeliveryCriticalIntent,
} from '../../../agent/work/agent-output.mjs';

const answerOf = (text) => text.replace(/\[TOOL EXECUTION LOG\][\s\S]*/, '').trim();
const logOf = (text) => text.match(/\[TOOL EXECUTION LOG\][\s\S]*/)[0];

// A discovery that recovered: a substantive clean answer, the failure confined to one tool-log line
// (a fragile count command), and a follow-up command that got the data anyway.
const RECOVERED = `## Infrastructure Discovery

I completed the read-only discovery of the project. Compute Engine instances: vm-alpha (RUNNING) and vm-beta (RUNNING). IAM service accounts: 18 total, including runtime-sa and chatbot-sa. The first firewall count attempt did not work, so I listed the rules directly and counted 7 firewall rules.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"gcloud compute instances list"}) → vm-alpha RUNNING
vm-beta RUNNING
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list --format=value(name) | wc -l"}) → Error: command failed (exit code 2): bad quoting near unexpected token
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list"}) → default-allow-ssh
default-allow-icmp
default-allow-internal
[END TOOL LOG]`;

// An action task (a deploy) that recovered by retry: the deliverable is the successful action, so
// the prose answer is legitimately short; recovery is proven by the tool log alone.
const DEPLOY_RETRY = `Deployed the site to the staging preview channel and captured the URL.

---
[TOOL EXECUTION LOG]
[TOOL] runCommand({"command":"firebase hosting:channel:deploy staging --cwd=/x"}) → Error: command failed: unknown option --cwd
[TOOL] runCommand({"command":"cd /x && firebase hosting:channel:deploy staging"}) → Channel URL: https://marketing-site--staging-abc123.web.app [expires 7d]
[END TOOL LOG]`;

// The same discovery, but the failed command is the terminal tool call (no later success), so the
// log shows no retry recovery and only the answer-length path can recover it.
const RECOVERED_NORETRY = `## Infrastructure Discovery

I completed the read-only discovery. Compute Engine instances: vm-alpha (RUNNING) and vm-beta (RUNNING). IAM service accounts: 18 total. I attempted a firewall count last but the command did not work; the rest of the discovery is complete and reported above at length so this answer clears the minimum-length gate for the isolated test below.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"gcloud compute instances list"}) → vm-alpha RUNNING
vm-beta RUNNING
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list --format=value(name) | wc -l"}) → Error: command failed (exit code 2): bad quoting near unexpected token
[END TOOL LOG]`;

describe('detectMotorFailure: strict', () => {
  it('flags a bare "Error: command failed" as an exit_code failure', () => {
    const r = detectMotorFailure('Error: command failed (exit code 1)');
    assert.equal(r.failed, true);
    assert.equal(r.type, 'exit_code');
  });
  it('flags [ERROR] Permission denied as an auth failure', () => {
    const r = detectMotorFailure('[ERROR] Permission denied while calling the API');
    assert.equal(r.failed, true);
    assert.equal(r.type, 'auth');
  });
  it('flags an expired delegation token, whatever the prefix', () => {
    const r = detectMotorFailure('Error: DWD token expired. Authentication failed.');
    assert.equal(r.failed, true);
    assert.equal(r.type, 'auth');
    assert.equal(detectMotorFailure('Fatal: PERMISSION_DENIED on drive.files.get').type, 'auth');
  });
  it('passes clean output through as not failed', () => {
    assert.deepEqual(detectMotorFailure('File created successfully.'), { failed: false, type: null, detail: '' });
    assert.equal(detectMotorFailure('Discovery complete. 18 service accounts found.').failed, false);
    assert.equal(detectMotorFailure(null).failed, false);
  });
  it('a failure word without an error prefix is not a failure', () => {
    assert.equal(detectMotorFailure('The docs say the command failed once in 2024.').failed, false);
  });
  it('still fires on the recovered text (the reason isRecoveredToolError is needed)', () => {
    assert.equal(detectMotorFailure(RECOVERED).failed, true);
  });
});

describe('isRecoveredToolError: recovered incident vs outcome failure', () => {
  it('true: failure confined to the tool log, with a substantive clean answer beside it', () => {
    assert.equal(isRecoveredToolError(RECOVERED), true);
  });

  it('false: no tool log at all, so the failure is the answer', () => {
    assert.equal(isRecoveredToolError('Error: command failed (exit code 1)'), false);
  });

  it('false: a thin answer (below minAnswerChars) even though the failure is in the log', () => {
    const thin = 'Done.\n\n---\n[TOOL EXECUTION LOG]\n[TOOL] shell({"cmd":"x"}) → Error: command failed\n[END TOOL LOG]';
    assert.equal(isRecoveredToolError(thin), false);
  });

  it('false: the answer prose itself declares the failure', () => {
    const declared = 'I attempted the discovery but Error: command failed on the primary listing and I could '
      + 'not recover from it. Here is a long explanation of everything I tried and why none of it worked, '
      + 'written out at length so the answer clears the minimum-length gate and we isolate this branch.\n\n'
      + '---\n[TOOL EXECUTION LOG]\n[TOOL] shell({"cmd":"x"}) → Error: command failed\n[END TOOL LOG]';
    assert.ok(answerOf(declared).length >= 200, 'the fixture answer is long enough');
    assert.equal(isRecoveredToolError(declared), false);
  });

  it('false: a clean tool log with no failure in it (nothing to recover from)', () => {
    const clean = RECOVERED.replace(/Error: command failed[^\n]*/, 'default-deny-all');
    assert.equal(detectMotorFailure(logOf(clean)).failed, false);
    assert.equal(isRecoveredToolError(clean), false);
  });

  it('answer-length gate: an impossibly high bar defeats the answer path when the log shows no retry', () => {
    assert.equal(isRecoveredToolError(RECOVERED_NORETRY, { minAnswerChars: 100000 }), false);
    assert.equal(isRecoveredToolError(RECOVERED_NORETRY), true, 'the default bar: its long answer recovers it');
  });
});

describe('retry recovery: a failed command superseded by a later success (action tasks)', () => {
  it('isRecoveredToolError is true for a short answer when the log shows the deploy retried and succeeded', () => {
    assert.ok(answerOf(DEPLOY_RETRY).length < 200, 'the fixture answer is short');
    assert.equal(detectMotorFailure(DEPLOY_RETRY).failed, true, 'the failed --cwd attempt still trips detection');
    assert.equal(isRecoveredToolError(DEPLOY_RETRY), true);
  });
  it('toolLogShowsRetryRecovery is true when a non-failing call follows the last failing one', () => {
    assert.equal(toolLogShowsRetryRecovery(logOf(DEPLOY_RETRY)), true);
  });
  it('toolLogShowsRetryRecovery is false when the terminal call failed (no recovery)', () => {
    assert.equal(toolLogShowsRetryRecovery(logOf(RECOVERED_NORETRY)), false);
  });
  it('toolLogShowsRetryRecovery is false with fewer than two tool entries', () => {
    assert.equal(toolLogShowsRetryRecovery('[TOOL EXECUTION LOG]\n[TOOL] x() → Error: command failed\n[END TOOL LOG]'), false);
  });
});

// A delivery-critical task (deploy, publish, promote) must not soft-pass a failed command on prose
// length alone: confident narrative is not a deployed artifact. It still soft-passes on proven
// retry recovery (the deploy actually succeeded on a second attempt).
describe('isDeliveryCriticalIntent', () => {
  it('true for deploy, publish, promote, release, go live, push to production, firebase deploy', () => {
    for (const s of [
      'Deploy the site to the staging channel.',
      'Publish the updated docs to the site.',
      'Promote staging to production.',
      'Cut a release of the package.',
      'Take the feature go live for all users.',
      'Push to production once approved.',
      'Run firebase deploy for the hosting target.',
      'Update the deployment and share the URL.',
    ]) assert.equal(isDeliveryCriticalIntent(s), true, s);
  });
  it('false for tasks with no delivery verb', () => {
    for (const s of [
      'Summarize the meeting notes into three bullets.',
      'Edit index.html to add a noindex meta tag.',
      'Gather the last three missions for each project.',
      '',
      null,
    ]) assert.equal(isDeliveryCriticalIntent(s), false, String(s));
  });
});

describe('isRecoveredToolError requireActionRecovery: the delivery-critical soft-pass gate', () => {
  // A failed deploy whose motor wrote a long confident narrative but never retried: the
  // answer-length path would soft-pass it into a false complete. requireActionRecovery closes that.
  const DEPLOY_FAIL_LONG_PROSE = 'I have completed the deployment of the site to the staging preview channel. '
    + 'The build compiled cleanly, assets were uploaded, and the hosting configuration was applied as specified. '
    + 'Everything looks good and the site should now be live on the staging URL for review by the team.\n\n'
    + '---\n[TOOL EXECUTION LOG]\n'
    + '[TOOL] runCommand({"command":"firebase hosting:channel:deploy staging"}) → Error: command failed (exit code 1): HTTP Error: 403, permission denied\n'
    + '[END TOOL LOG]';

  it('default (not delivery-critical): long prose beside a tool-log failure recovers', () => {
    assert.ok(answerOf(DEPLOY_FAIL_LONG_PROSE).length >= 200);
    assert.equal(isRecoveredToolError(DEPLOY_FAIL_LONG_PROSE), true);
  });
  it('requireActionRecovery: the same failed deploy no longer soft-passes on prose length', () => {
    assert.equal(isRecoveredToolError(DEPLOY_FAIL_LONG_PROSE, { requireActionRecovery: true }), false);
  });
  it('requireActionRecovery: a deploy that retried and succeeded still recovers', () => {
    assert.equal(isRecoveredToolError(DEPLOY_RETRY, { requireActionRecovery: true }), true);
  });
});
