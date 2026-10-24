#!/usr/bin/env node
// roles/paraclete-h2/skills/harness-release/harness-promote.mjs: Verify promotion gates and generate promotion reports for Paraclete-H2 candidates.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const USAGE = 'harness-promote --action <verify|report> [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--trials <n>] [--live] [--real-model] [--max-rollouts <n>] [--max-tokens <n>] [--vertex] [--judge-committee] [--apply] [--branch <branch>] [--push-pr] [--dry-run] [--out <path>] [--json]';

const VALID_ACTIONS = new Set(['verify', 'report']);
const VALID_STAGES = new Set(['stage1', 'stage2', 'all']);

function parseArgs(argv) {
  const opts = {
    action: 'verify',
    repo: process.cwd(),
    stage: 'stage1',
    role: null,
    trials: 2,
    live: false,
    vertex: false,
    judgeCommittee: false,
    apply: false,
    branch: null,
    pushPr: false,
    dryRun: false,
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
    else if (arg === '--role') opts.role = argv[++i] || null;
    else if (arg === '--trials') opts.trials = Number(argv[++i] || 2);
    else if (arg === '--live') opts.live = true;
    else if (arg === '--real-model') opts.realModel = true;
    else if (arg === '--max-rollouts') opts.maxRollouts = Number(argv[++i] || 0);
    else if (arg === '--max-tokens') opts.maxTokens = Number(argv[++i] || 0);
    else if (arg === '--vertex') opts.vertex = true;
    else if (arg === '--judge-committee') opts.judgeCommittee = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--branch') opts.branch = argv[++i] || null;
    else if (arg === '--push-pr') opts.pushPr = true;
    else if (arg === '--dry-run') opts.dryRun = true;
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
  const [validate, substrate, promote, cli] = await Promise.all([
    import(pathToFileURL(path.join(h2Dir, 'validate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'substrate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'promote.mjs')).href),
    fs.existsSync(path.join(h2Dir, 'cli.mjs'))
      ? import(pathToFileURL(path.join(h2Dir, 'cli.mjs')).href)
      : Promise.resolve(null),
  ]);
  return { validate, substrate, promote, cli };
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
  if ((opts.live || opts.realModel) && typeof h2.cli?.runCli === 'function') {
    const cliArgs = [
      'promote',
      '--stage',
      normalizedStage,
      '--live',
      ...(opts.vertex ? ['--vertex'] : []),
      ...(opts.judgeCommittee ? ['--judge-committee'] : []),
      ...(opts.apply ? ['--apply'] : []),
      ...(opts.pushPr ? ['--push-pr'] : []),
      ...(opts.branch ? ['--branch', opts.branch] : []),
      ...(opts.dryRun ? ['--dry-run'] : []),
      ...(opts.role ? ['--role', opts.role] : []),
      ...(opts.realModel ? ['--real-model'] : []),
      ...(opts.maxRollouts ? ['--max-rollouts', String(opts.maxRollouts)] : []),
      ...(opts.maxTokens ? ['--max-tokens', String(opts.maxTokens)] : []),
    ];
    const cliRes = await h2.cli.runCli(cliArgs, { repoRoot: opts.repo });
    const readiness = cliRes.readiness || { ready: Boolean(cliRes.ok), blockers: [] };
    const candidateId = readiness.candidateId || 'live-winner';
    const markdown = cliRes.report || h2.promote.formatPromotionReport(readiness);
    const payload = {
      ok: Boolean(cliRes.ok),
      promotable: Boolean(readiness.ready),
      action: opts.action,
      stage: opts.stage,
      candidateId,
      readiness,
      ...(cliRes.application ? { application: cliRes.application } : {}),
      ...(cliRes.pullRequest ? { pullRequest: cliRes.pullRequest } : {}),
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
    return payload.ok ? 0 : 1;
  }

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
  let application = null;
  if (opts.apply && typeof h2.promote.applyPromotedCandidate === 'function') {
    application = h2.promote.applyPromotedCandidate({
      candidate,
      readiness,
      repoRoot: opts.repo,
      branch: opts.branch,
      runTests: false,
    });
    readiness.application = application;
  }
  let pullRequest = null;
  if (opts.pushPr && typeof h2.promote.pushAndCreatePullRequest === 'function') {
    pullRequest = h2.promote.pushAndCreatePullRequest({
      candidate,
      readiness,
      application,
      repoRoot: opts.repo,
      branch: opts.branch,
      dryRun: opts.dryRun,
    });
    readiness.pullRequest = pullRequest;
  }
  const markdown = h2.promote.formatPromotionReport(readiness);

  const payload = {
    ok: readiness.ready,
    promotable: readiness.ready,
    action: opts.action,
    stage: opts.stage,
    candidateId: candidate.id,
    readiness,
    ...(application ? { application } : {}),
    ...(pullRequest ? { pullRequest } : {}),
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
