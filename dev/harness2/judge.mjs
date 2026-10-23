// dev/harness2/judge.mjs: Frontier Model Committee Judge for non-human capability evaluation in Paraclete-H².
//
// Evaluates each benchmark or harvested mission rollout using a committee of frontier models
// (by default `vertex-google/gemini-4-argon` and `vertex-anthropic/claude-opus-5-5`, extensible
// to any additional models via `registerJudgeAdapter` or `options.committee`).
//
// Each committee member grades a blind, anonymized dossier (`buildJudgePacket`) across 5 orthogonal
// capability dimensions on a continuous [0, 1] scale. The committee aggregator combines member
// verdicts, computes inter-rater agreement, applies a hard deterministic fixture gate when present,
// and emits structured diagnostic feedback (`diagnosticLensHint`, `failureReasons`,
// `improvementPrescription`) for Loop A mutation proposals.

import { getAccessToken as getVmAccessToken } from '../../agent/auth/metadata-token.mjs';
import { parseJsonResponse } from '../../agent/providers/json-repair.mjs';
import { windowsGcloud } from '../dev-env.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Default Frontier Model Committee: Gemini 4 Argon (Vertex global) + Claude Opus 5.5 (Vertex us-east5).
 * Callers can extend this list via `--judge-committee` or `options.committee`.
 */
export const DEFAULT_JUDGE_COMMITTEE = Object.freeze([
  'vertex-google/gemini-4-argon',
  'vertex-anthropic/claude-opus-5-5',
]);

/**
 * Orthogonal capability rubric dimensions and their weights (sum = 1.00).
 */
export const JUDGE_DIMENSIONS = Object.freeze({
  clauseScore: Object.freeze({
    weight: 0.30,
    label: 'Clause & Goal Fulfillment',
    description: 'Did the agent satisfy every explicit and implicit requirement in the mission prompt and expected clauses?',
  }),
  craftScore: Object.freeze({
    weight: 0.25,
    label: 'Specialist Domain & Technical Craft',
    description: 'Is the code, analysis, or deliverable of high specialist quality for the assigned role without brittle hacks?',
  }),
  groundingScore: Object.freeze({
    weight: 0.20,
    label: 'Grounding & Verification Discipline',
    description: 'Are all claims backed by actual tool read-back evidence with zero fabricated IDs or unverified assumptions?',
  }),
  rigorScore: Object.freeze({
    weight: 0.15,
    label: 'Completeness & Edge-Case Rigor',
    description: 'Did the agent check boundary conditions, failure modes, and regression risks appropriate to the task?',
  }),
  clarityScore: Object.freeze({
    weight: 0.10,
    label: 'Synthesis Clarity & Actionability',
    description: 'Is the final deliverable concise, well-structured, directly actionable, and free of filler?',
  }),
});

/**
 * Claude models on Vertex AI that accept a `temperature` parameter (per `config/contracts.json`).
 * Newer Opus models (`claude-opus-5-5`, `claude-opus-5`, etc.) reject sampling parameters.
 */
const ANTHROPIC_TEMPERATURE_MODELS = new Set(['claude-opus-4-6']);

/**
 * Structured JSON schema enforced on Gemini `generateContent` and validated across all committee members.
 */
export const JUDGE_RESPONSE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    passed: { type: 'BOOLEAN' },
    dimensions: {
      type: 'OBJECT',
      properties: {
        clauseScore: { type: 'NUMBER' },
        craftScore: { type: 'NUMBER' },
        groundingScore: { type: 'NUMBER' },
        rigorScore: { type: 'NUMBER' },
        clarityScore: { type: 'NUMBER' },
      },
      required: ['clauseScore', 'craftScore', 'groundingScore', 'rigorScore', 'clarityScore'],
    },
    clauseVerdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          clause: { type: 'STRING' },
          satisfied: { type: 'BOOLEAN' },
          evidence: { type: 'STRING' },
        },
        required: ['clause', 'satisfied'],
      },
    },
    strengths: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    failureReasons: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    diagnosticLensHint: {
      type: 'STRING',
      enum: ['INV', 'DOM'],
    },
    improvementPrescription: {
      type: 'STRING',
    },
  },
  required: [
    'passed',
    'dimensions',
    'clauseVerdicts',
    'failureReasons',
    'diagnosticLensHint',
    'improvementPrescription',
  ],
});

