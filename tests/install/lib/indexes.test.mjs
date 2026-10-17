// Tests for install/lib/indexes.sh: the plan read from install/firestore.indexes.json, and recognizing
// an index Firestore already has, whose listing appends __name__ and spells scopes in capitals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { callLib, needsBash, repoRoot } from '../harness.mjs';

const indexesFile = join(repoRoot, 'install', 'firestore.indexes.json').replace(/\\/g, '/');
const lines = (result) => result.stdout.split('\n').filter(Boolean);

test('the plan gives each index its signature and gcloud arguments', { skip: needsBash }, () => {
  const plan = lines(callLib(['names', 'indexes'], 'index_plan', [indexesFile]));
  assert.equal(plan.length, 6);
  assert.deepEqual(plan[0].split('\t'), [
    'messages|collection|thread_id:ascending,timestamp:descending',
    'messages',
    'collection',
    'thread_id=ascending;timestamp=descending',
  ]);
});

test('the TTL plan lists each field marked ttl', { skip: needsBash }, () => {
  assert.deepEqual(lines(callLib(['names', 'indexes'], 'ttl_plan', [indexesFile])), ['tool_results\texpire_at']);
});

test("an existing index matches its planned signature, whatever Firestore appends", { skip: needsBash }, () => {
  const listing = JSON.stringify([
    {
      name: 'projects/your-gcp-project/databases/(default)/collectionGroups/messages/indexes/CICAgOjXh4EK',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'thread_id', order: 'ASCENDING' },
        { fieldPath: 'timestamp', order: 'DESCENDING' },
        { fieldPath: '__name__', order: 'DESCENDING' },
      ],
      state: 'READY',
    },
    {
      name: 'projects/your-gcp-project/databases/(default)/collectionGroups/work/indexes/CICAgJim14AK',
      queryScope: 'COLLECTION_GROUP',
      fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'DESCENDING' }],
    },
  ]);
  const ids = lines(callLib(['names', 'indexes'], 'index_ids', [], { input: listing }));
  assert.deepEqual(ids, [
    'messages|collection|thread_id:ascending,timestamp:descending\tCICAgOjXh4EK',
    'work|collection_group|status:ascending,created_at:descending\tCICAgJim14AK',
  ]);
  const existing = ids.join('\n');
  assert.equal(callLib(['names', 'indexes'], 'index_id', [existing, 'messages|collection|thread_id:ascending,timestamp:descending']).stdout, 'CICAgOjXh4EK\n');
  assert.equal(callLib(['names', 'indexes'], 'index_id', [existing, 'work|collection|status:ascending,created_at:descending']).stdout, '',
    'a collection-group index does not serve a collection query');
});

test('reads the TTL state of one field from the listing', { skip: needsBash }, () => {
  const existing = [
    'projects/your-gcp-project/databases/(default)/collectionGroups/other_results/fields/expire_at\tACTIVE',
    'projects/your-gcp-project/databases/(default)/collectionGroups/tool_results/fields/expire_at\tCREATING',
  ].join('\n');
  assert.equal(callLib(['names', 'indexes'], 'ttl_state', [existing, 'tool_results', 'expire_at']).stdout, 'CREATING\n');
  assert.equal(callLib(['names', 'indexes'], 'ttl_state', [existing, 'results', 'expire_at']).stdout, '');
});
