// Tests for dev/loop/planner.mjs: the open items read from OPEN_ITEMS.md; the items already planned left
// out; the planner's brief and its answer checked (a candidate's key, a one-line title, 1 to 5 points);
// the issue it opens, with the OPEN_ITEMS point and the item's marker; nothing planned past the open
// limit, when every item is planned, on a skip or a refused answer, or in a dry run; the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_SUITE_VERSION } from '../../../dev/harness2/model-suite.mjs';
import { BENCH_VERSION, selectBenchItems } from '../../../dev/harness2/bench.mjs';
import { issueTarget, summarizeBaseline, taskPlanKey } from '../../../dev/loop/baseline.mjs';
import { LOOP_DEFAULTS } from '../../../dev/loop/config.mjs';
import {
  PLAN_LIMITS, benchBaselineCurrent, buildPlanBrief, buildPlanRetryBrief, issueBody, itemKey, main, openItems, parsePlan, planIssue, planLaneIssue,
  plannedKeys,
} from '../../../dev/loop/planner.mjs';
import { doneWhen } from '../../../dev/loop/reviewer.mjs';

const MARKDOWN = [
  '# Open items',
  '',
  'What one phase hands to a later one.',
  '',
  '## Found while building the dashboard (phase 6)',
  '',
  '- **Copied constants.** The dashboard copies `AGENT_SENDER` and the',
  '  collection names instead of importing them.',
  '- **Structured gateway log lines.** `brain-telemetry-read` parses the gateway\'s log text.',
  '',
  '## Phase 8\'s live check',
  '',
  'Some prose, then:',
  '- **Spaces, not direct messages.** An account reads a direct message.',
].join('\r\n');
const ITEMS = openItems(MARKDOWN);

test('the open items: each bold bullet, its wrapped lines joined, under its section', () => {
  assert.deepEqual(ITEMS, [
    { key: 'copied-constants', title: 'Copied constants', text: 'The dashboard copies `AGENT_SENDER` and the collection names instead of importing them.', section: 'Found while building the dashboard (phase 6)' },
    { key: 'structured-gateway-log-lines', title: 'Structured gateway log lines', text: "`brain-telemetry-read` parses the gateway's log text.", section: 'Found while building the dashboard (phase 6)' },
    { key: 'spaces-not-direct-messages', title: 'Spaces, not direct messages', text: 'An account reads a direct message.', section: "Phase 8's live check" },
  ]);
  assert.equal(itemKey('One Firestore client.'), 'one-firestore-client');
  assert.deepEqual([...plannedKeys([{ body: 'x <!-- loop-plan: copied-constants --> y' }, { body: null }])], ['copied-constants']);
});

