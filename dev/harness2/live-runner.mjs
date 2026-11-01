// dev/harness2/live-runner.mjs: In-process Gateway + Brain live rollout adapter, isolated git worktree mutations, and GCP lab planner for Paraclete-H².
// The lab is two projects, the driver's and the canary's (lab-canary.mjs), since one project holds one paraclete.
// The lab's follow-main timer (built by lab-updater.mjs; lab only) and the canary's coordinates on the driver
// (lab-canary.mjs) reach the lab VMs from here, over IAP SSH.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createOrganRegistry } from '../../agent/gateway/organs.mjs';
import { createVertexText } from '../../agent/providers/vertex-text.mjs';
import { buildBrain } from '../../agent/services/brain/main.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../../agent/storage/collections.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { dataPaths } from '../../config/instance.mjs';
import { indexIds, indexPlan, ttlPlan, ttlState } from '../../install/lib/indexes.mjs';
import { sshArgs, windowsGcloud } from '../dev-env.mjs';
import {
  getCurriculumUnitById,
  materializeCurriculumArtifacts,
  verifyUnitArtifacts,
} from './curriculum.mjs';
import { start as startFirestoreFake } from '../../tests/fakes/firestore-server.mjs';
import { getTaskFixture } from './fixtures.mjs';
import {
  LAB_CANARY,
  canaryInstanceEnv,
  canaryProjectFor,
  driverAccessOnCanary,
  instanceEnvRemoteCommand,
  instanceEnvResult,
  oldCanaryDeleteCommand,
} from './lab-canary.mjs';
import {
  FOLLOW_MAIN,
  followMainCommandFor,
  followMainResult,
  parseFollowMainOutput,
  parseIntervalMinutes,
} from './lab-updater.mjs';
import { loadSideProduct, usageFromLog } from './model-runs.mjs';
import { isModelTask } from './model-suite.mjs';
import { DEFAULT_JUDGE_COMMITTEE, buildJudgePacket, evaluateWithFrontierCommittee } from './judge.mjs';
import { applyProposal, buildProposalPrompt, createVertexProposalGenerator, parseProposal } from './proposer.mjs';
import { runTier1Evaluation, selectBenchmarkTasks } from './substrate.mjs';
import { DEFAULT_ROLES, rolesForStage } from './surface.mjs';
import { validateCandidateWorkspace } from './validate.mjs';

/** The product code a scripted rollout runs: the harness's own, since every side gets the same answers. */
const HARNESS_PRODUCT = Object.freeze({ buildBrain, COLLECTIONS, SUBCOLLECTIONS, createClient });

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Runs gcloud and returns its trimmed stdout. `interactive` (for `gcloud compute ssh`) leaves stdin and
 * stderr on your terminal, so a prompt from gcloud or the SSH client shows and can be answered.
 */
function defaultExecGcloud(args, { interactive = false } = {}) {
  const stdio = interactive ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'];
  if (process.platform === 'win32') {
    const { file, args: prefix, env } = windowsGcloud({ env: process.env });
    return execFileSync(file, [...prefix, ...args], { env, encoding: 'utf8', stdio }).trim();
  }
  return execFileSync('gcloud', args, { encoding: 'utf8', stdio }).trim();
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p?.text || '').join('\n\n');
  return '';
}

function formatToolLog(lines) {
  return `\n\n---\n[TOOL EXECUTION LOG]\n${lines.join('\n')}\n[END TOOL LOG]`;
}

function formatVerdict(pass, { reasoning = 'checked', checks = [] } = {}) {
  const args = pass
    ? JSON.stringify({ reasoning, checks })
    : JSON.stringify({
        reasoning,
        checks: checks.length ? checks : [{ criterion: 'outcome', pass: false, evidence: reasoning }],
        recommendation: 'fix it',
      });
  return `Verdict reached.${formatToolLog([`[TOOL] ${pass ? 'report_pass' : 'report_fail'}(${args}) → recorded`])}`;
}

/**
 * Create an isolated git worktree for a candidate mutation branch so Loop A
 * never mutates the active working tree in place.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.candidateId]
 * @param {string} [opts.baseRef]
 * @param {Function} [opts.execGit]
 * @returns {{ worktreePath: string, branchName: string, cleanup: () => void }}
 */
export function createIsolatedWorktree(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const candidateId = String(opts.candidateId || `cand-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
  const branchName = `h2/${candidateId}`;
  const baseRef = opts.baseRef || 'HEAD';
  const execGit = opts.execGit || defaultExecGit;
  const worktreePath = opts.worktreePath || path.join(os.tmpdir(), `paraclete-h2-${candidateId}`);

  execGit(['worktree', 'add', '-B', branchName, worktreePath, baseRef], repoRoot);

  return {
    worktreePath,
    branchName,
    cleanup() {
      try {
        execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
      } catch { /* ignore cleanup error */ }
      try {
        execGit(['branch', '-D', branchName], repoRoot);
      } catch { /* ignore branch delete error */ }
    },
  };
}

/**
 * Compute changed repo-relative paths inside a candidate worktree relative to `HEAD`.
 *
 * @param {string} worktreePath
 * @param {object} [opts]
 * @param {Function} [opts.execGit]
 * @returns {string[]}
 */
export function getWorktreeTouchedPaths(worktreePath, opts = {}) {
  const execGit = opts.execGit || defaultExecGit;
  const out = execGit(['status', '--porcelain'], worktreePath);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.slice(3).trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

/**
 * Snapshot a candidate workspace's contracts and prompt sizes so rollouts can
 * execute even after the temporary git worktree is cleaned up.
 *
 * @param {string} repoRoot
 * @param {string} [role]
 */
export function snapshotCandidateConfig(repoRoot, role = 'paraclete-h2') {
  const contractsPath = path.join(repoRoot, 'config', 'contracts.json');
  const contracts = loadContracts({ path: contractsPath });
  const promptsDir = path.join(repoRoot, 'prompts');
  const rolePromptsDir = path.join(repoRoot, 'roles', role, 'prompts');
  const registry = createOrganRegistry({
    models: contracts.vertex?.models || contracts.models,
    maxSteps: contracts.organs?.max_steps || contracts.limits?.maxToolStepsPerTurn,
    promptsDir,
    rolePromptsDir: fs.existsSync(rolePromptsDir) ? rolePromptsDir : undefined,
  });

  const organPromptTokens = {};
  const organPrompts = {};
  for (const organ of registry.ids) {
    const cfg = registry.get(organ);
    organPrompts[organ] = cfg.systemPrompt || '';
    organPromptTokens[organ] = Math.max(120, Math.ceil((cfg.systemPrompt?.length || 400) / 4));
  }

  const cachedList = [...(contracts.caching?.organs || [])];
  if (contracts.vertex?.gemini_explicit_cache) {
    cachedList.push('cortex', 'prefrontal', 'motor', 'cerebellum');
  }

  return {
    contracts,
    organPrompts,
    organPromptTokens,
    cachedOrgans: new Set(cachedList),
  };
}

/**
 * Start an in-process HTTP gateway server speaking `/v1/chat/completions` and `/v1/sessions/*`,
 * backed by the candidate's `config/contracts.json` and `prompts/` registry, executing the task's
 * seeded workspace fixture during the `motor` turn and recording authentic token usage.
 */
export async function startInProcessFixtureGateway({
  task,
  fixture,
  workspaceDir,
  configSnapshot,
  usageRecords,
  token = 'h2-live-token',
}) {
  const sessions = new Map();
  let turnSeq = 0;

  const computeUsage = (organ, systemText, outputChars = 240) => {
    const basePrompt =
      configSnapshot.organPromptTokens[organ] ||
      Math.max(120, Math.ceil((systemText?.length || 600) / 4));
    const maxSteps = configSnapshot.contracts?.organs?.max_steps ?? 25;
    const previewChars = configSnapshot.contracts?.brain?.result_preview_chars ?? 3000;
    const budgetFactor = Math.min(
      1.15,
      Math.max(0.55, (maxSteps / 25) * 0.5 + (previewChars / 3000) * 0.5),
    );
    const promptTokenCount = Math.round(basePrompt * budgetFactor);
    const candidatesTokenCount = Math.max(40, Math.round((outputChars / 4) * budgetFactor));
    const cachedContentTokenCount = configSnapshot.cachedOrgans.has(organ)
      ? Math.round(promptTokenCount * 0.65)
      : 0;
    const rec = {
      organ,
      prompt_tokens: promptTokenCount,
      completion_tokens: candidatesTokenCount,
      promptTokenCount,
      candidatesTokenCount,
      cachedContentTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    };
    usageRecords.push(rec);
    return rec;
  };

  let decideCalled = false;

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, { object: 'list', data: [] });
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(401, { error: { message: 'Unauthorized', type: 'auth_error' } });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/v1/sessions/')) {
      const id = decodeURIComponent(req.url.slice('/v1/sessions/'.length));
      return send(200, { ok: true, existed: sessions.delete(id) });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      return send(404, { error: { message: 'not found' } });
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const organ = String(body.model || 'brain/cortex').replace(/^brain\//, '');
    const messages = body.messages || [];
    const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content));
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const user = textOf(nonSystem[nonSystem.length - 1]?.content);

    let echo;
    if (body.session?.id && organ !== 'cerebellum') {
      const s = body.session;
      if (s.op === 'continue') {
        const live = sessions.get(s.id);
        const reason = !live
          ? 'absent'
          : live.organ !== organ
            ? 'organ'
            : live.systemHash !== system[0]
              ? 'system_hash'
              : live.seq !== s.seq
                ? 'seq'
                : null;
        if (reason) {
          return send(200, { session: { id: s.id, present: false, reason } });
        }
        live.seq += 1;
        echo = { id: s.id, present: true, seq: live.seq };
      } else {
        sessions.set(s.id, { organ, seq: 0, systemHash: system[0] });
        echo = { id: s.id, present: true, seq: 0 };
      }
    }

    let content = '';
    let toolRecords = undefined;
    const taskInstruction = task.prompt || task.goal || task.id;

    if (organ === 'cortex') {
      if (user.includes('Acknowledge this message briefly')) {
        content = `Starting ${task.id}.`;
      } else if (user.includes('"mode":"classify"')) {
        content = JSON.stringify({
          classification: 'new_mission',
          reasoning: `Executing benchmark mission ${task.id}`,
          instruction: taskInstruction,
          accept_criteria: (task.expectedClauses || ['Complete task']).join('; '),
        });
      } else if (user.includes('"mode":"decide"')) {
        if (!decideCalled) {
          decideCalled = true;
          content = JSON.stringify({
            action: 'checkpoint_plan',
            goal: taskInstruction,
            reasoning: 'Proceed with checkpoint execution',
          });
        } else {
          content = JSON.stringify({
            action: 'synthesize',
            synthesis: `Verified ${(task.expectedClauses || []).join('; ')}`,
            answer: `Completed ${task.id}: verified ${(task.expectedClauses || []).join('; ')}`,
          });
        }
      } else if (user.includes('"mode":"respond_compose"')) {
        content = JSON.stringify({
          reasoning: 'grounded in verified workspace',
          response: `Completed ${task.id}.`,
        });
      }
    } else if (organ === 'prefrontal') {
      if (user.includes('"mode":"analyze"')) {
        content = JSON.stringify({
          objective: taskInstruction,
          parts: (task.expectedClauses || ['Complete task']).map((clause, i) => ({
            id: `p${i + 1}`,
            summary: clause,
            risk: 'none',
          })),
        });
      } else if (user.includes('[PLAN STRUCTURING')) {
        content = JSON.stringify({
          checkpoints: [
            {
              instruction: taskInstruction,
              accept_criteria: (task.expectedClauses || ['Complete task']).join('; '),
              tasks: [
                {
                  agent: 'motor',
                  task: `Execute and verify ${task.id}: ${(task.expectedClauses || []).join(', ')}`,
                  accept_criteria: (task.expectedClauses || ['verified']).join('; '),
                },
              ],
            },
          ],
        });
      }
    } else if (organ === 'motor' || organ === 'temporal-research') {
      let summaryClause = (task.expectedClauses || []).join('; ');
      let logLines = [`[TOOL] shell({"command":"echo verified"}) → exit 0`];
      if (fixture) {
        fixture.applyReferenceSolution(workspaceDir);
        const verified = fixture.verifyWorkspace(workspaceDir);
        toolRecords = verified.toolRecords;
        summaryClause = `${verified.summary} — ${(task.expectedClauses || []).join('; ')}`;
        logLines = (verified.toolRecords || []).map(
          (r) => `[TOOL] ${r.tool}(${JSON.stringify({ command: r.command || 'verify' })}) → exit ${r.exitCode ?? 0}`,
        );
      }
      if (task.curriculumUnitId) {
        const curriculumUnit = getCurriculumUnitById(task.curriculumUnitId);
        if (curriculumUnit) {
          materializeCurriculumArtifacts(workspaceDir, curriculumUnit);
          const artifactList = (curriculumUnit.requiredArtifacts || []).map((a) => a.path).join(', ');
          summaryClause = `${summaryClause} | Artifacts verified: ${artifactList}`;
          logLines.push(
            `[TOOL] shell({"command":"verify-artifacts ${artifactList}"}) → exit 0`,
          );
        }
      }
      content = `Executed and verified ${task.id}: ${summaryClause}.${formatToolLog(logLines)}`;
    } else if (organ === 'cerebellum') {
      content = formatVerdict(true, {
        reasoning: `Verified ${(task.expectedClauses || []).join('; ')}`,
      });
    } else if (organ === 'temporal-memory') {
      if (user.includes('recording what a mission taught')) {
        content = '{"lesson":""}';
      } else {
        content = 'No relevant context found.';
      }
    }

    const usage = computeUsage(organ, system[0] || '', content.length);
    turnSeq += 1;
    return send(200, {
      id: `chatcmpl-h2-${turnSeq}`,
      object: 'chat.completion',
      model: 'vertex-google/h2-live',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'STOP' }],
      usage,
      ...(echo ? { session: echo } : {}),
      ...(toolRecords ? { tool_records: toolRecords } : {}),
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Execute a real in-process `buildBrain` + HTTP Gateway + seeded workspace fixture
 * rollout against the Tier-1 hermetic Firestore/GCS substrate.
 *
 * Without `opts.gatewayUrl` the gateway is the in-process fixture gateway, which scripts every
 * organ's answer, so the result carries `scripted: true`. With it, the organs answer through that
 * gateway, which reads its own installed organ prompts, not the candidate's.
 *
 * With `opts.realModel` (model-runs.mjs createModelRunContext) every organ answers through the real
 * model: the side's own checkout (the baseline's, or the one `opts.filePatches` makes) supplies both
 * the code and the files, so its gateway and its brain run (model-runs.mjs loadSideProduct), read that
 * checkout and call the real utility model, and the clock is the wall clock. A model-suite task (model-suite.mjs) is seeded into the motor's
 * workspace and checked there afterwards, and the share of its checks that passed is the run's
 * capability (`checkScore`). The result carries `measured: true`, the only runs promotion evidence
 * accepts (evidence.mjs).
 *
 * @param {object} task
 * @param {object} substrateCtx
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {object} [opts.configSnapshot]
 * @param {string} [opts.gatewayUrl]
 * @param {object} [opts.realModel]    a real-model run's context
 * @param {object} [opts.filePatches]  with realModel: the side's files that differ from HEAD
 */
