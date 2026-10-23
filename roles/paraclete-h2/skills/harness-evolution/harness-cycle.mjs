#!/usr/bin/env node
// roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs: Run Loop A diagnosis, validation, and evolutionary optimization cycles.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const USAGE = 'harness-cycle --action <diagnose|validate|run|surface|curriculum|report|scaffold-skill|scaffold-role> [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--id <id>] [--unit <unit-id>] [--track <organs|engineering_roles|specialist_roles>] [--status] [--suggest] [--max-units <n>] [--state-path <path>] [--markdown] [--iterations <n>] [--candidates <n>] [--trials <n>] [--lens <context|sub_agents|tools|scaffolding>] [--live] [--vertex] [--judge-committee] [--include-harvested] [--expand-curriculum] [--apply] [--push-pr] [--library <path>] [--out <path>] [--json]';

const VALID_ACTIONS = new Set(['diagnose', 'validate', 'run', 'surface', 'curriculum', 'report', 'scaffold-skill', 'scaffold-role']);
const VALID_STAGES = new Set(['stage1', 'stage2', 'all']);
const VALID_LENSES = new Set(['context', 'sub_agents', 'tools', 'scaffolding']);

function parseArgs(argv) {
  const opts = {
    action: 'run',
    repo: process.cwd(),
    stage: 'stage1',
    role: null,
    id: null,
    unit: null,
    track: null,
    status: false,
    suggest: false,
    maxUnits: null,
    statePath: null,
    markdown: false,
    iterations: 2,
    candidates: 2,
    trials: 2,
    lens: null,
    live: false,
    vertex: false,
    judgeCommittee: false,
    includeHarvested: false,
    expandCurriculum: false,
    apply: false,
    pushPr: false,
    library: null,
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
    else if (arg === '--id') opts.id = argv[++i] || null;
    else if (arg === '--unit') opts.unit = argv[++i] || null;
    else if (arg === '--track') opts.track = argv[++i] || null;
    else if (arg === '--status') opts.status = true;
    else if (arg === '--suggest') opts.suggest = true;
    else if (arg === '--max-units') opts.maxUnits = Number(argv[++i] || 8);
    else if (arg === '--state-path') opts.statePath = path.resolve(argv[++i] || '');
    else if (arg === '--markdown') opts.markdown = true;
    else if (arg === '--iterations') opts.iterations = Number(argv[++i] || 2);
    else if (arg === '--candidates') opts.candidates = Number(argv[++i] || 2);
    else if (arg === '--trials') opts.trials = Number(argv[++i] || 2);
    else if (arg === '--lens') opts.lens = argv[++i] || null;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--vertex') opts.vertex = true;
    else if (arg === '--judge-committee') opts.judgeCommittee = true;
    else if (arg === '--include-harvested') opts.includeHarvested = true;
    else if (arg === '--expand-curriculum') opts.expandCurriculum = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--push-pr') opts.pushPr = true;
    else if (arg === '--library') opts.library = path.resolve(argv[++i] || '');
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
    if (opts.lens && ! VALID_LENSES.has(opts.lens)) {
      return { error: `--lens must be one of: ${[...VALID_LENSES].join(', ')}` };
    }
  }
  return opts;
}