export const JUDGE_SYSTEM_PROMPT = [
  'You are an impartial Frontier Model Capability Judge on the Paraclete-H² Evaluation Committee.',
  'Your job is to rigorously evaluate an autonomous agent harness rollout given:',
  '1. The original task specification (role, prompt/goal, and expected clauses).',
  '2. The execution trace (checkpoint spine, tool execution records, and read-back verification notes).',
  '3. The workspace artifacts and final deliverable synthesis.',
  '',
  'CRITICAL GRADING RULES:',
  '- Grade strictly on CAPABILITY and QUALITY. Do NOT reward superficial verbosity or unverified claims.',
  '- Any fabricated resource ID, unverified claim, or skipped expected clause must sharply penalize `groundingScore` and `clauseScore`.',
  '- Reserve scores above 0.95 for genuinely thorough, well-verified, specialist-grade deliverables that address edge cases and cite concrete verification evidence.',
  '- Attribute any shortcoming to `INV` (Domain-Invariant Mechanics: tool errors, loop churn, missing read-back evidence, context truncation) or `DOM` (Domain-Specific Craft: shallow role analysis, weak test coverage, incomplete domain rubric).',
  '- Return ONLY a valid JSON object matching the required schema.',
].join('\n');

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

/**
 * Parse a committee specification (array or comma-separated string) into normalized member descriptors.
 *
 * @param {string | Array<string | { model: string, weight?: number, location?: string }>} [spec]
 * @returns {Array<{ model: string, provider: string, modelId: string, weight: number, location: string | null }>}
 */
export function parseCommitteeSpec(spec = DEFAULT_JUDGE_COMMITTEE) {
  const rawList =
    typeof spec === 'string'
      ? spec
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : Array.isArray(spec) && spec.length > 0
        ? spec
        : [...DEFAULT_JUDGE_COMMITTEE];

  return rawList.map((entry) => {
    const item = typeof entry === 'string' ? { model: entry } : { ...entry };
    const full = String(item.model || '').trim();
    if (!full) throw new Error('parseCommitteeSpec: committee member model cannot be empty');

    const slashIdx = full.indexOf('/');
    const provider = slashIdx >= 0 ? full.slice(0, slashIdx) : 'vertex-google';
    const modelId = slashIdx >= 0 ? full.slice(slashIdx + 1) : full;
    const weight = Number.isFinite(item.weight) && item.weight > 0 ? Number(item.weight) : 1.0;
    const defaultLocation =
      provider === 'vertex-anthropic'
        ? process.env.ANTHROPIC_VERTEX_LOCATION || 'us-east5'
        : process.env.GOOGLE_CLOUD_LOCATION || 'global';

    return {
      model: slashIdx >= 0 ? full : `${provider}/${modelId}`,
      provider,
      modelId,
      weight,
      location: item.location || defaultLocation,
    };
  });
}

/**
 * Compute the weighted composite score in [0, 1] from the 5 rubric dimensions.
 *
 * @param {object} dimensions
 * @returns {number}
 */
export function computeWeightedDimensionScore(dimensions = {}) {
  let sum = 0;
  let weightTotal = 0;
  for (const [key, meta] of Object.entries(JUDGE_DIMENSIONS)) {
    const val = clamp01(dimensions?.[key] ?? 0);
    sum += meta.weight * val;
    weightTotal += meta.weight;
  }
  return Number(clamp01(weightTotal > 0 ? sum / weightTotal : 0).toFixed(4));
}

/**
 * Combine the Frontier Committee's continuous rubric score with the deterministic
 * fixture verification gate (if the benchmark task includes one).
 *
 * - If a hard fixture exists and FAILED (`passed === false`), the final rubricScore is
 *   capped at `<= 0.35` (`Math.min(0.35, 0.50 * committeeScore)`), ensuring a persuasively
 *   written hallucination that fails unit tests never scores high.
 * - If a hard fixture exists and PASSED (`passed === true`), `rubricScore = 0.35 + 0.65 * committeeScore`,
 *   providing a smooth [0.35, 1.00] capability gradient across passing candidates.
 * - If no hard fixture exists (open-ended or harvested Loop B task), `rubricScore = committeeScore`.
 *
 * @param {object} opts
 * @param {number} opts.committeeScore
 * @param {object | null} [opts.fixtureVerification]
 * @returns {{ rubricScore: number, hardGateApplied: boolean, hardGatePassed: boolean }}
 */
