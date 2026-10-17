// Tests for agent/work/resource-ledger.mjs. Fixtures follow the shapes real tool output takes,
// including the escaped JSON inside a runCommand_response wrapper that motor transcripts carry.
// Ids are placeholders, never real Drive ids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractResources, extractResourcesFromProse, mergeResources, renderResources,
  resourceKey, normalizeName, seedFromProse, repairIds, isEditDistanceOne,
} from '../../../agent/work/resource-ledger.mjs';

// The shape of a real request: it named all three folders with their ids, and the agent still
// searched for them by name, one search returning empty because the real folder name differs.
const REAL_REQUEST = 'Create 3 monthly retainer compensation addendums for Advisor One, '
  + 'Advisor Two, and Advisor Three and place them in the In Progress folder '
  + '(1INPROGRESSFOLDER0000000000000009).  Workflow: 1. Find the monthly fee comp '
  + 'addendum master template in the Master Templates folder '
  + '(1MASTERTEMPLATES00000000000000009) and duplicate it 3 times. 2. Read the signed '
  + 'advisor contracts from the Signed Artifacts folder '
  + '(1SIGNEDARTIFACTS00000000000000009)';

// A Drive search hit for the folder a mission kept failing to find.
const DRIVE_SEARCH = JSON.stringify({
  files: [{
    id: '1MASTERTEMPLATES00000000000000009',
    name: 'master templates',
    type: 'folder',
    owner: 'someone@example.com',
    modified: '2026-07-01T00:00:00Z',
    link: 'https://drive.google.com/x',
  }],
  count: 1,
}, null, 2);

// An empty result must yield nothing, not a bogus entry.
const DRIVE_SEARCH_EMPTY = '{"files":[],"count":0}';

// A PDF converted to a Google Doc.
const DRIVE_TO_DOC = JSON.stringify({
  status: 'converted',
  docId: '1CONVERTEDDOC0000000000000000000000000000009',
  name: 'Advisor One Agreement [text]',
  sourceMime: 'application/pdf',
  readWith: 'docs-cat 1CONVERTEDDOC0000000000000000000000000000009',
});

// The real transport: JSON escaped inside a runCommand_response wrapper.
const NESTED = '{"runCommand_response": {"result": "{\\"status\\":\\"created\\",\\"id\\":\\"1INPROGRESSFOLDER0000000000000009\\",\\"name\\":\\"In Progress\\",\\"link\\":\\"https://x\\"}"}}';

describe('normalizeName / resourceKey', () => {
  it('collapses case and punctuation so one folder is one entry', () => {
    assert.equal(normalizeName('Master Templates'), 'master templates');
    assert.equal(normalizeName('master-templates'), 'master templates');
    assert.equal(normalizeName('  MASTER   TEMPLATES  '), 'master templates');
    assert.equal(resourceKey('drive_folder', 'Master Templates'), resourceKey('drive_folder', 'master-templates'));
  });

  it('drops a file extension so a doc and its filename agree', () => {
    assert.equal(normalizeName('Agreement_Advisory.pdf'), 'agreement advisory');
  });

  it("keeps genuinely different names apart (aliasing is consolidation's job)", () => {
    assert.notEqual(
      resourceKey('drive_folder', 'signed artifacts'),
      resourceKey('drive_folder', 'Executed Advisory Agreements'),
    );
  });
});

