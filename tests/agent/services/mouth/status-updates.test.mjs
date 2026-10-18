// Tests for agent/services/mouth/status-updates.mjs and its prompts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseStatusPrompts, fillTemplate, activitySummary, waitingAddress, advance, createStatusUpdates,
} from '../../../../agent/services/mouth/status-updates.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from '../ears/fake-db.mjs';

const CREATED = Date.parse('2026-10-17T12:00:00Z');
const SCHEDULE = [10_000, 300_000, 600_000];
const DASH = { channel: 'dashboard', thread: 'th-1' };
const PROMPTS_FILE = new URL('../../../../agent/services/mouth/status-prompts.md', import.meta.url);

const mission = (over = {}) => ({
  id: 'w-1', type: 'M', status: 'active', created_at: new Date(CREATED).toISOString(), instruction: 'Write the report',
  source_channel: 'dashboard', source_meta: { address: DASH, raw_text: 'Can you write the Q3 report?' }, ...over,
});

describe('pure helpers', () => {
  test('the prompts file holds both templates, with their placeholders', () => {
    const prompts = parseStatusPrompts(readFileSync(PROMPTS_FILE, 'utf8'));
    for (const kind of ['ack', 'update']) {
      assert.ok(prompts[kind].length > 50, kind);
      for (const ph of ['{agent_name}', '{activity_summary}', '{original_question}']) assert.ok(prompts[kind].includes(ph), `${kind} ${ph}`);
      assert.ok(!prompts[kind].startsWith('#'), 'the heading is not part of the template');
    }
    assert.deepEqual(parseStatusPrompts(''), { ack: '', update: '' });
  });

  test('templates are filled, and a missing value becomes empty', () => {
    assert.equal(fillTemplate('{a} and {a}, {b}', { a: 'x', b: undefined }), 'x and x, ');
  });

  test('where a mission stands, from its checkpoint spine', () => {
    const spine = [{ status: 'complete', outcome: 'Gather data' }, { status: 'pending', outcome: 'Build the table' }, { status: 'pending', outcome: 'File it' }];
    assert.equal(activitySummary(mission({ _cp_spine: spine })), 'finished 1 of 3 steps; now on: Build the table');
    assert.equal(activitySummary(mission()), 'thinking it through');
    assert.equal(activitySummary(mission({ status: 'queued' })), 'about to start');
  });

  test('only a person waiting in a thread or space gets notes', () => {
    assert.deepEqual(waitingAddress(mission()), DASH);
    assert.equal(waitingAddress(mission({ source_channel: 'system', source_meta: {} })), null, 'responsibility work');
    assert.equal(waitingAddress(mission({ source_meta: { address: { channel: 'dashboard' } } })), null, 'no thread');
    assert.equal(waitingAddress(mission({ source_channel: 'gchat', source_meta: { address: { channel: 'gchat' } } })), null, 'no space');
    assert.deepEqual(waitingAddress(mission({ source_channel: 'gchat', source_meta: { address: { channel: 'gchat', space: 'spaces/A' } } })),
      { channel: 'gchat', space: 'spaces/A', thread: null });
  });

  test('advancing the schedule reports only the latest step passed', () => {
    assert.deepEqual(advance(0, 5_000, SCHEDULE), { index: 0, due: -1 });
    assert.deepEqual(advance(0, 10_000, SCHEDULE), { index: 1, due: 0 });
    assert.deepEqual(advance(0, 700_000, SCHEDULE), { index: 3, due: 2 });
    assert.deepEqual(advance(3, 9_999_999, SCHEDULE), { index: 3, due: -1 });
  });
});

function setup(docs = {}, { answers = [], spokenAt = 0, enabled = true, llmEnabled = true, clock = { now: CREATED + 1_000 } } = {}) {
  const db = fakeDb(docs);
  const sent = [];
  const calls = [];
  const outbound = {
    lastSpokenAt: () => spokenAt,
    send: async (addr, text, opts) => { sent.push({ addr, text, key: opts?.key }); return true; },
  };
  const notes = createStatusUpdates({
    db,
    collections: COLLECTIONS,
    outbound,
    transform: async (text, instruction, opts) => { calls.push({ text, instruction, opts }); return answers.shift() ?? null; },
    prompts: { ack: 'ACK as {agent_name}: {activity_summary} / {original_question}', update: 'UPDATE as {agent_name}' },
    agentName: 'Paraclete',
    schedule: SCHEDULE,
    enabled,
    llmEnabled,
    callOptions: { maxTokens: 2000 },
    now: () => clock.now,
  });
  return { db, sent, calls, notes, clock, setSpoken: (v) => { spokenAt = v; } };
}

