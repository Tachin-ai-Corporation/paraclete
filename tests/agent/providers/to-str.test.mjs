// Tests for agent/providers/to-str.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStr } from '../../../agent/providers/to-str.mjs';

test('strings pass through and null or undefined become empty', () => {
  assert.equal(toStr('hello'), 'hello');
  assert.equal(toStr(''), '');
  assert.equal(toStr(null), '');
  assert.equal(toStr(undefined), '');
});

test('an object gives its instruction, then its text, then its JSON', () => {
  assert.equal(toStr({ instruction: 'do it', text: 'ignored' }), 'do it');
  assert.equal(toStr({ text: 'body' }), 'body');
  assert.equal(toStr({ a: 1 }), '{"a":1}');
  assert.equal(toStr([1, 2]), '[1,2]');
});

test('numbers and booleans become their string form', () => {
  assert.equal(toStr(0), '0');
  assert.equal(toStr(false), 'false');
});