describe('extractResources: real tool shapes', () => {
  it('pulls a folder out of a Drive search listing', () => {
    const r = extractResources(DRIVE_SEARCH);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], {
      kind: 'drive_folder',
      name: 'master templates',
      id: '1MASTERTEMPLATES00000000000000009',
    });
  });

  it('returns nothing for an empty result set', () => {
    assert.deepEqual(extractResources(DRIVE_SEARCH_EMPTY), []);
  });

  it('reads a docId from a conversion and types it as a doc', () => {
    const r = extractResources(DRIVE_TO_DOC);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'doc');
    assert.equal(r[0].id, '1CONVERTEDDOC0000000000000000000000000000009');
  });

  it('digs JSON out of an escaped runCommand_response wrapper', () => {
    const r = extractResources(NESTED);
    assert.equal(r.length, 1, 'nested escaped payloads are how results actually arrive');
    assert.equal(r[0].name, 'In Progress');
    assert.equal(r[0].id, '1INPROGRESSFOLDER0000000000000009');
  });

  it('survives a full prose transcript with fenced JSON and finds every id', () => {
    const transcript = `## Step 1: Find the folders

### Action Taken
I searched Drive.

\`\`\`json
${DRIVE_SEARCH}
\`\`\`

Then I converted the contract:
${DRIVE_TO_DOC}

### Status
SUCCESS`;
    const ids = extractResources(transcript).map((x) => x.id).sort();
    assert.deepEqual(ids, [
      '1MASTERTEMPLATES00000000000000009',
      '1CONVERTEDDOC0000000000000000000000000000009',
    ].sort());
  });

  it('types Chat spaces, images and pdfs', () => {
    const r = extractResources(JSON.stringify([
      { name: 'spaces/AAAA1234', id: 'spaces/AAAA1234' },
      { name: 'Logo', id: '1LOGOIMAGE0000000009', mimeType: 'image/png' },
      { name: 'Contract', fileId: '1CONTRACTPDF00000009', mimeType: 'application/pdf' },
    ]));
    assert.deepEqual(r.map((x) => x.kind), ['space', 'image', 'pdf']);
  });

  it('ignores short or garbage ids and unnamed objects', () => {
    assert.deepEqual(extractResources('{"id":"abc","name":"too short"}'), []);
    assert.deepEqual(extractResources('{"id":"1MASTERTEMPLATES00000000000000009"}'), [],
      'an id with no name cannot be recalled by name: worthless to the ledger');
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', null, undefined, '{{{', '{"a":', 'plain prose', '[]']) {
      assert.deepEqual(extractResources(bad), []);
    }
  });

  it('de-duplicates repeated mentions of the same resource', () => {
    assert.equal(extractResources(`${DRIVE_SEARCH}\n${DRIVE_SEARCH}`).length, 1);
  });
});

describe('extractResourcesFromProse: ids the person already gave', () => {
  it('recovers all three folders from the request', () => {
    const r = extractResourcesFromProse(REAL_REQUEST);
    const byName = Object.fromEntries(r.map((x) => [x.name, x]));
    assert.equal(byName['In Progress'].id, '1INPROGRESSFOLDER0000000000000009');
    assert.equal(byName['Master Templates'].id, '1MASTERTEMPLATES00000000000000009');
    assert.equal(byName['Signed Artifacts'].id, '1SIGNEDARTIFACTS00000000000000009');
    for (const x of r) assert.equal(x.kind, 'drive_folder', 'the noun "folder" types them');
  });

  it('handles a quoted name before the noun', () => {
    const r = extractResourcesFromProse("the 'Signed Artifacts' folder (1SIGNEDARTIFACTS00000000000000009)");
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'Signed Artifacts');
    assert.equal(r[0].kind, 'drive_folder');
  });

  it('handles a bare quoted name with no noun', () => {
    const r = extractResourcesFromProse('copy from "Master Templates" (1MASTERTEMPLATES00000000000000009)');
    assert.deepEqual(r, [{ kind: 'file', name: 'Master Templates', id: '1MASTERTEMPLATES00000000000000009' }]);
  });

  it('types by noun: doc, sheet, pdf', () => {
    const kinds = ['document', 'spreadsheet', 'pdf'].map((noun) =>
      extractResourcesFromProse(`see the "Thing" ${noun} (1AbCdEfGhIjKlMnOpQrStUvWxYz123456)`)[0]?.kind);
    assert.deepEqual(kinds, ['doc', 'sheet', 'pdf']);
  });

  // A wrong name→id mapping is worse than none, because it gets trusted.
  it('refuses to invent a pair when the name is ambiguous', () => {
    for (const t of [
      'folder ID: 1AMBIGFOLDER000000000000000000009',
      'Master template doc = 1AMBIGDOC00000000000000000000000000000000009',
      'put it in the folder (1AbCdEfGhIjKlMnOpQrStUvWxYz123456)',
    ]) {
      assert.deepEqual(extractResourcesFromProse(t), [], `must skip: ${t}`);
    }
  });

  it('never mistakes a commit sha or mission id for a resource', () => {
    assert.deepEqual(extractResourcesFromProse('commit 3e25f8b7bfee9a1c2d3e4f5a6b7c8d9e0f1a2b3c is on main'), []);
    assert.deepEqual(extractResourcesFromProse('mission w-1700000000000-0a1b2c3d blocked'), []);
    assert.deepEqual(extractResourcesFromProse('no identifiers here at all'), []);
  });

  it('merges cleanly with tool-captured entries: same folder, one entry', () => {
    const seeded = extractResourcesFromProse(REAL_REQUEST);
    const captured = [{ kind: 'drive_folder', name: 'master templates', id: '1MASTERTEMPLATES00000000000000009' }];
    const a = mergeResources({}, seeded, { now: 'T0', source: 'request' });
    const b = mergeResources(a.ledger, captured, { now: 'T1', source: '1.1' });
    assert.equal(b.added, 0, 'the case-insensitive key collapses "Master Templates" and "master templates"');
    assert.equal(b.updated, 0, 'same id: nothing to update');
    assert.equal(Object.keys(b.ledger).length, 3);
  });

  it('never throws on junk', () => {
    for (const bad of ['', null, undefined, '(((', '1'.repeat(500)]) {
      assert.ok(Array.isArray(extractResourcesFromProse(bad)));
    }
  });
});

