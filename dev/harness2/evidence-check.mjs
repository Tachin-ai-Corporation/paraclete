// dev/harness2/evidence-check.mjs: the check every harness promotion pull request must pass in CI. A
// promotion is a pull request from a `harness2/` or `h2/` branch of this repository. It passes only
// when its description carries an evidence block (evidence.mjs `parseEvidenceBlock`) that
// `judgeEvidence` passes, judged afresh here (a `verdict` stored in the block is ignored), and the block
// names every file the pull request changes. Any other pull request passes at once.
//
// Anything that merges a promotion once CI passes therefore cannot merge one without measured
// evidence, or one whose files were rewritten after they were measured: rewriting a promotion's branch
// or its description runs this check again. It does not merge, comment or change anything; it reads the
// pull request through the GitHub CLI. Run by .github/workflows/promotion-evidence.yml on every pull
// request event, including an edit of its description:
//
//   node dev/harness2/evidence-check.mjs --pr <n> [--repo <owner/name>] [--json]
//
// Exit codes: 0 passes (or not a promotion), 1 fails, 2 a usage mistake.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { judgeEvidence, parseEvidenceBlock } from './evidence.mjs';

/** The branches a harness promotion comes from (promote.mjs and the curriculum name them so). */
export const PROMOTION_BRANCH = /^(harness2|h2)\//;

/** Whether a pull request is a harness promotion: from this repository, from a promotion branch. */
export function isPromotion(pr) {
  return PROMOTION_BRANCH.test(String(pr?.headRefName || '')) && !pr?.isCrossRepository;
}

/**
 * The verdict on one pull request. Pure.
 *
 * @param {object} pr       { headRefName, isCrossRepository, body, files: [{ path }] }
 * @param {object} [rules]  evidence rules, as judgeEvidence takes them
 * @returns {{ promotion: boolean, ok: boolean, problems: string[] }}
 */
export function checkPromotionEvidence(pr, rules) {
  if (!isPromotion(pr)) return { promotion: false, ok: true, problems: [] };
  const evidence = parseEvidenceBlock(pr.body);
  if (!evidence) {
    return {
      promotion: true,
      ok: false,
      problems: ['its description carries no evidence block (```json paraclete-h2-evidence```), so nothing shows the change was measured'],
    };
  }
  const { verdict: _stored, ...measured } = evidence;
  const problems = [...judgeEvidence(measured, rules).problems];
  const named = new Set((measured.touchedPaths || []).map((p) => String(p).replace(/\\/g, '/')));
  const unnamed = (pr.files || []).map((f) => String(f.path || f)).filter((p) => !named.has(p));
  if (unnamed.length) {
    problems.push(`it changes files its evidence does not name, so they were not measured: ${unnamed.join(', ')}`);
  }
  return { promotion: true, ok: problems.length === 0, problems };
}

function defaultExecGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The pull request as the check reads it, through the GitHub CLI.
 *
 * @param {Function} execGh  (args) => stdout
 * @param {number} number
 * @param {string} [repo]    owner/name
 */
export function readPullRequest(execGh, number, repo) {
  const out = execGh(['pr', 'view', String(number), ...(repo ? ['--repo', repo] : []),
    '--json', 'number,headRefName,isCrossRepository,body,files']);
  return JSON.parse(out);
}

function parseArgs(argv) {
  const opts = { pr: null, repo: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pr') opts.pr = Number(argv[++i]);
    else if (a === '--repo') opts.repo = argv[++i] || null;
    else if (a === '--json') opts.json = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (!Number.isInteger(opts.pr) || opts.pr <= 0) return { error: '--pr <number> is required' };
  return opts;
}

/**
 * The command line.
 *
 * @param {string[]} argv
 * @param {object} [deps]  { execGh, stdout, stderr }
 * @returns {number} exit code
 */
export function main(argv, { execGh = defaultExecGh, stdout = process.stdout, stderr = process.stderr } = {}) {
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`${opts.error}\nUsage: node dev/harness2/evidence-check.mjs --pr <n> [--repo <owner/name>] [--json]\n`);
    return 2;
  }
  let pr;
  try {
    pr = readPullRequest(execGh, opts.pr, opts.repo);
  } catch (err) {
    stderr.write(`could not read pull request #${opts.pr}: ${String(err.message || err).split('\n')[0]}\n`);
    return 1;
  }
  const verdict = checkPromotionEvidence(pr);
  if (opts.json) {
    stdout.write(`${JSON.stringify({ pr: opts.pr, ...verdict }, null, 2)}\n`);
  } else if (!verdict.promotion) {
    stdout.write(`#${opts.pr} is not a harness promotion; nothing to check.\n`);
  } else if (verdict.ok) {
    stdout.write(`#${opts.pr}: its measured evidence passes, and names every file it changes.\n`);
  } else {
    stdout.write(`#${opts.pr} is not promotable:\n${verdict.problems.map((p) => `- ${p}`).join('\n')}\n`);
  }
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
