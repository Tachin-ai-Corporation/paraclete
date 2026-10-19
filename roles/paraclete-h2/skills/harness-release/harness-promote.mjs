#!/usr/bin/env node
// roles/paraclete-h2/skills/harness-release/harness-promote.mjs: Verify promotion gates and generate promotion reports for Paraclete-H2 candidates.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const USAGE = 'harness-promote --action <verify|report> [--repo <dir>] [--stage <stage1|stage2|all>] [--trials <n>] [--out <path>] [--json]';

const VALID_ACTIONS = new Set(['verify', 'report']);
const VALID_STAGES = new Set(['stage1', 'stage2', 'all']);

function parseArgs(argv) {
  const opts = {
    action: 'verify',
    repo: process.cwd(),
    stage: 'stage1',
    trials: 2,
    out: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--action') opts.action = argv[++i] || '';
    else if (arg === '--repo') opts.repo = path.resolve(argv[++i] || '.');
    else if (arg === '--stage') opts.stage = argv[++i] || 'stage1';
    else if (arg === '--trials') opts.trials = Number(argv[++i] || 2);
    else if (arg === '--out') opts.out = path.resolve(argv[++i] || '');
    else if (arg === '--json') opts.json = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (! opts.help) {
    if (! VALID_ACTIONS.has(opts.action)) {
      return { error: `--action must be one of: ${[...VALID_ACTIONS].join(', ')}` };
    }
    if (! VALID_STAGES.has(opts.stage)) {
      return { error: `--stage must be one of: ${[...VALID_STAGES].join(', ')}` };
    }
  }
  return opts;
}

async function loadHarness2Modules(repoDir) {
  const h2Dir = path.join(repoDir, 'dev', 'harness2');
  if (! fs.existsSync(path.join(h2Dir, 'promote.mjs'))) return null;
  const [validate, substrate, promote] = await Promise.all([
    import(pathToFileURL(path.join(h2Dir, 'validate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'substrate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'promote.mjs')).href),
  ]);
  return { validate, substrate, promote };
}

function writeOut(outPath, payload) {
  if (! outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function emit(stdout, payload, asJson, summaryText) {
  if (asJson) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    stdout.write(`${summaryText}\n`);
  }
}

export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);

  if (opts.error) {
    stderr.write(`error: ${opts.error}\nUsage: ${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    stdout.write(`Usage: ${USAGE}\n`);
    return 0;
  }

  const h2 = deps.h2 || await loadHarness2Modules(opts.repo);
  if (! h2) {
    stderr.write(`error: dev/harness2 modules not found in repo: ${opts.repo}\n`);
    return 1;
  }

  const normalizedStage = opts.stage === 'all' ? 'stage2' : opts.stage;
  const surfaceCheck = h2.validate.validateCandidateWorkspace({
    repoRoot: opts.repo,
    stage: normalizedStage,
    runTests: false,
  });
  const evalRes = await h2.substrate.runTier1Evaluation({ stage: normalizedStage });

  const candidate = {
    id: 'candidate-head',
    lens: 'SYN',
    stage: normalizedStage,
    touchedPaths: [],
    scores: evalRes.summary,
  };
  const readiness = h2.promote.evaluatePromotionReadiness({
    candidate,
    baselineScores: evalRes.summary,
    validation: surfaceCheck,
  });
  const markdown = h2.promote.formatPromotionReport(readiness);

  const payload = {
    ok: readiness.ready,
    promotable: readiness.ready,
    action: opts.action,
    stage: opts.stage,
    candidateId: candidate.id,
    readiness,
    markdown,
  };

  writeOut(opts.out, payload);
  if (opts.action === 'report' && ! opts.json) {
    stdout.write(`${markdown}\n`);
  } else {
    emit(
      stdout,
      payload,
      opts.json,
      readiness.ready
        ? `Promotion gates passed for ${payload.candidateId}`
        : `Promotion blocked for ${payload.candidateId}: ${(readiness.blockers || []).join('; ')}`,
    );
  }
  return readiness.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