describe('mergeResources', () => {
  const found = extractResources(DRIVE_SEARCH);

  it('adds a new entry', () => {
    const { ledger, added } = mergeResources({}, found, { now: 'T0' });
    assert.equal(added, 1);
    assert.equal(ledger['drive_folder:master templates'].id, '1MASTERTEMPLATES00000000000000009');
    assert.equal(ledger['drive_folder:master templates'].first_seen, 'T0');
  });

  it('is idempotent: merging the same batch twice changes nothing', () => {
    const one = mergeResources({}, found, { now: 'T0' });
    const two = mergeResources(one.ledger, found, { now: 'T1' });
    assert.equal(two.added, 0);
    assert.equal(two.updated, 0);
    assert.deepEqual(two.ledger, one.ledger);
  });

  it('updates in place when the id changes, remembering the old one', () => {
    const one = mergeResources({}, found, { now: 'T0' });
    const moved = [{ kind: 'drive_folder', name: 'master templates', id: '9NEWID_NEWID_NEWID_NEWID' }];
    const two = mergeResources(one.ledger, moved, { now: 'T2' });
    assert.equal(two.updated, 1);
    const e = two.ledger['drive_folder:master templates'];
    assert.equal(e.id, '9NEWID_NEWID_NEWID_NEWID');
    assert.equal(e.previous_id, '1MASTERTEMPLATES00000000000000009', 'a dead id must be visible, not silently overwritten');
    assert.equal(e.updated_at, 'T2');
  });

  it('is order-independent', () => {
    const a = [{ kind: 'drive_folder', name: 'A', id: 'AAAAAAAAAAAA' }, { kind: 'doc', name: 'B', id: 'BBBBBBBBBBBB' }];
    const l1 = mergeResources({}, a, { now: 'T' }).ledger;
    const l2 = mergeResources({}, [...a].reverse(), { now: 'T' }).ledger;
    assert.deepEqual(l1, l2);
  });

  it('enforces the cap and reports what it dropped', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'drive_folder', name: `f${i}`, id: `IDIDIDIDIDID${i}` }));
    const { ledger, added, dropped } = mergeResources({}, many, { now: 'T', max: 3 });
    assert.equal(Object.keys(ledger).length, 3);
    assert.equal(added, 3);
    assert.equal(dropped, 2, 'silent truncation would make the ledger quietly wrong');
  });

  it('tolerates junk entries without corrupting the ledger', () => {
    const { ledger } = mergeResources({}, [null, {}, { name: 'x' }, { id: 'y' }], { now: 'T' });
    assert.deepEqual(ledger, {});
  });
});

describe('renderResources', () => {
  it('renders one line per resource with the id intact', () => {
    const { ledger } = mergeResources({}, extractResources(DRIVE_SEARCH), { now: 'T' });
    const out = renderResources(ledger);
    assert.match(out, /Known Resources/);
    assert.match(out, /do NOT search for these again/);
    assert.match(out, /folder: "master templates" = 1MASTERTEMPLATES00000000000000009/);
  });

  it('shows a replaced id beside the current one', () => {
    const one = mergeResources({}, extractResources(DRIVE_SEARCH), { now: 'T' }).ledger;
    const two = mergeResources(one, [{ kind: 'drive_folder', name: 'master templates', id: '9NEWID_NEWID_NEWID_NEWID' }], { now: 'T2' }).ledger;
    assert.match(renderResources(two), /= 9NEWID_NEWID_NEWID_NEWID \(was 1MASTERTEMPLATES00000000000000009\)/);
  });

  it('returns an empty string for an empty ledger (no dead block in the prompt)', () => {
    assert.equal(renderResources({}), '');
    assert.equal(renderResources(null), '');
  });

  it('sorts cue matches first but keeps everything else', () => {
    const rows = [
      { kind: 'drive_folder', name: 'unrelated stuff', id: 'ZZZZZZZZZZZZ' },
      { kind: 'drive_folder', name: 'signed artifacts', id: 'SSSSSSSSSSSS' },
    ];
    const { ledger } = mergeResources({}, rows, { now: 'T' });
    const lines = renderResources(ledger, { cues: ['signed'] }).split('\n').filter((l) => l.startsWith('- '));
    assert.match(lines[0], /signed artifacts/);
    assert.equal(lines.length, 2, 'a near-miss cue must not hide the rest of the ledger');
  });

  it('flags truncation when over the limit', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ kind: 'doc', name: `d${i}`, id: `IDIDIDIDIDID${i}` }));
    const { ledger } = mergeResources({}, many, { now: 'T' });
    assert.match(renderResources(ledger, { limit: 2 }), /…4 more/);
  });
});