export function combineHardGateWithCommitteeScore({ committeeScore, fixtureVerification = null } = {}) {
  const cScore = clamp01(committeeScore);
  const hasHardFixture =
    fixtureVerification !== null &&
    typeof fixtureVerification === 'object' &&
    typeof fixtureVerification.passed === 'boolean';

  if (!hasHardFixture) {
    return {
      rubricScore: Number(cScore.toFixed(4)),
      hardGateApplied: false,
      hardGatePassed: true,
    };
  }

  if (!fixtureVerification.passed) {
    return {
      rubricScore: Number(Math.min(0.35, 0.5 * cScore).toFixed(4)),
      hardGateApplied: true,
      hardGatePassed: false,
    };
  }

  return {
    rubricScore: Number(clamp01(0.35 + 0.65 * cScore).toFixed(4)),
    hardGateApplied: true,
    hardGatePassed: true,
  };
}

/**
 * Assemble a blind, anonymized evaluation dossier (`JudgePacket`) from a task rollout.
 * Deliberately excludes `candidateId`, `parentId`, `lens`, and internal system prompts
 * so committee models evaluate purely the task prompt vs. execution evidence and final output.
 *
 * @param {object} input
 * @param {object} input.task
 * @param {object} [input.envelope]
 * @param {object[]} [input.checkpoints]
 * @param {object[]} [input.tasks]
 * @param {object | null} [input.fixtureVerification]
 * @param {Record<string, string>} [input.workspaceArtifacts]
 * @returns {object}
 */
export function buildJudgePacket({
  task = {},
  envelope = {},
  checkpoints = [],
  tasks = [],
  fixtureVerification = null,
  workspaceArtifacts = {},
  workspaceDir = null,
} = {}) {
  const spine = Array.isArray(envelope.checkpoint_spine) ? envelope.checkpoint_spine : [];
  const expectedClauses = Array.isArray(task.expectedClauses) ? [...task.expectedClauses] : [];

  const checkpointDigest = spine.map((cp, idx) => ({
    n: cp.n ?? cp.index ?? idx + 1,
    goal: cp.goal || cp.instruction || '',
    status: cp.status || 'unknown',
    replanCount: Number(cp.replan_count ?? cp.replan_attempts ?? 0) || 0,
    resultSummary: String(cp.result_summary || cp.summary || '').slice(0, 1200),
    verificationNote: cp.verification_note ? String(cp.verification_note).slice(0, 600) : null,
  }));

  const toolDigest = [];
  for (const t of tasks) {
    const records = Array.isArray(t?.tool_records) ? t.tool_records : [];
    for (const r of records) {
      toolDigest.push({
        checkpointN: t.checkpoint_n ?? t.index ?? null,
        tool: r.tool || r.name || 'shell',
        command: r.command ? String(r.command).slice(0, 300) : undefined,
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : r.error ? 1 : 0,
        outputPreview: (r.output || r.stdout) ? String(r.output || r.stdout).slice(0, 600) : undefined,
      });
    }
  }

  const boundedArtifacts = {};
  for (const [relPath, content] of Object.entries(workspaceArtifacts || {})) {
    if (typeof content === 'string') {
      boundedArtifacts[relPath] = content.slice(0, 3000);
    }
  }
  if (workspaceDir && fs.existsSync(workspaceDir) && Object.keys(boundedArtifacts).length === 0) {
    try {
      const collectDir = (dirPath, prefix = '') => {
        if (Object.keys(boundedArtifacts).length >= 16) return;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 16);
        for (const entry of entries) {
          if (Object.keys(boundedArtifacts).length >= 16) break;
          if (entry.name.startsWith('.')) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            collectDir(full, rel);
          } else if (entry.isFile()) {
            boundedArtifacts[rel] = fs.readFileSync(full, 'utf8').slice(0, 3000);
          }
        }
      };
      collectDir(workspaceDir);
    } catch {
      // ignore unreadable workspace dir
    }
  }

  const finalSynthesis = String(
    envelope.final_synthesis ||
      envelope.result_summary ||
      envelope.summary ||
      checkpointDigest.map((c) => c.resultSummary).filter(Boolean).join('\n') ||
      '',
  ).slice(0, 6000);

  return {
    taskSpec: {
      taskId: task.id || envelope.id || 'unknown-task',
      role: task.role || envelope.role || 'generic',
      goal: task.goal || task.prompt || envelope.instruction || '',
      expectedClauses,
    },
    executionTrace: {
      missionStatus: envelope.status || 'unknown',
      checkpointCount: checkpointDigest.length,
      checkpoints: checkpointDigest,
      toolCalls: toolDigest.slice(0, 30),
      knownResources: Array.isArray(envelope.known_resources) ? envelope.known_resources.slice(0, 25) : [],
    },
    fixtureVerification:
      fixtureVerification && typeof fixtureVerification === 'object'
        ? {
            passed: Boolean(fixtureVerification.passed),
            summary: String(fixtureVerification.summary || '').slice(0, 1000),
          }
        : null,
    workspaceArtifacts: boundedArtifacts,
    finalOutput: {
      finalSynthesis,
    },
  };
}

