// Tests for agent/services/control/workspace-send-as.mjs and the workspace_send_as command:
// creating and re-verifying custom Gmail Send-As aliases through Domain-Wide Delegation without
// interactive sign-in, handling 409 conflicts, missing scopes, and non-mail roles.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { manageWorkspaceSendAs } from '../../../../agent/services/control/workspace-send-as.mjs';
import { createHandlers } from '../../../../agent/services/control/commands.mjs';
import { createCommandQueue } from '../../../../agent/services/control/command-queue.mjs';
import { GMAIL_SETTINGS_SHARING, workspaceScopesFor } from '../../../../agent/auth/workspace-scopes.mjs';
import { fakeGoogle, ACCOUNT, PROJECT, SIGNER, VM_TOKEN } from './workspace-fakes.mjs';
import { fakeDb, fakeSystemd, fakeGatewayFetch, controlRuntime } from './fakes.mjs';

const SUPPORT_INSTANCE = {
  project: PROJECT,
  role: 'support-specialist',
  workspace: { account: ACCOUNT, signer: SIGNER },
};

describe('manageWorkspaceSendAs', () => {
  test('creates an accepted alias without interactive login', async () => {
    const google = fakeGoogle({
      granted: workspaceScopesFor('support-specialist'),
      apis: {
        gmailSendAs: (call) => {
          assert.equal(call.method, 'POST');
          assert.deepEqual(JSON.parse(call.body), {
            sendAsEmail: 'support@example.com',
            treatAsAlias: true,
            displayName: 'Support Team',
          });
          return new Response(JSON.stringify({
            sendAsEmail: 'support@example.com',
            displayName: 'Support Team',
            verificationStatus: 'accepted',
          }), { status: 200 });
        },
      },
    });
    const out = await manageWorkspaceSendAs({
      action: 'create',
      email: ' Support@Example.com ',
      displayName: 'Support Team',
      instance: SUPPORT_INSTANCE,
      fetch: google.fetch,
      getVmAccessToken: async () => VM_TOKEN,
    });
    assert.equal(out.accepted, true);
    assert.equal(out.verification_status, 'accepted');
    assert.equal(out.send_as_email, 'support@example.com');
    assert.match(out.message, /ready to send replies/);
  });

  test('handles pending verification, 409 already-exists re-verify, and explicit verify action', async () => {
    let calls = [];
    const google = fakeGoogle({
      granted: workspaceScopesFor('support-specialist'),
      apis: {
        gmailSendAs: (call) => {
          calls.push({ method: call.method, url: call.url });
          if (call.method === 'POST' && call.url.endsWith('/settings/sendAs')) {
            return new Response(JSON.stringify({ error: { code: 409, message: 'Already exists' } }), { status: 409 });
          }
          if (call.method === 'GET' && call.url.includes('/settings/sendAs/support%40example.com')) {
            return new Response(JSON.stringify({
              sendAsEmail: 'support@example.com',
              verificationStatus: 'pending',
            }), { status: 200 });
          }
          if (call.method === 'POST' && call.url.endsWith('/verify')) {
            return new Response(null, { status: 204 });
          }
          throw new Error(`unexpected ${call.method} ${call.url}`);
        },
      },
    });
    const out = await manageWorkspaceSendAs({
      action: 'create',
      email: 'support@example.com',
      instance: SUPPORT_INSTANCE,
      fetch: google.fetch,
      getVmAccessToken: async () => VM_TOKEN,
    });
    assert.equal(out.accepted, false);
    assert.equal(out.verification_status, 'pending');
    assert.match(out.message, /open it from your own inbox/);
    assert.equal(calls.length, 3);

    calls = [];
    const verified = await manageWorkspaceSendAs({
      action: 'verify',
      email: 'support@example.com',
      instance: SUPPORT_INSTANCE,
      fetch: google.fetch,
      getVmAccessToken: async () => VM_TOKEN,
    });
    assert.equal(verified.verification_status, 'pending');
    assert.equal(calls.length, 2);
  });

  test('names gmail.settings.sharing when the DWD grant lacks it and blocks non-mail roles', async () => {
    const missingScope = fakeGoogle({
      granted: workspaceScopesFor('support-specialist').filter((s) => !GMAIL_SETTINGS_SHARING.includes(s)),
    });
    await assert.rejects(
      manageWorkspaceSendAs({
        email: 'support@example.com',
        instance: SUPPORT_INSTANCE,
        fetch: missingScope.fetch,
        getVmAccessToken: async () => VM_TOKEN,
      }),
      /does not yet include gmail\.settings\.sharing/,
    );

    await assert.rejects(
      manageWorkspaceSendAs({
        email: 'support@example.com',
        instance: { ...SUPPORT_INSTANCE, role: 'executive-assistant' },
        fetch: missingScope.fetch,
        getVmAccessToken: async () => VM_TOKEN,
      }),
      /does not send Gmail mail/,
    );

    await assert.rejects(
      manageWorkspaceSendAs({
        email: ACCOUNT,
        instance: SUPPORT_INSTANCE,
        fetch: missingScope.fetch,
        getVmAccessToken: async () => VM_TOKEN,
      }),
      /already the agent's primary mailbox/,
    );
  });
});

describe('workspace_send_as control command', () => {
  test('provisions alias, refreshes workspace_check, and patches config/workspace_account.last_check', async () => {
    const db = fakeDb();
    const google = fakeGoogle({
      granted: workspaceScopesFor('support-specialist'),
      apis: {
        gmailSendAs: (call) => {
          if (call.method === 'POST' && call.url.endsWith('/settings/sendAs')) {
            return new Response(JSON.stringify({
              sendAsEmail: 'support@example.com',
              displayName: 'Support',
              verificationStatus: 'accepted',
            }), { status: 200 });
          }
          return new Response(JSON.stringify({
            sendAs: [
              { sendAsEmail: ACCOUNT, isPrimary: true, verificationStatus: 'accepted' },
              { sendAsEmail: 'support@example.com', displayName: 'Support', isPrimary: false, verificationStatus: 'accepted' },
            ],
          }), { status: 200 });
        },
      },
    });
    const base = controlRuntime({ db, fetch: fakeGatewayFetch().fetch, role: 'support-specialist' });
    const runtime = {
      ...base,
      fetch: google.fetch,
      getAccessToken: async () => VM_TOKEN,
      instance: { ...base.instance, workspace: { account: ACCOUNT, signer: SIGNER } },
    };
    const handlers = createHandlers({ runtime, systemd: fakeSystemd(), settings: { readyTimeoutMs: 1000, upgradeMaxSeconds: 60 }, now: () => new Date('2026-11-25T18:00:00Z') });
    const queue = createCommandQueue({ db, collections: runtime.collections, handlers, verifyCommand: async () => ({}) });
    db.set('commands/sa1', {
      type: 'workspace_send_as',
      params: { action: 'create', email: 'support@example.com', display_name: 'Support' },
      status: 'pending',
      requested_by: 'admin@example.com',
      created_at: '2026-11-25T18:00:00.000Z',
    });
    await queue.tick();
    const doc = db.get('commands/sa1');
    assert.equal(doc.status, 'done', doc.error);
    assert.equal(doc.result.accepted, true);
    assert.equal(db.get('config/workspace_account').last_check.apis.find((a) => a.api === 'gmail').send_as.length, 2);
  });
});