// seedFromProse exists so the planner and the executor seed identically. The planner call is the
// one that matters: when seeding ran only after planning, the plan that writes ids into tasks was
// structured against an empty ledger, and a hand-typed id with one wrong character got pinned into
// the checkpoint skeleton.
describe('seedFromProse', () => {
  it('seeds the ids the person stated in the request', () => {
    const { ledger, added } = seedFromProse({}, REAL_REQUEST, { now: 'T', source: 'request' });
    assert.equal(added, 3, 'all three folders the request named');
    assert.equal(ledger[resourceKey('drive_folder', 'In Progress')].id, '1INPROGRESSFOLDER0000000000000009');
    assert.equal(Object.values(ledger).every((v) => v.source === 'request'), true);
  });

  it('is idempotent: both callers may seed the same text every iteration', () => {
    const first = seedFromProse({}, REAL_REQUEST, { now: 'T1', source: 'request' });
    const second = seedFromProse(first.ledger, REAL_REQUEST, { now: 'T2', source: 'request' });
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.deepEqual(second.ledger, first.ledger);
  });

  // The oscillation guard. A seed runs on every mission iteration, so if prose could overwrite a
  // tool-captured id, a stale id in the request would clobber the corrected one on every pass.
  it('never overwrites an id captured from a tool result', () => {
    const observed = mergeResources({}, [
      { kind: 'drive_folder', name: 'In Progress', id: 'TOOLOBSERVEDIDTOOLOBSERVEDID' },
    ], { now: 'T', source: '1.1' }).ledger;

    const { ledger, added, updated } = seedFromProse(observed, REAL_REQUEST, { now: 'T2', source: 'request' });
    assert.equal(updated, 0, 'prose is a claim; a tool result is an observation');
    assert.equal(ledger[resourceKey('drive_folder', 'In Progress')].id, 'TOOLOBSERVEDIDTOOLOBSERVEDID');
    assert.equal(ledger[resourceKey('drive_folder', 'In Progress')].source, '1.1');
    assert.equal(added, 2, 'the two folders it had not already observed still seed');
  });

  it('returns an empty ledger for prose with no ids, without throwing', () => {
    for (const bad of ['', null, undefined, 'draft three addendums, leave blanks empty']) {
      assert.deepEqual(seedFromProse(undefined, bad, {}), { ledger: {}, added: 0, updated: 0, dropped: 0 });
    }
  });
});

// Two consecutive missions each pinned one id with a single wrong character: the template with
// t→c, then the first advisor's contract with k→c, while transcribing the other ids perfectly.
// One wrong character in one of three is the whole defect.
const TRUE_TEMPLATE = '1TEMPLATEFIXED000000000000000000000000000009';
const TYPO_TEMPLATE = '1TEMPLATEFIXED000000000000000000000X00000009';
const TRUE_FIRST    = '1ADVISORAGREEMENT000000000000000000000000009';
const TYPO_FIRST    = '1ADVISORAGREEMXNT000000000000000000000000009';
const TRUE_SECOND   = '1SECONDAGREEMENT0000000000000000000000000009';

const LEDGER = mergeResources({}, [
  { kind: 'file', name: 'MASTER Comp Addendum Fixed', id: TRUE_TEMPLATE },
  { kind: 'doc', name: 'Advisor One Agreement', id: TRUE_FIRST },
  { kind: 'doc', name: 'Advisor Two Engagement SOW', id: TRUE_SECOND },
], { now: 'T', source: '1.1' }).ledger;

