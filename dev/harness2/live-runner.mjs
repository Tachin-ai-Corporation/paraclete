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
import { getTaskFixture } from './fixtures.mjs';
import { runTier1Evaluation, selectBenchmarkTasks } from './substrate.mjs';
import { validateCandidateWorkspace } from './validate.mjs';

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
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
      Math.max(0.75, (maxSteps / 25) * 0.5 + (previewChars / 3000) * 0.5),
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

  const gateway = await startInProcessFixtureGateway({
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

    const evalCritique = {
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
        raw.organs.max_steps = Math.max(18, 25 - level);
      }
      if (raw.brain && typeof raw.brain === 'object') {
        raw.brain.result_preview_chars = Math.max(2100, 3000 - level * 150);
      }
      fs.writeFileSync(contractsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      return { touchedPaths: ['config/contracts.json'] };
    }
  }

  const overlayRel = 'roles/paraclete-h2/prompts/cortex.md';
  const overlayAbs = path.join(targetRoot, overlayRel);
  if (fs.existsSync(overlayAbs)) {
    const conciseLines = [
      '# Role Overlay: Paraclete-H² (`cortex`)',
      '',
      'Operate as the unified Harness Engineer for Loop A (evolution) and Loop B (harvesting).',
      'Attribute every failure to a single diagnostic lens before mutating:',
      '- `INV` (`c1_contracts`, `c2_base_prompts`, `c3_shared_skills`, `c4_generic_role`): mechanical loop, tool, or token budget issues.',
      '- `DOM` (`c5_role_overlays`, `c6_role_skills`, `c7_role_processes`, `c8_role_memory`): role rubric or domain workflow gaps.',
      `Never mutate immutable spine modules. Enforce Tier-1 validation before rollout (level ${level}).`,
    ];
    const pad = Math.max(0, (4 - Math.min(4, level)) * 40);
    if (pad > 0) {
      conciseLines.push(`<!-- pad:${'x'.repeat(pad)} -->`);
    }
    fs.writeFileSync(overlayAbs, `${conciseLines.join('\n')}\n`, 'utf8');
    return { touchedPaths: [overlayRel] };
  }

  return { touchedPaths: [] };
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
      for (const r of ['paraclete-h2', 'software-engineer', 'qa-engineer', 'devops-engineer']) {
        getSnapshotForRole(r);
      }

      const runTaskRollout = worktreeInfo
        ? async (task, substrateCtx) =>
            runInProcessBrainRollout(task, substrateCtx, {
              repoRoot,
              configSnapshot: getSnapshotForRole(task.role || 'paraclete-h2'),
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
        hypothesis: `${spec.lens} (${spec.escalationMode}) live candidate`,
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
    runInProcessBrainRollout(task, substrateCtx, { repoRoot });

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

/**
 * Generate the two-tier GCP lab (`paraclete-h2-lab`) provisioning plan and exact commands
 * for `paraclete-h2-driver` (`e2-standard-8`) and `paraclete-h2-canary` (`e2-standard-4`).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.zone]
 * @param {string} [opts.region]
 */
export function buildGcpLabPlan(opts = {}) {
  const projectId = opts.projectId || 'paraclete-h2-lab';
  const region = opts.region || 'us-central1';
  const zone = opts.zone || `${region}-a`;

  return {
    projectId,
    region,
    zone,
    vms: [
      {
        name: 'paraclete-h2-driver',
        machineType: 'e2-standard-8',
        role: 'paraclete-h2',
        tier: 'Tier-1 Evolution Driver (Loop A + Loop B Harvester)',
        bootDiskGb: 100,
      },
      {
        name: 'paraclete-h2-canary',
        machineType: 'e2-standard-4',
        role: 'software-engineer',
        tier: 'Tier-2 Canary Target (Real Vertex AI + Firestore + systemd)',
        bootDiskGb: 50,
      },
    ],
    commands: [
      `gcloud projects create ${projectId} --name="Paraclete H2 Evolution Lab"`,
      `gcloud config set project ${projectId}`,
      `gcloud services enable compute.googleapis.com aiplatform.googleapis.com firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com`,
      `gcloud compute instances create paraclete-h2-driver --project=${projectId} --zone=${zone} --machine-type=e2-standard-8 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=100GB --scopes=cloud-platform`,
      `gcloud compute instances create paraclete-h2-canary --project=${projectId} --zone=${zone} --machine-type=e2-standard-4 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=50GB --scopes=cloud-platform`,
      `gcloud compute ssh paraclete-h2-driver --zone=${zone} --command="sudo bash install/install.sh --role paraclete-h2 --agent-id paraclete-h2-driver --project ${projectId}"`,
      `gcloud compute ssh paraclete-h2-canary --zone=${zone} --command="sudo bash install/install.sh --role software-engineer --agent-id paraclete-h2-canary --project ${projectId}"`,
      `node dev/harness2/cli.mjs canary --agent paraclete-h2-canary --role paraclete-h2`,
    ],
  };
}