export async function runInProcessBrainRollout(task, substrateCtx, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const role = task.role || 'paraclete-h2';
  const taskInstruction = task.prompt || task.goal || task.id;
  const realModel = opts.realModel || null;
  let surfaceRoot = repoRoot;
  let launcherProblem = null;
  if (realModel) {
    realModel.meter.startRollout();
    const side = realModel.sides.forPatches(opts.filePatches || {});
    launcherProblem = realModel.sides.prepareRole(side, role)?.problem || null;
    surfaceRoot = side.root;
  }
  const configSnapshot = realModel
    ? snapshotCandidateConfig(surfaceRoot, role)
    : opts.configSnapshot || snapshotCandidateConfig(repoRoot, role);
  const fixture = getTaskFixture(task.id);
  const modelTask = isModelTask(task);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `paraclete-h2-task-${task.id}-`));
  // A real motor works in the data root's workspace/, as on an instance; the scripted one in the root.
  const taskDir = realModel ? dataPaths({ data_root: workspaceDir }).workspace : workspaceDir;
  fs.mkdirSync(taskDir, { recursive: true });
  const usageRecords = [];

  if (modelTask) {
    task.seed(taskDir);
  } else if (fixture) {
    fixture.seedWorkspace(taskDir);
  }

  const firestoreOrigin =
    substrateCtx.firestore?.origin ||
    String(substrateCtx.firestoreUrl || '').replace(/\/v1\/projects\/.*$/, '') ||
    `http://127.0.0.1:${substrateCtx.firestorePort}`;
  const gcsOrigin =
    substrateCtx.gcs?.origin ||
    substrateCtx.gcsUrl ||
    `http://127.0.0.1:${substrateCtx.gcsPort || 9}`;
  let nowMs = Date.parse('2026-10-19T12:00:00.000Z');
  const clock = realModel
    ? () => Date.now()
    : () => {
        nowMs += 150;
        return nowMs;
      };
  const startedAt = Date.now();
  let gateway = null;
  // A real-model rollout gets a Firestore of its own: a mission another rollout left active (a timeout,
  // a gateway error) must never be picked up and run here, in this rollout's workspace.
  const ownFirestore = realModel ? await startFirestoreFake({ projectId: ROLLOUT_PROJECT }) : null;
  const firestoreHost = ownFirestore ? ownFirestore.origin : firestoreOrigin;
  const projectId = ownFirestore ? ROLLOUT_PROJECT : substrateCtx.firestore?.projectId || 'paraclete-h2-tier1';
  let timedOut = false;

  try {
    // A real-model rollout runs the side's own product code; a scripted one, which measures nothing,
    // runs the harness's.
    const product = realModel ? await (realModel.product || loadSideProduct)(surfaceRoot) : HARNESS_PRODUCT;
    const { COLLECTIONS, SUBCOLLECTIONS } = product;
    const db = product.createClient({
      projectId,
      firestoreHost,
      getAccessToken: async () => 'test-token',
      logger: () => {},
    });

    if (realModel) {
      gateway = await realModel.startGateway({
        sideRoot: surfaceRoot,
        role,
        contracts: configSnapshot.contracts,
        dataRoot: workspaceDir,
        db,
        project: realModel.access.project,
        accessToken: await realModel.access.getAccessToken(),
        product,
        // The agent's own commands read this rollout's instance record (its Firestore, its data root),
        // never the instance the harness runs on.
        env: { ...process.env, PARACLETE_INSTANCE: writeRolloutInstance({ workspaceDir, surfaceRoot, role, firestoreHost, gcsOrigin }) },
      });
    } else if (opts.gatewayUrl) {
      gateway = { url: opts.gatewayUrl, token: opts.gatewayToken || 'h2-live-token', stop: async () => {} };
    } else {
      gateway = await startInProcessFixtureGateway({
        task,
        fixture,
        workspaceDir,
        configSnapshot,
        usageRecords,
      });
    }

    const instance = {
      project: realModel ? realModel.access.project : projectId,
      region: 'us-central1',
      zone: 'us-central1-a',
      agent_name: 'Paraclete',
      role,
      install_root: surfaceRoot,
      data_root: workspaceDir,
      bucket: 'paraclete-h2-tier1-bucket',
      workspace: null,
      endpoints: {},
      gateway_token_file: path.join(workspaceDir, 'no-token-file'),
    };

    // A real-model rollout counts its tokens from the brain's own telemetry lines.
    const log = realModel
      ? (level, message) => {
          const rec = usageFromLog(message);
          if (rec) {
            usageRecords.push(rec);
            realModel.meter.addTokens(rec.totalTokenCount);
          }
        }
      : () => {};

    const runtime = {
      service: 'brain',
      contracts: configSnapshot.contracts,
      instance,
      log,
      db,
      collections: COLLECTIONS,
      subcollections: SUBCOLLECTIONS,
      getAccessToken: realModel ? realModel.access.getAccessToken : async () => 'test-token',
      fetch: globalThis.fetch,
      firestoreHost,
      storageHost: gcsOrigin,
      paths: {
        installRoot: surfaceRoot,
        prompts: path.join(surfaceRoot, 'prompts'),
        skills: path.join(surfaceRoot, 'skills'),
        roles: path.join(surfaceRoot, 'roles'),
        genericRole: path.join(surfaceRoot, 'roles', 'generic'),
        role: path.join(surfaceRoot, 'roles', role),
        data: dataPaths(instance),
      },
      gatewayUrl: gateway.url,
    };

    // The scripted path takes the deterministic schema route; a real-model brain builds its own
    // utility client from the runtime, as on an instance.
    const vertexText = realModel
      ? undefined
      : createVertexText({
          projectId,
          getAccessToken: async () => 'test-token',
          fetch: async () => {
            throw new Error('deterministic schema path in Tier-1');
          },
          logger: () => {},
        });

    // A rollout has no artifact manager, so no mission tree: its task messages must not name one, or a
    // motor that follows them writes its work there, and the task is seeded into, and checked in, the
    // motor's working directory.
    const brain = product.buildBrain(runtime, {
      ...(vertexText ? { vertexText } : {}),
      gatewayToken: gateway.token,
      artifacts: null,
      missionDir: null,
      clock,
    });

    await brain.init();

    const intakeId = `i-dashboard-${task.id}`;
    await db.write(`${COLLECTIONS.intake}/${intakeId}`, {
      id: intakeId,
      text: taskInstruction,
      source: 'dashboard',
      status: 'pending',
      created_at: new Date(clock()).toISOString(),
      attachments: [],
      source_meta: {
        address: { channel: 'dashboard', thread: `th-${task.id}` },
        channel_msg_id: task.id,
        raw_text: taskInstruction,
        sender: 'eval@example.com',
        sender_name: 'Harness2 Evaluator',
      },
    });

    await brain.tickIntake();
    if (realModel) {
      // A mission past its time is cut off: its gateway stops before the workspace is checked, so no
      // turn still writes while the checks run, and the run says it timed out.
      timedOut = (await runWithin(brain.parts.runner.tick(), realModel.timeoutMs)) === 'timeout';
      if (timedOut) {
        await runWithin(gateway.stop(), GATEWAY_STOP_GRACE_MS);
        gateway = null;
      }
    } else {
      await brain.parts.runner.tick();
    }

    const baseVerification = modelTask
      ? task.verify(taskDir)
      : fixture
        ? fixture.verifyWorkspace(taskDir)
        : {
            passed: !realModel,
            summary: (task.expectedClauses || []).join('; '),
            toolRecords: realModel ? [] : [{ tool: 'shell', exitCode: 0 }],
          };

    const curriculumUnit = task.curriculumUnitId ? getCurriculumUnitById(task.curriculumUnitId) : null;
    const artifactVerification = curriculumUnit
      ? verifyUnitArtifacts(taskDir, curriculumUnit)
      : null;

    const fixtureVerification = {
      ...baseVerification,
      passed: Boolean(baseVerification.passed && (!artifactVerification || artifactVerification.passed)),
      verified: Boolean(baseVerification.passed && (!artifactVerification || artifactVerification.passed)),
      summary: `${timedOut ? `timed out after ${Math.round(realModel.timeoutMs / 1000)} s; ` : ''}${artifactVerification
        ? `${baseVerification.summary} | Artifacts (${artifactVerification.passedCount}/${artifactVerification.totalRequired}) verified`
        : baseVerification.summary}`,
      ...(artifactVerification ? { artifactVerification } : {}),
    };

    // A real-model rollout's Firestore holds only its own mission (and that mission's checkpoints and
    // tasks); the scripted path finds its mission by its instruction.
    const workDocs = await db.query('', COLLECTIONS.work, [], { noOrderBy: true, limit: 50 });
    const missions = realModel ? workDocs.filter((d) => d.type === 'M') : workDocs;
    const rawEnvelope = missions.find((d) => String(d.instruction || '').includes(taskInstruction.slice(0, 20))) ||
      missions[0] || {
        id: `mission-${task.id}`,
        status: fixtureVerification.passed && !realModel ? 'complete' : 'failed',
        checkpoint_spine: [],
      };

    // A real-model run keeps what the mission did; the scripted path writes its expected clauses in.
    const isDone = (status) => ['completed', 'complete', 'done', 'passed'].includes(status);
    const rawSpine =
      Array.isArray(rawEnvelope.checkpoint_spine) && rawEnvelope.checkpoint_spine.length > 0
        ? rawEnvelope.checkpoint_spine
        : realModel
          ? []
          : (task.expectedClauses || ['Complete task']).map((clause, idx) => ({
              index: idx + 1,
              instruction: clause,
              status: 'completed',
            }));

    const normalizedSpine = rawSpine.map((cp, idx) => ({
      ...cp,
      n: cp.n ?? cp.index ?? idx + 1,
      goal: cp.goal || cp.instruction || (task.expectedClauses || [])[idx] || '',
      status: realModel
        ? (isDone(cp.status) ? 'done' : cp.status || 'failed')
        : fixtureVerification.passed && (cp.status === 'completed' || cp.status === 'done' || cp.status === 'passed')
          ? 'done'
          : 'failed',
      replan_count: cp.replan_count ?? cp.replan_attempts ?? 0,
      result_summary: `${cp.summary || cp.result_summary || ''} | ${fixtureVerification.summary} | ${(task.expectedClauses || []).join('; ')}`,
    }));

    const envelope = {
      ...rawEnvelope,
      role,
      duration_ms: realModel ? Date.now() - startedAt : 950,
      status: realModel
        ? (isDone(rawEnvelope.status) ? 'completed' : rawEnvelope.status || 'failed')
        : fixtureVerification.passed && (rawEnvelope.status === 'complete' || rawEnvelope.status === 'completed')
          ? 'completed'
          : 'failed',
      checkpoint_spine: normalizedSpine,
    };

    const tasks = normalizedSpine.map((cp, idx) => ({
      id: `${task.id}-task-${idx + 1}`,
      index: idx,
      checkpoint_n: cp.n,
      goal: cp.goal,
      status: realModel
        ? (cp.status === 'done' ? 'completed' : 'failed')
        : fixtureVerification.passed ? 'completed' : 'failed',
      tool_records: realModel
        ? []
        : fixtureVerification.toolRecords || [{ tool: 'shell', exitCode: fixtureVerification.passed ? 0 : 1 }],
    }));

    const judgePacket = buildJudgePacket({
      task,
      envelope,
      tasks,
      workspaceDir: taskDir,
      fixtureVerification,
    });

    const useFrontierJudge = Boolean(opts.useFrontierJudge || opts.judgeCommittee || opts.judgeOptions);
    const evalCritique = useFrontierJudge
      ? await evaluateWithFrontierCommittee(judgePacket, {
          committee: opts.judgeCommittee || DEFAULT_JUDGE_COMMITTEE,
          ...(opts.judgeOptions || {}),
        })
      : realModel
        ? {
            passed: Boolean(fixtureVerification.passed),
            rubricScore: typeof fixtureVerification.score === 'number' ? fixtureVerification.score : fixtureVerification.passed ? 1 : 0,
            failureReasons: fixtureVerification.passed ? [] : [fixtureVerification.summary],
            // What the proposer is told about a failed run (lenses.mjs judgePrescriptions); a held-out
            // task's never reaches it (recursion.mjs).
            ...(fixtureVerification.passed
              ? {}
              : { improvementPrescription: `the ${role} mission for "${taskInstruction.slice(0, 160)}" ended with ${fixtureVerification.summary}` }),
          }
        : {
            passed: Boolean(fixtureVerification.passed && envelope.status === 'completed'),
            rubricScore: fixtureVerification.passed && envelope.status === 'completed' ? 1.0 : 0.3,
            failureReasons: fixtureVerification.passed ? [] : [fixtureVerification.summary],
          };

    return {
      envelope,
      checkpoints: [],
      tasks,
      usageRecords,
      evalCritique,
      fixtureVerification,
      judgePacket,
      // The share of a model-suite task's checks that passed: a real-model run's capability.
      ...(realModel && modelTask ? { checkScore: fixtureVerification.score } : {}),
      // Without a gateway URL or a real model the in-process fixture gateway wrote every organ's answer,
      // so the run is the same for any harness and measures nothing about a candidate. A gateway URL's
      // gateway reads its own installed prompts. Only a real-model run measured the side it ran for
      // (evidence.mjs refuses the others).
      // A checkout without its role's command launchers (one on Windows) runs a different agent than
      // an instance does, so its run is not a measurement.
      scripted: !opts.gatewayUrl && !realModel,
      measured: Boolean(realModel) && !launcherProblem,
      ...(launcherProblem ? { launcherProblem } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    };
  } finally {
    if (gateway) await runWithin(gateway.stop(), GATEWAY_STOP_GRACE_MS);
    if (ownFirestore) await ownFirestore.stop();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

/** How long a stopping gateway may take to answer its requests in flight before a rollout moves on. */
const GATEWAY_STOP_GRACE_MS = 30_000;

/** The project of a real-model rollout's own Firestore. */
const ROLLOUT_PROJECT = 'paraclete-h2-rollout';

/**
 * A real-model rollout's instance record, for the commands its agent runs (they read
 * PARACLETE_INSTANCE): its own Firestore and storage endpoints, its data root, the side's checkout.
 * Returns the file's path.
 */
function writeRolloutInstance({ workspaceDir, surfaceRoot, role, firestoreHost, gcsOrigin }) {
  const file = path.join(workspaceDir, 'instance.json');
  const posix = (p) => String(p).replace(/\\/g, '/');
  fs.writeFileSync(file, `${JSON.stringify({
    project: ROLLOUT_PROJECT,
    region: 'us-central1',
    zone: 'us-central1-a',
    agent_name: 'Paraclete',
    role,
    install_root: posix(surfaceRoot),
    data_root: posix(workspaceDir),
    bucket: `${ROLLOUT_PROJECT}-bucket`,
    workspace: null,
    endpoints: { firestore: firestoreHost, storage: gcsOrigin },
    gateway_token_file: path.join(workspaceDir, 'gateway-token'),
  }, null, 2)}\n`, 'utf8');
  return file;
}

/** Waits for `promise`, at most `ms`; resolves 'timeout' when the time runs out first. */
async function runWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default candidate workspace mutation generator driven by `buildMutationProposalSpec`.
 * Applies bounded, valid harness improvements inside `targetRoot` (isolated git worktree).
 */
export async function applyDefaultCandidateMutation({ spec, baseState, targetRoot }) {
  const stepIndex = (spec.priorAttemptsSummary?.length || 0) + 1;
  const gen = Number(baseState?.generation || 0) + 1;
  const level = (gen - 1) * 2 + stepIndex;

  if (baseState?.filePatches && typeof baseState.filePatches === 'object') {
    for (const [relPath, content] of Object.entries(baseState.filePatches)) {
      const abs = path.join(targetRoot, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
  }

  if (spec.lens === 'INV') {
    const contractsPath = path.join(targetRoot, 'config', 'contracts.json');
    if (fs.existsSync(contractsPath)) {
      const raw = JSON.parse(fs.readFileSync(contractsPath, 'utf8'));
      if (raw.vertex && typeof raw.vertex === 'object') {
        raw.vertex.gemini_explicit_cache = true;
      }
      if (raw.organs && typeof raw.organs === 'object') {
        const currentSteps = Number(raw.organs.max_steps) || 25;
        raw.organs.max_steps = Math.max(15, Math.min(currentSteps - stepIndex, 25 - level));
      }
      if (raw.brain && typeof raw.brain === 'object') {
        const currentPreview = Number(raw.brain.result_preview_chars) || 3000;
        raw.brain.result_preview_chars = Math.max(1650, Math.min(currentPreview - stepIndex * 150, 3000 - level * 150));
      }
      fs.writeFileSync(contractsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      return { touchedPaths: ['config/contracts.json'] };
    }
  }

  const requestedOverlay = String(spec?.targetMutablePath || '').replace(/\\/g, '/');
  const overlayRel =
    requestedOverlay.startsWith('roles/') && !requestedOverlay.startsWith('roles/generic/')
      ? requestedOverlay
      : 'roles/paraclete-h2/prompts/cortex.md';
  const overlayAbs = path.join(targetRoot, overlayRel);
  if (overlayRel !== 'roles/paraclete-h2/prompts/cortex.md') {
    const existing = fs.existsSync(overlayAbs) ? fs.readFileSync(overlayAbs, 'utf8') : `# Overlay (${overlayRel})\n`;
    const cleaned = existing.replace(/\n*## Capability-First Artifact Protocol[\s\S]*$/m, '').trimEnd();
    const protocolLines = [
      '',
      '## Capability-First Artifact Protocol',
      '- Verify every required output artifact on disk before reporting checkpoint completion.',
      '- Cross-check numeric totals, schema keys, and boundary edge cases with deterministic read-back.',
      ...(level <= 2 ? ['- Emit grounded citations for every claim and preserve immutable spine boundaries.'] : []),
    ];
    fs.mkdirSync(path.dirname(overlayAbs), { recursive: true });
    fs.writeFileSync(overlayAbs, `${cleaned}\n${protocolLines.join('\n')}\n`, 'utf8');
    return { touchedPaths: [overlayRel] };
  }
  if (fs.existsSync(overlayAbs)) {
    const optionalClauses = [
      '- Verify Pareto dominance on capability, reliability, and efficiency before promotion.',
      '- Archive candidate lineage and reject stale platform versions during harvesting.',
      '- Keep all assembled organ prompts within the 24,000-character budget.',
    ];
    const conciseLines = [
      '# Role Overlay: Paraclete-H² (`cortex`)',
      '',
      'Operate as the unified Harness Engineer for Loop A (evolution) and Loop B (harvesting).',
      'Credo: Capability overrides all other metrics and must never regress; optimize efficiency only after capability.',
      'Attribute every failure to a single diagnostic lens before mutating:',
      '- `INV` (`c1_contracts`, `c2_base_prompts`, `c3_cerebellum_verifier`, `c4_memory_consolidation`): mechanical loop, tool, or token budget issues.',
      '- `DOM` (`c5_role_overlays`, `c6_skill_playbooks`, `c7_role_manifests`): role rubric or domain workflow gaps.',
      ...optionalClauses.slice(0, Math.max(0, 4 - Math.min(4, level))),
      'Never mutate immutable spine modules. Enforce Tier-1 validation before rollout.',
    ];
    fs.writeFileSync(overlayAbs, `${conciseLines.join('\n')}\n`, 'utf8');
    return { touchedPaths: [overlayRel] };
  }

  return { touchedPaths: [] };
}

/**
 * Propose and apply a candidate harness mutation with a model: build the request
 * (proposer.mjs `buildProposalPrompt`), ask the generator (`vertexGenerate`, or by default a Gemini
 * model on Vertex AI through `createVertexProposalGenerator`), and write its edits into `targetRoot`.
 * When there is no generator, the call fails, or the answer is unusable or changes nothing, it applies
 * `fallback` (the template edits of `applyDefaultCandidateMutation`) instead and says why in
 * `fallbackReason`. A fallback is never promoted, and recursion.mjs does not evaluate it.
 *
 * @param {object} opts
 * @param {object} opts.spec
 * @param {object} opts.baseState
 * @param {string} opts.targetRoot
 * @param {Function} [opts.vertexGenerate]  Async `(prompt: string, spec: object) => Promise<string | { hypothesis?: string, edits?: object[], patches?: Record<string,string> }>`
 * @param {Function} [opts.fallback]
 * @returns {Promise<{ touchedPaths: string[], hypothesis?: string, source: 'vertex' | 'fallback', fallbackReason?: string }>}
 */
export async function proposeVertexMutation(opts = {}) {
  const { spec, baseState, targetRoot, vertexGenerate } = opts;
  const fallback = opts.fallback || applyDefaultCandidateMutation;

  if (baseState?.filePatches && typeof baseState.filePatches === 'object') {
    for (const [relPath, content] of Object.entries(baseState.filePatches)) {
      const abs = path.join(targetRoot, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
  }

  let fallbackReason;
  try {
    const generate = vertexGenerate || createVertexProposalGenerator();
    const { prompt } = buildProposalPrompt({ spec, targetRoot });
    const proposal = parseProposal(await generate(prompt, spec));
    const { touchedPaths } = applyProposal({ proposal, targetRoot, stage: spec?.stage });
    if (touchedPaths.length > 0) {
      return {
        touchedPaths,
        hypothesis: proposal.hypothesis || `${spec?.lens || 'INV'} model proposal`,
        source: 'vertex',
      };
    }
    fallbackReason = 'the model proposed no change';
  } catch (err) {
    fallbackReason = err?.message || String(err);
  }

  const fb = await fallback({ spec, baseState, targetRoot });
  return {
    touchedPaths: fb?.touchedPaths || [],
    hypothesis: fb?.hypothesis || `${spec?.lens || 'INV'} (${spec?.escalationMode || 'refine'}) live candidate`,
    source: 'fallback',
    fallbackReason,
  };
}

/**
 * Build a live `proposeAndApply` callback for `runEvolutionLoop` that creates an
 * isolated worktree (or uses a custom `applyMutation` hook), records touched paths,
 * and binds a candidate `runTaskRollout` reflecting the mutated workspace state.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.stage]
 * @param {boolean} [opts.useWorktree]
 * @param {boolean} [opts.useVertex]
 * @param {Function} [opts.vertexGenerate]
 * @param {Function} [opts.applyMutation]
 * @param {Function} [opts.execGit]
 */
export function createLiveProposeAndApply(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const stage = opts.stage || 'stage1';

  return async function proposeAndApply(spec, baseState) {
    const stepIndex = (spec.priorAttemptsSummary?.length || 0) + 1;
    const candidateId = `${baseState.id}-${spec.lens.toLowerCase()}-${stepIndex}`;

    let touchedPaths = [];
    let mutationHypothesis = `${spec.lens} (${spec.escalationMode}) live candidate`;
    // Where the change came from: 'vertex' (a model proposed it), 'fallback' or 'template' (the fixed
    // edits of applyDefaultCandidateMutation), 'custom' (an applyMutation hook), 'none' (no change).
    // Promotion evidence (evidence.mjs) refuses template changes, and recursion.mjs does not evaluate
    // them. A model proposal that fell back to the template says why in fallbackReason.
    let proposalSource = 'none';
    let fallbackReason = null;
    let worktreeInfo = null;
    if (opts.useWorktree) {
      worktreeInfo = createIsolatedWorktree({
        repoRoot,
        candidateId,
        execGit: opts.execGit,
      });
    }

    try {
      const targetRoot = worktreeInfo ? worktreeInfo.worktreePath : repoRoot;
      const mutator =
        typeof opts.applyMutation === 'function'
          ? opts.applyMutation
          : opts.useVertex
            ? (args) => proposeVertexMutation({ ...args, vertexGenerate: opts.vertexGenerate })
            : worktreeInfo
              ? applyDefaultCandidateMutation
              : null;

      if (mutator) {
        const effectiveSpec = opts.targetMutablePath
          ? { ...spec, targetMutablePath: opts.targetMutablePath }
          : spec;
        const res = await mutator({
          spec: effectiveSpec,
          baseState,
          candidateId,
          targetRoot,
        });
        touchedPaths = Array.isArray(res?.touchedPaths)
          ? res.touchedPaths
          : (worktreeInfo ? getWorktreeTouchedPaths(targetRoot, { execGit: opts.execGit }) : []);
        if (res?.hypothesis) {
          mutationHypothesis = res.hypothesis;
        }
        proposalSource = res?.source
          || (mutator === applyDefaultCandidateMutation ? 'template' : typeof opts.applyMutation === 'function' ? 'custom' : 'none');
        fallbackReason = res?.fallbackReason || null;
      }

      const filePatches = { ...(baseState?.filePatches || {}) };
      for (const rel of touchedPaths) {
        const abs = path.join(targetRoot, rel);
        if (fs.existsSync(abs)) {
          filePatches[rel] = fs.readFileSync(abs, 'utf8');
        }
      }

      const roleSnapshots = new Map();
      const getSnapshotForRole = (roleName) => {
        if (!roleSnapshots.has(roleName)) {
          if (fs.existsSync(path.join(targetRoot, 'config', 'contracts.json'))) {
            roleSnapshots.set(
              roleName,
              snapshotCandidateConfig(targetRoot, roleName),
            );
          } else {
            return roleSnapshots.get('generic') || roleSnapshots.get('paraclete-h2');
          }
        }
        return roleSnapshots.get(roleName);
      };
      const stageRoles = new Set([
        'generic',
        'paraclete-h2',
        ...DEFAULT_ROLES,
        ...rolesForStage(stage, { repoRoot: targetRoot }),
      ]);
      for (const r of stageRoles) {
        getSnapshotForRole(r);
      }

      // A real-model rollout runs from a checkout of HEAD with this candidate's files written in, so
      // the model sees its prompts; the scripted one reads only its config snapshot.
      const runTaskRollout = worktreeInfo
        ? async (task, substrateCtx) =>
            runInProcessBrainRollout(task, substrateCtx, {
              repoRoot,
              configSnapshot: getSnapshotForRole(task.role || 'paraclete-h2'),
              gatewayUrl: opts.gatewayUrl,
              gatewayToken: opts.gatewayToken,
              useFrontierJudge: opts.useFrontierJudge,
              judgeCommittee: opts.judgeCommittee,
              judgeOptions: opts.judgeOptions,
              ...(opts.realModel ? { realModel: opts.realModel, filePatches } : {}),
            })
        : undefined;

      return {
        id: candidateId,
        parentId: baseState.id,
        lens: spec.lens,
        stage,
        allowedComponents: spec.allowedComponents,
        touchedPaths,
        filePatches,
        roleSnapshots,
        worktreePath: worktreeInfo?.worktreePath || null,
        hypothesis: mutationHypothesis,
        proposal: {
          source: proposalSource,
          hypothesis: mutationHypothesis,
          ...(fallbackReason ? { fallbackReason } : {}),
        },
        runTaskRollout,
      };
    } finally {
      if (worktreeInfo && opts.autoCleanup !== false) {
        worktreeInfo.cleanup();
      }
    }
  };
}

/**
 * Run a live Tier-1 evaluation against `repoRoot` using the real in-process
 * `buildBrain` + HTTP Gateway + seeded workspace fixtures.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {'stage1' | 'stage2'} [opts.stage]
 * @param {string} [opts.role]
 * @param {object[]} [opts.tasks]
 * @param {Function} [opts.runTaskRollout]
 * @param {number} [opts.trials]  How many times each task runs (default 1)
 * @param {string} [opts.gatewayUrl]
 * @param {string} [opts.gatewayToken]
 * @param {object} [opts.realModel]    a real-model run's context (model-runs.mjs)
 * @param {object} [opts.filePatches]  with realModel and the default rollout: the side's files that
 *                                     differ from HEAD (none for the baseline)
 * @param {object} [opts.deps]
 */
export async function evaluateLiveTarget(opts = {}) {
  const stage = opts.stage || 'stage1';
  const tasks = opts.tasks || selectBenchmarkTasks({ stage, role: opts.role });
  const repoRoot = opts.repoRoot || process.cwd();
  const validation = validateCandidateWorkspace({
    repoRoot,
    touchedPaths: opts.touchedPaths || [],
    stage,
    runTests: Boolean(opts.runTests),
    deps: opts.deps,
  });

  const defaultRollout = (task, substrateCtx) =>
    runInProcessBrainRollout(task, substrateCtx, {
      repoRoot,
      gatewayUrl: opts.gatewayUrl,
      gatewayToken: opts.gatewayToken,
      useFrontierJudge: opts.useFrontierJudge,
      judgeCommittee: opts.judgeCommittee,
      judgeOptions: opts.judgeOptions,
      ...(opts.realModel ? { realModel: opts.realModel, filePatches: opts.filePatches || {} } : {}),
    });

  const evalRes = await runTier1Evaluation({
    stage,
    role: opts.role,
    tasks,
    trials: opts.trials,
    runTaskRollout: opts.runTaskRollout || defaultRollout,
    // A real-model rollout that fails ran the side's own code, so it counts against that side.
    failedRunsMeasured: Boolean(opts.realModel),
    ...(opts.deps?.retry ? { retry: opts.deps.retry } : {}),
    ...(opts.deps?.sleep ? { sleep: opts.deps.sleep } : {}),
    deps: opts.deps,
  });

  return {
    ...evalRes,
    repoRoot,
    validation,
    hasPromptsDir: fs.existsSync(path.join(repoRoot, 'prompts')),
  };
}

/**
 * Create a Tier-2 canary runner that executes a read-only smoke test and optional
 * task rollouts against a canary VM (`canaryAgent`), in its own project (`projectId`, `zone`) when
 * those are given; the `canary` subcommand gives the lab canary's (lab-canary.mjs). Without a
 * `runSmoke` nothing reaches a VM, so the smoke check fails and there are no rollouts: it never
 * reports a canary it did not run.
 *
 * @param {object} [opts]
 * @param {string} [opts.role]
 * @param {string} [opts.projectId]  the canary's project
 * @param {string} [opts.zone]
 * @param {Function} [opts.runSmoke]   Injectable `(args: { canaryAgent, role, projectId?, zone? }) => Promise<{ pass?: boolean, exitCode?: number }>`
 * @param {Function} [opts.runTask]    Injectable `(task, { canaryAgent, role, projectId?, zone? }) => Promise<object>`
 */
export function createDevCanaryRunner(opts = {}) {
  return async function canaryRunner({ canaryAgent, tasks = [] }) {
    if (typeof opts.runSmoke !== 'function') return { smokePassed: false, rollouts: [] };
    const role = opts.role || tasks[0]?.role || 'paraclete-h2';
    const target = {
      canaryAgent,
      role,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.zone ? { zone: opts.zone } : {}),
    };
    const smokeRes = await opts.runSmoke(target);
    const smokePassed = Boolean(smokeRes?.pass ?? (smokeRes?.exitCode === 0));
    const rollouts = [];
    for (const task of tasks) {
      if (typeof opts.runTask === 'function') {
        rollouts.push(await opts.runTask(task, target));
      } else {
        rollouts.push({
          envelope: {
            id: `canary-${canaryAgent}-${task.id}`,
            role: task.role || role,
            status: smokePassed ? 'completed' : 'failed',
            duration_ms: 1500,
            checkpoint_spine: (task.expectedClauses || []).map((clause, idx) => ({
              n: idx + 1,
              goal: clause,
              status: smokePassed ? 'done' : 'failed',
              replan_count: 0,
              result_summary: smokePassed ? `Canary verified: ${clause}` : `Canary failed: ${clause}`,
            })),
          },
          checkpoints: [],
          tasks: (task.expectedClauses || []).map((clause, idx) => ({
            id: `canary-task-${idx + 1}`,
            index: idx,
            checkpoint_n: idx + 1,
            goal: clause,
            status: smokePassed ? 'completed' : 'failed',
            tool_records: [{ tool: 'shell', exitCode: smokePassed ? 0 : 1 }],
          })),
          usageRecords: [{ promptTokenCount: 1600, candidatesTokenCount: 450, cachedContentTokenCount: 800 }],
        });
      }
    }
    return { smokePassed, rollouts };
  };
}

const PARACLETE_STARTUP_SCRIPT = `#!/bin/bash
# paraclete startup script, written by install/install.sh. Fetches install/bootstrap.sh from the
# repository and commit in this VM's metadata and runs it as root in the unit paraclete-bootstrap.
# Read its output with: journalctl -u paraclete-bootstrap
set -euo pipefail
attribute() {
  curl --fail --silent --show-error --retry 5 --retry-connrefused -H 'Metadata-Flavor: Google' \\
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}
repo="$(attribute paraclete-repo)"
ref="$(attribute paraclete-ref)"
install -d -m 0700 /run/paraclete-bootstrap
curl --fail --silent --show-error --location --retry 10 --retry-delay 6 --retry-all-errors \\
  --output /run/paraclete-bootstrap/bootstrap.sh \\
  "https://raw.githubusercontent.com/\${repo}/\${ref}/install/bootstrap.sh"
exec systemd-run --unit=paraclete-bootstrap --collect --wait --quiet --setenv=HOME=/root \\
  --property=StandardOutput=journal --property=StandardError=journal \\
  /bin/bash /run/paraclete-bootstrap/bootstrap.sh
`;

/** A zone, and the region it is in, as dev-env.mjs checks them in instance.env. */
const ZONE = /^([a-z]+-[a-z]+[0-9]+)-[a-z]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]+$/;

/**
 * The lab's region and zone: `--zone` alone sets its region, `--region` alone its `-a` zone, neither
 * is us-central1-a. Throws on a malformed one, or a zone outside the region, which every dev/ command
 * would refuse in the canary's instance.env.
 *
 * @param {{region?: string|boolean, zone?: string|boolean}} opts
 * @returns {{region: string, zone: string}}
 */
function labLocation({ region, zone }) {
  const given = (v) => v !== undefined && v !== null;
  if (given(zone) && !ZONE.test(String(zone))) throw new Error(`--zone must be a zone such as us-central1-a, got '${String(zone).slice(0, 40)}'`);
  if (given(region) && !REGION.test(String(region))) throw new Error(`--region must be a region such as us-central1, got '${String(region).slice(0, 40)}'`);
  const r = given(region) ? region : given(zone) ? ZONE.exec(zone)[1] : 'us-central1';
  const z = given(zone) ? zone : `${r}-a`;
  if (!z.startsWith(`${r}-`)) throw new Error(`--zone ${z} is not in --region ${r}: give a zone in the region, or --zone alone`);
  return { region: r, zone: z };
}

/** The flags that name the lab in a command it prints: both projects, the region and the zone. */
function labFlagsOf({ projectId, canaryProjectId, region, zone }) {
  return `--project ${projectId} --canary-project ${canaryProjectId} --region ${region} --zone ${zone}`;
}

/** The indexes and TTL policies the agent's and the dashboard's queries need; install.sh reads it too. */
const INDEXES_FILE = new URL('../../install/firestore.indexes.json', import.meta.url);

/**
 * A lab project's Firestore gets what install.sh gives an instance's: every index and TTL policy in
 * install/firestore.indexes.json that the database lacks is created in the background (--async), so a
 * second run creates nothing. A create Firestore answers ALREADY_EXISTS made what was wanted (another
 * creator got there first, or gcloud retried a create that had gone through). Until an index is built,
 * the query it serves fails and the agent's services and the dev/ commands retry or report it.
 */
function ensureFirestoreIndexes(execGcloud, p, step) {
  const file = JSON.parse(fs.readFileSync(INDEXES_FILE, 'utf8'));
  const db = ['--database=(default)', `--project=${p}`];
  const listing = (args) => {
    try {
      return JSON.parse(execGcloud([...args, ...db, '--format=json']) || '[]');
    } catch {
      return [];
    }
  };
  const have = new Set(indexIds(listing(['firestore', 'indexes', 'composite', 'list'])).map((i) => i.signature));
  const indexes = indexPlan(file).filter((index) => !have.has(index.signature));
  for (const index of indexes) {
    try {
      execGcloud(['firestore', 'indexes', 'composite', 'create', `--collection-group=${index.group}`, `--query-scope=${index.scope}`,
        ...index.fields.map((f) => `--field-config=field-path=${f.path},order=${f.order}`), ...db, '--async', '--quiet']);
    } catch (err) {
      if (!/ALREADY_EXISTS/.test(`${err?.message || ''}\n${err?.stderr || ''}`)) throw err;
    }
  }
  step('firestore-indexes', indexes.length ? 'created' : 'exists', `${indexes.length} of ${indexPlan(file).length} created`);

  const ttls = listing(['firestore', 'fields', 'ttls', 'list']);
  const missing = ttlPlan(file).filter((t) => !['ACTIVE', 'CREATING'].includes(ttlState(ttls, t.group, t.field)));
  for (const t of missing) {
    execGcloud(['firestore', 'fields', 'ttls', 'update', t.field, `--collection-group=${t.group}`, '--enable-ttl', ...db, '--async', '--quiet']);
  }
  step('firestore-ttls', missing.length ? 'created' : 'exists', missing.map((t) => `${t.group}.${t.field}`).join(', '));
}

/**
 * Generate the harness lab's provisioning plan and exact commands: `paraclete-h2-driver`
 * (`e2-standard-8`) in the lab's project (`paraclete-h2-lab` unless `projectId`), and
 * `paraclete-h2-canary` (`e2-standard-4`) in a project of its own (`<lab project>-canary` unless
 * `canaryProjectId`; lab-canary.mjs), because one project holds one paraclete and each VM runs a full
 * install. Each project gets what its VM needs (`projects`). The driver's agent account also gets, on
 * the canary's project, what the dev/ commands need to check the canary (`driverAccess`), and its
 * harness checkout gets the canary's coordinates (`instanceEnv`). Throws when the canary's project
 * cannot be worked out (canaryProjectFor), or the region and zone do not fit (labLocation).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]  the lab's project, which holds the driver
 * @param {string} [opts.canaryProjectId]  the canary's project
 * @param {string} [opts.zone]  default the region's -a zone
 * @param {string} [opts.region]  default the zone's region, else us-central1
 * @param {string} [opts.organizationId]
 * @param {string} [opts.billingAccount]
 * @param {string|number} [opts.intervalMinutes]  the follow-main timer's interval (lab-updater.mjs)
 */
export function buildGcpLabPlan(opts = {}) {
  const projectId = opts.projectId || 'paraclete-h2-lab';
  const canaryProjectId = canaryProjectFor(projectId, opts.canaryProjectId);
  const { region, zone } = labLocation(opts);
  const intervalMinutes = parseIntervalMinutes(opts.intervalMinutes);
  const serviceAccountId = 'paraclete-agent';
  const serviceAccountOf = (project) => [serviceAccountId, `${project}.iam.gserviceaccount.com`].join('@');

  const apis = [
    'compute.googleapis.com',
    'run.googleapis.com',
    'firestore.googleapis.com',
    'iam.googleapis.com',
    'iamcredentials.googleapis.com',
    'aiplatform.googleapis.com',
    'artifactregistry.googleapis.com',
    'cloudbuild.googleapis.com',
    'secretmanager.googleapis.com',
    'storage.googleapis.com',
    'iap.googleapis.com',
    'drive.googleapis.com',
    'cloudresourcemanager.googleapis.com',
  ];

  const projectRoles = [
    'roles/aiplatform.user',
    'roles/datastore.user',
    'roles/logging.logWriter',
    'roles/monitoring.metricWriter',
    'roles/logging.viewer',
    'roles/storage.objectUser',
    'roles/storage.bucketViewer',
    'roles/cloudbuild.builds.editor',
  ];

  // One project per paraclete: the driver's, then the canary's.
  const projects = [
    { projectId, displayName: 'Paraclete H2 Evolution Lab', vm: LAB_CANARY.driverVm },
    { projectId: canaryProjectId, displayName: 'Paraclete H2 Canary', vm: LAB_CANARY.vm },
  ].map((p) => ({ ...p, bucket: `${p.projectId}-paraclete`, serviceAccountEmail: serviceAccountOf(p.projectId) }));
  const [lab, canary] = projects;
  const inProject = (p) => ({ projectId: p.projectId, bucket: p.bucket, serviceAccountEmail: p.serviceAccountEmail });
  const labFlags = labFlagsOf({ projectId, canaryProjectId, region, zone });
  const orgFlag =opts.organizationId ? ` --organization=${opts.organizationId}` : '';

  return {
    projectId,
    canaryProjectId,
    region,
    zone,
    organizationId: opts.organizationId || null,
    billingAccount: opts.billingAccount || null,
    serviceAccountId,
    apis,
    projectRoles,
    projects,
    vms: [
      {
        name: LAB_CANARY.driverVm,
        ...inProject(lab),
        machineType: 'e2-standard-8',
        role: 'paraclete-h2',
        agentName: 'Paraclete-H2-Driver',
        tier: 'Tier-1 Evolution Driver (Loop A + Loop B Harvester)',
        bootDiskGb: 100,
        bootDiskType: 'pd-ssd',
        imageFamily: 'debian-12',
        imageProject: 'debian-cloud',
        harnessCheckout: FOLLOW_MAIN.harnessCheckout,
      },
      {
        name: LAB_CANARY.vm,
        ...inProject(canary),
        machineType: 'e2-standard-4',
        role: 'software-engineer',
        agentName: 'Paraclete-H2-Canary',
        tier: 'Tier-2 Canary Target (Real Vertex AI + Firestore + systemd)',
        bootDiskGb: 50,
        bootDiskType: 'pd-balanced',
        imageFamily: 'debian-12',
        imageProject: 'debian-cloud',
        harnessCheckout: null,
      },
    ],
    driverAccess: driverAccessOnCanary({
      canaryProjectId,
      driverServiceAccountEmail: lab.serviceAccountEmail,
      canaryServiceAccountEmail: canary.serviceAccountEmail,
    }),
    instanceEnv: {
      vm: LAB_CANARY.driverVm,
      path: LAB_CANARY.instanceEnvPath,
      text: canaryInstanceEnv({ projectId: canaryProjectId, region, zone }),
    },
    // Lab only: both VMs follow main's head through upgrade.sh. Product instances follow releases.
    followMain: { timer: FOLLOW_MAIN.timerUnit, intervalMinutes },
    commands: [
      ...projects.flatMap((p) => [
        `gcloud projects create ${p.projectId} --name="${p.displayName}"${orgFlag}`,
        ...(opts.billingAccount ? [`gcloud billing projects link ${p.projectId} --billing-account=${opts.billingAccount}`] : []),
        `gcloud services enable ${apis.join(' ')} --project=${p.projectId}`,
      ]),
      `gcloud compute instances create ${LAB_CANARY.driverVm} --project=${projectId} --zone=${zone} --machine-type=e2-standard-8 --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=100GB --boot-disk-type=pd-ssd --scopes=cloud-platform,https://www.googleapis.com/auth/drive --tags=paraclete`,
      `gcloud compute instances create ${LAB_CANARY.vm} --project=${canaryProjectId} --zone=${zone} --machine-type=e2-standard-4 --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=50GB --boot-disk-type=pd-balanced --scopes=cloud-platform,https://www.googleapis.com/auth/drive --tags=paraclete`,
      `node dev/harness2/cli.mjs lab-follow-main --install --interval ${intervalMinutes} ${labFlags}`,
      `node dev/harness2/cli.mjs lab-status ${labFlags}`,
    ],
  };
}

/**
 * Resolve the current repository's GitHub `owner/name` and 40-character HEAD commit SHA.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {Function} [opts.execGit]
 */
function resolveRepoAndCommit(opts = {}) {
  const cwd = opts.repoRoot || process.cwd();
  const execGit = opts.execGit || defaultExecGit;
  let repo = opts.repo || null;
  if (!repo) {
    try {
      const remoteUrl = execGit(['remote', 'get-url', 'origin'], cwd);
      const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
        String(remoteUrl).trim(),
      );
      if (m) repo = `${m[1]}/${m[2]}`;
    } catch {
      repo = null;
    }
  }
  let commit = opts.commit || null;
  if (!commit) {
    try {
      commit = execGit(['rev-parse', 'HEAD'], cwd);
    } catch {
      commit = null;
    }
  }
  return {
    repo,
    commit,
    release: opts.release || 'main',
  };
}

/** Why a gcloud call failed, in one short line. Never err.message from execFileSync: it repeats the whole command line. */
function gcloudProblem(err, what = 'gcloud') {
  return Number.isInteger(err?.status)
    ? `${what} exited with code ${err.status}`
    : String(err?.message || err).split('\n')[0].slice(0, 200);
}

/** Runs an IAM call, again while a principal or role just created is not visible yet. */
function iamWithRetry(execGcloud, args, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execGcloud(args);
    } catch (err) {
      const msg = String(err?.stderr || err?.message || '');
      if (attempt < maxAttempts && msg.includes('does not exist')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Steps 1 to 7 of provisionGcpLab for one of the lab's projects: the project and its billing, the APIs,
 * the agent's service account and its roles, Firestore with the indexes install.sh gives it, the
 * bucket, the network and the IAP SSH firewall. Each step checks first, so a second run creates
 * nothing. Returns the network's name.
 */
function provisionLabProject(plan, project, { execGcloud, recordStep }) {
  const p = project.projectId;
  const step = (name, status, detail = '') => recordStep(name, status, detail, p);

  // 1. Ensure project exists
  let projectExists = false;
  try {
    const num = execGcloud(['projects', 'describe', p, '--format=value(projectNumber)']);
    projectExists = Boolean(num);
  } catch {
    projectExists = false;
  }
  if (!projectExists) {
    const createArgs = ['projects', 'create', p, `--name=${project.displayName}`, '--quiet'];
    if (plan.organizationId) {
      createArgs.push(`--organization=${plan.organizationId}`);
    }
    execGcloud(createArgs);
    step('project', 'created', p);
  } else {
    step('project', 'exists', p);
  }

  // 2. Ensure billing is linked
  let billingEnabled = false;
  try {
    const enabled = execGcloud(['billing', 'projects', 'describe', p, '--format=value(billingEnabled)']);
    billingEnabled = /^true$/i.test(String(enabled).trim());
  } catch {
    billingEnabled = false;
  }
  if (!billingEnabled && plan.billingAccount) {
    execGcloud(['billing', 'projects', 'link', p, `--billing-account=${plan.billingAccount}`, '--quiet']);
    step('billing', 'linked', plan.billingAccount);
  } else {
    step('billing', billingEnabled ? 'enabled' : 'skipped', plan.billingAccount || '');
  }

  // 3. Enable APIs (in batches of 10 per Service Usage limit)
  for (let i = 0; i < plan.apis.length; i += 10) {
    const batch = plan.apis.slice(i, i + 10);
    execGcloud(['services', 'enable', ...batch, `--project=${p}`, '--quiet']);
  }
  step('apis', 'enabled', `${plan.apis.length} APIs`);

  // 4. Service account & IAM bindings
  let saExists = false;
  try {
    const email = execGcloud([
      'iam',
      'service-accounts',
      'describe',
      project.serviceAccountEmail,
      `--project=${p}`,
      '--format=value(email)',
    ]);
    saExists = Boolean(email);
  } catch {
    saExists = false;
  }
  if (!saExists) {
    execGcloud([
      'iam',
      'service-accounts',
      'create',
      plan.serviceAccountId,
      `--project=${p}`,
      '--display-name=paraclete agent',
      '--description=The paraclete agent: its VMs run as this account.',
      '--quiet',
    ]);
    step('service-account', 'created', project.serviceAccountEmail);
  } else {
    step('service-account', 'exists', project.serviceAccountEmail);
  }

  for (const role of plan.projectRoles) {
    iamWithRetry(execGcloud, [
      'projects',
      'add-iam-policy-binding',
      p,
      `--member=serviceAccount:${project.serviceAccountEmail}`,
      `--role=${role}`,
      '--condition=None',
      '--quiet',
    ]);
  }
  iamWithRetry(execGcloud, [
    'iam',
    'service-accounts',
    'add-iam-policy-binding',
    project.serviceAccountEmail,
    `--project=${p}`,
    `--member=serviceAccount:${project.serviceAccountEmail}`,
    '--role=roles/iam.serviceAccountUser',
    '--condition=None',
    '--quiet',
  ]);
  step('iam', 'bound', `${plan.projectRoles.length} project roles`);

  // 5. Firestore Native database
  let fsType = '';
  try {
    fsType = execGcloud([
      'firestore',
      'databases',
      'describe',
      '--database=(default)',
      `--project=${p}`,
      '--format=value(type)',
    ]);
  } catch {
    fsType = '';
  }
  if (!fsType) {
    execGcloud([
      'firestore',
      'databases',
      'create',
      '--database=(default)',
      `--location=${plan.region}`,
      '--type=firestore-native',
      `--project=${p}`,
      '--quiet',
    ]);
    step('firestore', 'created', plan.region);
  } else {
    step('firestore', 'exists', fsType);
  }
  ensureFirestoreIndexes(execGcloud, p, step);

  // 6. GCS bucket
  let bucketExists = false;
  try {
    const bName = execGcloud([
      'storage',
      'buckets',
      'describe',
      `gs://${project.bucket}`,
      `--project=${p}`,
      '--format=value(name)',
    ]);
    bucketExists = Boolean(bName);
  } catch {
    bucketExists = false;
  }
  if (!bucketExists) {
    execGcloud([
      'storage',
      'buckets',
      'create',
      `gs://${project.bucket}`,
      `--project=${p}`,
      `--location=${plan.region}`,
      '--uniform-bucket-level-access',
      '--public-access-prevention',
      '--quiet',
    ]);
    step('bucket', 'created', `gs://${project.bucket}`);
  } else {
    step('bucket', 'exists', `gs://${project.bucket}`);
  }
  execGcloud([
    'storage',
    'buckets',
    'add-iam-policy-binding',
    `gs://${project.bucket}`,
    `--member=serviceAccount:${project.serviceAccountEmail}`,
    '--role=roles/storage.objectAdmin',
    '--quiet',
  ]);

  // 7. Network & IAP SSH firewall rules
  let networkName = 'default';
  try {
    const net = execGcloud(['compute', 'networks', 'describe', 'default', `--project=${p}`, '--format=value(name)']);
    if (!net) networkName = 'paraclete';
  } catch {
    networkName = 'paraclete';
  }
  if (networkName === 'paraclete') {
    let customNetExists = false;
    try {
      customNetExists = Boolean(
        execGcloud(['compute', 'networks', 'describe', 'paraclete', `--project=${p}`, '--format=value(name)']),
      );
    } catch {
      customNetExists = false;
    }
    if (!customNetExists) {
      execGcloud([
        'compute',
        'networks',
        'create',
        'paraclete',
        '--subnet-mode=auto',
        '--description=Created by the paraclete installer',
        `--project=${p}`,
        '--quiet',
      ]);
    }
  }

  let allowRuleExists = false;
  try {
    allowRuleExists = Boolean(
      execGcloud(['compute', 'firewall-rules', 'describe', 'paraclete-allow-iap-ssh', `--project=${p}`, '--format=value(name)']),
    );
  } catch {
    allowRuleExists = false;
  }
  if (!allowRuleExists) {
    execGcloud([
      'compute',
      'firewall-rules',
      'create',
      'paraclete-allow-iap-ssh',
      `--network=${networkName}`,
      '--direction=INGRESS',
      '--action=ALLOW',
      '--rules=tcp:22',
      '--source-ranges=35.235.240.0/20',
      '--target-tags=paraclete',
      '--priority=1000',
      '--description=SSH to the paraclete VMs through Identity-Aware Proxy only',
      `--project=${p}`,
      '--quiet',
    ]);
  }

  let denyRuleExists = false;
  try {
    denyRuleExists = Boolean(
      execGcloud(['compute', 'firewall-rules', 'describe', 'paraclete-deny-ingress', `--project=${p}`, '--format=value(name)']),
    );
  } catch {
    denyRuleExists = false;
  }
  if (!denyRuleExists) {
    execGcloud([
      'compute',
      'firewall-rules',
      'create',
      'paraclete-deny-ingress',
      `--network=${networkName}`,
      '--direction=INGRESS',
      '--action=DENY',
      '--rules=all',
      '--source-ranges=0.0.0.0/0',
      '--target-tags=paraclete',
      '--priority=65000',
      '--description=Nothing else reaches the paraclete VMs',
      `--project=${p}`,
      '--quiet',
    ]);
  }
  step('network', 'ready', networkName);
  return networkName;
}

/**
 * Step 8 of provisionGcpLab: the driver's access to the canary's project (lab-canary.mjs). The custom
 * SSH role is created, brought back from deletion or given the permissions it should have, and left
 * alone when it already has them; the bindings are added, which changes nothing when they are there.
 */
function grantDriverAccess(plan, { execGcloud, recordStep }) {
  const access = plan.driverAccess;
  const p = access.projectId;
  const role = access.sshRole;
  const wanted = [...role.permissions].sort();
  let described = null;
  try {
    described = execGcloud(['iam', 'roles', 'describe', role.id, `--project=${p}`, '--format=json']);
  } catch {
    described = null;
  }
  if (described === null) {
    execGcloud([
      'iam',
      'roles',
      'create',
      role.id,
      `--project=${p}`,
      `--title=${role.title}`,
      `--description=${role.description}`,
      `--permissions=${wanted.join(',')}`,
      '--stage=GA',
      '--quiet',
    ]);
    recordStep('driver-access:ssh-role', 'created', role.name, p);
  } else {
    let current = null;
    try {
      current = JSON.parse(described);
    } catch {
      current = null;
    }
    const deleted = current?.deleted === true;
    if (deleted) execGcloud(['iam', 'roles', 'undelete', role.id, `--project=${p}`, '--quiet']);
    const have = Array.isArray(current?.includedPermissions) ? [...current.includedPermissions].sort().join(',') : null;
    const same = have === wanted.join(',');
    if (!same) execGcloud(['iam', 'roles', 'update', role.id, `--project=${p}`, `--permissions=${wanted.join(',')}`, '--quiet']);
    recordStep('driver-access:ssh-role', deleted ? 'undeleted' : same ? 'exists' : 'updated', role.name, p);
  }
  for (const projectRole of access.projectRoles) {
    iamWithRetry(execGcloud, [
      'projects',
      'add-iam-policy-binding',
      p,
      `--member=${access.member}`,
      `--role=${projectRole}`,
      '--condition=None',
      '--quiet',
    ]);
  }
  for (const binding of access.serviceAccountRoles) {
    iamWithRetry(execGcloud, [
      'iam',
      'service-accounts',
      'add-iam-policy-binding',
      binding.serviceAccount,
      `--project=${p}`,
      `--member=${access.member}`,
      `--role=${binding.role}`,
      '--condition=None',
      '--quiet',
    ]);
  }
  recordStep(
    'driver-access',
    'bound',
    `${access.member}: ${access.projectRoles.length} project roles, ${access.serviceAccountRoles.length} on the canary's account`,
    p,
  );
}

/** A project's VMs, as `gcloud compute instances list` describes them. Throws when gcloud fails. */
function listInstances(execGcloud, projectId) {
  const raw = execGcloud(['compute', 'instances', 'list', `--project=${projectId}`, '--format=json']);
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list : [];
}

/** One listed VM, in the shape lab-status reports. */
function describeInstance(inst, projectId) {
  const items = inst?.metadata?.items || [];
  const meta = (key) => items.find((i) => i.key === key)?.value || null;
  const machineTypeParts = String(inst.machineType || '').split('/');
  const zoneParts = String(inst.zone || '').split('/');
  return {
    name: inst.name,
    project: projectId,
    status: inst.status,
    machineType: machineTypeParts[machineTypeParts.length - 1] || null,
    zone: zoneParts[zoneParts.length - 1] || null,
    role: meta('paraclete-role'),
    agentName: meta('paraclete-agent-name'),
    commit: meta('paraclete-ref'),
    internalIp: inst?.networkInterfaces?.[0]?.networkIP || null,
    externalIp: inst?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || null,
  };
}

/** Whether a listed VM was installed as a paraclete: install.sh's metadata names its role and ref. */
function carriesParaclete(inst) {
  return (inst?.metadata?.items || []).some((item) => item.key === 'paraclete-role' || item.key === 'paraclete-ref');
}

/**
 * What stops provisionGcpLab before it changes anything, or null. It reads only. A project that does
 * not exist yet, or has no billing, cannot have its APIs enabled unless `--billing` is given, which an
 * existing lab gaining its canary's project runs into. And a project that already holds a paraclete
 * other than its own lab VM (another instance's project, named by `--project` or `--canary-project`)
 * would hold two; in the lab's project, a canary from before is the one other VM allowed, and step 10
 * reports it.
 */
function labPreflight(plan, execGcloud) {
  for (const project of plan.projects) {
    const p = project.projectId;
    let exists = false;
    try {
      exists = Boolean(execGcloud(['projects', 'describe', p, '--format=value(projectNumber)']));
    } catch {
      exists = false;
    }
    if (!plan.billingAccount) {
      let billed = false;
      if (exists) {
        try {
          billed = /^true$/i.test(String(execGcloud(['billing', 'projects', 'describe', p, '--format=value(billingEnabled)'])).trim());
        } catch {
          billed = false;
        }
      }
      if (!billed) {
        const why = exists ? `${p} has no billing account linked` : `${p} does not exist yet, and a new project has no billing account`;
        return `${why}, so its APIs cannot be enabled. Run lab-provision again with --billing <account-id>, and --org <org-id> too if the lab is in an organization. Nothing was changed.`;
      }
    }
    if (!exists) continue;
    let listed;
    try {
      listed = listInstances(execGcloud, p);
    } catch (err) {
      // Compute Engine not enabled yet: then the project has no VM at all.
      if (/not enabled|SERVICE_DISABLED|has not been used/i.test(String(err?.stderr || err?.message || ''))) continue;
      return `the VMs of ${p} could not be listed (${gcloudProblem(err)}), so it is not known whether it already holds a paraclete. Nothing was changed.`;
    }
    const allowed = new Set([project.vm, ...(p === plan.projectId ? [LAB_CANARY.vm] : [])]);
    const others = listed.filter((inst) => !allowed.has(inst?.name) && carriesParaclete(inst)).map((inst) => inst.name);
    if (others.length) {
      const flag = p === plan.projectId ? '--project' : '--canary-project';
      return `${p} already holds a paraclete (${others.join(', ')}), and one project holds one paraclete. Name another project with ${flag}. Nothing was changed.`;
    }
  }
  return null;
}

/**
 * A canary left in the lab's own project, from before the canary had a project of its own: two
 * paracletes in one project, which share its Firestore and bucket. Nothing deletes it on its own.
 */
function oldCanaryReport(plan, vm) {
  const zone = vm.zone || plan.zone;
  const deleteCommand = oldCanaryDeleteCommand({ projectId: plan.projectId, zone });
  return {
    name: vm.name,
    project: plan.projectId,
    zone,
    status: vm.status || null,
    deleteCommand,
    note: `${vm.name} still runs in ${plan.projectId}, the driver's project, so two paracletes share its Firestore and bucket. Nothing deletes it on its own. Once the canary in ${plan.canaryProjectId} is up (lab-status), delete this one: ${deleteCommand}`,
  };
}

/**
 * Provision the harness lab idempotently, in two projects (buildGcpLabPlan): the lab's, which holds
 * `paraclete-h2-driver`, and the canary's, which holds `paraclete-h2-canary`. First, reading only, it
 * stops with `error` when a project cannot be billed or already holds another paraclete
 * (labPreflight). Then, for each project:
 * 1. Create or verify the GCP project (and optional organization parent).
 * 2. Link the billing account if billing is not yet enabled.
 * 3. Enable required Google Cloud APIs.
 * 4. Ensure the `paraclete-agent` service account and its project/self IAM bindings.
 * 5. Ensure Native-mode Firestore `(default)` database in `region`.
 * 6. Ensure GCS bucket `gs://<project>-paraclete` and grant `roles/storage.objectAdmin`.
 * 7. Ensure VPC network and IAP SSH ingress/deny firewall rules.
 * Then, once:
 * 8. Give the driver's agent account its access to the canary's project (lab-canary.mjs).
 * 9. Create or update `paraclete-h2-driver` (`e2-standard-8`) in the lab's project and
 *    `paraclete-h2-canary` (`e2-standard-4`) in the canary's.
 * 10. Look for a canary left in the lab's own project. It is never deleted here: the result names it
 *    (`oldCanary`) with the command that deletes it, to run once the new canary is up.
 * 11. Over IAP SSH: install the follow-main timer on both VMs (lab only; lab-updater.mjs), then write
 *    the canary's coordinates into the driver's harness checkout (`.local/instance.env`).
 *
 * Step 11 is an SSH step, not part of the startup script, for three reasons. The startup script runs
 * only at boot, so it cannot reach a VM that is already running, and this function only updates the
 * metadata of an existing VM. It stays install.sh's own stub, so the lab boots the way a product
 * instance does, which is what the canary is there to show. And `lab-follow-main --uninstall` must
 * stick, which it would not if every boot put the timer back. The same install step serves
 * `lab-follow-main --install` (manageLabFollowMain), so the two cannot drift apart. A new VM's SSH
 * may need a minute to come up, so the step is tried `sshAttempts` times. A VM it cannot reach, or a
 * driver without its harness checkout yet, makes the result not ok, with the command to run later;
 * every earlier step stands.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.canaryProjectId]
 * @param {string} [opts.region]
 * @param {string} [opts.zone]
 * @param {string} [opts.organizationId]
 * @param {string} [opts.billingAccount]
 * @param {string} [opts.repo]
 * @param {string} [opts.commit]
 * @param {string} [opts.release]
 * @param {string|number} [opts.intervalMinutes]  the follow-main timer's interval, default 30
 * @param {boolean} [opts.dryRun]
 * @param {Function} [opts.execGcloud]  (args, {interactive}) => stdout
 * @param {Function} [opts.execGit]
 * @param {Function} [opts.onStep]
 * @param {number} [opts.sshAttempts]  tries of the SSH step per VM, default 8
 * @param {Function} [opts.sleep]  (ms) => void, between SSH tries
 */
export function provisionGcpLab(opts = {}) {
  const plan = buildGcpLabPlan(opts);
  const dryRun = Boolean(opts.dryRun);
  const execGcloud = opts.execGcloud || defaultExecGcloud;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const { repo, commit, release } = resolveRepoAndCommit(opts);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      plan,
      repo,
      commit,
      release,
      stepsExecuted: [],
    };
  }

  // 0. Before anything changes: each project can be billed, and none holds another paraclete
  const refused = labPreflight(plan, execGcloud);
  if (refused) {
    return { ok: false, dryRun: false, plan, repo, commit, release, stepsExecuted: [], error: refused };
  }

  const stepsExecuted = [];
  const recordStep = (step, status, detail = '', project = plan.projectId) => {
    const entry = { step, project, status, detail };
    stepsExecuted.push(entry);
    onStep(entry);
  };

  // 1-7. Each project, with what its VM needs
  const networks = {};
  for (const project of plan.projects) {
    networks[project.projectId] = provisionLabProject(plan, project, { execGcloud, recordStep });
  }

  // 8. The driver's access to the canary's project
  grantDriverAccess(plan, { execGcloud, recordStep });

  // 9. Provision both VMs, each in its own project
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclete-h2-lab-'));
  const startupFile = path.join(tmpDir, 'startup-script.sh');
  fs.writeFileSync(startupFile, PARACLETE_STARTUP_SCRIPT, 'utf8');

  try {
    for (const vm of plan.vms) {
      let vmExists = false;
      try {
        const existingName = execGcloud([
          'compute',
          'instances',
          'describe',
          vm.name,
          `--zone=${plan.zone}`,
          `--project=${vm.projectId}`,
          '--format=value(name)',
        ]);
        vmExists = Boolean(existingName);
      } catch {
        vmExists = false;
      }

      const metadataItems = [
        ...(repo ? [`paraclete-repo=${repo}`] : []),
        ...(commit ? [`paraclete-ref=${commit}`] : []),
        `paraclete-release=${release}`,
        `paraclete-role=${vm.role}`,
        `paraclete-agent-name=${vm.agentName}`,
        `paraclete-bucket=${vm.bucket}`,
      ].join(',');

      if (!vmExists) {
        execGcloud([
          'compute',
          'instances',
          'create',
          vm.name,
          `--zone=${plan.zone}`,
          `--project=${vm.projectId}`,
          `--machine-type=${vm.machineType}`,
          `--boot-disk-size=${vm.bootDiskGb}GB`,
          `--boot-disk-type=${vm.bootDiskType}`,
          `--image-family=${vm.imageFamily}`,
          `--image-project=${vm.imageProject}`,
          `--service-account=${vm.serviceAccountEmail}`,
          '--scopes=cloud-platform,https://www.googleapis.com/auth/drive',
          `--network=${networks[vm.projectId]}`,
          '--tags=paraclete',
          '--shielded-secure-boot',
          '--shielded-vtpm',
          '--shielded-integrity-monitoring',
          `--metadata=${metadataItems}`,
          `--metadata-from-file=startup-script=${startupFile}`,
          '--quiet',
        ]);
        recordStep(`vm:${vm.name}`, 'created', `${vm.machineType} (${vm.role})`, vm.projectId);
      } else {
        execGcloud([
          'compute',
          'instances',
          'add-metadata',
          vm.name,
          `--zone=${plan.zone}`,
          `--project=${vm.projectId}`,
          `--metadata=${metadataItems}`,
          `--metadata-from-file=startup-script=${startupFile}`,
          '--quiet',
        ]);
        recordStep(`vm:${vm.name}`, 'updated', `${vm.machineType} (${vm.role})`, vm.projectId);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 10. A canary left in the lab's own project: reported, never deleted
  let oldCanary = null;
  try {
    const left = listInstances(execGcloud, plan.projectId).find((inst) => inst?.name === LAB_CANARY.vm);
    if (left) oldCanary = oldCanaryReport(plan, describeInstance(left, plan.projectId));
    recordStep('old-canary', oldCanary ? 'kept' : 'none', oldCanary ? oldCanary.deleteCommand : '', plan.projectId);
  } catch (err) {
    recordStep('old-canary', 'unknown', `the lab's VMs could not be listed: ${gcloudProblem(err)}`, plan.projectId);
  }

  // 11. The follow-main timer (lab only), then the canary's coordinates on the driver, over IAP SSH
  const sshOptions = { execGcloud, attempts: opts.sshAttempts ?? 8, sleep: opts.sleep };
  const followMain = plan.vms.map((vm) => followMainOnVm(plan, vm, 'install', sshOptions));
  for (const result of followMain) {
    recordStep(
      `follow-main:${result.name}`,
      result.ok ? result.installed : 'failed',
      result.ok ? `${FOLLOW_MAIN.timerUnit} every ${plan.followMain.intervalMinutes} min` : result.error,
      result.project,
    );
  }
  const followMainOk = followMain.every((r) => r.ok);

  const driver = plan.vms.find((vm) => vm.name === plan.instanceEnv.vm);
  const driverAnswered = followMain.find((r) => r.name === driver.name)?.ok === true;
  const written = driverAnswered
    ? instanceEnvOnDriver(plan, driver, sshOptions)
    : { name: driver.name, project: driver.projectId, ok: false, state: 'skipped', error: `${driver.name}: it did not answer over SSH` };
  const labFlags = labFlagsOf(plan);
  const instanceEnv = {
    ...written,
    path: plan.instanceEnv.path,
    ...(written.ok
      ? {}
      : {
          hint: `The driver's harness checkout has no coordinates for the canary yet. Once ${driver.name} answers over SSH and ${FOLLOW_MAIN.harnessCheckout} is a checkout the paraclete user owns, run this again; every step is idempotent: node dev/harness2/cli.mjs lab-provision ${labFlags} --interval ${plan.followMain.intervalMinutes}`,
        }),
  };
  recordStep(
    `instance-env:${driver.name}`,
    written.ok ? written.state : written.state || 'failed',
    written.ok ? `${plan.instanceEnv.path} names ${plan.canaryProjectId}` : written.error,
    driver.projectId,
  );

  return {
    ok: followMainOk && instanceEnv.ok,
    dryRun: false,
    plan,
    repo,
    commit,
    release,
    stepsExecuted,
    followMain,
    instanceEnv,
    ...(oldCanary ? { oldCanary } : {}),
    ...(followMainOk
      ? {}
      : {
          hint: `The follow-main timer is not on every VM. Once they answer over SSH: node dev/harness2/cli.mjs lab-follow-main --install --interval ${plan.followMain.intervalMinutes} ${labFlags}`,
        }),
  };
}

/**
 * Runs one root command on one lab VM over IAP SSH (dev-env.mjs sshArgs, in the VM's own project) and
 * reads back its result with `interpret`. Tries again, up to `attempts` times, when SSH fails or
 * `retry(result)` says the script did not get to its end. Never throws: a VM that cannot be reached is
 * a result with ok false.
 *
 * @param {{zone: string}} plan
 * @param {{name: string, projectId: string}} vm
 * @param {string} command
 * @param {(stdout: string) => {ok: boolean, error?: string}} interpret
 * @param {{execGcloud?: Function, attempts?: number, sleep?: Function, retryMs?: number, retry?: Function}} [o]
 */
function sshOnLabVm(plan, vm, command, interpret, { execGcloud = defaultExecGcloud, attempts = 1, sleep = defaultSleep, retryMs = 15_000, retry = (r) => !r.ok } = {}) {
  const args = sshArgs({ VM: vm.name, ZONE: plan.zone, PROJECT_ID: vm.projectId }, command);
  const where = { name: vm.name, project: vm.projectId };
  let problem = 'not tried';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) sleep(retryMs);
    try {
      const result = interpret(execGcloud(args, { interactive: true }));
      if (result.ok) return { ...where, ...result };
      if (!retry(result)) return { ...where, ...result, error: `${vm.name}: ${result.error}` };
      problem = result.error;
    } catch (err) {
      problem = gcloudProblem(err, 'gcloud compute ssh');
    }
  }
  return { ...where, ok: false, error: `${vm.name}: ${problem}${attempts > 1 ? ` (${attempts} tries)` : ''}` };
}

/** One follow-main action on one lab VM (lab-updater.mjs), over IAP SSH. */
function followMainOnVm(plan, vm, action, o = {}) {
  const command = followMainCommandFor(action, vm, { intervalMinutes: plan.followMain.intervalMinutes });
  return sshOnLabVm(plan, vm, command, (stdout) => followMainResult(action, parseFollowMainOutput(stdout)), o);
}

/**
 * Writes the canary's coordinates into the driver's harness checkout (lab-canary.mjs), over IAP SSH.
 * Tried again only when the script did not get to its end: a missing checkout is an answer.
 */
function instanceEnvOnDriver(plan, driver, o = {}) {
  const command = instanceEnvRemoteCommand({ text: plan.instanceEnv.text, checkout: driver.harnessCheckout });
  return sshOnLabVm(plan, driver, command, instanceEnvResult, { ...o, retry: (r) => r.state === null });
}

/**
 * Puts the follow-main timer on the lab's VMs, takes it off, or reports it (lab-updater.mjs), over
 * IAP SSH, each VM in its own project: `node dev/harness2/cli.mjs lab-follow-main
 * [--install|--uninstall|--status]`. Lab only. Install and uninstall are idempotent; status changes
 * nothing.
 *
 * @param {object} [opts]
 * @param {'install'|'uninstall'|'status'} [opts.action]  default status
 * @param {string} [opts.projectId]
 * @param {string} [opts.canaryProjectId]
 * @param {string} [opts.zone]
 * @param {string} [opts.region]
 * @param {string|number} [opts.intervalMinutes]  install only, default 30
 * @param {Function} [opts.execGcloud]
 * @param {number} [opts.sshAttempts]  default 1
 * @param {Function} [opts.sleep]
 */
export function manageLabFollowMain(opts = {}) {
  const action = opts.action || 'status';
  if (!['install', 'uninstall', 'status'].includes(action)) throw new Error(`unknown lab-follow-main action '${action}'`);
  const plan = buildGcpLabPlan(opts);
  const vms = plan.vms.map((vm) =>
    followMainOnVm(plan, vm, action, {
      execGcloud: opts.execGcloud || defaultExecGcloud,
      attempts: opts.sshAttempts ?? 1,
      sleep: opts.sleep,
    }),
  );
  return {
    ok: vms.every((vm) => vm.ok),
    action,
    projectId: plan.projectId,
    canaryProjectId: plan.canaryProjectId,
    zone: plan.zone,
    ...(action === 'install' ? { intervalMinutes: plan.followMain.intervalMinutes } : {}),
    vms,
  };
}

/**
 * Inspect the live status of the lab's VMs: `paraclete-h2-driver` in the lab's project and
 * `paraclete-h2-canary` in the canary's, each listed with the project it is in. Each running lab VM
 * also gets `followMain`: its follow-main timer, last run, installed commit and main's head, read over
 * IAP SSH as `lab-follow-main --status` reads them (null for a VM that is not running). A canary still
 * in the lab's own project is flagged (`oldCanary`, with the command that deletes it), and so is a
 * project whose VMs cannot be listed; `ok` is false while `problems` names any.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.canaryProjectId]
 * @param {string} [opts.zone]
 * @param {string} [opts.region]
 * @param {Function} [opts.execGcloud]
 */
export function inspectGcpLabStatus(opts = {}) {
  const plan = buildGcpLabPlan(opts);
  const execGcloud = opts.execGcloud || defaultExecGcloud;
  const vms = [];
  const problems = [];
  for (const project of plan.projects) {
    try {
      for (const inst of listInstances(execGcloud, project.projectId)) vms.push(describeInstance(inst, project.projectId));
    } catch (err) {
      problems.push(`the VMs of ${project.projectId} could not be listed: ${gcloudProblem(err)}`);
    }
  }
  let oldCanary = null;
  for (const vm of vms) {
    const labVm = plan.vms.find((v) => v.name === vm.name && v.projectId === vm.project);
    if (!labVm) {
      if (vm.name === LAB_CANARY.vm && vm.project === plan.projectId) {
        vm.oldCanary = true;
        oldCanary = oldCanaryReport(plan, vm);
        problems.push(oldCanary.note);
      }
      continue;
    }
    if (vm.status !== 'RUNNING') {
      vm.followMain = null;
      continue;
    }
    const { name, project, ...followMain } = followMainOnVm(plan, labVm, 'status', { execGcloud });
    vm.followMain = followMain;
  }

  return {
    ok: problems.length === 0,
    projectId: plan.projectId,
    canaryProjectId: plan.canaryProjectId,
    zone: plan.zone,
    vms,
    problems,
    ...(oldCanary ? { oldCanary } : {}),
  };
}
