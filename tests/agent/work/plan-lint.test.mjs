// Tests for agent/work/plan-lint.mjs. The shape measured: a task whose input is an identifier an
// earlier task must discover is one outcome wrongly split in two. In the plan that showed it, task 2
// re-resolved "identified in the previous task" from context, picked the wrong template from a
// folder listing, and three documents were built from it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBackReferences, matchBackReference, formatBackReference } from '../../../agent/work/plan-lint.mjs';

// The two tasks, in the shape they had (ids are placeholders, never a real Drive id).
const REAL_PLAN = [
  {
    instruction: 'Gather all required information',
    accept_criteria: 'Master template identified',
    tasks: [
      {
        agent: 'motor',
        task: "Locate the master fixed comp addendum template within the 'master templates folder' (ID: FOLDER_ID).",
      },
      {
        agent: 'motor',
        task: "Duplicate the master template (identified in the previous task) three times into the 'In Progress' Google Drive folder (ID: FOLDER_ID). Name the new documents per advisor.",
      },
    ],
  },
];

describe('findBackReferences: the real failure', () => {
  it("flags the task that must re-resolve a previous task's identifier", () => {
    const f = findBackReferences(REAL_PLAN);
    assert.equal(f.length, 1, 'exactly one bad task in this checkpoint');
    assert.equal(f[0].checkpoint, 1);
    assert.equal(f[0].task, 2, 'task 2 is the one that guessed at the template');
    assert.match(f[0].phrase, /in the previous task/i);
    assert.match(f[0].text, /^Duplicate the master template/);
  });

  it('does not flag the discovering task itself', () => {
    const f = findBackReferences(REAL_PLAN);
    assert.ok(!f.some((x) => x.task === 1), 'task 1 discovers the id, it does not consume one');
    // …and not merely because it is first: its wording carries no back-reference.
    assert.equal(matchBackReference(REAL_PLAN[0].tasks[0].task), null);
  });
});

describe('findBackReferences: only the very first task of a plan is exempt', () => {
  // Deliberately not per checkpoint. A per-checkpoint exemption let the defect through whenever the
  // locate/use split straddled a boundary: the offending task was index 0 of its own checkpoint and
  // went uncounted. A checkpoint boundary does not make a separate dispatch safer at re-resolving
  // an identifier.
  it('flags a cross-checkpoint identifier dependency', () => {
    const plan = [
      { tasks: [{ agent: 'motor', task: 'Locate the master template.' }] },
      { tasks: [{ agent: 'motor', task: 'Using the doc id from the previous checkpoint, apply the replacements.' }] },
    ];
    const found = findBackReferences(plan);
    assert.equal(found.length, 1);
    assert.deepEqual({ checkpoint: found[0].checkpoint, task: found[0].task }, { checkpoint: 2, task: 1 });
  });

  it('exempts the first task of the plan, which has nothing behind it', () => {
    // A backward phrase here points outside the plan entirely, so it means something else.
    assert.deepEqual(
      findBackReferences([{ tasks: [{ agent: 'motor', task: 'Use the folder identified in the previous task.' }] }]),
      [],
    );
  });
});

describe('findBackReferences: false-positive guard', () => {
  // Ordinary sequencing language. None of these says "an input I need was produced by an earlier
  // task", so flagging them would make the metric useless.
  const BENIGN = [
    'After the drafts exist, verify each one opens.',
    'Once the folder is ready, move the three documents into it.',
    'For each advisor, set the fixed monthly amount.',
    'Then verify the result matches the accept criteria.',
    'Create three copies of the template and name them per advisor.',
    'Report the outcome to the requester with a link to each document.',
    'Within the In Progress folder, confirm all three documents are present.',
    'Read the contracts file before editing any placeholder.',
    'Verify the replacements were applied to every document.',
    'Move each draft created in this checkpoint into the destination folder.',
    'Use the folder id from the Known Resources block.',
  ];

  for (const text of BENIGN) {
    it(`does not flag: ${text}`, () => {
      assert.equal(matchBackReference(text), null);
    });
  }

  it('reports nothing for a whole clean checkpoint', () => {
    const plan = [{ tasks: BENIGN.map((task) => ({ agent: 'motor', task })) }];
    assert.deepEqual(findBackReferences(plan), []);
  });
});

describe('findBackReferences: phrasings a planner actually produces', () => {
  // Every one of these is a plausible rewrite of the CP1 task 2 wording; the detector must not be
  // defeated by paraphrase, or the count under-reports the defect.
  const FLAGGED = [
    'Duplicate the template identified in the previous task.',
    'Clone the doc from the previous task into In Progress.',
    'Use the file found in the previous step.',
    'Copy the template identified above three times.',
    'Rename the document found above.',
    'Clone the template from step 1.',
    'Apply the replacements to the doc in the prior task.',
    'Duplicate the master template as determined earlier.',
    'Duplicate the template you located.',
    'Clone the template located earlier.',
    'Read the previously identified master template.',
    'Open the aforementioned master template.',
    'Take the output of the previous step and clone it.',
    'Clone the template identified in task 1.',
    "Build the addendum from the first task's findings.",
  ];

  for (const text of FLAGGED) {
    it(`flags: ${text}`, () => {
      const phrase = matchBackReference(text);
      assert.ok(phrase, 'expected a back-reference phrase');
      assert.ok(text.toLowerCase().includes(phrase.toLowerCase()), 'the phrase is quoted from the task');
    });
  }
});