describe('isEditDistanceOne', () => {
  it('catches a single substitution, the observed failure mode', () => {
    assert.equal(isEditDistanceOne(TYPO_FIRST, TRUE_FIRST), true);
    assert.equal(isEditDistanceOne(TYPO_TEMPLATE, TRUE_TEMPLATE), true);
  });

  it('catches one insertion or deletion', () => {
    assert.equal(isEditDistanceOne('abc123def456ghi789jkl012m', 'abc123def456ghi789jkl012'), true);
    assert.equal(isEditDistanceOne('abc123def456ghi789jkl012', 'abc123def456ghi789jkl012m'), true);
    assert.equal(isEditDistanceOne('abcXdef', 'abcdef'), true, 'an insertion mid-string');
  });

  it('rejects identical strings: distance 0 is not distance 1', () => {
    assert.equal(isEditDistanceOne(TRUE_FIRST, TRUE_FIRST), false);
  });

  it('rejects two or more edits, and unrelated ids', () => {
    assert.equal(isEditDistanceOne(TRUE_FIRST, TRUE_SECOND), false);
    assert.equal(isEditDistanceOne('abcde12345abcde12345abcde', 'abXde12345abXde12345abcde'), false);
    assert.equal(isEditDistanceOne('abXcdYef', 'abcdef'), false, 'two insertions');
  });

  it('never throws on non-strings', () => {
    for (const [a, b] of [[null, 'x'], [undefined, undefined], [1, 2], ['x', {}]]) {
      assert.equal(isEditDistanceOne(a, b), false);
    }
  });
});

describe('repairIds', () => {
  it('repairs the exact id that blocked a real mission', () => {
    const task = `Extract the full name and address for the first advisor from the Google Doc with ID ${TYPO_FIRST}.`;
    const { text, repairs, unknown } = repairIds(task, LEDGER);
    assert.equal(text.includes(TRUE_FIRST), true);
    assert.equal(text.includes(TYPO_FIRST), false);
    assert.equal(repairs.length, 1);
    assert.deepEqual({ from: repairs[0].from, to: repairs[0].to }, { from: TYPO_FIRST, to: TRUE_FIRST });
    assert.equal(repairs[0].name, 'Advisor One Agreement', 'names the resource so the log is readable');
    assert.deepEqual(unknown, []);
  });

  it('leaves correct ids untouched and repairs only the broken one', () => {
    const plan = `read ${TRUE_SECOND}, then ${TYPO_FIRST}, then ${TRUE_TEMPLATE}`;
    const { text, repairs } = repairIds(plan, LEDGER);
    assert.equal(repairs.length, 1, 'exactly the one that was wrong');
    assert.equal(text, `read ${TRUE_SECOND}, then ${TRUE_FIRST}, then ${TRUE_TEMPLATE}`);
  });

  // Timidity is the point: a wrong correction is worse than none, because it looks right.
  it('reports an unknown id rather than snapping it to something plausible', () => {
    const novel = '1ZZZZZZZZZZZZZZZZZZZZ9999999999999999999999z';
    const { text, repairs, unknown } = repairIds(`open ${novel}`, LEDGER);
    assert.equal(text, `open ${novel}`, 'an id we have never seen may be perfectly real');
    assert.deepEqual(repairs, []);
    assert.deepEqual(unknown, [novel]);
  });

  it('refuses to choose when two ledger ids are both one edit away', () => {
    const a = 'AAAAAAAAAAAAAAAAAAAAAAAA1';
    const ambiguous = mergeResources({}, [
      { kind: 'doc', name: 'one', id: `${a}b` },
      { kind: 'doc', name: 'two', id: `${a}c` },
    ], { now: 'T' }).ledger;
    const { text, repairs, unknown } = repairIds(`${a}d`, ambiguous);
    assert.equal(text, `${a}d`);
    assert.deepEqual(repairs, []);
    assert.deepEqual(unknown, [`${a}d`]);
  });

  it('ignores commit shas, mission ids, and ordinary prose', () => {
    const sha = '3e25f8b7bfee9a1c2d3e4f5a6b7c8d9e0f1a2b3c';
    const t = `mission w-1700000000001-1a2b3c4d at commit ${sha} duplicated the template`;
    const { text, repairs } = repairIds(t, LEDGER);
    assert.equal(text, t);
    assert.deepEqual(repairs, []);
  });

  it('is a no-op with an empty ledger or empty text', () => {
    assert.deepEqual(repairIds(`x ${TYPO_FIRST}`, {}), { text: `x ${TYPO_FIRST}`, repairs: [], unknown: [] });
    for (const bad of ['', null, undefined]) {
      assert.deepEqual(repairIds(bad, LEDGER), { text: '', repairs: [], unknown: [] });
    }
  });

  it('is idempotent: repairing repaired text changes nothing', () => {
    const once = repairIds(`use ${TYPO_FIRST}`, LEDGER);
    const twice = repairIds(once.text, LEDGER);
    assert.equal(twice.text, once.text);
    assert.deepEqual(twice.repairs, []);
  });
});
