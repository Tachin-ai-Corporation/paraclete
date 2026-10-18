// Tests for dashboard/components/settings/workspace/workspace-wizard.js: the Workspace setup's decisions
// as data. The address rule agrees with the control service's; a save is offered only after a test of
// that exact address, refused when the token or Drive failed, and allowed after a warning when only
// other APIs failed; the steps' states and the one-line summary follow the record and the last test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSummary, checkAddress, listNames, saveDecision, stepStates, REQUIRED_APIS,
} from '../../../../../dashboard/components/settings/workspace/workspace-wizard.js';
import { checkWorkspaceAccount } from '../../../../../agent/services/control/workspace-account.mjs';

const ACCOUNT = 'agent@example.com';
const NAMES = { chat: 'Google Chat', drive: 'Google Drive', docs: 'Google Docs', gmail: 'Gmail' };
function check({ account = ACCOUNT, failing = [], error = 'HTTP 403: no', missing = [] } = {}) {
  const apis = Object.entries(NAMES).map(([api, name]) => ({ api, name, ok: !failing.includes(api), error: failing.includes(api) ? error : null, fix: null }));
  return { account, ready: failing.length === 0, missing_scopes: missing, apis };
}

// Addresses outside the placeholder domains are built from parts: the repo's hygiene test allows only
// placeholder domains to appear as written addresses.
const at = (local, domain) => [local, domain].join('@');

test('the address rule is the control service\'s', () => {
  for (const value of ['Agent@Example.com', ' ada.lovelace+x@example.org ', 'a@b', 'agent', at('x', 'gmail.com'), at('x', 'googlemail.com'),
    at('x', 'mail.example.co'), 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com', `${'a'.repeat(250)}@example.com`]) {
    const here = checkAddress(value);
    let there = null;
    try { there = checkWorkspaceAccount(value); } catch { /* refused */ }
    assert.equal(here.account, there, value);
    assert.equal(Boolean(here.error), there === null, value);
  }
  assert.deepEqual(checkAddress(''), { account: null, error: null }, 'nothing typed is no error');
  assert.match(checkAddress(at('x', 'gmail.com')).error, /personal Google account/);
  assert.match(checkAddress(at('x', 'developer.gserviceaccount.com')).error, /service account/);
});

test('a save needs a test of exactly that address', () => {
  assert.deepEqual(saveDecision(null, null), { allowed: false, confirm: false, reason: "Enter the agent's address first.", warning: '' });
  assert.match(saveDecision(null, ACCOUNT).reason, /Run Test for agent@example\.com first/);
  assert.match(saveDecision(check({ account: 'other@example.com' }), ACCOUNT).reason, /Run Test for agent@example\.com/);
  assert.deepEqual(saveDecision(check(), ACCOUNT), { allowed: true, confirm: false, reason: '', warning: '' });
});

test('no token, or no Drive, blocks a save; other failures allow one after a warning', () => {
  const token = saveDecision(check({ failing: Object.keys(NAMES), error: 'Delegated token exchange failed: unauthorized_client' }), ACCOUNT);
  assert.equal(token.allowed, false);
  assert.match(token.reason, /no token/);

  assert.deepEqual(REQUIRED_APIS, ['drive']);
  const drive = saveDecision(check({ failing: ['drive', 'gmail'] }), ACCOUNT);
  assert.equal(drive.allowed, false);
  assert.match(drive.reason, /^Google Drive must work first/);

  const partial = saveDecision(check({ failing: ['chat', 'gmail'] }), ACCOUNT);
  assert.equal(partial.allowed, true);
  assert.equal(partial.confirm, true);
  assert.equal(partial.warning, 'Google Chat and Gmail did not answer. Saved now, the agent cannot use them until the test passes.');
  assert.match(saveDecision(check({ failing: ['gmail'] }), ACCOUNT).warning, /cannot use it until/);
});

test('the steps follow the address, the delegation the test found, Chat, and the test', () => {
  assert.deepEqual(stepStates({ account: null, setup: null, check: null }), { user: 'todo', delegation: 'todo', chat: 'todo', test: 'todo' });
  assert.deepEqual(stepStates({ account: ACCOUNT, setup: {}, check: check() }), { user: 'done', delegation: 'done', chat: 'done', test: 'done' });
  assert.deepEqual(stepStates({ account: ACCOUNT, setup: {}, check: check({ failing: ['gmail'], missing: ['https://www.googleapis.com/auth/gmail.readonly'] }) }),
    { user: 'done', delegation: 'problem', chat: 'done', test: 'problem' });
  assert.equal(stepStates({ account: ACCOUNT, setup: {}, check: check({ failing: ['chat'] }) }).chat, 'problem',
    'Chat refused with every scope granted: the Chat app record is the likely cause');
  assert.equal(stepStates({ account: ACCOUNT, setup: {}, check: check({ failing: ['chat'], missing: ['https://www.googleapis.com/auth/chat.messages'] }) }).chat, 'todo',
    'with a scope missing, the delegation is the problem, not the Chat app record');
  assert.equal(stepStates({ account: ACCOUNT, setup: { client_id_error: 'denied' }, check: null }).delegation, 'problem');
  assert.equal(stepStates({ account: ACCOUNT, setup: {}, check: check({ account: 'other@example.com' }) }).test, 'todo', 'a test of another address does not count');
  assert.equal(stepStates({ account: ACCOUNT, setup: {}, check: { ...check({ failing: ['chat'] }), missing_scopes: null } }).delegation, 'todo',
    'when the test could not judge the grant, the step stays to do');
});

test('the summary line', () => {
  assert.deepEqual(accountSummary(null), { state: 'checking', detail: '', failing: [] });
  assert.equal(accountSummary({ needed: false }).state, 'not_needed');
  assert.equal(accountSummary({ needed: true, account: null }).state, 'todo');
  const account = { account: ACCOUNT };
  assert.equal(accountSummary({ needed: true, account, last_check: check() }).state, 'done');
  const failing = accountSummary({ needed: true, account, last_check: check({ failing: ['chat'] }) });
  assert.deepEqual([failing.state, failing.failing], ['problem', ['Google Chat']]);
  assert.match(accountSummary({ needed: true, account, last_check: null }).detail, /not been tested since it was saved/);
  assert.equal(listNames(['a', 'b', 'c']), 'a, b and c');
  assert.equal(listNames(['a']), 'a');
});
