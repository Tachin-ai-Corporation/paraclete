// tests/integration/dashboard-round-trip.test.mjs: the three services that carry a conversation, wired
// together against the in-memory Firestore fake and a fake gateway. A person's dashboard message goes
// through the ears (intake), the brain (a planned, executed, verified mission) and the mouth (the reply,
// written back into the same dashboard thread). This is build plan phase 4's exit check: the services
// run a mission end to end with no Google Cloud behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { createVertexText } from '../../agent/providers/vertex-text.mjs';
import { createEars } from '../../agent/services/ears/main.mjs';
import { createMouth } from '../../agent/services/mouth/main.mjs';
import { startBrain, drainRunner, organScript } from '../agent/services/brain/harness.mjs';

/** A utility-model client with no network: preprocessing and voicing take their fallbacks. */
const offlineVertexText = (projectId) => createVertexText({
  projectId,
  getAccessToken: async () => 'test-token',
  fetch: async () => { throw new Error('no network in tests'); },
  logger: () => {},
});

/** The same runtime the brain got, for another service. */
const runtimeFor = (base, service, logs) => ({
  ...base,
  service,
  log: (level, message, fields) => logs.push({ service, level, message: String(message), ...fields }),
});

test('a dashboard message becomes a mission, and its result comes back in the same thread', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'checkpoint_plan', goal: 'Write the quarterly report' }] }) });
  const logs = [];
  try {
    const vertexText = offlineVertexText(t.firestore.projectId);
    const ears = createEars(runtimeFor(t.runtime, 'ears', logs), { vertexText, now: t.clock });
    const mouth = createMouth(runtimeFor(t.runtime, 'mouth', logs), { vertexText, now: t.clock });
    await t.brain.init();

    // A person types into the dashboard: the message shape the dashboard writes.
    await t.db.write(`${COLLECTIONS.messages}/m1`, {
      text: 'Please write the quarterly report',
      timestamp: new Date(t.clock()),
      processed: false,
      sender: 'person@example.com',
      sender_name: 'Person',
      thread_id: 'th-1',
      attachments: [],
    });

    // Ears: the message becomes an intake carrying its thread, and is marked processed.
    await ears.tickDashboard();
    const intakes = await t.docs(COLLECTIONS.intake);
    assert.equal(intakes.length, 1);
    assert.deepEqual(intakes[0].source_meta.address, { channel: 'dashboard', thread: 'th-1' });
    assert.equal(intakes[0].source_meta.sender, 'person@example.com');
    assert.equal((await t.read(`${COLLECTIONS.messages}/m1`)).processed, true);

    // Brain: the intake becomes a mission, which runs to completion.
    await t.brain.tickIntake();
    const ran = await drainRunner(t.brain);
    assert.equal(ran.length, 1);
    const mission = await t.read(`${COLLECTIONS.work}/${ran[0]}`);
    assert.equal(mission.status, 'complete');
    assert.equal(mission.delivery_status, 'pending');

    // Mouth: the acknowledgment and the result go back to the person's thread, oldest first.
    await mouth.tick();
    await mouth.tick();
    const replies = (await t.docs(COLLECTIONS.messages))
      .filter((m) => m.sender === 'agent')
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    assert.ok(replies.length >= 2, `expected an acknowledgment and a result, got ${replies.length}`);
    for (const reply of replies) {
      assert.equal(reply.thread_id, 'th-1', 'every reply lands in the thread the request came from');
      assert.equal(reply.sender_name, 'Paraclete');
    }
    assert.ok(replies.some((r) => /The report is ready/.test(r.text)), 'the mission result reaches the person');
    const delivered = await t.read(`${COLLECTIONS.work}/${ran[0]}`);
    assert.equal(delivered.delivery_status, 'delivered');
    assert.equal(delivered.delivered_channel, 'dashboard');

    // Nothing failed along the way.
    const errors = [...logs, ...t.logs].filter((l) => l.level === 'ERROR');
    assert.deepEqual(errors, []);
  } finally {
    await t.stop();
  }
});
