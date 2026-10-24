#!/usr/bin/env node
// roles/paraclete-h2/skills/harness-benchmark/harness-eval.mjs: Evaluate Stage 1 and Stage 2 benchmark suites and harvest failed trajectories.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const USAGE = 'harness-eval --action <evaluate|harvest|suites> [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--trials <n>] [--live] [--real-model] [--max-rollouts <n>] [--max-tokens <n>] [--judge-committee] [--include-harvested] [--expand-curriculum] [--persist] [--input <path>] [--out <path>] [--json]';

const VALID_ACTIONS = new Set(['evaluate', 'harvest', 'suites']);
const VALID_STAGES = new Set(['stage1', 'stage2', 'all']);

function parseArgs(argv) {
  const opts = {
    action: 'evaluate',
    repo: process.cwd(),
    stage: 'stage1',
    role: null,
    trials: 2,
    live: false,
    judgeCommittee: false,
    includeHarvested: false,
    expandCurriculum: false,
    persist: false,
    input: null,
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
    else if (arg === '--judge-committee') opts.judgeCommittee = true;
    else if (arg === '--include-harvested') opts.includeHarvested = true;
    else if (arg === '--expand-curriculum') opts.expandCurriculum = true;
    else if (arg === '--persist') opts.persist = true;
    else if (arg === '--input') opts.input = path.resolve(argv[++i] || '');
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
  if (! fs.existsSync(path.join(h2Dir, 'substrate.mjs'))) return null;
  const optional = (file) => (fs.existsSync(path.join(h2Dir, file))
    ? import(pathToFileURL(path.join(h2Dir, file)).href)
    : Promise.resolve(null));
  const [substrate, harvest, liveRunner, cli] = await Promise.all([
    import(pathToFileURL(path.join(h2Dir, 'substrate.mjs')).href),
    import(pathToFileURL(path.join(h2Dir, 'harvest.mjs')).href),
    optional('live-runner.mjs'),
    optional('cli.mjs'),
  ]);
  return { substrate, harvest, liveRunner, cli };
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

  if (opts.action === 'suites') {
    const tasks = h2.substrate.selectBenchmarkTasks({ stage: normalizedStage, role: opts.role || undefined });
    const payload = {
      ok: true,
      action: 'suites',
      stage: opts.stage,
      roleFilter: opts.role,
      taskCount: tasks.length,
      tasks,
    };
    writeOut(opts.out, payload);
    emit(stdout, payload, opts.json, `Benchmark suites (${tasks.length} tasks for stage=${opts.stage})`);
    return 0;
  }

  if (opts.action === 'evaluate') {
    const tasks = h2.substrate.selectBenchmarkTasks({
      stage: normalizedStage,
      role: opts.role || undefined,
      includeHarvested: opts.includeHarvested,
    });
    // A real-model evaluation goes through the harness CLI, which owns the run's model context.
    const realArgs = [
      'eval',
      '--stage', normalizedStage,
      ...(opts.role ? ['--role', opts.role] : []),
      ...(opts.trials ? ['--trials', String(opts.trials)] : []),
      ...(opts.judgeCommittee ? ['--judge-committee'] : []),
      ...(opts.realModel ? ['--real-model'] : []),
      ...(opts.maxRollouts ? ['--max-rollouts', String(opts.maxRollouts)] : []),
      ...(opts.maxTokens ? ['--max-tokens', String(opts.maxTokens)] : []),
    ];
    const result = opts.realModel && typeof h2.cli?.runCli === 'function'
      ? await h2.cli.runCli(realArgs, { repoRoot: opts.repo })
      : opts.live && h2.liveRunner?.evaluateLiveTarget
      ? await h2.liveRunner.evaluateLiveTarget({
          repoRoot: opts.repo,
          stage: normalizedStage,
          role: opts.role || undefined,
          tasks,
          useFrontierJudge: opts.judgeCommittee,
        })
      : await h2.substrate.runTier1Evaluation({
          stage: normalizedStage,
          role: opts.role || undefined,
          tasks,
        });
    const payload = {
      ok: true,
      action: 'evaluate',
      stage: opts.stage,
      roleFilter: opts.role,
      live: opts.live,
      trials: opts.trials,
      summary: result.summary,
      trajectoryCount: result.trajectories.length,
    };
    writeOut(opts.out, payload);
    emit(
      stdout,
      payload,
      opts.json,
      `Evaluation complete: capability=${result.summary.capability}, reliability=${result.summary.reliability}, fitness=${result.summary.fitness} (${result.trajectories.length} trajectories)`,
    );
    return 0;
  }

  if (opts.action === 'harvest') {
    let rawTrajectories = [];
    if (opts.input && fs.existsSync(opts.input)) {
      rawTrajectories = typeof h2.harvest.loadMissionsFromInput === 'function'
        ? h2.harvest.loadMissionsFromInput(opts.input)
        : JSON.parse(fs.readFileSync(opts.input, 'utf8'));
    } else {
      const sim = await h2.substrate.runTier1Evaluation({ stage: normalizedStage, role: opts.role || undefined });
      rawTrajectories = sim.trajectories;
    }
    const harvested = h2.harvest.harvestMissionTrajectories(rawTrajectories, {
      role: opts.role || null,
    });
    const tasks = h2.harvest.synthesizeBenchmarkCandidatesFromHarvest(harvested.accepted);
    let curriculumExpansion = null;
    if (opts.expandCurriculum && typeof h2.harvest.expandCurriculumForSaturatedRoles === 'function') {
      const evalSim = await h2.substrate.runTier1Evaluation({ stage: normalizedStage, role: opts.role || undefined });
      curriculumExpansion = h2.harvest.expandCurriculumForSaturatedRoles(evalSim, {
        persist: opts.persist,
      });
      tasks.push(...curriculumExpansion.synthesizedTasks);
    }
    if (opts.persist && typeof h2.harvest.saveHarvestedBenchmarkTasks === 'function') {
      h2.harvest.saveHarvestedBenchmarkTasks(tasks);
    }
    const payload = {
      ok: true,
      action: 'harvest',
      inputCount: rawTrajectories.length,
      harvestedCount: tasks.length,
      ...(curriculumExpansion ? { curriculumExpansion } : {}),
      tasks,
    };
    writeOut(opts.out, payload);
    emit(stdout, payload, opts.json, `Harvested ${tasks.length} regression fixtures from ${rawTrajectories.length} trajectories`);
    return 0;
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
