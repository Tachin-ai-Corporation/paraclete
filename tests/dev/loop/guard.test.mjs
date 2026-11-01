// Tests for dev/loop/guard.mjs and .github/workflows/loop-guard.yml: a loop pull request passes only with
// an open `loop` issue it resolves, no referee or existing-test change, a test with any code change, a
// review whose points are the issue's "Done when" as it reads now and whose verdict passes when judged
// afresh, the reviewed files exactly, and measured evidence for a behaviour change; any other pull
// request passes at once; the workflow runs on every change with the base branch's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromotionEvidence, formatEvidenceMarkdown } from '../../../dev/harness2/evidence.mjs';
import { MODEL_SUITE_VERSION, selectModelTasks } from '../../../dev/harness2/model-suite.mjs';
import { BENCH_VERSION, selectBenchItems } from '../../../dev/harness2/bench.mjs';
import { isLoopBranch, loopGuard, main, parseReviewBlock, resolvedIssue } from '../../../dev/loop/guard.mjs';
import { doneWhen, formatReviewMarkdown } from '../../../dev/loop/reviewer.mjs';
import { revertBody } from '../../../dev/loop/sentinel.mjs';
import { readRepoFile } from '../../repo/repo-files.mjs';

const ISSUE = {
  number: 33,
  title: 'The mission page shows an approval gate as its own row',
  body: 'Gates are skipped.\n\n**Done when:**\n- The plan shows each gate as its own row.\n- The change is covered by new tests.\n',
  state: 'OPEN',
  labels: [{ name: 'loop' }],
};
const ITEMS = doneWhen(ISSUE);
const SHA = { plan: 'a'.repeat(40), test: 'b'.repeat(40) };
const FILES = [
  { filename: 'dashboard/components/work/WorkPlan.jsx', status: 'modified', sha: SHA.plan },
  { filename: 'tests/dashboard/components/work/work-plan.test.mjs', status: 'added', sha: SHA.test },
];
const REVIEWED = { 'dashboard/components/work/WorkPlan.jsx': SHA.plan, 'tests/dashboard/components/work/work-plan.test.mjs': SHA.test };
const met = (items) => ({ items: items.map((_, i) => ({ n: i + 1, met: true, evidence: 'seen' })), resolves: true, problems: [] });

const body = ({ review = met(ITEMS), items = ITEMS, files = REVIEWED, extra = '' } = {}) => [
  'Resolves #33.', '', '## Checks', '', formatReviewMarkdown(review, items, files), extra,
].join('\n');
const pr = (o = {}) => ({ headRefName: 'loop/33-the-mission-page', isCrossRepository: false, body: body(), ...o });
const check = (o = {}) => loopGuard({
  pr: pr(o.pr), files: o.files || FILES, issue: o.issue === undefined ? ISSUE : o.issue, mainChanged: o.mainChanged === undefined ? [] : o.mainChanged,
});
/** The marker a measured pull request carries: the commit of main it was measured against. */
const MEASURED_ON = 'e'.repeat(40);
const measuredOn = `\n<!-- loop-measured-base: ${MEASURED_ON} -->`;

test('only a loop branch of this repository is checked; the pieces', () => {
  assert.equal(isLoopBranch('loop/33-x'), true);
  assert.equal(isLoopBranch('harness2/x'), false);
  assert.deepEqual(check({ pr: { headRefName: 'claude/work' } }), { loop: false, ok: true, problems: [], issue: null });
  assert.deepEqual(check({ pr: { isCrossRepository: true } }), { loop: false, ok: true, problems: [], issue: null }, 'a fork can name its branch anything');
  assert.equal(resolvedIssue('Resolves #33.\n'), 33);
  assert.equal(resolvedIssue('Fixes the thing'), null);
  assert.deepEqual(parseReviewBlock(body()).files, REVIEWED);
  assert.equal(parseReviewBlock('no block'), null);
});

test('a loop pull request with a passing review of the files it changes passes', () => {
  assert.deepEqual(check(), { loop: true, ok: true, problems: [], issue: 33 });
});