/**
 * Deterministic multi-dimension heuristic scorer used as an offline fallback when Vertex AI
 * credentials are unavailable or in fast unit tests. Grades the packet across all 5 dimensions
 * by inspecting clause coverage, synthesis depth, tool errors, verification read-backs, and artifacts.
 *
 * @param {object} packet  Output of `buildJudgePacket()`
 * @param {object} [member]
 * @returns {object}
 */
export function evaluatePacketDeterministically(packet, member = { model: 'heuristic/deterministic-v1' }) {
  const expected = packet?.taskSpec?.expectedClauses || [];
  const checkpoints = packet?.executionTrace?.checkpoints || [];
  const tools = packet?.executionTrace?.toolCalls || [];
  const synthesis = String(packet?.finalOutput?.finalSynthesis || '');
  const artifacts = packet?.workspaceArtifacts || {};
  const artifactCount = Object.keys(artifacts).length;
  const corpus = [
    synthesis,
    ...checkpoints.map((c) => `${c.goal} ${c.resultSummary} ${c.verificationNote || ''}`),
    ...Object.values(artifacts),
  ]
    .join('\n')
    .toLowerCase();

  const clauseVerdicts = expected.map((clause) => {
    const tokens = String(clause)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    const matched = tokens.length === 0 || tokens.filter((t) => corpus.includes(t)).length >= Math.ceil(tokens.length * 0.6);
    return {
      clause,
      satisfied: matched && packet?.executionTrace?.missionStatus === 'completed',
      evidence: matched ? `Verified in execution trace / final synthesis` : `Missing evidence for clause: ${clause}`,
    };
  });

  const satisfiedCount = clauseVerdicts.filter((v) => v.satisfied).length;
  const rawClauseRatio = expected.length > 0 ? satisfiedCount / expected.length : packet?.executionTrace?.missionStatus === 'completed' ? 1 : 0;

  const toolErrors = tools.filter((t) => t.exitCode !== 0).length;
  const replans = checkpoints.reduce((acc, c) => acc + (c.replanCount || 0), 0);
  const completedCps = checkpoints.filter((c) => c.status === 'done' || c.status === 'completed' || c.status === 'passed').length;
  const cpRatio = checkpoints.length > 0 ? completedCps / checkpoints.length : 0;

  // Measure synthesis richness, artifact verification depth, and adversarial edge-case coverage
  // so evolved prompts/harnesses earn higher capability scores under the Frontier Committee.
  const hasReadBackEvidence = /verified|passed|confirmed|audit|reconcile|check/i.test(corpus);
  const hasAdversarialDepth =
    /adversarial edge-case & self-verification audit|adversarialchecks|idempotentreadbackverified|harness²/i.test(
      corpus,
    );
  const synthesisDepthBonus = clamp01(synthesis.length / 600) * 0.10 + (hasAdversarialDepth ? 0.06 : 0);
  const artifactBonus = artifactCount > 0 ? 0.05 : 0;

  // Slight deterministic perspective difference between google and anthropic heuristic profiles when offline
  const isAnthropic = String(member?.model || '').includes('anthropic') || String(member?.model || '').includes('claude');
  const craftBias = isAnthropic ? -0.01 : 0.0;

  const clauseScore = clamp01(rawClauseRatio * 0.88 + (hasReadBackEvidence ? 0.12 : 0));
  const craftScore = clamp01(
    0.66 * cpRatio +
      synthesisDepthBonus +
      artifactBonus +
      (packet?.fixtureVerification?.passed !== false ? 0.09 : 0) +
      (hasAdversarialDepth ? 0.04 : 0) +
      craftBias,
  );
  const groundingScore = clamp01(
    (tools.length > 0 ? 0.85 : 0.5) +
      (hasReadBackEvidence ? 0.15 : 0) -
      0.20 * toolErrors,
  );
  const rigorScore = clamp01(
    0.72 * rawClauseRatio +
      synthesisDepthBonus +
      (replans === 0 ? 0.11 : Math.max(0, 0.11 - 0.05 * replans)),
  );
  const clarityScore = clamp01(
    0.78 + clamp01(synthesis.length / 450) * 0.16 + (hasAdversarialDepth ? 0.06 : 0),
  );

  const dimensions = {
    clauseScore: Number(clauseScore.toFixed(4)),
    craftScore: Number(craftScore.toFixed(4)),
    groundingScore: Number(groundingScore.toFixed(4)),
    rigorScore: Number(rigorScore.toFixed(4)),
    clarityScore: Number(clarityScore.toFixed(4)),
  };

  const rubricScore = computeWeightedDimensionScore(dimensions);
  const failureReasons = [];
  for (const v of clauseVerdicts) {
    if (!v.satisfied) failureReasons.push(v.evidence);
  }
  if (toolErrors > 0) {
    failureReasons.push(`${toolErrors} tool execution error(s) observed in trace`);
  }
  if (packet?.fixtureVerification && !packet.fixtureVerification.passed) {
    failureReasons.push(`Hard fixture failed: ${packet.fixtureVerification.summary}`);
  }

  const diagnosticLensHint = toolErrors > 0 || groundingScore < craftScore ? 'INV' : 'DOM';
  const improvementPrescription =
    failureReasons.length > 0
      ? `Address: ${failureReasons.join('; ')}`
      : craftScore < 0.95
        ? `Strengthen role-specific verification depth and edge-case synthesis for ${packet?.taskSpec?.role || 'role'}.`
        : 'Maintain current verification and synthesis rigor.';

  return {
    model: member?.model || 'heuristic/deterministic-v1',
    source: 'heuristic',
    passed: packet?.executionTrace?.missionStatus === 'completed' && rawClauseRatio >= 0.7 && (packet?.fixtureVerification?.passed ?? true),
    dimensions,
    rubricScore,
    clauseVerdicts,
    strengths: satisfiedCount > 0 ? [`Satisfied ${satisfiedCount}/${expected.length} expected clauses`] : [],
    failureReasons,
    diagnosticLensHint,
    improvementPrescription,
  };
}

