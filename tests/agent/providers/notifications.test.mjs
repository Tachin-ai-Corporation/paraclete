// Tests for agent/providers/notifications.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, ACK_FALLBACKS } from '../../../agent/providers/notifications.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const NOW = Date.parse('2026-10-17T10:00:00Z');

/** A notifier over an in-memory Firestore, a scripted model and a scripted gateway. */
function setup({ transform = async () => null, gateway, docs = {}, files = {}, projects = {} } = {}) {
  const writes = [];
  const gatewayCalls = [];
  const notifier = createNotifier({
    vertexText: { transform },
    firestoreRead: async (collection, id) => docs[`${collection}/${id}`] || null,
    firestoreWrite: async (collection, id, data) => writes.push({ collection, id, data }),
    collections: COLLECTIONS,
    addressFromMeta: (meta, channel) => ({ channel, from: meta.thread }),
    generateId: (prefix) => `${prefix}-1`,
    cachedReadFile: (path) => files[path] || null,
    getGatewayConfig: () => ({ url: 'http://127.0.0.1:8080/v1/chat/completions', token: 'gw-token', route: 'agent/cortex' }),
    getProjects: () => projects,
    fetch: async (url, init) => {
      gatewayCalls.push({ url, init, body: JSON.parse(init.body) });
      return gateway ? gateway() : { ok: false, status: 500 };
    },
    now: () => NOW,
    logger: () => {},
    config: { identityPath: '/opt/paraclete/prompts/IDENTITY.md' },
  });
  return { notifier, writes, gatewayCalls };
}

const gatewayReply = (content) => () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

describe('summarizeForDelivery', () => {
  it('passes status updates and error reports through without a model call', async () => {
    let called = false;
    const { notifier } = setup({ transform: async () => { called = true; return 'rewritten'; } });
    assert.equal(await notifier.summarizeForDelivery('status_update', 'Halfway there'), 'Halfway there');
    assert.equal(await notifier.summarizeForDelivery('error_report', 'HTTP 500 from Drive'), 'HTTP 500 from Drive');
    assert.equal(called, false);
  });

  it('rewrites an approval request from its steps, strips a fence and caps the length', async () => {
    let prompt = '';
    const { notifier } = setup({ transform: async (text) => { prompt = text; return `\`\`\`markdown\n${'y'.repeat(2000)}\n\`\`\``; } });
    const out = await notifier.summarizeForDelivery('approval_request', 'raw', { steps: [{ step: '1.1', result: 'drafted' }], title: 'Publish the post' });
    assert.equal(out, 'y'.repeat(1500));
    assert.match(prompt, /APPROVAL TITLE: Publish the post/);
    assert.match(prompt, /"result": "drafted"/);
  });

  it('a completion keeps the answer, reasoning, risk order in its prompt', async () => {
    let prompt = '';
    const { notifier } = setup({ transform: async (text) => { prompt = text; return 'The answer is 42.'; } });
    assert.equal(await notifier.summarizeForDelivery('completion', 'raw', { rawText: 'it is 42', title: 'Count things' }), 'The answer is 42.');
    assert.match(prompt, /answer → reasoning → risk/);
    assert.match(prompt, /RAW OUTPUT:\nit is 42/);
  });

  it('falls back to the raw text when the model returns nothing or fails', async () => {
    const empty = setup({ transform: async () => '' }).notifier;
    assert.equal(await empty.summarizeForDelivery('completion', 'raw text'), 'raw text');
    const failing = setup({ transform: async () => { throw new Error('quota'); } }).notifier;
    assert.equal(await failing.summarizeForDelivery('approval_request', 'raw text'), 'raw text');
  });
});

describe('extractCurrentMessage', () => {
  it('returns the message after the current-message marker, or the whole text', () => {
    const { notifier } = setup();
    assert.equal(notifier.extractCurrentMessage('[Chat messages since 9:00]\nold\n[Current message - respond to this]\n Send the report '), 'Send the report');
    assert.equal(notifier.extractCurrentMessage('plain request'), 'plain request');
    assert.equal(notifier.extractCurrentMessage(undefined), '');
  });
});

describe('writeStatusUpdate', () => {
  it('writes a pending status task under the envelope, addressed like its parent', async () => {
    const docs = { [`${COLLECTIONS.work}/m-1`]: { source_channel: 'dashboard', source_meta: { thread: 'th-1' } } };
    const { notifier, writes } = setup({ docs });
    await notifier.writeStatusUpdate('m-1', 'Collecting the figures');
    assert.equal(writes.length, 1);
    const { collection, id, data } = writes[0];
    assert.equal(collection, COLLECTIONS.work);
    assert.equal(id, 'status-1');
    assert.equal(data.type, 'T');
    assert.equal(data.parent_id, 'm-1');
    assert.equal(data.status, 'complete');
    assert.equal(data.delivery_status, 'pending');
    assert.equal(data.output, 'Collecting the figures');
    assert.deepEqual(data.delivery_address, { channel: 'dashboard', from: 'th-1' });
    assert.equal(data.created_at, '2026-10-17T10:00:00.000Z');
    assert.equal('owner' in data, false, 'one agent per instance: no owner field');
  });

  it('still writes the update when the parent cannot be read', async () => {
    const { notifier, writes } = setup();
    await notifier.writeStatusUpdate('missing', 'Working');
    assert.equal(writes[0].data.source_channel, 'system');
    assert.equal(writes[0].data.delivery_address, null);
  });

  it('requires the work collection name', () => {
    assert.throws(() => createNotifier({ collections: {} }), /collections\.work is required/);
  });
});

describe('generateAck', () => {
  it("asks the gateway in the agent's voice, with its current work and projects", async () => {
    const { notifier, gatewayCalls } = setup({
      gateway: gatewayReply('Picking the sales report back up now.'),
      files: { '/opt/paraclete/prompts/IDENTITY.md': 'Calm and exact.' },
      projects: { web: { id: 'web', name: 'Website', description: 'The public site' } },
    });
    const ack = await notifier.generateAck('[Current message - respond to this]\nUpdate the sales report', [{ status: 'blocked', instruction: 'Sales report' }]);
    assert.equal(ack, 'Picking the sales report back up now.');
    const [call] = gatewayCalls;
    assert.equal(call.init.headers.Authorization, 'Bearer gw-token');
    assert.equal(call.body.model, 'agent/cortex');
    const [system, user] = call.body.messages;
    assert.match(system.content, /BLOCKED: "Sales report"/);
    assert.match(system.content, /Website: The public site/);
    assert.match(system.content, /Your personality:\nCalm and exact\./);
    assert.match(user.content, /"Update the sales report"$/);
  });

  it('falls back to a generic acknowledgment when the gateway fails or answers badly', async () => {
    assert.ok(ACK_FALLBACKS.includes(await setup().notifier.generateAck('hi', [])));
    assert.ok(ACK_FALLBACKS.includes(await setup({ gateway: gatewayReply('x'.repeat(300)) }).notifier.generateAck('hi', [])));
  });
});