test('the issue: named, open and labelled loop', () => {
  assert.match(check({ pr: { body: body().replace('Resolves #33.', 'Done.') } }).problems.join(' | '), /names no issue it resolves/);
  assert.match(check({ issue: null }).problems.join(' | '), /issue #33 could not be read/);
  assert.match(check({ issue: { ...ISSUE, state: 'CLOSED' } }).problems.join(' | '), /issue #33 is not open/);
  assert.match(check({ issue: { ...ISSUE, labels: [] } }).problems.join(' | '), /issue #33 is not labelled loop/);
});

test("the cycle's rules again: the referee, existing tests, and a test with any code change", () => {
  const referee = [...FILES, { filename: '.github/workflows/ci.yml', status: 'modified', sha: 'c'.repeat(40) }];
  assert.match(check({ files: referee }).problems.join(' | '), /\.github\/workflows\/ci\.yml judges changes or runs the loop/);
  const weakened = [...FILES, { filename: 'tests/agent/old.test.mjs', status: 'removed', sha: 'd'.repeat(40) }];
  assert.match(check({ files: weakened }).problems.join(' | '), /tests\/agent\/old\.test\.mjs is an existing test/);
  const untested = [FILES[0]];
  assert.match(check({ files: untested }).problems.join(' | '), /changes code \(dashboard\/components\/work\/WorkPlan\.jsx\) and adds no test/);
  assert.match(check({ files: [] }).problems.join(' | '), /changes no file/);
});

test('the review is judged afresh against the issue as it reads now; its own verdict counts for nothing', () => {
  assert.match(check({ pr: { body: 'Resolves #33.\n' } }).problems.join(' | '), /carries no review block/);
  const short = { items: [{ n: 1, met: true, evidence: 'e' }, { n: 2, met: false, evidence: 'no test' }], resolves: false, problems: [] };
  const forged = body({ review: short }).replace('"resolves":false', '"resolves":true');
  assert.match(check({ pr: { body: forged } }).problems.join(' | '), /its review does not pass: point 2 is not met/);
  const edited = { ...ISSUE, body: `${ISSUE.body.trim()}\n- The README says so.\n` };
  assert.match(check({ issue: edited }).problems.join(' | '), /judged points other than issue #33's "Done when" as it reads now/);
  assert.match(check({ pr: { body: body({ review: met([]), items: [] }) } }).problems.join(' | '), /its review does not pass: it judged no point/);
});

test('what merges is what was reviewed, file by file', () => {
  const pushedLater = [{ ...FILES[0], sha: 'e'.repeat(40) }, FILES[1]];
  assert.match(check({ files: pushedLater }).problems.join(' | '), /it is not the change that was reviewed: dashboard\/components\/work\/WorkPlan\.jsx differ/);
  const extra = [...FILES, { filename: 'docs/guide.md', status: 'modified', sha: 'f'.repeat(40) }];
  assert.match(check({ files: extra }).problems.join(' | '), /docs\/guide\.md differ from the reviewed files/);
  const removedFile = [...FILES, { filename: 'docs/old.md', status: 'removed', sha: '1'.repeat(40) }];
  assert.equal(check({ files: removedFile, pr: { body: body({ files: { ...REVIEWED, 'docs/old.md': null } }) } }).ok, true, 'a removal is reviewed as null');
  assert.match(check({ pr: { body: body({ files: {} }) } }).problems.join(' | '), /not the change that was reviewed/, 'a review that names no files binds nothing');
});

const runs = (caps, taskId = 't', split = 'train') => caps.map((capability, i) => ({ taskId, split, trial: i + 1, capability, measured: true }));
/** Every active task of the model suite, passing on both sides: what a whole measurement covers. */
const everyTask = () => selectModelTasks().flatMap((task) => runs([1, 1, 1], task.id, task.split));
const evidence = (touchedPaths, cand = [0.8, 0.8, 0.8], { tasks = everyTask(), suite = { name: 'model', version: MODEL_SUITE_VERSION } } = {}) => buildPromotionEvidence({
  candidate: { id: 'loop-33', lens: 'LOOP', touchedPaths, proposal: { source: 'coding-agent' } },
  baselineTrajectories: [...runs([0.8, 0.8, 0.8]), ...tasks], candidateTrajectories: [...runs(cand), ...tasks],
  suite,
});

test("a change to the agent's behaviour carries measured evidence that names its files and shows nothing worse", () => {
  const agentFiles = [{ filename: 'agent/work/thing.mjs', status: 'modified', sha: SHA.plan }, { filename: 'tests/agent/thing.test.mjs', status: 'added', sha: SHA.test }];
  const reviewed = { 'agent/work/thing.mjs': SHA.plan, 'tests/agent/thing.test.mjs': SHA.test };
  const touched = ['agent/work/thing.mjs', 'tests/agent/thing.test.mjs'];
  const withEvidence = (e) => body({ files: reviewed, extra: e ? `\n${formatEvidenceMarkdown(e)}${measuredOn}` : '' });
  assert.match(check({ files: agentFiles, pr: { body: withEvidence(null) } }).problems.join(' | '), /changes the agent's behaviour and carries no evidence block/);
  assert.equal(check({ files: agentFiles, pr: { body: withEvidence(evidence(touched)) } }).ok, true);
  assert.match(check({ files: agentFiles, pr: { body: withEvidence(evidence(['agent/work/thing.mjs'])) } }).problems.join(' | '), /its evidence did not measure tests\/agent\/thing\.test\.mjs/);
  assert.match(check({ files: agentFiles, pr: { body: withEvidence(evidence(touched, [0.5, 0.5, 0.5])) } }).problems.join(' | '), /got worse/);
  const [first, ...others] = selectModelTasks();
  const partial = evidence(touched, undefined, { tasks: others.flatMap((task) => runs([1, 1, 1], task.id, task.split)) });
  assert.match(check({ files: agentFiles, pr: { body: withEvidence(partial) } }).problems.join(' | '), new RegExp(`its evidence has no runs on both sides of ${first.id}$`));
  const oldSuite = evidence(touched, undefined, { suite: { name: 'model', version: MODEL_SUITE_VERSION - 1 } });
  assert.match(check({ files: agentFiles, pr: { body: withEvidence(oldSuite) } }).problems.join(' | '), new RegExp(`measured on model v${MODEL_SUITE_VERSION - 1}, not the model suite v${MODEL_SUITE_VERSION}`));
});

test("a pull request for an issue planned from a failing task must show that task improved", () => {
  const targeted = { ...ISSUE, body: `${ISSUE.body}\n<!-- loop-target: t -->` };
  assert.deepEqual(doneWhen(targeted), ITEMS, 'the marker is not a point');
  assert.match(check({ issue: targeted }).problems.join(' | '), /its issue targets the task t, and it changes nothing the agent reads/);
  const agentFiles = [{ filename: 'prompts/cortex.md', status: 'modified', sha: SHA.plan }];
  const reviewed = { 'prompts/cortex.md': SHA.plan };
  const withEvidence = (e) => body({ files: reviewed, extra: `\n${formatEvidenceMarkdown(e)}${measuredOn}` });
  assert.match(check({ issue: targeted, files: agentFiles, pr: { body: withEvidence(evidence(['prompts/cortex.md'])) } }).problems.join(' | '), /the target task t did not improve: capability 0\.8 -> 0\.8/);
  assert.equal(check({ issue: targeted, files: agentFiles, pr: { body: withEvidence(evidence(['prompts/cortex.md'], [0.9, 0.9, 0.9])) } }).ok, true);
});

test('a measured change is refused once what the agent reads changed on main since it was measured', () => {
  const agentFiles = [{ filename: 'agent/work/thing.mjs', status: 'modified', sha: SHA.plan }, { filename: 'tests/agent/thing.test.mjs', status: 'added', sha: SHA.test }];
  const reviewed = { 'agent/work/thing.mjs': SHA.plan, 'tests/agent/thing.test.mjs': SHA.test };
  const touched = ['agent/work/thing.mjs', 'tests/agent/thing.test.mjs'];
  const measured = (marker = measuredOn) => body({ files: reviewed, extra: `\n${formatEvidenceMarkdown(evidence(touched))}${marker}` });
  const verdict = (o) => check({ files: agentFiles, pr: { body: measured(o.marker) }, mainChanged: o.mainChanged });
  assert.equal(verdict({ mainChanged: ['docs/guide.md', 'dev/loop/cycle.mjs'] }).ok, true, 'main moved, but nothing the agent reads');
  assert.match(verdict({ mainChanged: ['docs/guide.md', 'agent/services/brain/main.mjs', 'prompts/cortex.md'] }).problems.join(' | '),
    /it was measured against eeeeeeeeeeee, and what the agent reads changed on main since \(agent\/services\/brain\/main\.mjs, prompts\/cortex\.md\): it must be measured again/);
  assert.match(verdict({ mainChanged: null }).problems.join(' | '), /what main changed since eeeeeeeeeeee, the commit it was measured against, could not be read/);
  assert.match(verdict({ marker: '', mainChanged: [] }).problems.join(' | '), /its body names no commit it was measured against/);
});

test('the command: 0 passes or not a loop pull request, 1 fails or cannot read, 2 a usage mistake', async () => {
  const sink = () => ({ text: '', write(s) { this.text += s; } });
  const run = async (view, argv = ['--pr', '45', '--repo', 'your-org/paraclete']) => {
    const out = sink();
    const err = sink();
    const execGh = (args) => {
      if (view instanceof Error) throw view;
      if (args[0] === 'pr') return JSON.stringify(view);
      if (args[0] === 'api') return JSON.stringify(FILES);
      return JSON.stringify(ISSUE);
    };
    const code = await main(argv, { execGh, stdout: out, stderr: err });
    return { code, out: out.text };
  };
  const passing = await run(pr());
  assert.equal(passing.code, 0);
  assert.match(passing.out, /#45 passes the loop guard: its review of #33 passes/);
  const failing = await run(pr({ body: 'Resolves #33.\n' }));
  assert.equal(failing.code, 1);
  assert.match(failing.out, /#45 does not pass the loop guard:\n- its body carries no review block/);
  assert.equal((await run({ headRefName: 'claude/x', body: '' })).code, 0);
  assert.equal((await run(new Error('gh: not logged in'))).code, 1);
  assert.equal((await run(pr(), ['--pr', '45'])).code, 2);
});

test('a revert pull request is checked as a revert: no review, no issue, the reverted files set back exactly', () => {
  const sha = 'a'.repeat(40);
  const reverted = {
    message: 'v1: x\n\nMerged from #54 at ' + 'b'.repeat(40) + ' by dev/loop/merger.mjs: CI and the loop guard passed, and its reviewer found every point of #52 met.',
    files: [{ filename: 'agent/work/thing.mjs', status: 'modified' }],
    before: { 'agent/work/thing.mjs': 'c'.repeat(40) },
  };
  const pr = { headRefName: `loop/revert-${sha.slice(0, 12)}`, body: revertBody({ sha, pr: 54, issue: 52, failed: ['Tests'] }) };
  const files = [{ filename: 'agent/work/thing.mjs', status: 'modified', sha: 'c'.repeat(40) }];
  assert.deepEqual(loopGuard({ pr, files, issue: null, reverted }), { loop: true, revert: true, ok: true, problems: [], issue: null }, 'code reverted needs no new test');
  const wrong = loopGuard({ pr, files: [{ ...files[0], sha: 'd'.repeat(40) }], issue: null, reverted });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems.join(' | '), /does not set exactly the reverted commit's files back/);
});

test('the workflow runs on every change to a pull request, read-only, with the base branch code', () => {
  const yml = readRepoFile('.github/workflows/loop-guard.yml');
  assert.match(yml, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(yml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, "never the pull request's own code");
  assert.match(yml, /permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}issues: read\n/);
  assert.doesNotMatch(yml, /write/);
  assert.match(yml, /^ {4}name: Loop guard$/m, 'the check name branch protection requires');
  assert.match(yml, /node dev\/loop\/guard\.mjs --pr "\$\{\{ github\.event\.pull_request\.number \}\}" --repo "\$\{\{ github\.repository \}\}"/);
});

test("a role's change is measured on that role's tasks only, and only a change on main that reaches them makes it stale", () => {
  const roleFiles = [{ filename: 'roles/designer/prompts/cortex.md', status: 'modified', sha: SHA.plan }];
  const reviewed = { 'roles/designer/prompts/cortex.md': SHA.plan };
  const designer = selectModelTasks().filter((task) => task.role === 'designer');
  const own = designer.flatMap((task) => runs([1, 1, 1], task.id, task.split));
  const measured = buildPromotionEvidence({
    candidate: { id: 'loop-33', lens: 'LOOP', touchedPaths: ['roles/designer/prompts/cortex.md'], proposal: { source: 'coding-agent' } },
    baselineTrajectories: own, candidateTrajectories: own, suite: { name: 'model', version: MODEL_SUITE_VERSION },
  });
  const verdict = (mainChanged) => check({ files: roleFiles, mainChanged, pr: { body: body({ files: reviewed, extra: `\n${formatEvidenceMarkdown(measured)}${measuredOn}` }) } });
  assert.equal(verdict([]).ok, true, "evidence of the designer's tasks covers a designer change");
  assert.equal(verdict(['roles/finance-analyst/prompts/cortex.md', 'roles/designer/role.json']).ok, true, "another role's change does not reach them");
  assert.match(verdict(['prompts/motor.md']).problems.join(' | '), /what the agent reads changed on main since \(prompts\/motor\.md\): it must be measured again/);
  assert.match(verdict(['roles/designer/memory.md']).problems.join(' | '), /must be measured again/, "the designer's own files do");
});

test('a pull request for an issue that names its module keeps to that module', () => {
  const scoped = { ...ISSUE, body: `${ISSUE.body}\n<!-- loop-module: platform:dashboard -->` };
  const repoFiles = ['dashboard/components/work/WorkPlan.jsx', 'prompts/motor.md'];
  const guard = (o) => loopGuard({ pr: pr(), files: FILES, issue: scoped, mainChanged: [], repoFiles, ...o });
  assert.match(guard({}).problems.join(' | '), /names the module platform:dashboard, which has no lane/);
  const cortexIssue = { ...ISSUE, body: `${ISSUE.body}\n<!-- loop-module: organ:cortex -->` };
  assert.match(loopGuard({ pr: pr(), files: FILES, issue: cortexIssue, mainChanged: [], repoFiles }).problems.join(' | '),
    /it changes files outside its module organ:cortex: dashboard\/components\/work\/WorkPlan\.jsx \(platform:dashboard\), tests\/dashboard\/components\/work\/work-plan\.test\.mjs \(platform:dashboard\)/);
  assert.match(loopGuard({ pr: pr(), files: FILES, issue: cortexIssue, mainChanged: [] }).problems.join(' | '), /names the module organ:cortex, and the repo's files could not be read/);
  assert.deepEqual(check().problems, [], 'an issue without a module is not scoped');
});

test("an organ lane's bench evidence covers its bench, belongs to its issue's organ, and is stale only when main reaches what a bench runs", () => {
  const files = [
    { filename: 'agent/organs/cerebellum/verify.mjs', status: 'modified', sha: SHA.plan },
    { filename: 'tests/agent/organs/cerebellum/verify-attack.test.mjs', status: 'added', sha: SHA.test },
  ];
  const reviewed = { 'agent/organs/cerebellum/verify.mjs': SHA.plan, 'tests/agent/organs/cerebellum/verify-attack.test.mjs': SHA.test };
  const guardTasks = selectModelTasks().slice(0, 3);
  const trajectories = [
    ...selectBenchItems({ organ: 'cerebellum' }).flatMap((i) => runs([1, 1, 1], i.id, i.split)),
    ...guardTasks.flatMap((task) => runs([1], task.id, task.split)),
  ];
  const benchEvidence = buildPromotionEvidence({
    candidate: { id: 'loop-33', lens: 'LOOP', touchedPaths: files.map((f) => f.filename), proposal: { source: 'coding-agent' } },
    baselineTrajectories: trajectories,
    candidateTrajectories: trajectories,
    suite: { name: 'bench:cerebellum', version: BENCH_VERSION, guard: { name: 'model', version: MODEL_SUITE_VERSION, tasks: guardTasks.map((task) => task.id) } },
  });
  const scoped = { ...ISSUE, body: `${ISSUE.body}\n<!-- loop-module: organ:cerebellum -->` };
  const repoFiles = ['agent/organs/cerebellum/verify.mjs', 'prompts/motor.md', 'agent/gateway/turn-loop.mjs', 'roles/designer/prompts/cortex.md', 'roles/generic/processes/p-x.json', 'skills/drive/SKILL.md'];
  const verdictFor = ({ issue = scoped, mainChanged = [] } = {}) => loopGuard({
    pr: pr({ body: body({ files: reviewed, extra: `\n${formatEvidenceMarkdown(benchEvidence)}${measuredOn}` }) }), files, issue, mainChanged, repoFiles,
  });
  assert.deepEqual(verdictFor().problems, []);
  assert.equal(verdictFor({ mainChanged: ['prompts/motor.md', 'roles/designer/prompts/cortex.md'] }).ok, true, "another organ's and another role's files do not reach the cerebellum's bench");
  for (const reaches of ['agent/gateway/turn-loop.mjs', 'roles/generic/processes/p-x.json', 'skills/drive/SKILL.md']) {
    assert.match(verdictFor({ mainChanged: [reaches] }).problems.join(' | '), /it must be measured again/, reaches);
  }
  const motorIssue = { ...ISSUE, body: `${ISSUE.body}\n<!-- loop-module: organ:motor -->` };
  assert.match(verdictFor({ issue: motorIssue }).problems.join(' | '), /its evidence is the cerebellum bench's, and its issue does not name organ:cerebellum/);
  const noFiles = loopGuard({ pr: pr({ body: body({ files: reviewed, extra: `\n${formatEvidenceMarkdown(benchEvidence)}${measuredOn}` }) }), files, issue: scoped, mainChanged: ['prompts/motor.md'] });
  assert.match(noFiles.problems.join(' | '), /could not be read/);
});
