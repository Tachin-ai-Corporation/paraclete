// Tests for dev/loop/planner.mjs: the open items read from OPEN_ITEMS.md; the items already planned left
// out; the planner's brief and its answer checked (a candidate's key, a one-line title, 1 to 5 points);
// the issue it opens, with the OPEN_ITEMS point and the item's marker; nothing planned past the open
// limit, when every item is planned, on a skip or a refused answer, or in a dry run; the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_DEFAULTS } from '../../../dev/loop/config.mjs';
import {
  buildPlanBrief, issueBody, itemKey, main, openItems, parsePlan, planIssue, plannedKeys,
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
  assert.match(brief, /\{"key": "<the key in brackets>", "title": /);
  assert.match(brief, /If no candidate fits, answer \{"skip": "<why>"\} instead\./);
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
  assert.match(parsePlan(answer({ doneWhen: ['one\ntwo'] }), ITEMS).problems.join(' | '), /each point must be one line/);
  assert.deepEqual(parsePlan('```json\n{"skip": "each needs a person"}\n```', ITEMS), { plan: null, skip: 'each needs a person', problems: [] });
  assert.match(parsePlan('no answer', ITEMS).problems[0], /no answer in the form asked/);
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
