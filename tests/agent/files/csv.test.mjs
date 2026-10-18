// Tests for agent/files/csv.mjs: RFC 4180 parsing with a guessed delimiter, and writing back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, formatCsv, parseCsv } from '../../../agent/files/csv.mjs';

test('quoted cells, doubled quotes, line breaks inside quotes and CRLF all parse', () => {
  const text = '﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nLee,\n';
  assert.deepEqual(parseCsv(text), [['name', 'note'], ['Smith, J', 'said "hi"\nthen left'], ['Lee', '']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'no final line break');
  assert.deepEqual(parseCsv(''), []);
});

test('the delimiter is guessed from the first line, outside quotes', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n'), '\t');
  assert.equal(detectDelimiter('"x,y";z;w'), ';', 'a comma inside quotes does not count');
  assert.equal(detectDelimiter('single'), ',');
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('writing quotes only the cells that need it, and round-trips', () => {
  const rows = [['a', 'b, c', 'say "x"', ' pad', null, 7], ['line\nbreak', '', true, undefined, 'plain', 0]];
  const text = formatCsv(rows);
  assert.equal(text.split('\n')[0], 'a,"b, c","say ""x"""," pad",,7');
  assert.deepEqual(parseCsv(text), [['a', 'b, c', 'say "x"', ' pad', '', '7'], ['line\nbreak', '', 'true', '', 'plain', '0']]);
  assert.equal(formatCsv([]), '');
});
