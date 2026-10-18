// Tests for dashboard/components/chat/upload-list.js: what the composer's files add up to for Send, how
// far an upload has got, why a PUT to the bucket failed, and which drags and drops carry files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILES, draggingFiles, filesOf, newItem, percent, putFailure, uploadSummary } from '../../../../dashboard/components/chat/upload-list.js';
import { MAX_ATTACHMENTS } from '../../../../dashboard/lib/server/uploads.mjs';

const file = (name, size = 10) => ({ name, size, type: '' });
const done = (name) => ({ ...newItem(file(name), name), status: 'done', attachment: { name, size: 10, gcsPath: `files/in/u-1-0a1b2c3d/${name}` } });

test('a new file starts uploading with nothing sent', () => {
  assert.deepEqual(newItem(file('a.pdf', 99), 'f1'), {
    key: 'f1', file: file('a.pdf', 99), name: 'a.pdf', size: 99, status: 'uploading', loaded: 0, error: null, attachment: null,
  });
  assert.equal(MAX_FILES, MAX_ATTACHMENTS, 'the composer allows what the server allows');
});

test('Send waits for every upload, and for failed ones to be removed or tried again; then it carries the uploaded files', () => {
  assert.deepEqual(uploadSummary([]), { running: 0, failed: 0, attachments: [], blocked: null });

  const ready = uploadSummary([done('a.pdf'), done('b.csv')]);
  assert.equal(ready.blocked, null);
  assert.deepEqual(ready.attachments.map((a) => a.name), ['a.pdf', 'b.csv']);

  const uploading = uploadSummary([done('a.pdf'), newItem(file('b.csv'), 'b'), newItem(file('c.csv'), 'c')]);
  assert.equal(uploading.running, 2);
  assert.equal(uploading.blocked, '2 files are still uploading');
  assert.equal(uploadSummary([newItem(file('b.csv'), 'b')]).blocked, 'a file is still uploading');

  const failed = uploadSummary([done('a.pdf'), { ...newItem(file('b.csv'), 'b'), status: 'failed', error: 'too large' }]);
  assert.equal(failed.failed, 1);
  assert.match(failed.blocked, /did not upload: remove it or try it again/);
  assert.deepEqual(failed.attachments.map((a) => a.name), ['a.pdf']);

  const many = uploadSummary(Array.from({ length: MAX_FILES + 1 }, (_, i) => done(`f${i}.txt`)));
  assert.equal(many.blocked, `a message carries at most ${MAX_FILES} files`);
});

test('progress is a whole percentage, never past 100', () => {
  assert.equal(percent(0, 100), 0);
  assert.equal(percent(499, 1000), 49);
  assert.equal(percent(1000, 1000), 100);
  assert.equal(percent(2000, 1000), 100);
  assert.equal(percent(5, 0), 0);
});

test("a failed PUT says why, from the bucket's own error code where it gave one", () => {
  assert.match(putFailure(0), /could not reach the bucket.*CORS/);
  assert.match(putFailure(403, '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>...</Message></Error>'), /signature did not match/);
  assert.match(putFailure(400, '<Error><Code>ExpiredToken</Code></Error>'), /expired/);
  assert.match(putFailure(400, '<Error><Code>EntityTooLarge</Code></Error>'), /too large/);
  assert.equal(putFailure(403, '<Error><Code>AccessDenied</Code></Error>'), 'the bucket refused the upload (HTTP 403, AccessDenied)');
  assert.equal(putFailure(503, 'Service Unavailable'), 'the bucket answered HTTP 503');
});

test('only drags that carry files count, and a drop gives its files as an array', () => {
  assert.equal(draggingFiles({ types: ['Files'] }), true);
  assert.equal(draggingFiles({ types: ['text/plain', 'text/html'] }), false);
  assert.equal(draggingFiles(null), false);
  const list = { 0: file('a.pdf'), 1: file('b.csv'), length: 2 };
  assert.deepEqual(filesOf(list).map((f) => f.name), ['a.pdf', 'b.csv']);
  assert.deepEqual(filesOf(null), []);
});
