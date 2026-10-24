// Tests for dev/harness2/evidence-check.mjs and .github/workflows/promotion-evidence.yml: a harness
// promotion pull request passes CI only with an evidence block that passes judgeEvidence, judged afresh,
// naming every file it changes; any other pull request passes at once; the workflow runs on every
// change to the branch or the description, with the base branch's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromotionEvidence, formatEvidenceMarkdown } from '../../../dev/harness2/evidence.mjs';
import { checkPromotionEvidence, isPromotion, main } from '../../../dev/harness2/evidence-check.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const runs = (caps) => caps.map((capability, i) => ({ taskId: 'a', trial: i + 1, capability, measured: true }));

/** Evidence as a real-model promotion carries it (passes today's rules and the stricter real-model ones). */
function evidence({ source = 'vertex', cand = [0.9, 0.92, 0.88], touchedPaths = ['roles/data-engineer/prompts/motor.md'] } = {}) {
  return {
    ...buildPromotionEvidence({
      candidate: { id: 'c', lens: 'DOM', touchedPaths, proposal: { source, hypothesis: 'verify the output' } },
      baselineTrajectories: runs([0.4, 0.42, 0.38]),
      candidateTrajectories: runs(cand),
    }),
    measured: true,
    calibration: { ok: true, aa: { delta: 0, noise: 0.01 }, knownBad: { delta: -0.5, noise: 0.02, detected: true }, problems: [] },
  };
}

const promotion = (o = {}) => ({
  headRefName: 'harness2/curriculum-unit-role-data-analyst',
  isCrossRepository: false,
  body: `# Report\n\n${formatEvidenceMarkdown(evidence())}\n`,
  files: [{ path: 'roles/data-engineer/prompts/motor.md' }],
  ...o,
});

/** #25's description as the external merger rewrote it: a report that says it was not measured. */
const REWRITTEN = [
  '# Paraclete-H² Candidate Promotion Report (gen0-baseline-syn)',
  '',
  '- **Status**: READY FOR PROMOTION',
  '- **Tier-1 Scores**: capability=0.995 (delta=+0.635)',
  '',
  '## Measured Evidence',
  '',
  '- None: this candidate was not measured against the baseline, so it is not promotable.',
].join('\n');

test('only a promotion branch of this repository is a promotion', () => {
  assert.equal(isPromotion({ headRefName: 'harness2/x' }), true);
  assert.equal(isPromotion({ headRefName: 'h2/promote-x' }), true);
  assert.equal(isPromotion({ headRefName: 'claude/some-work' }), false);
  assert.equal(isPromotion({ headRefName: 'harness2/x', isCrossRepository: true }), false, 'a fork can name its branch anything');
  assert.deepEqual(checkPromotionEvidence({ headRefName: 'release-gate-yank', body: '' }), { promotion: false, ok: true, problems: [] });
});

test('a promotion with passing evidence that names every changed file passes', () => {
  assert.deepEqual(checkPromotionEvidence(promotion()), { promotion: true, ok: true, problems: [] });
});

test('a promotion whose description says it was not measured fails, as #25 would have', () => {
  const { ok, problems } = checkPromotionEvidence(promotion({ body: REWRITTEN, files: [{ path: 'roles/data-engineer/prompts/motor.md' }, { path: 'roles/data-engineer/prompts/cerebellum.md' }] }));
  assert.equal(ok, false);
  assert.match(problems[0], /carries no evidence block/);
});

test('the evidence is judged afresh: a stored verdict counts for nothing', () => {
  const failing = { ...evidence({ source: 'template' }), verdict: { ok: true, problems: [] } };
  const body = `\`\`\`json paraclete-h2-evidence\n${JSON.stringify(failing)}\n\`\`\`\n`;
  const { ok, problems } = checkPromotionEvidence(promotion({ body }));
  assert.equal(ok, false);
  assert.match(problems.join(' | '), /came from 'template'/);
});

test('a file the evidence does not name was not measured, and fails', () => {
  const { ok, problems } = checkPromotionEvidence(promotion({ files: [{ path: 'roles/data-engineer/prompts/motor.md' }, { path: 'roles/data-engineer/prompts/cerebellum.md' }] }));
  assert.equal(ok, false);
  assert.match(problems.join(' | '), /does not name, so they were not measured: roles\/data-engineer\/prompts\/cerebellum\.md/);
});

function sink() {
  let text = '';
  return { write: (s) => { text += s; }, get text() { return text; } };
}

test('the command: 0 passes or not a promotion, 1 fails or cannot read, 2 a usage mistake', () => {
  const run = (pr, argv = ['--pr', '25']) => {
    const out = sink();
    const err = sink();
    const calls = [];
    const code = main(argv, { execGh: (args) => { calls.push(args); if (pr instanceof Error) throw pr; return JSON.stringify(pr); }, stdout: out, stderr: err });
    return { code, out: out.text, err: err.text, calls };
  };
  const passing = run(promotion());
  assert.equal(passing.code, 0);
  assert.deepEqual(passing.calls[0], ['pr', 'view', '25', '--json', 'number,headRefName,isCrossRepository,body,files']);
  assert.match(passing.out, /passes, and names every file/);
  const failing = run(promotion({ body: REWRITTEN }));
  assert.equal(failing.code, 1);
  assert.match(failing.out, /#25 is not promotable:\n- its description carries no evidence block/);
  assert.equal(run({ headRefName: 'claude/x', body: '' }).code, 0);
  assert.equal(run(new Error('gh: not logged in')).code, 1);
  assert.equal(run(promotion(), []).code, 2);
  const withRepo = run(promotion(), ['--pr', '25', '--repo', 'your-org/paraclete', '--json']);
  assert.deepEqual(withRepo.calls[0].slice(0, 5), ['pr', 'view', '25', '--repo', 'your-org/paraclete']);
  assert.equal(JSON.parse(withRepo.out).ok, true);
});

test('the workflow runs on every change to a pull request, read-only, with the base branch code', () => {
  const yml = readFileSync(path.join(REPO, '.github', 'workflows', 'promotion-evidence.yml'), 'utf8');
  assert.match(yml, /types: \[opened, synchronize, reopened, edited\]/, 'an edited description is checked again');
  assert.match(yml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, "never the pull request's own code");
  assert.match(yml, /contents: read\n\s+pull-requests: read/);
  assert.doesNotMatch(yml, /write/);
  assert.match(yml, /node dev\/harness2\/evidence-check\.mjs --pr "\$\{\{ github\.event\.pull_request\.number \}\}"/);
});