async function loadHarness2Modules(repoDir) {
  const h2Dir = path.join(repoDir, 'dev', 'harness2');
  const surfacePath = path.join(h2Dir, 'surface.mjs');
  if (! fs.existsSync(surfacePath)) return null;
  const [surface, validate, substrate, lenses, cli, liveRunner] = await Promise.all([
    import(pathToFileURL(path.join(h2Dir, 'surface.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'validate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'substrate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'lenses.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'cli.mjs')).href),
    fs.existsSync(path.join(h2Dir, 'live-runner.mjs'))
      ? import(pathToFileURL(path.join(h2Dir, 'live-runner.mjs')).href)
      : Promise.resolve(null),
  ]);
  return { surface, validate, substrate, lenses, cli, liveRunner };
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

  if (opts.action === 'surface') {
    const payload = {
      ok: true,
      action: 'surface',
      repo: opts.repo,
      surface: h2.surface.PARACLETE_SURFACE,
      stage1BuilderRoles: h2.surface.STAGE1_BUILDER_ROLES,
      roles: h2.surface.rolesForStage(normalizedStage, { repoRoot: opts.repo }),
      immutablePaths: h2.surface.IMMUTABLE_SPINE_PREFIXES,
    };
    writeOut(opts.out, payload);
    emit(stdout, payload, opts.json, `Paraclete-H2 surface (${payload.roles.length} roles, stage1: ${payload.stage1BuilderRoles.join(', ')})`);
    return 0;
  }

  if (opts.action === 'validate') {
    const report = h2.validate.validateCandidateWorkspace({
      repoRoot: opts.repo,
      stage: normalizedStage,
      runTests: false,
    });
    const payload = {
      ok: report.ok,
      valid: report.ok,
      action: 'validate',
      repo: opts.repo,
      ...report,
    };
    writeOut(opts.out, payload);
    emit(
      stdout,
      payload,
      opts.json,
      report.ok
        ? `Validation passed for stage=${normalizedStage}`
        : `Validation failed: ${(report.violations || []).join('; ')}`,
    );
    return report.ok ? 0 : 1;
  }

  if (opts.action === 'scaffold-skill') {
    const scaffold = h2.surface.buildSkillScaffold({
      skillId: opts.id || 'custom-skill',
      role: opts.role || null,
    });
    const payload = { ok: true, action: 'scaffold-skill', scaffold };
    writeOut(opts.out, payload);
    emit(stdout, payload, opts.json, `Scaffolded skill ${scaffold.baseDir}`);
    return 0;
  }

  if (opts.action === 'scaffold-role') {
    const scaffold = h2.surface.buildRoleScaffold({
      roleId: opts.id || opts.role || 'specialist-role',
    });
    const payload = { ok: true, action: 'scaffold-role', scaffold };
    writeOut(opts.out, payload);
    emit(stdout, payload, opts.json, `Scaffolded role ${scaffold.roleDir}`);
    return 0;
  }

  if (opts.action === 'diagnose') {
    const evalResult = opts.live && h2.liveRunner?.evaluateLiveTarget
      ? await h2.liveRunner.evaluateLiveTarget({
          repoRoot: opts.repo,
          stage: normalizedStage,
          role: opts.role || undefined,
          useFrontierJudge: opts.judgeCommittee,
        })
      : await h2.substrate.runTier1Evaluation({
          stage: normalizedStage,
          role: opts.role || undefined,
        });
    const routing = h2.lenses.selectLensForTrajectories(evalResult.trajectories);
    const proposalSpec = h2.lenses.buildMutationProposalSpec({
      lens: routing.primaryLens || 'INV',
      trajectories: evalResult.trajectories,
      stage: normalizedStage,
    });
    const payload = {
      ok: true,
      action: 'diagnose',
      stage: opts.stage,
      live: opts.live,
      lensFilter: opts.lens,
      summary: evalResult.summary,
      primaryLens: routing.primaryLens,
      routing,
      proposalSpec,
    };
    writeOut(opts.out, payload);
    emit(
      stdout,
      payload,
      opts.json,
      `Diagnosis complete (stage=${opts.stage}, primaryLens=${payload.primaryLens || 'INV'}, fitness=${evalResult.summary.fitness})`,
    );
    return 0;
  }

  if (opts.action === 'run') {
    const result = await h2.cli.runEvolutionLoop({
      stage: normalizedStage,
      role: opts.role || undefined,
      generations: opts.iterations,
      recursionSteps: opts.candidates,
      archivePath: opts.library || undefined,
      proposeAndApply: opts.live && h2.liveRunner?.createLiveProposeAndApply
        ? h2.liveRunner.createLiveProposeAndApply({
            repoRoot: opts.repo,
            stage: normalizedStage,
            useVertex: opts.vertex,
            useFrontierJudge: opts.judgeCommittee,
          })
        : undefined,
    });
    const payload = {
      ok: true,
      action: 'run',
      stage: opts.stage,
      live: opts.live,
      lensFilter: opts.lens,
      bestCandidateId: result.winner.id,
      bestSummary: result.winner.scores,
      generations: result.generations,
      attempts: result.attempts,
    };
    writeOut(opts.out, payload);
    emit(
      stdout,
      payload,
      opts.json,
      `Loop A complete: bestCandidate=${payload.bestCandidateId} (fitness=${payload.bestSummary.fitness})`,
    );
    return 0;
  }

  if (opts.action === 'curriculum') {
    const cliArgs = [
      'curriculum',
      ...(opts.unit ? ['--unit', opts.unit] : []),
      ...(opts.track ? ['--track', opts.track] : []),
      ...(opts.status ? ['--status'] : []),
      ...(opts.suggest ? ['--suggest'] : []),
      ...(opts.maxUnits ? ['--max-units', String(opts.maxUnits)] : []),
      ...(opts.statePath ? ['--state-path', opts.statePath] : []),
      ...(opts.live ? ['--live'] : []),
      ...(opts.vertex ? ['--vertex'] : []),
      ...(opts.judgeCommittee ? ['--judge-committee'] : []),
      ...(opts.apply ? ['--apply'] : []),
      ...(opts.pushPr ? ['--push-pr'] : []),
    ];
    const result = await h2.cli.runCli(cliArgs, { repoRoot: opts.repo });
    const payload = {
      ok: Boolean(result.ok),
      action: 'curriculum',
      ...result,
    };
    writeOut(opts.out, payload);
    const summaryText = opts.status
      ? `Curriculum coverage: ${result.coverage?.completedUnits || 0}/${result.coverage?.totalUnits || 0} completed`
      : opts.suggest
        ? `Synthesized Curriculum Epoch ${result.suggestedEpoch}: ${result.proposedUnitsCount} units queued`
        : `Curriculum unit ${result.curriculumUnit?.id || 'unknown'} complete (promoted=${Boolean(result.readiness?.ready)})`;
    emit(stdout, payload, opts.json, summaryText);
    return result.ok ? 0 : 1;
  }

  if (opts.action === 'report') {
    const cliArgs = [
      'report',
      ...(opts.statePath ? ['--state-path', opts.statePath] : []),
      ...(opts.library ? ['--archive-path', opts.library] : []),
      ...(opts.markdown ? ['--markdown'] : []),
    ];
    const result = await h2.cli.runCli(cliArgs, { repoRoot: opts.repo });
    const payload = {
      ok: Boolean(result.ok),
      action: 'report',
      ...result,
    };
    writeOut(opts.out, payload);
    const summaryText = opts.markdown
      ? result.markdown
      : `Paraclete-H2 Status Report (${result.standardVersion}): ${result.statusReport?.curriculum?.completedUnits || 0}/${result.statusReport?.curriculum?.totalUnits || 0} curriculum units, $${result.statusReport?.cost?.totals?.accruedToDateUsd || 0} accrued`;
    emit(stdout, payload, opts.json, summaryText);
    return result.ok ? 0 : 1;
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
