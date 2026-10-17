// Tests for agent/work/project-context.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateContextEntry, filterProjectContext, MAX_CONTEXT_KEYS } from '../../../agent/work/project-context.mjs';

describe('validateContextEntry', () => {
  it('accepts a durable resource reference', () => {
    assert.deepEqual(validateContextEntry('site_repo', { kind: 'repo', ref: 'example/site' }), { ok: true });
    assert.deepEqual(validateContextEntry('brand-voice', { kind: 'convention', summary: 'Plain words, short sentences.' }), { ok: true });
    assert.deepEqual(validateContextEntry('live_site', { kind: 'url', url: 'https://example.com' }), { ok: true });
  });

  it('refuses a key that is not a semantic slug', () => {
    assert.match(validateContextEntry('x', { kind: 'doc', ref: 'd' }).reason, /semantic slug/);
    assert.match(validateContextEntry('has space', { kind: 'doc', ref: 'd' }).reason, /semantic slug/);
  });

  it('refuses a key that names history, state, particulars or process steps', () => {
    for (const key of ['deploy_history', 'repo_state', 'failure_mode', 'last-attempt', 'debug_notes', 'next_steps', 'release_workflow', 'publish_process']) {
      assert.equal(validateContextEntry(key, { kind: 'doc', ref: 'd' }).ok, false, key);
    }
  });

  it('refuses an empty entry, a bare value, an unknown kind, or a packet with no pointer', () => {
    assert.match(validateContextEntry('notes_doc', null).reason, /empty/);
    assert.match(validateContextEntry('notes_doc', {}).reason, /empty/);
    assert.match(validateContextEntry('notes_doc', '  ').reason, /empty/);
    assert.match(validateContextEntry('notes_doc', 'a string').reason, /resource packet/);
    assert.match(validateContextEntry('notes_doc', ['a']).reason, /resource packet/);
    assert.match(validateContextEntry('notes_doc', { kind: 'thought', ref: 'x' }).reason, /kind must be one of/);
    assert.match(validateContextEntry('notes_doc', { kind: 'doc', name: 'Notes' }).reason, /ref, url, or summary/);
  });
});

describe('filterProjectContext', () => {
  it('keeps conforming entries and reports the rest with reasons', () => {
    const { context, dropped } = filterProjectContext({
      site_repo: { kind: 'repo', ref: 'example/site' },
      deploy_history: { kind: 'resource', summary: 'three attempts' },
      bare: 'x',
    });
    assert.deepEqual(Object.keys(context), ['site_repo']);
    assert.deepEqual(dropped.map((d) => d.key), ['deploy_history', 'bare']);
  });

  it('enforces the key cap deterministically, dropping the lexically last extras', () => {
    const map = {};
    for (let i = 0; i < MAX_CONTEXT_KEYS + 3; i++) map[`doc_${String(i).padStart(2, '0')}`] = { kind: 'doc', ref: `d-${i}` };
    const { context, dropped } = filterProjectContext(map);
    assert.equal(Object.keys(context).length, MAX_CONTEXT_KEYS);
    assert.deepEqual(dropped.map((d) => d.key), ['doc_24', 'doc_25', 'doc_26']);
    assert.match(dropped[0].reason, /exceeds MAX_CONTEXT_KEYS\(24\)/);
  });

  it('takes the cap as a parameter and tolerates no map', () => {
    const { context } = filterProjectContext({ a_doc: { kind: 'doc', ref: '1' }, b_doc: { kind: 'doc', ref: '2' } }, 1);
    assert.deepEqual(Object.keys(context), ['a_doc']);
    assert.deepEqual(filterProjectContext(undefined), { context: {}, dropped: [] });
  });
});
