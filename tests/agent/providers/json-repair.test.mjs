// Tests for agent/providers/json-repair.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonResponse, repairTruncatedJson, extractBalancedJson } from '../../../agent/providers/json-repair.mjs';

describe('parseJsonResponse', () => {
  it('parses clean JSON', () => {
    assert.deepEqual(parseJsonResponse('{"action":"synthesize","reason":"done"}'), { action: 'synthesize', reason: 'done' });
  });

  it('strips markdown fences', () => {
    assert.deepEqual(parseJsonResponse('```json\n{"action":"test"}\n```'), { action: 'test' });
  });

  it('strips a trailing Action: block', () => {
    assert.deepEqual(parseJsonResponse('{"action":"checkpoint_plan"}\nAction: do stuff'), { action: 'checkpoint_plan' });
  });

  it('recovers a response the model cut off mid-value', () => {
    const result = parseJsonResponse('{"action":"synthesize","synthesis":"the report is rea');
    assert.equal(result.action, 'synthesize');
  });

  it('returns a parse_failed object for garbage input', () => {
    assert.equal(parseJsonResponse('not json at all').error, 'parse_failed');
  });

  it('returns a parse_failed object for empty input', () => {
    assert.equal(parseJsonResponse('').error, 'parse_failed');
  });

  it('treats a missing response as empty instead of throwing', () => {
    for (const raw of [undefined, null, 42]) {
      assert.deepEqual(parseJsonResponse(raw), { error: 'parse_failed', raw: '' });
    }
  });
});

describe('extractBalancedJson', () => {
  it('extracts the first balanced object from surrounding text', () => {
    assert.equal(extractBalancedJson('prefix {"a":1} suffix'), '{"a":1}');
  });

  it('handles nested objects', () => {
    assert.equal(extractBalancedJson('{"a":{"b":2}}'), '{"a":{"b":2}}');
  });

  it('ignores braces inside strings', () => {
    assert.equal(extractBalancedJson('{"a":"hello {world}"}'), '{"a":"hello {world}"}');
  });

  it('returns null when no JSON is present', () => {
    assert.equal(extractBalancedJson('no braces here'), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(extractBalancedJson(''), null);
  });
});

describe('repairTruncatedJson', () => {
  it('returns null for input under 10 characters', () => {
    assert.equal(repairTruncatedJson('{}'), null);
  });

  it('returns null for JSON that is already balanced', () => {
    assert.equal(repairTruncatedJson('{"action":"test"}'), null);
  });

  it('closes an open string, object and array, keeping the action', () => {
    const result = repairTruncatedJson('{"action":"synthesize","data":{"key":"val');
    assert.notEqual(result, null);
    assert.equal(result.action, 'synthesize');
  });

  it('closes a string cut mid-value and keeps what was written', () => {
    const result = repairTruncatedJson('{"action":"checkpoint_plan","reasoning":"because the');
    assert.deepEqual(result, { action: 'checkpoint_plan', reasoning: 'because the' });
  });

  it('drops a half-written last list item when a comma closes the previous one', () => {
    const result = repairTruncatedJson('{"action":"checkpoint_plan","reads":["first","sec');
    assert.deepEqual(result, { action: 'checkpoint_plan', reads: ['first'] });
  });

  it('accepts a classification as the minimum structure', () => {
    assert.equal(repairTruncatedJson('{"classification":"respond","response":"hel').classification, 'respond');
  });

  it('rejects a repaired object with neither action nor classification', () => {
    assert.equal(repairTruncatedJson('{"summary":"half a sentence'), null);
  });

  it('returns null when there is no opening brace', () => {
    assert.equal(repairTruncatedJson('just text'), null);
  });
});