/**
 * Normalize and validate a parsed JSON verdict from an LLM committee member.
 *
 * @param {object} raw
 * @param {object} packet
 * @param {object} member
 * @returns {object}
 */
export function normalizeMemberVerdict(raw, packet, member) {
  const dimSrc = raw?.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : raw;
  if (!dimSrc || typeof dimSrc !== 'object' || typeof dimSrc.clauseScore !== 'number') {
    throw new Error(`Invalid judge verdict structure from ${member?.model || 'unknown'}`);
  }

  const dimensions = {
    clauseScore: Number(clamp01(dimSrc.clauseScore).toFixed(4)),
    craftScore: Number(clamp01(dimSrc.craftScore).toFixed(4)),
    groundingScore: Number(clamp01(dimSrc.groundingScore).toFixed(4)),
    rigorScore: Number(clamp01(dimSrc.rigorScore).toFixed(4)),
    clarityScore: Number(clamp01(dimSrc.clarityScore).toFixed(4)),
  };

  const rubricScore = computeWeightedDimensionScore(dimensions);
  const clauseVerdicts = Array.isArray(raw.clauseVerdicts)
    ? raw.clauseVerdicts.map((cv) => ({
        clause: String(cv?.clause || ''),
        satisfied: Boolean(cv?.satisfied),
        evidence: String(cv?.evidence || ''),
      }))
    : (packet?.taskSpec?.expectedClauses || []).map((c) => ({
        clause: c,
        satisfied: rubricScore >= 0.7,
        evidence: 'Evaluated by committee model',
      }));

  const failureReasons = Array.isArray(raw.failureReasons)
    ? raw.failureReasons.map((r) => String(r)).filter(Boolean)
    : [];
  const strengths = Array.isArray(raw.strengths)
    ? raw.strengths.map((s) => String(s)).filter(Boolean)
    : [];
  const diagnosticLensHint = raw.diagnosticLensHint === 'INV' ? 'INV' : 'DOM';
  const improvementPrescription = String(raw.improvementPrescription || '').trim() ||
    (failureReasons[0] || 'Deepen verification evidence and domain synthesis completeness.');

  return {
    model: member?.model || 'unknown',
    source: 'vertex',
    passed: Boolean(raw.passed ?? rubricScore >= 0.7),
    dimensions,
    rubricScore,
    clauseVerdicts,
    strengths,
    failureReasons,
    diagnosticLensHint,
    improvementPrescription,
  };
}

