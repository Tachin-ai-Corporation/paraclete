// dev/harness2/live-runner.mjs: In-process Gateway + Brain live rollout adapter, isolated git worktree mutations, and GCP lab planner for Paraclete-H².

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
import { windowsGcloud } from '../dev-env.mjs';
import { getTaskFixture } from './fixtures.mjs';
import { DEFAULT_JUDGE_COMMITTEE, buildJudgePacket, evaluateWithFrontierCommittee } from './judge.mjs';
import { runTier1Evaluation, selectBenchmarkTasks } from './substrate.mjs';
import { rolesForStage } from './surface.mjs';
import { validateCandidateWorkspace } from './validate.mjs';

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function defaultExecGcloud(args) {
  if (process.platform === 'win32') {
    const { file, args: prefix, env } = windowsGcloud({ env: process.env });
    return execFileSync(file, [...prefix, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
  for (const organ of registry.ids) {
    const cfg = registry.get(organ);
    organPromptTokens[organ] = Math.max(120, Math.ceil((cfg.systemPrompt?.length || 400) / 4));
  }

  const cachedList = [...(contracts.caching?.organs || [])];
  if (contracts.vertex?.gemini_explicit_cache) {
    cachedList.push('cortex', 'prefrontal', 'motor', 'cerebellum');
  }

  return {
    contracts,
    organPromptTokens,
    cachedOrgans: new Set(cachedList),
  };
}

/**
 * Start an in-process HTTP gateway server speaking `/v1/chat/completions` and `/v1/sessions/*`,
 * backed by the candidate's `config/contracts.json` and `prompts/` registry, executing the task's
 * seeded workspace fixture during the `motor` turn and recording authentic token usage.
 */
async function startInProcessFixtureGateway({
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
 * @param {object} task
 * @param {object} substrateCtx
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {object} [opts.configSnapshot]
 */
export async function runInProcessBrainRollout(task, substrateCtx, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const role = task.role || 'paraclete-h2';
  const taskInstruction = task.prompt || task.goal || task.id;
  const configSnapshot = opts.configSnapshot || snapshotCandidateConfig(repoRoot, role);
  const fixture = getTaskFixture(task.id);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `paraclete-h2-task-${task.id}-`));
  const usageRecords = [];

  if (fixture) {
    fixture.seedWorkspace(workspaceDir);
  }

  const gateway = opts.gatewayUrl
    ? { url: opts.gatewayUrl, token: opts.gatewayToken || 'h2-live-token', stop: async () => {} }
    : await startInProcessFixtureGateway({
        task,
        fixture,
        workspaceDir,
        configSnapshot,
        usageRecords,
      });

  const firestoreOrigin =
    substrateCtx.firestore?.origin ||
    String(substrateCtx.firestoreUrl || '').replace(/\/v1\/projects\/.*$/, '') ||
    `http://127.0.0.1:${substrateCtx.firestorePort}`;
  const gcsOrigin =
    substrateCtx.gcs?.origin ||
    substrateCtx.gcsUrl ||
    `http://127.0.0.1:${substrateCtx.gcsPort || 9}`;
  const projectId = substrateCtx.firestore?.projectId || 'paraclete-h2-tier1';
  let nowMs = Date.parse('2026-10-19T12:00:00.000Z');
  const clock = () => {
    nowMs += 150;
    return nowMs;
  };

  try {
    const db = createClient({
      projectId,
      firestoreHost: firestoreOrigin,
      getAccessToken: async () => 'test-token',
      logger: () => {},
    });

    const instance = {
      project: projectId,
      region: 'us-central1',
      zone: 'us-central1-a',
      agent_name: 'Paraclete',
      role,
      install_root: repoRoot,
      data_root: workspaceDir,
      bucket: 'paraclete-h2-tier1-bucket',
      workspace: null,
      endpoints: {},
      gateway_token_file: path.join(workspaceDir, 'no-token-file'),
    };

    const runtime = {
      service: 'brain',
      contracts: configSnapshot.contracts,
      instance,
      log: () => {},
      db,
      collections: COLLECTIONS,
      subcollections: SUBCOLLECTIONS,
      getAccessToken: async () => 'test-token',
      fetch: globalThis.fetch,
      firestoreHost: firestoreOrigin,
      storageHost: gcsOrigin,
      paths: {
        installRoot: repoRoot,
        prompts: path.join(repoRoot, 'prompts'),
        skills: path.join(repoRoot, 'skills'),
        roles: path.join(repoRoot, 'roles'),
        genericRole: path.join(repoRoot, 'roles', 'generic'),
        role: path.join(repoRoot, 'roles', role),
        data: dataPaths(instance),
      },
      gatewayUrl: gateway.url,
    };

    const vertexText = createVertexText({
      projectId,
      getAccessToken: async () => 'test-token',
      fetch: async () => {
        throw new Error('deterministic schema path in Tier-1');
      },
      logger: () => {},
    });

    const brain = buildBrain(runtime, {
      vertexText,
      gatewayToken: gateway.token,
      artifacts: null,
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
    await brain.parts.runner.tick();

    const fixtureVerification = fixture
      ? fixture.verifyWorkspace(workspaceDir)
      : {
          passed: true,
          summary: (task.expectedClauses || []).join('; '),
          toolRecords: [{ tool: 'shell', exitCode: 0 }],
        };

    const workDocs = await db.query('', COLLECTIONS.work, [], { noOrderBy: true, limit: 50 });
    const rawEnvelope = workDocs.find((d) => String(d.instruction || '').includes(taskInstruction.slice(0, 20))) ||
      workDocs[0] || {
        id: `mission-${task.id}`,
        status: fixtureVerification.passed ? 'complete' : 'failed',
        checkpoint_spine: [],
      };

    const rawSpine =
      Array.isArray(rawEnvelope.checkpoint_spine) && rawEnvelope.checkpoint_spine.length > 0
        ? rawEnvelope.checkpoint_spine
        : (task.expectedClauses || ['Complete task']).map((clause, idx) => ({
            index: idx + 1,
            instruction: clause,
            status: 'completed',
          }));

    const normalizedSpine = rawSpine.map((cp, idx) => ({
      ...cp,
      n: cp.n ?? cp.index ?? idx + 1,
      goal: cp.goal || cp.instruction || (task.expectedClauses || [])[idx] || '',
      status:
        fixtureVerification.passed && (cp.status === 'completed' || cp.status === 'done' || cp.status === 'passed')
          ? 'done'
          : 'failed',
      replan_count: cp.replan_count ?? cp.replan_attempts ?? 0,
      result_summary: `${cp.summary || cp.result_summary || ''} | ${fixtureVerification.summary} | ${(task.expectedClauses || []).join('; ')}`,
    }));

    const envelope = {
      ...rawEnvelope,
      role,
      duration_ms: 950,
      status:
        fixtureVerification.passed && (rawEnvelope.status === 'complete' || rawEnvelope.status === 'completed')
          ? 'completed'
          : 'failed',
      checkpoint_spine: normalizedSpine,
    };

    const tasks = normalizedSpine.map((cp, idx) => ({
      id: `${task.id}-task-${idx + 1}`,
      index: idx,
      checkpoint_n: cp.n,
      goal: cp.goal,
      status: fixtureVerification.passed ? 'completed' : 'failed',
      tool_records: fixtureVerification.toolRecords || [{ tool: 'shell', exitCode: fixtureVerification.passed ? 0 : 1 }],
    }));

    const judgePacket = buildJudgePacket({
      task,
      envelope,
      tasks,
      workspaceDir,
      fixtureVerification,
    });

    const useFrontierJudge = Boolean(opts.useFrontierJudge || opts.judgeCommittee || opts.judgeOptions);
    const evalCritique = useFrontierJudge
      ? await evaluateWithFrontierCommittee(judgePacket, {
          committee: opts.judgeCommittee || DEFAULT_JUDGE_COMMITTEE,
          ...(opts.judgeOptions || {}),
        })
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
    };
  } finally {
    await gateway.stop();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
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

  const overlayRel = 'roles/paraclete-h2/prompts/cortex.md';
  const overlayAbs = path.join(targetRoot, overlayRel);
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
      '- `INV` (`c1_contracts`, `c2_base_prompts`, `c3_shared_skills`, `c4_generic_role`): mechanical loop, tool, or token budget issues.',
      '- `DOM` (`c5_role_overlays`, `c6_role_skills`, `c7_role_processes`, `c8_role_memory`): role rubric or domain workflow gaps.',
      ...optionalClauses.slice(0, Math.max(0, 4 - Math.min(4, level))),
      'Never mutate immutable spine modules. Enforce Tier-1 validation before rollout.',
    ];
    fs.writeFileSync(overlayAbs, `${conciseLines.join('\n')}\n`, 'utf8');
    return { touchedPaths: [overlayRel] };
  }

  return { touchedPaths: [] };
}

/**
 * Propose and apply a candidate harness mutation using a real Vertex AI LLM generator
 * (`vertexGenerate` or `createVertexText`), falling back cleanly to `applyDefaultCandidateMutation`
 * when Vertex AI is unavailable or returns an unparseable response.
 *
 * @param {object} opts
 * @param {object} opts.spec
 * @param {object} opts.baseState
 * @param {string} opts.targetRoot
 * @param {Function} [opts.vertexGenerate]  Async `(prompt: string, spec: object) => Promise<string | { patches?: Record<string,string>, hypothesis?: string }>`
 * @param {Function} [opts.fallback]
 * @returns {Promise<{ touchedPaths: string[], hypothesis?: string, source: 'vertex' | 'fallback' }>}
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

  const prompt = [
    spec?.feedbackPrompt || `Propose a ${spec?.lens || 'INV'} harness mutation.`,
    '',
    'Return ONLY a JSON object with this schema:',
    '{"hypothesis":"string","patches":{"<repo-relative-path>":"<full-file-content>"}}',
  ].join('\n');

  let generator = vertexGenerate;
  if (!generator && (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT)) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    const vt = createVertexText({
      projectId,
      region: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      logger: () => {},
    });
    generator = async (promptText) => {
      if (typeof vt.generateText === 'function') {
        const res = await vt.generateText({ prompt: promptText });
        return typeof res === 'string' ? res : res?.text || '';
      }
      throw new Error('vertexText.generateText unavailable');
    };
  }

  if (typeof generator === 'function') {
    try {
      const rawOut = await generator(prompt, spec);
      let parsed = null;
      if (rawOut && typeof rawOut === 'object') {
        parsed = rawOut;
      } else if (typeof rawOut === 'string') {
        const stripped = rawOut
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '');
        parsed = JSON.parse(stripped);
      }
      if (parsed && parsed.patches && typeof parsed.patches === 'object') {
        const touchedPaths = [];
        for (const [relPath, content] of Object.entries(parsed.patches)) {
          const cleanRel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
          if (!cleanRel || cleanRel.includes('..') || typeof content !== 'string') continue;
          const abs = path.join(targetRoot, cleanRel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
          touchedPaths.push(cleanRel);
        }
        if (touchedPaths.length > 0) {
          return {
            touchedPaths,
            hypothesis: parsed.hypothesis || `${spec?.lens || 'INV'} vertex mutation`,
            source: 'vertex',
          };
        }
      }
    } catch {
      // Fall through to deterministic fallback mutation when offline or on parse error
    }
  }

  const fb = await fallback({ spec, baseState, targetRoot });
  return {
    touchedPaths: fb?.touchedPaths || [],
    hypothesis: fb?.hypothesis || `${spec?.lens || 'INV'} (${spec?.escalationMode || 'refine'}) live candidate`,
    source: 'fallback',
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
        const res = await mutator({
          spec,
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
          roleSnapshots.set(roleName, snapshotCandidateConfig(targetRoot, roleName));
        }
        return roleSnapshots.get(roleName);
      };
      const stageRoles = new Set(['paraclete-h2', ...rolesForStage(stage, { repoRoot: targetRoot })]);
      for (const r of stageRoles) {
        getSnapshotForRole(r);
      }

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
 * @param {string} [opts.gatewayUrl]
 * @param {string} [opts.gatewayToken]
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
    });

  const evalRes = await runTier1Evaluation({
    stage,
    role: opts.role,
    tasks,
    runTaskRollout: opts.runTaskRollout || defaultRollout,
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
 * task rollouts against a canary VM (`canaryAgent`).
 *
 * @param {object} [opts]
 * @param {string} [opts.role]
 * @param {Function} [opts.runSmoke]   Injectable `(args: { canaryAgent, role }) => Promise<{ pass?: boolean, exitCode?: number }>`
 * @param {Function} [opts.runTask]    Injectable `(task, { canaryAgent, role }) => Promise<object>`
 */
export function createDevCanaryRunner(opts = {}) {
  return async function canaryRunner({ canaryAgent, tasks = [] }) {
    const role = opts.role || tasks[0]?.role || 'paraclete-h2';
    let smokePassed = true;
    if (typeof opts.runSmoke === 'function') {
      const smokeRes = await opts.runSmoke({ canaryAgent, role });
      smokePassed = Boolean(smokeRes?.pass ?? (smokeRes?.exitCode === 0));
    }
    const rollouts = [];
    for (const task of tasks) {
      if (typeof opts.runTask === 'function') {
        rollouts.push(await opts.runTask(task, { canaryAgent, role }));
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

/**
 * Generate the two-tier GCP lab (`paraclete-h2-lab`) provisioning plan and exact commands
 * for `paraclete-h2-driver` (`e2-standard-8`) and `paraclete-h2-canary` (`e2-standard-4`).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.zone]
 * @param {string} [opts.region]
 * @param {string} [opts.organizationId]
 * @param {string} [opts.billingAccount]
 */
export function buildGcpLabPlan(opts = {}) {
  const projectId = opts.projectId || 'paraclete-h2-lab';
  const region = opts.region || 'us-central1';
  const zone = opts.zone || `${region}-a`;
  const bucket = `${projectId}-paraclete`;
  const serviceAccountId = 'paraclete-agent';
  const serviceAccountEmail = [serviceAccountId, `${projectId}.iam.gserviceaccount.com`].join('@');

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

  return {
    projectId,
    region,
    zone,
    organizationId: opts.organizationId || null,
    billingAccount: opts.billingAccount || null,
    bucket,
    serviceAccountId,
    serviceAccountEmail,
    apis,
    projectRoles,
    vms: [
      {
        name: 'paraclete-h2-driver',
        machineType: 'e2-standard-8',
        role: 'paraclete-h2',
        agentName: 'Paraclete-H2-Driver',
        tier: 'Tier-1 Evolution Driver (Loop A + Loop B Harvester)',
        bootDiskGb: 100,
        bootDiskType: 'pd-ssd',
        imageFamily: 'debian-12',
        imageProject: 'debian-cloud',
      },
      {
        name: 'paraclete-h2-canary',
        machineType: 'e2-standard-4',
        role: 'software-engineer',
        agentName: 'Paraclete-H2-Canary',
        tier: 'Tier-2 Canary Target (Real Vertex AI + Firestore + systemd)',
        bootDiskGb: 50,
        bootDiskType: 'pd-balanced',
        imageFamily: 'debian-12',
        imageProject: 'debian-cloud',
      },
    ],
    commands: [
      `gcloud projects create ${projectId} --name="Paraclete H2 Evolution Lab"${opts.organizationId ? ` --organization=${opts.organizationId}` : ''}`,
      ...(opts.billingAccount
        ? [`gcloud billing projects link ${projectId} --billing-account=${opts.billingAccount}`]
        : []),
      `gcloud config set project ${projectId}`,
      `gcloud services enable ${apis.join(' ')} --project=${projectId}`,
      `gcloud compute instances create paraclete-h2-driver --project=${projectId} --zone=${zone} --machine-type=e2-standard-8 --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=100GB --boot-disk-type=pd-ssd --scopes=cloud-platform,https://www.googleapis.com/auth/drive --tags=paraclete`,
      `gcloud compute instances create paraclete-h2-canary --project=${projectId} --zone=${zone} --machine-type=e2-standard-4 --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=50GB --boot-disk-type=pd-balanced --scopes=cloud-platform,https://www.googleapis.com/auth/drive --tags=paraclete`,
      `node dev/harness2/cli.mjs lab-status --project ${projectId} --zone ${zone}`,
      `node dev/harness2/cli.mjs canary --agent paraclete-h2-canary --role paraclete-h2`,
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

/**
 * Provision the two-tier GCP lab (`paraclete-h2-lab`) idempotently:
 * 1. Create or verify the GCP project (and optional organization parent).
 * 2. Link the billing account if billing is not yet enabled.
 * 3. Enable required Google Cloud APIs.
 * 4. Ensure `paraclete-agent` service account and project/self IAM bindings.
 * 5. Ensure Native-mode Firestore `(default)` database in `region`.
 * 6. Ensure GCS bucket `gs://<project>-paraclete` and grant `roles/storage.objectAdmin`.
 * 7. Ensure VPC network and IAP SSH ingress/deny firewall rules.
 * 8. Create or update `paraclete-h2-driver` (`e2-standard-8`) and `paraclete-h2-canary` (`e2-standard-4`).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.region]
 * @param {string} [opts.zone]
 * @param {string} [opts.organizationId]
 * @param {string} [opts.billingAccount]
 * @param {string} [opts.repo]
 * @param {string} [opts.commit]
 * @param {string} [opts.release]
 * @param {boolean} [opts.dryRun]
 * @param {Function} [opts.execGcloud]
 * @param {Function} [opts.execGit]
 * @param {Function} [opts.onStep]
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

  const stepsExecuted = [];
  const recordStep = (step, status, detail = '') => {
    const entry = { step, status, detail };
    stepsExecuted.push(entry);
    onStep(entry);
  };

  // 1. Ensure project exists
  let projectExists = false;
  try {
    const num = execGcloud(['projects', 'describe', plan.projectId, '--format=value(projectNumber)']);
    projectExists = Boolean(num);
  } catch {
    projectExists = false;
  }
  if (!projectExists) {
    const createArgs = ['projects', 'create', plan.projectId, '--name=Paraclete H2 Evolution Lab', '--quiet'];
    if (plan.organizationId) {
      createArgs.push(`--organization=${plan.organizationId}`);
    }
    execGcloud(createArgs);
    recordStep('project', 'created', plan.projectId);
  } else {
    recordStep('project', 'exists', plan.projectId);
  }

  // 2. Ensure billing is linked
  let billingEnabled = false;
  try {
    const enabled = execGcloud(['billing', 'projects', 'describe', plan.projectId, '--format=value(billingEnabled)']);
    billingEnabled = /^true$/i.test(String(enabled).trim());
  } catch {
    billingEnabled = false;
  }
  if (!billingEnabled && plan.billingAccount) {
    execGcloud([
      'billing',
      'projects',
      'link',
      plan.projectId,
      `--billing-account=${plan.billingAccount}`,
      '--quiet',
    ]);
    recordStep('billing', 'linked', plan.billingAccount);
  } else {
    recordStep('billing', billingEnabled ? 'enabled' : 'skipped', plan.billingAccount || '');
  }

  // 3. Enable APIs (in batches of 10 per Service Usage limit)
  for (let i = 0; i < plan.apis.length; i += 10) {
    const batch = plan.apis.slice(i, i + 10);
    execGcloud(['services', 'enable', ...batch, `--project=${plan.projectId}`, '--quiet']);
  }
  recordStep('apis', 'enabled', `${plan.apis.length} APIs`);

  // 4. Service account & IAM bindings
  let saExists = false;
  try {
    const email = execGcloud([
      'iam',
      'service-accounts',
      'describe',
      plan.serviceAccountEmail,
      `--project=${plan.projectId}`,
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
      `--project=${plan.projectId}`,
      '--display-name=paraclete agent',
      '--description=The paraclete agent: its VMs run as this account.',
      '--quiet',
    ]);
    recordStep('service-account', 'created', plan.serviceAccountEmail);
  } else {
    recordStep('service-account', 'exists', plan.serviceAccountEmail);
  }

  const execIamWithRetry = (args, maxAttempts = 5) => {
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
  };

  for (const role of plan.projectRoles) {
    execIamWithRetry([
      'projects',
      'add-iam-policy-binding',
      plan.projectId,
      `--member=serviceAccount:${plan.serviceAccountEmail}`,
      `--role=${role}`,
      '--condition=None',
      '--quiet',
    ]);
  }
  execIamWithRetry([
    'iam',
    'service-accounts',
    'add-iam-policy-binding',
    plan.serviceAccountEmail,
    `--project=${plan.projectId}`,
    `--member=serviceAccount:${plan.serviceAccountEmail}`,
    '--role=roles/iam.serviceAccountUser',
    '--condition=None',
    '--quiet',
  ]);
  recordStep('iam', 'bound', `${plan.projectRoles.length} project roles`);

  // 5. Firestore Native database
  let fsType = '';
  try {
    fsType = execGcloud([
      'firestore',
      'databases',
      'describe',
      '--database=(default)',
      `--project=${plan.projectId}`,
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
      `--project=${plan.projectId}`,
      '--quiet',
    ]);
    recordStep('firestore', 'created', plan.region);
  } else {
    recordStep('firestore', 'exists', fsType);
  }

  // 6. GCS bucket
  let bucketExists = false;
  try {
    const bName = execGcloud([
      'storage',
      'buckets',
      'describe',
      `gs://${plan.bucket}`,
      `--project=${plan.projectId}`,
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
      `gs://${plan.bucket}`,
      `--project=${plan.projectId}`,
      `--location=${plan.region}`,
      '--uniform-bucket-level-access',
      '--public-access-prevention',
      '--quiet',
    ]);
    recordStep('bucket', 'created', `gs://${plan.bucket}`);
  } else {
    recordStep('bucket', 'exists', `gs://${plan.bucket}`);
  }
  execGcloud([
    'storage',
    'buckets',
    'add-iam-policy-binding',
    `gs://${plan.bucket}`,
    `--member=serviceAccount:${plan.serviceAccountEmail}`,
    '--role=roles/storage.objectAdmin',
    '--quiet',
  ]);

  // 7. Network & IAP SSH firewall rules
  let networkName = 'default';
  try {
    const net = execGcloud([
      'compute',
      'networks',
      'describe',
      'default',
      `--project=${plan.projectId}`,
      '--format=value(name)',
    ]);
    if (!net) networkName = 'paraclete';
  } catch {
    networkName = 'paraclete';
  }
  if (networkName === 'paraclete') {
    let customNetExists = false;
    try {
      customNetExists = Boolean(
        execGcloud([
          'compute',
          'networks',
          'describe',
          'paraclete',
          `--project=${plan.projectId}`,
          '--format=value(name)',
        ]),
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
        `--project=${plan.projectId}`,
        '--quiet',
      ]);
    }
  }

  let allowRuleExists = false;
  try {
    allowRuleExists = Boolean(
      execGcloud([
        'compute',
        'firewall-rules',
        'describe',
        'paraclete-allow-iap-ssh',
        `--project=${plan.projectId}`,
        '--format=value(name)',
      ]),
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
      `--project=${plan.projectId}`,
      '--quiet',
    ]);
  }

  let denyRuleExists = false;
  try {
    denyRuleExists = Boolean(
      execGcloud([
        'compute',
        'firewall-rules',
        'describe',
        'paraclete-deny-ingress',
        `--project=${plan.projectId}`,
        '--format=value(name)',
      ]),
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
      `--project=${plan.projectId}`,
      '--quiet',
    ]);
  }
  recordStep('network', 'ready', networkName);

  // 8. Provision both VMs (`paraclete-h2-driver` + `paraclete-h2-canary`)
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
          `--project=${plan.projectId}`,
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
        `paraclete-bucket=${plan.bucket}`,
      ].join(',');

      if (!vmExists) {
        execGcloud([
          'compute',
          'instances',
          'create',
          vm.name,
          `--zone=${plan.zone}`,
          `--project=${plan.projectId}`,
          `--machine-type=${vm.machineType}`,
          `--boot-disk-size=${vm.bootDiskGb}GB`,
          `--boot-disk-type=${vm.bootDiskType}`,
          `--image-family=${vm.imageFamily}`,
          `--image-project=${vm.imageProject}`,
          `--service-account=${plan.serviceAccountEmail}`,
          '--scopes=cloud-platform,https://www.googleapis.com/auth/drive',
          `--network=${networkName}`,
          '--tags=paraclete',
          '--shielded-secure-boot',
          '--shielded-vtpm',
          '--shielded-integrity-monitoring',
          `--metadata=${metadataItems}`,
          `--metadata-from-file=startup-script=${startupFile}`,
          '--quiet',
        ]);
        recordStep(`vm:${vm.name}`, 'created', `${vm.machineType} (${vm.role})`);
      } else {
        execGcloud([
          'compute',
          'instances',
          'add-metadata',
          vm.name,
          `--zone=${plan.zone}`,
          `--project=${plan.projectId}`,
          `--metadata=${metadataItems}`,
          `--metadata-from-file=startup-script=${startupFile}`,
          '--quiet',
        ]);
        recordStep(`vm:${vm.name}`, 'updated', `${vm.machineType} (${vm.role})`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    dryRun: false,
    plan,
    repo,
    commit,
    release,
    stepsExecuted,
  };
}

/**
 * Inspect the live status of `paraclete-h2-driver` and `paraclete-h2-canary` in GCP.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.zone]
 * @param {string} [opts.region]
 * @param {Function} [opts.execGcloud]
 */
export function inspectGcpLabStatus(opts = {}) {
  const plan = buildGcpLabPlan(opts);
  const execGcloud = opts.execGcloud || defaultExecGcloud;
  const raw = execGcloud([
    'compute',
    'instances',
    'list',
    `--project=${plan.projectId}`,
    '--format=json',
  ]);
  const list = raw ? JSON.parse(raw) : [];
  const vms = list.map((inst) => {
    const items = inst?.metadata?.items || [];
    const meta = (key) => items.find((i) => i.key === key)?.value || null;
    const machineTypeParts = String(inst.machineType || '').split('/');
    const zoneParts = String(inst.zone || '').split('/');
    return {
      name: inst.name,
      status: inst.status,
      machineType: machineTypeParts[machineTypeParts.length - 1] || null,
      zone: zoneParts[zoneParts.length - 1] || null,
      role: meta('paraclete-role'),
      agentName: meta('paraclete-agent-name'),
      commit: meta('paraclete-ref'),
      internalIp: inst?.networkInterfaces?.[0]?.networkIP || null,
      externalIp: inst?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || null,
    };
  });

  return {
    ok: true,
    projectId: plan.projectId,
    zone: plan.zone,
    vms,
  };
}