describe('findBackReferences: numbering across a multi-checkpoint plan', () => {
  it('reports 1-based checkpoint and task numbers in plan order', () => {
    const plan = [
      {
        instruction: 'Gather all required information',
        tasks: [
          { agent: 'motor', task: 'Locate the master template.' },
          { agent: 'motor', task: 'Read the contracts file.' },
          { agent: 'motor', task: 'Clone the template identified in the previous task.' },
        ],
      },
      {
        instruction: 'Create and fill the addendums',
        tasks: [
          { agent: 'motor', task: 'Duplicate the template three times.' },
          { agent: 'motor', task: 'Run docs-batch-edit using the doc id from step 1.' },
        ],
      },
      {
        instruction: 'File them',
        tasks: [{ agent: 'motor', task: 'Move all three into In Progress.' }],
      },
    ];
    const f = findBackReferences(plan);
    assert.equal(f.length, 2);
    assert.deepEqual(f.map((x) => [x.checkpoint, x.task]), [[1, 3], [2, 2]]);
    assert.match(f[0].phrase, /previous task/i);
    assert.match(f[1].phrase, /step 1/i);
  });

  it('uses positional task numbers so a finding maps back to the plan', () => {
    // A textless task still occupies a slot; if it were skipped, every number after it would point
    // at the wrong task in the plan a person is reading.
    const plan = [{
      tasks: [
        { agent: 'motor', task: 'Locate the master template.' },
        { agent: 'motor' },
        { agent: 'motor', task: 'Clone the template found in the previous step.' },
      ],
    }];
    const f = findBackReferences(plan);
    assert.equal(f.length, 1);
    assert.equal(f[0].task, 3);
  });
});

describe('findBackReferences: the instruction field', () => {
  it('reads a task carrying its text as `instruction` rather than `task`', () => {
    // extractCheckpoints normalizes to `task`, but plans arrive from the cortex with either key,
    // and a lint that only reads one key silently passes everything.
    const plan = [{
      tasks: [
        { agent: 'motor', instruction: 'Locate the master template.' },
        { agent: 'motor', instruction: 'Duplicate the template identified in the previous task.' },
      ],
    }];
    const f = findBackReferences(plan);
    assert.equal(f.length, 1);
    assert.equal(f[0].task, 2);
    assert.equal(f[0].text, 'Duplicate the template identified in the previous task.');
  });

  it('falls through an empty `task` to `instruction`', () => {
    const plan = [{
      tasks: [
        { agent: 'motor', task: 'Locate the master template.' },
        { agent: 'motor', task: '', instruction: 'Clone the template from the previous task.' },
      ],
    }];
    assert.equal(findBackReferences(plan).length, 1);
  });
});

describe('findBackReferences: never throws', () => {
  it('tolerates a malformed plan', () => {
    assert.deepEqual(findBackReferences(null), []);
    assert.deepEqual(findBackReferences(undefined), []);
    assert.deepEqual(findBackReferences([]), []);
    assert.deepEqual(findBackReferences({}), [], 'non-array input');
    assert.deepEqual(findBackReferences('checkpoints'), []);
    assert.deepEqual(findBackReferences([null, undefined, 'cp']), []);
    assert.deepEqual(findBackReferences([{}]), [], 'checkpoint with no tasks');
    assert.deepEqual(findBackReferences([{ tasks: 'nope' }]), []);
    assert.deepEqual(findBackReferences([{ tasks: [{}, {}] }]), [], 'tasks with no text');
    assert.deepEqual(findBackReferences([{ tasks: [{ agent: 'motor', task: 42 }, { task: null }] }]), []);
  });

  it('handles string tasks as their own text', () => {
    const plan = [{ tasks: ['Locate the master template.', 'Clone the one from the previous task.'] }];
    const f = findBackReferences(plan);
    assert.equal(f.length, 1);
    assert.equal(f[0].task, 2);
    assert.equal(f[0].text, 'Clone the one from the previous task.');
  });
});

describe('matchBackReference / formatBackReference', () => {
  it('returns null for empty and non-string input', () => {
    assert.equal(matchBackReference(''), null);
    assert.equal(matchBackReference(null), null);
    assert.equal(matchBackReference(undefined), null);
    assert.equal(matchBackReference(123), null);
    assert.equal(matchBackReference({}), null);
  });

  it('is case-insensitive and collapses whitespace in the reported phrase', () => {
    // The phrase is quoted from the task, so it keeps the planner's own casing.
    assert.equal(matchBackReference('Clone the template IDENTIFIED IN THE PREVIOUS TASK.'), 'IN THE PREVIOUS TASK');
    assert.equal(matchBackReference('Clone the doc\n  from the\n  previous task.'), 'from the previous task');
  });

  it('is stateless across repeated calls on the same pattern', () => {
    // A /g regex reused across tasks would skip findings after the first; guard that.
    const text = 'Clone the template identified in the previous task.';
    assert.equal(matchBackReference(text), matchBackReference(text));
  });

  it('formats one log line per finding', () => {
    const [f] = findBackReferences(REAL_PLAN);
    const line = formatBackReference(f);
    assert.match(line, /^CP1 task 2 back-ref "in the previous task": Duplicate the master template/);
    assert.ok(!line.includes('\n'), 'one line');
    assert.equal(formatBackReference(null), '');
  });

  it('truncates a long task text so the log line stays readable', () => {
    const long = { checkpoint: 1, task: 2, phrase: 'from the previous task', text: 'x'.repeat(300) };
    assert.ok(formatBackReference(long).length < 160);
    assert.match(formatBackReference(long), /…$/);
  });
});