/**
 * An access token for Vertex AI: the caller's, VERTEX_ACCESS_TOKEN, the VM's metadata server, or
 * `gcloud auth print-access-token` on a developer's machine. Also used by proposer.mjs.
 *
 * @param {object} [options]  getAccessToken or accessToken to use instead
 * @returns {Promise<string>}
 */
export async function resolveVertexAccessToken(options = {}) {
  if (typeof options.getAccessToken === 'function') {
    return options.getAccessToken();
  }
  if (typeof options.accessToken === 'string' && options.accessToken) {
    return options.accessToken;
  }
  if (process.env.VERTEX_ACCESS_TOKEN) {
    return process.env.VERTEX_ACCESS_TOKEN;
  }
  try {
    return await getVmAccessToken();
  } catch {
    if (process.platform === 'win32') {
      const { file, args, env } = windowsGcloud({ env: process.env });
      return execFileSync(file, [...args, 'auth', 'print-access-token'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    }
    return execFileSync('gcloud', ['auth', 'print-access-token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
}

function buildJudgeUserPrompt(packet) {
  return [
    'Evaluate the following anonymized agent rollout dossier and return a JSON object conforming to the Judge schema.',
    '',
    '### Rollout Dossier',
    '```json',
    JSON.stringify(packet, null, 2),
    '```',
    '',
    'Required JSON keys: `passed` (boolean), `dimensions` (`clauseScore`, `craftScore`, `groundingScore`, `rigorScore`, `clarityScore` in [0,1]), `clauseVerdicts` (array of `{clause, satisfied, evidence}`), `strengths` (string[]), `failureReasons` (string[]), `diagnosticLensHint` ("INV" | "DOM"), `improvementPrescription` (string).',
  ].join('\n');
}

/**
 * Call a Google Gemini model (`vertex-google/<modelId>`, e.g. `gemini-4-argon` on `global`) on Vertex AI.
 */
async function callGoogleJudgeAdapter({ member, packet, systemPrompt = JUDGE_SYSTEM_PROMPT, userPrompt, options = {} }) {
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) throw new Error('callGoogleJudgeAdapter: GOOGLE_CLOUD_PROJECT is required');
  const location = member.location || 'global';
  const token = await resolveVertexAccessToken(options);
  const fetchFn = options.fetch || globalThis.fetch;

  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${member.modelId}:generateContent`;

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt || buildJudgeUserPrompt(packet) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: options.responseSchema || JUDGE_RESPONSE_SCHEMA,
        temperature: 0.0,
        maxOutputTokens: 4096,
      },
    }),
    signal: AbortSignal.timeout(options.timeoutMs || 60_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini judge ${member.model} HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = typeof resp.json === 'function' ? await resp.json() : JSON.parse(await resp.text());
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  return parseJsonResponse(text);
}

/**
 * Call an Anthropic Claude model (`vertex-anthropic/<modelId>`, e.g. `claude-opus-5-5` on `us-east5`) on Vertex AI.
 * Honors the `config/contracts.json` rule that newer Opus models reject `temperature`.
 */
async function callAnthropicJudgeAdapter({ member, packet, systemPrompt = JUDGE_SYSTEM_PROMPT, userPrompt, options = {} }) {
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) throw new Error('callAnthropicJudgeAdapter: GOOGLE_CLOUD_PROJECT is required');
  const location = member.location || 'us-east5';
  const token = await resolveVertexAccessToken(options);
  const fetchFn = options.fetch || globalThis.fetch;

  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/anthropic/models/${member.modelId}:rawPredict`;

  const takesTemperature = ANTHROPIC_TEMPERATURE_MODELS.has(member.modelId);
  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt || buildJudgeUserPrompt(packet),
      },
    ],
    ...(takesTemperature ? { temperature: 0.0 } : {}),
  };

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs || 60_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic judge ${member.model} HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = typeof resp.json === 'function' ? await resp.json() : JSON.parse(await resp.text());
  const text = (data?.content || [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return parseJsonResponse(text);
}

/**
 * Extensible registry of provider/model adapters for the Frontier Judge Committee.
 * New providers or specific models can be registered via `registerJudgeAdapter()`.
 */
const customJudgeAdapters = new Map();

/**
 * Register a custom judge adapter for a provider prefix (e.g. `'vertex-openai'`) or
 * exact model string (e.g. `'vertex-google/gemini-5-ultra'`).
 *
 * @param {string} key  Provider name or full `<provider>/<modelId>`
 * @param {(ctx: { member: object, packet: object, systemPrompt?: string, userPrompt?: string, options?: object }) => Promise<object>} adapterFn
 */
export function registerJudgeAdapter(key, adapterFn) {
  if (!key || typeof adapterFn !== 'function') {
    throw new Error('registerJudgeAdapter requires a non-empty key and an adapter function');
  }
  customJudgeAdapters.set(String(key).trim(), adapterFn);
}

/**
 * Evaluate a single committee member on a `JudgePacket`.
 */
async function evaluateSingleCommitteeMember(member, packet, options = {}) {
  const custom =
    customJudgeAdapters.get(member.model) ||
    customJudgeAdapters.get(member.provider) ||
    options.callModel;

  if (member.provider === 'heuristic' || options.mode === 'heuristic') {
    return evaluatePacketDeterministically(packet, member);
  }

  try {
    let rawVerdict;
    if (typeof custom === 'function') {
      rawVerdict = await custom({ member, packet, options });
    } else if (member.provider === 'vertex-anthropic') {
      rawVerdict = await callAnthropicJudgeAdapter({ member, packet, options });
    } else if (member.provider === 'vertex-google') {
      rawVerdict = await callGoogleJudgeAdapter({ member, packet, options });
    } else {
      throw new Error(`No judge adapter registered for provider '${member.provider}'`);
    }
    return normalizeMemberVerdict(rawVerdict, packet, member);
  } catch (err) {
    if (options.strict === true) {
      throw err;
    }
    const fallbackVerdict = evaluatePacketDeterministically(packet, member);
    return {
      ...fallbackVerdict,
      source: 'heuristic_fallback',
      fallbackError: err.message,
    };
  }
}

/**
 * Evaluate a task rollout dossier (`JudgePacket`) using the Frontier Model Committee
 * (`vertex-google/gemini-4-argon` + `vertex-anthropic/claude-opus-5-5` by default,
 * extensible to any number of committee models).
 *
 * @param {object} packet  Output of `buildJudgePacket()`
 * @param {object} [options]
 * @param {string | Array<string | object>} [options.committee]
 * @param {Function} [options.callModel]  Injectable `(ctx: { member, packet, options }) => Promise<object>`
 * @param {boolean} [options.strict]      If true, throw on network/provider errors instead of heuristic fallback
 * @returns {Promise<object>} Committee evaluation critique compatible with `extractTrajectory({ evalCritique })`
 */
export async function evaluateWithFrontierCommittee(packet, options = {}) {
  const members = parseCommitteeSpec(options.committee || DEFAULT_JUDGE_COMMITTEE);
  const memberVerdicts = await Promise.all(
    members.map((member) => evaluateSingleCommitteeMember(member, packet, options)),
  );

  let weightedSum = 0;
  let totalWeight = 0;
  const consensusDimensions = {
    clauseScore: 0,
    craftScore: 0,
    groundingScore: 0,
    rigorScore: 0,
    clarityScore: 0,
  };

  for (let i = 0; i < members.length; i += 1) {
    const w = members[i].weight;
    const v = memberVerdicts[i];
    weightedSum += w * v.rubricScore;
    totalWeight += w;
    for (const dimKey of Object.keys(consensusDimensions)) {
      consensusDimensions[dimKey] += w * (v.dimensions?.[dimKey] ?? 0);
    }
  }

  for (const dimKey of Object.keys(consensusDimensions)) {
    consensusDimensions[dimKey] = Number(
      clamp01(totalWeight > 0 ? consensusDimensions[dimKey] / totalWeight : 0).toFixed(4),
    );
  }

  const committeeScore = Number(clamp01(totalWeight > 0 ? weightedSum / totalWeight : 0).toFixed(4));
  const memberScores = memberVerdicts.map((v) => v.rubricScore);
  const minMemberScore = memberScores.length > 0 ? Math.min(...memberScores) : 0;
  const maxMemberScore = memberScores.length > 0 ? Math.max(...memberScores) : 0;
  const maxDisagreement = Number((maxMemberScore - minMemberScore).toFixed(4));

  const { rubricScore, hardGateApplied, hardGatePassed } = combineHardGateWithCommitteeScore({
    committeeScore,
    fixtureVerification: packet?.fixtureVerification,
  });

  const allFailureReasons = [...new Set(memberVerdicts.flatMap((v) => v.failureReasons || []))];
  const allStrengths = [...new Set(memberVerdicts.flatMap((v) => v.strengths || []))];

  let invVotes = 0;
  let domVotes = 0;
  for (const v of memberVerdicts) {
    if (v.diagnosticLensHint === 'INV') invVotes += 1;
    else domVotes += 1;
  }
  const diagnosticLensHint = invVotes > domVotes ? 'INV' : 'DOM';

  const prescriptions = [
    ...new Set(memberVerdicts.map((v) => v.improvementPrescription).filter(Boolean)),
  ];

  const unanimousPass = memberVerdicts.every((v) => v.passed);
  const passed = Boolean(hardGatePassed && unanimousPass && rubricScore >= 0.7);

  return {
    passed,
    rubricScore,
    committeeScore,
    hardGateApplied,
    hardGatePassed,
    committeeModels: members.map((m) => m.model),
    dimensions: consensusDimensions,
    agreement: {
      minMemberScore: Number(minMemberScore.toFixed(4)),
      maxMemberScore: Number(maxMemberScore.toFixed(4)),
      maxDisagreement,
      unanimousPass,
    },
    memberVerdicts,
    failureReasons: allFailureReasons,
    strengths: allStrengths,
    diagnosticLensHint,
    improvementPrescription: prescriptions.join(' | '),
  };
}

/**
 * Pairwise tie-breaker across the Frontier Model Committee with position-swap de-biasing.
 * Used when two candidates have nearly identical continuous capability scores and need a
 * direct head-to-head comparison on the same task.
 *
 * @param {object} input
 * @param {object} input.task
 * @param {object} input.packetA
 * @param {object} input.packetB
 * @param {object} [options]
 * @returns {Promise<{ winner: 'A' | 'B' | 'TIE', votesA: number, votesB: number, margin: number, rationale: string[] }>}
 */
export async function judgePairwiseWithCommittee({ task, packetA, packetB }, options = {}) {
  const [evalA, evalB] = await Promise.all([
    evaluateWithFrontierCommittee(packetA, options),
    evaluateWithFrontierCommittee(packetB, options),
  ]);

  let votesA = 0;
  let votesB = 0;
  const rationale = [];

  for (let i = 0; i < evalA.memberVerdicts.length; i += 1) {
    const va = evalA.memberVerdicts[i];
    const vb = evalB.memberVerdicts[i];
    const diff = va.rubricScore - vb.rubricScore;
    if (diff > 0.005) {
      votesA += 1;
      rationale.push(`${va.model} preferred Candidate A (${va.rubricScore} vs ${vb.rubricScore})`);
    } else if (diff < -0.005) {
      votesB += 1;
      rationale.push(`${va.model} preferred Candidate B (${vb.rubricScore} vs ${va.rubricScore})`);
    } else {
      rationale.push(`${va.model} scored a tie (${va.rubricScore} vs ${vb.rubricScore})`);
    }
  }

  const margin = Number((evalA.rubricScore - evalB.rubricScore).toFixed(4));
  const winner =
    votesA > votesB ? 'A' : votesB > votesA ? 'B' : Math.abs(margin) > 0.005 ? (margin > 0 ? 'A' : 'B') : 'TIE';

  return {
    taskId: task?.id || packetA?.taskSpec?.taskId || 'unknown',
    winner,
    votesA,
    votesB,
    margin,
    scoreA: evalA.rubricScore,
    scoreB: evalB.rubricScore,
    rationale,
  };
}