test('the brief: the candidates as data, what to skip, and the form of the answer', () => {
  const brief = buildPlanBrief({ items: ITEMS });
  assert.match(brief, /<items>\n\[copied-constants\] \(Found while building the dashboard \(phase 6\)\) Copied constants\. The dashboard copies/);
  assert.match(brief, /Skip an item that asks a person to decide something, needs live infrastructure/);
  assert.match(brief, /would change what judges a change \(dev\/loop\//);
  assert.match(brief, /Do not add a point about OPEN_ITEMS\.md: that one is added for you\./);
  assert.match(brief, /Ask for tests in a new test file under tests\/, named for what it tests: a test file that exists already may not be changed/);
  assert.match(brief, /\{"key": "<the key in brackets>", "title": /);
  assert.match(brief, /If no candidate fits, answer \{"skip": "<why>"\} instead\./);
  assert.match(brief, /the title is one line of 10 to 120 characters; each point is one line of at most 400 characters \(split a longer one into two points\)/,
    'the brief states every limit parsePlan refuses past');
});

test('a retry brief repeats the brief, quotes the refused answer as data, and names the problems', () => {
  const brief = buildPlanBrief({ items: ITEMS });
  const retry = buildPlanRetryBrief({ brief, output: `I looked around.\n${answer({ doneWhen: ['x'.repeat(401)] })}`, problems: ['each point must be one line of at most 400 characters (point 1 has 401)'] });
  assert.ok(retry.startsWith(brief));
  assert.match(retry, /<answer>\n```json\n\{"key":"copied-constants"/);
  assert.doesNotMatch(retry, /I looked around/, 'only the answer is quoted');
  assert.match(retry, /Why it was refused:\n- each point must be one line of at most 400 characters \(point 1 has 401\)/);
});

const answer = (o) => `I read the code.\n\`\`\`json\n${JSON.stringify({ key: 'copied-constants', title: 'The dashboard imports the agent constants it copies', context: 'It copies them.', doneWhen: ['dashboard/lib imports AGENT_SENDER from agent/providers/channel.mjs.', 'A new test under tests/dashboard/ checks the values match.'], ...o })}\n\`\`\`\n`;

test("the planner's answer is checked: a candidate's key, a one-line title, 1 to 5 one-line points; or a skip", () => {
  const { plan } = parsePlan(answer({}), ITEMS);
  assert.deepEqual(plan, {
    key: 'copied-constants', title: 'The dashboard imports the agent constants it copies', context: 'It copies them.',
    doneWhen: ['dashboard/lib imports AGENT_SENDER from agent/providers/channel.mjs.', 'A new test under tests/dashboard/ checks the values match.'],
  });
  assert.match(parsePlan(answer({ key: 'not-an-item' }), ITEMS).problems[0], /'not-an-item' is not one of the candidates/);
  assert.match(parsePlan(answer({ title: 'Short' }), ITEMS).problems.join(' | '), /one line of 10 to 120 characters/);
  assert.match(parsePlan(answer({ doneWhen: [] }), ITEMS).problems.join(' | '), /1 to 5 points/);
  assert.match(parsePlan(answer({ doneWhen: ['a', 'b', 'c', 'd', 'e', 'f'] }), ITEMS).problems.join(' | '), /1 to 5 points/);
  assert.match(parsePlan(answer({ doneWhen: ['one\ntwo'] }), ITEMS).problems.join(' | '), /each point must be one line .*\(point 1 has 7 and breaks lines\)/);
  assert.match(parsePlan(answer({ doneWhen: ['ok', 'y'.repeat(PLAN_LIMITS.pointMax + 1)] }), ITEMS).problems.join(' | '), /at most 400 characters \(point 2 has 401\)/);
  assert.ok(parsePlan(answer({ doneWhen: ['z'.repeat(PLAN_LIMITS.pointMax)] }), ITEMS).plan, 'a point of exactly the limit passes');
  assert.deepEqual(parsePlan('```json\n{"skip": "each needs a person"}\n```', ITEMS), { plan: null, skip: 'each needs a person', problems: [] });
  assert.match(parsePlan('no answer', ITEMS).problems[0], /no answer in the form asked/);
  const existing = answer({ doneWhen: ['`tests/agent/services/control/responsibilities.test.mjs` verifies the full instruction.', 'A new tests/dashboard/constants.test.mjs checks them.'] });
  const exists = (p) => p === 'tests/agent/services/control/responsibilities.test.mjs';
  assert.match(parsePlan(existing, ITEMS, { exists }).problems.join(' | '), /ask for changes to existing test files, which no change may make: tests\/agent\/services\/control\/responsibilities\.test\.mjs$/);
  assert.equal(parsePlan(existing, ITEMS).plan.key, 'copied-constants', 'nothing exists: a new test file is fine');
});

test("the issue: its context, the item quoted, its points, the OPEN_ITEMS point, and the item's marker; the reviewer reads its points", () => {
  const { plan } = parsePlan(answer({}), ITEMS);
  const body = issueBody(plan, ITEMS[0]);
  assert.match(body, /^It copies them\.\n\nFrom `docs\/plan\/OPEN_ITEMS\.md` \(Found while building the dashboard \(phase 6\)\):\n\n> \*\*Copied constants\.\*\* The dashboard copies/);
  assert.match(body, /<!-- loop-plan: copied-constants -->$/);
  assert.deepEqual(doneWhen({ title: plan.title, body }), [
    'dashboard/lib imports AGENT_SENDER from agent/providers/channel.mjs.',
    'A new test under tests/dashboard/ checks the values match.',
    'The item "Copied constants" is removed from `docs/plan/OPEN_ITEMS.md`, or updated to say what remains.',
  ]);
});

/** A fake gh: the loop issues open and of every state, the stuck ones, and the issue it creates. */
function fakeGh({ open = [], all = [], stuck = [] } = {}) {
  const calls = [];
  return {
    calls,
    exec(args) {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') {
        const label = args[args.indexOf('--label') + 1];
        const state = args[args.indexOf('--state') + 1];
        return JSON.stringify(label === 'loop-stuck' ? stuck : state === 'open' ? open : all);
      }
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/your-org/paraclete/issues/77';
      return '';
    },
  };
}

const settings = { ...LOOP_DEFAULTS, planner: { ...LOOP_DEFAULTS.planner, command: 'planner' } };
const plan = (gh, o = {}) => planIssue({
  repoRoot: '/repo', repo: 'your-org/paraclete', settings, execGh: gh.exec, readFile: () => MARKDOWN,
  planner: async ({ brief }) => ({ output: o.output ?? answer({}), reason: null, brief }), ...o,
});

test('an issue is planned from an item not yet planned, and opened with the loop label', async () => {
  const gh = fakeGh({ all: [{ body: '<!-- loop-plan: structured-gateway-log-lines -->' }] });
  let asked = '';
  const res = await plan(gh, { planner: async ({ brief, cwd }) => { asked = `${cwd}\n${brief}`; return { output: answer({}), reason: null }; } });
  assert.equal(res.issue.number, 77);
  assert.equal(res.issue.title, 'The dashboard imports the agent constants it copies');
  assert.match(asked, /^\/repo\n/, 'the planner reads the checkout');
  assert.match(asked, /\[copied-constants\]/);
  assert.doesNotMatch(asked, /\[structured-gateway-log-lines\]/, 'a planned item is never offered again');
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.deepEqual([create[create.indexOf('--label') + 1], create[create.indexOf('--title') + 1]], ['loop', 'The dashboard imports the agent constants it copies']);
  assert.match(create[create.indexOf('--body') + 1], /<!-- loop-plan: copied-constants -->/);
});

test("a refused answer is asked for again with its problems, planner.retries times, and only then refused", async () => {
  const briefs = [];
  const answers = [answer({ doneWhen: ['w'.repeat(500)] }), answer({})];
  const gh = fakeGh();
  const res = await plan(gh, { planner: async ({ brief }) => { briefs.push(brief); return { output: answers.shift(), reason: null }; } });
  assert.equal(res.issue.number, 77, 'the second answer passed and opened the issue');
  assert.equal(briefs.length, 2);
  assert.match(briefs[1], /Why it was refused:\n- each point must be one line of at most 400 characters \(point 1 has 500\)/);

  let asked = 0;
  const refused = await plan(fakeGh(), { planner: async () => { asked += 1; return { output: answer({ key: 'nope' }), reason: null }; } });
  assert.equal(asked, 1 + LOOP_DEFAULTS.planner.retries);
  assert.match(refused.reason, /the planner's answer was refused: 'nope' is not one of the candidates/);
  let once = 0;
  await plan(fakeGh(), { settings: { ...settings, planner: { ...settings.planner, retries: 0 } }, planner: async () => { once += 1; return { output: answer({ key: 'nope' }), reason: null }; } });
  assert.equal(once, 1, 'retries 0: asked once');
  let skipped = 0;
  await plan(fakeGh(), { planner: async () => { skipped += 1; return { output: '{"skip": "none fits"}', reason: null }; } });
  assert.equal(skipped, 1, 'a skip is an answer: not asked again');
});

/** A baseline in which main's head fails `tests pass` of se-fix-failing-test in both runs. */
const SUMMARY = {
  suiteVersion: MODEL_SUITE_VERSION, commit: 'c'.repeat(40), at: '2027-01-21T06:00:00.000Z', trials: 2, measured: true,
  tasks: [
    { id: 'se-fix-failing-test', role: 'software-engineer', split: 'train', runs: 2, measuredRuns: 2, score: 0.5,
      checks: [{ name: 'tests pass', runs: 2, failed: 2, detail: 'not ok 1 - sums a range' }, { name: 'only the source changed', runs: 3, failed: 1 }] },
    { id: 'se-implement-from-spec', role: 'software-engineer', split: 'holdout', runs: 2, measuredRuns: 2, score: 0 },
  ],
};

/** A git whose origin/main is `head`, with `changed` the paths that differ from the baseline's commit. */
const gitAt = (head, changed = []) => (args) => (args[0] === 'rev-parse' ? head : args[0] === 'diff' ? changed.join('\n') : '');

test("a training task main's head fails is planned first, by code, with its failing checks and its target", async () => {
  const gh = fakeGh();
  let asked = 0;
  const res = await plan(gh, { baseline: () => SUMMARY, execGit: gitAt(SUMMARY.commit), planner: async () => { asked += 1; return { output: answer({}), reason: null }; } });
  assert.equal(asked, 0, 'no planner model is asked');
  assert.equal(res.issue.number, 77);
  assert.equal(res.issue.title, "The software-engineer agent passes the se-fix-failing-test task's checks");
  const body = res.issue.body;
  assert.match(body, /^On main's head \(`cccccccccccc`\), the agent fails checks of the model suite's training task `se-fix-failing-test` \(role `software-engineer`\): 2 real-model run\(s\) in the baseline of 2027-01-21, capability 0\.5\./);
  assert.match(body, /\n- `tests pass` failed in 2 of 2 runs: not ok 1 - sums a range\n/);
  assert.doesNotMatch(body, /only the source changed/, 'a check failing in fewer than half the runs is not named');
  assert.doesNotMatch(body, /se-implement-from-spec/, 'a held-out task never reaches an issue');
  assert.match(body, /\nThe task asks the agent:\n\n> /);
  assert.equal(issueTarget(body), 'se-fix-failing-test');
  const task = { ...SUMMARY.tasks[0], failing: [SUMMARY.tasks[0].checks[0]] };
  assert.match(body, new RegExp(`<!-- loop-plan: ${taskPlanKey(task)} -->`));
  const points = doneWhen(res.issue);
  assert.equal(points.length, 2);
  assert.match(points[0], /^The change is to what the agent reads or runs/);
  assert.match(points[1], /nothing in it names this task, its files or its wording\.$/);
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.equal(create[create.indexOf('--label') + 1], 'loop');

  const planned = await plan(fakeGh({ all: [{ body: `<!-- loop-plan: ${taskPlanKey(task)} -->` }] }), { baseline: () => SUMMARY, execGit: gitAt(SUMMARY.commit) });
  assert.equal(planned.issue.title, 'The dashboard imports the agent constants it copies', 'a failure planned already: on to the open items');
  const dry = await plan(fakeGh(), { baseline: () => SUMMARY, execGit: gitAt(SUMMARY.commit), dryRun: true });
  assert.deepEqual([dry.issue, dry.plan.target], [null, 'se-fix-failing-test']);
});

test('nothing is planned from a baseline of an older head when what the agent reads changed since', async () => {
  const logs = [];
  const stale = await plan(fakeGh(), { baseline: () => SUMMARY, execGit: gitAt('d'.repeat(40), ['agent/services/brain/main.mjs', 'docs/guide.md']), log: (l) => logs.push(l) });
  assert.equal(stale.issue.title, 'The dashboard imports the agent constants it copies', 'on to the open items');
  assert.match(logs.join('\n'), /not planning from the baseline: what the agent reads changed since the baseline of cccccccccccc \(agent\/services\/brain\/main\.mjs\)/);
  const docsOnly = await plan(fakeGh(), { baseline: () => SUMMARY, execGit: gitAt('d'.repeat(40), ['docs/guide.md', 'dev/loop/README.md']) });
  assert.equal(docsOnly.plan.target, 'se-fix-failing-test', 'main moved, but nothing the agent reads: the baseline still holds');
  const broken = await plan(fakeGh(), { baseline: () => SUMMARY, execGit: () => { throw new Error('fatal: bad object'); } });
  assert.equal(broken.plan.target, undefined, 'a baseline that cannot be compared is not planned from');
});

test('nothing is planned past the open limit, with every item planned, on a skip, a refused answer, or in a dry run', async () => {
  const two = [{ body: '' }, { body: '' }];
  assert.match((await plan(fakeGh({ open: two }))).reason, /2 loop issue\(s\) are open, the planner's limit is 2/);
  const everyKey = ITEMS.map((i) => ({ body: `<!-- loop-plan: ${i.key} -->` }));
  assert.match((await plan(fakeGh({ all: everyKey.slice(0, 2), stuck: everyKey.slice(2) }))).reason, /every item of docs\/plan\/OPEN_ITEMS\.md has been planned/, 'stuck issues count as planned');
  assert.match((await plan(fakeGh(), { output: '{"skip": "each needs a person"}' })).reason, /found no item to plan: each needs a person/);
  assert.match((await plan(fakeGh(), { output: answer({ key: 'nope' }) })).reason, /the planner's answer was refused: 'nope' is not one of the candidates/);
  const gh = fakeGh();
  const dry = await plan(gh, { dryRun: true });
  assert.equal(dry.issue, null);
  assert.match(dry.plan.body, /<!-- loop-plan: copied-constants -->/);
  assert.equal(gh.calls.some((a) => a[1] === 'create'), false);
  assert.match((await planIssue({ repoRoot: '/repo', settings: LOOP_DEFAULTS, execGh: fakeGh().exec, readFile: () => MARKDOWN })).reason, /no planner command: set planner\.command/);
});

test('the command: 0 when it planned or would, 1 when not, 2 for a usage mistake', async () => {
  const out = { text: '', write(s) { this.text += s; } };
  const deps = (o = {}) => ({ repoRoot: '/repo', settings, execGh: fakeGh().exec, readFile: () => MARKDOWN, planner: async () => ({ output: answer({}), reason: null }), stdout: out, ...o });
  assert.equal(await main(['--dry-run'], deps()), 0);
  assert.match(out.text, /^would plan: The dashboard imports the agent constants it copies\n/);
  assert.equal(await main([], deps({ planner: async () => ({ output: '{"skip": "none"}', reason: null }) })), 1);
  assert.equal(await main(['--bogus'], deps({ stderr: { write() {} } })), 2);
});

/** A bench baseline of the cerebellum at `commit`, with `failing` training items failing a check in every run. */
function benchSummary({ commit = 'a'.repeat(40), failing = [] } = {}) {
  const items = selectBenchItems({ organ: 'cerebellum' });
  const runs = items.flatMap((item) => [1, 2].map((trial) => {
    const bad = failing.includes(item.id);
    return {
      taskId: item.id, trial, split: item.split, measured: true, checkScore: bad ? 0 : 1,
      checks: [{ name: `the verifier's verdict is ${item.expect}`, ok: !bad, ...(bad ? { detail: 'got pass' } : {}) }],
    };
  }));
  return summarizeBaseline({ trials: 2, trajectories: runs }, { commit, at: '2027-01-21T10:00:00Z', tasks: items, suite: 'bench:cerebellum', version: BENCH_VERSION });
}

/** git in the checkout, as the bench baseline's currency reads it. */
const benchGitAt = ({ head, changed = [] }) => (args) => {
  if (args[0] === 'rev-parse') return head;
  if (args[0] === 'diff') return changed.join('\n');
  if (args[0] === 'ls-files') return ['agent/organs/cerebellum/verify.mjs', 'prompts/motor.md', 'agent/gateway/turn-loop.mjs'].join('\n');
  return '';
};

test("an organ's lane plans from its bench baseline: a failing training item becomes an issue for its module, targeting the item", () => {
  const train = selectBenchItems({ organ: 'cerebellum', split: 'train' })[0];
  const held = selectBenchItems({ organ: 'cerebellum', split: 'holdout' })[0];
  const summary = benchSummary({ failing: [train.id, held.id] });
  const gh = fakeGh();
  const res = planLaneIssue({ repoRoot: '/repo', repo: 'your-org/paraclete', settings, execGh: gh.exec, execGit: benchGitAt({ head: 'a'.repeat(40) }), organ: 'cerebellum', summary });
  assert.equal(res.issue.number, 77, res.reason);
  assert.equal(res.plan.target, train.id, 'a held-out item is never planned');
  assert.equal(res.issue.title, `The cerebellum passes its bench's ${train.id} checks`);
  const body = gh.calls.find((a) => a[1] === 'create')[gh.calls.find((a) => a[1] === 'create').indexOf('--body') + 1];
  assert.equal(issueTarget(body), train.id);
  assert.match(body, /<!-- loop-module: organ:cerebellum -->/);
  assert.match(body, new RegExp(`<!-- loop-plan: bench-cerebellum-${train.id}-v${BENCH_VERSION}-[0-9a-f]{8} -->`));
  assert.match(body, /failed in 2 of 2 runs: got pass/);
  assert.equal(doneWhen({ body }).length, 2);
  assert.doesNotMatch(body, new RegExp(train.acceptCriteria.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), "the item's own wording is not quoted");

  const planned = fakeGh({ all: [{ body: `<!-- loop-plan: ${res.plan.key} -->` }] });
  assert.match(planLaneIssue({ repoRoot: '/repo', settings, execGh: planned.exec, execGit: benchGitAt({ head: 'a'.repeat(40) }), organ: 'cerebellum', summary }).reason,
    /no training item of the cerebellum's bench fails a check in its latest baseline, unplanned/);
  const full = fakeGh({ open: [{ body: '<!-- loop-module: organ:cerebellum -->' }, { body: '<!-- loop-module: organ:cerebellum -->' }, { body: 'global' }] });
  assert.match(planLaneIssue({ repoRoot: '/repo', settings, execGh: full.exec, execGit: benchGitAt({ head: 'a'.repeat(40) }), organ: 'cerebellum', summary }).reason,
    /2 issue\(s\) for organ:cerebellum are open, the planner's limit is 2/, 'only its own issues count against the limit');
});

test("a bench baseline describes main until main changes what a bench run reaches", () => {
  const summary = benchSummary({ failing: [selectBenchItems({ organ: 'cerebellum', split: 'train' })[0].id] });
  const at = (o) => benchBaselineCurrent({ repoRoot: '/repo', summary, organ: 'cerebellum', execGit: benchGitAt({ head: 'b'.repeat(40), ...o }) });
  assert.deepEqual(benchBaselineCurrent({ repoRoot: '/repo', summary, organ: 'cerebellum', execGit: benchGitAt({ head: summary.commit }) }), { current: true, reason: null });
  assert.equal(at({ changed: ['prompts/motor.md', 'docs/GLOSSARY.md'] }).current, true, "another organ's file, and nothing the agent reads");
  assert.match(at({ changed: ['agent/gateway/turn-loop.mjs'] }).reason, /what the cerebellum's bench reaches changed since its baseline of a{12} \(agent\/gateway\/turn-loop\.mjs\)/);
  const gh = fakeGh();
  assert.match(planLaneIssue({ repoRoot: '/repo', settings, execGh: gh.exec, execGit: benchGitAt({ head: 'b'.repeat(40), changed: ['agent/organs/cerebellum/verify.mjs'] }), organ: 'cerebellum', summary }).reason,
    /not planning from the cerebellum's bench baseline: what the cerebellum's bench reaches changed/);
  assert.equal(gh.calls.some((a) => a[1] === 'create'), false);
  assert.match(benchBaselineCurrent({ repoRoot: '/repo', summary: null, organ: 'cerebellum', execGit: benchGitAt({ head: 'x' }) }).reason, /there is no bench baseline/);
});