describe('the status notes pass', () => {
  test('a note is sent at each step of the schedule, the first as an acknowledgment', async () => {
    const t = setup({ 'work/w-1': mission() }, { answers: ['"On it, give me a moment."', 'Still pulling the numbers together.'] });
    assert.equal(await t.notes.pass(), 0, 'the first sighting only records the mission');
    t.clock.now = CREATED + 11_000;
    assert.equal(await t.notes.pass(), 1);
    assert.deepEqual(t.sent[0], { addr: DASH, text: 'On it, give me a moment.', key: 'status:w-1:0' });
    assert.equal(t.calls[0].instruction, 'ACK as Paraclete: thinking it through / Can you write the Q3 report?');
    assert.equal(t.calls[0].text, 'Question: "Can you write the Q3 report?"');
    assert.deepEqual(t.calls[0].opts, { maxTokens: 2000 });

    t.clock.now = CREATED + 60_000;
    assert.equal(await t.notes.pass(), 0, 'nothing due between steps');
    t.clock.now = CREATED + 301_000;
    await t.notes.pass();
    assert.equal(t.sent[1].text, 'Still pulling the numbers together.');
    assert.equal(t.calls[1].instruction, 'UPDATE as Paraclete');
  });

  test('no note when the agent already spoke to the person since the previous step', async () => {
    const t = setup({ 'work/w-1': mission() }, { spokenAt: CREATED + 3_000 });
    await t.notes.pass();
    t.clock.now = CREATED + 11_000;
    await t.notes.pass();
    assert.equal(t.sent.length, 0, "the brain's acknowledgment already went out");
    t.clock.now = CREATED + 301_000;
    await t.notes.pass();
    assert.equal(t.sent.length, 1, 'nothing said since the 10s step, so the 5 minute note goes');
  });

  test('a mission first seen late starts after the steps it passed: no burst after a restart', async () => {
    const t = setup({ 'work/w-1': mission() }, { clock: { now: CREATED + 400_000 } });
    await t.notes.pass();
    assert.equal(t.sent.length, 0);
    t.clock.now = CREATED + 601_000;
    await t.notes.pass();
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].key, 'status:w-1:2', 'one key per mission and step: a note is posted to Chat once');
  });

  test('the plain fallback stands in for the model', async () => {
    const t = setup({ 'work/w-1': mission() }, { llmEnabled: false });
    await t.notes.pass();
    t.clock.now = CREATED + 301_000;
    await t.notes.pass();
    assert.equal(t.sent[0].text, "Still on it: this one's taking a bit longer.", 'several steps passed at once send one note, the latest');
    assert.equal(t.calls.length, 0);
  });

  test('switched off, nothing is read or sent', async () => {
    const t = setup({ 'work/w-1': mission() }, { enabled: false });
    assert.equal(await t.notes.pass(), 0);
    assert.equal(t.db.calls.length, 0);
  });

  test('only missions under way are read, and finished ones are forgotten', async () => {
    const t = setup({
      'work/w-1': mission(),
      'work/done': mission({ id: 'done', status: 'complete' }),
      'work/task': mission({ id: 'task', type: 'T' }),
    });
    await t.notes.pass();
    await t.db.patch('work/w-1', ['status'], { status: { stringValue: 'needs_input' } });
    t.clock.now = CREATED + 11_000;
    await t.notes.pass();
    assert.equal(t.sent.length, 0, 'a mission waiting on the person gets no "still working" note');
    await t.db.patch('work/w-1', ['status'], { status: { stringValue: 'active' } });
    await t.notes.pass();
    assert.equal(t.sent.length, 0, 'back in progress it is seen anew, after the steps already passed');
  });

  test('the query reads missions in progress without ordering', async () => {
    const seen = [];
    const notes = createStatusUpdates({
      db: { query: async (...args) => { seen.push(args); return []; } },
      collections: COLLECTIONS, outbound: {}, prompts: { ack: '', update: '' }, agentName: 'Paraclete', schedule: SCHEDULE,
    });
    await notes.pass();
    const [, collection, filters, opts] = seen[0];
    assert.equal(collection, 'work');
    assert.deepEqual(filters[0], { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } });
    assert.deepEqual(filters[1].value.arrayValue.values.map((v) => v.stringValue), ['pending', 'planned', 'queued', 'active']);
    assert.equal(opts.noOrderBy, true);
  });

  test('a note that cannot be sent is logged and the pass goes on', async () => {
    const logs = [];
    const clock = { now: CREATED };
    const notes = createStatusUpdates({
      db: fakeDb({ 'work/w-1': mission(), 'work/w-2': mission({ id: 'w-2', source_meta: { address: { channel: 'dashboard', thread: 'th-2' } } }) }),
      collections: COLLECTIONS,
      outbound: { lastSpokenAt: () => 0, send: async (addr) => { if (addr.thread === 'th-1') throw new Error('boom'); return true; } },
      prompts: { ack: '', update: '' }, agentName: 'Paraclete', schedule: SCHEDULE, llmEnabled: false,
      log: (...a) => logs.push(a), now: () => clock.now,
    });
    await notes.pass();
    clock.now = CREATED + 11_000;
    assert.equal(await notes.pass(), 1);
    assert.ok(logs.some(([level, message, fields]) => level === 'WARN' && message === 'status note could not be sent' && fields.mission === 'w-1'));
  });
});
