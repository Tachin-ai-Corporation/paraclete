// agent/services/brain/main.mjs: the brain service, the agent's mission loop. Builds the libraries with
// the contracts mapped onto their parameters, then runs its loops: the intake loop (inbound messages,
// approval replies, timed waits coming due, approved gates, "run now" triggers, and the heartbeat after
// each pass), the runner loop (one mission at a time, envelope-runner.mjs), the scheduler's one-minute
// tick and the hourly archival sweep. Started by systemd (paraclete-brain.service); importing this module
// starts nothing. Tests build it with buildBrain() and drive the ticks themselves.
//
// Module map: settings.mjs (configuration), gateway-client.mjs (organ turns), prompt-assembly.mjs (the
// context sent with them), envelope-store.mjs (Firestore), intake.mjs, intake-handlers.mjs and
// approval-replies.mjs (what comes in), envelope-runner.mjs and mission-context.mjs (the mission loop),
// actions/ (the cortex's moves), completion.mjs (how a run ends), memory.mjs (recall and records),
// waits.mjs (timed waits), responsibilities.mjs (the scheduler and triggers).
//
// Health: after every intake pass the service rewrites <data root>/services/brain/health.json. The
// control service reads it: a beat_at older than a minute means a hung loop. The runner's own state
// (the mission it is running, and since when) rides in the same file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentIdentity } from '../../../config/instance.mjs';
import { createServiceRuntime, readAdminSettings, skillDirectories } from '../service-runtime.mjs';
import { createVertexText } from '../../providers/vertex-text.mjs';
import { createNotifier } from '../../providers/notifications.mjs';
import { createGitStore, createRemoteStore } from '../../storage/git-store.mjs';
import { createFileStore } from '../../storage/file-store.mjs';
import { listOutgoing } from '../../files/outgoing.mjs';
import { assembleConversation } from '../../context/conversation-context.mjs';
import { sweepThreadTurns } from '../../context/thread-ledger.mjs';
import { createApprovalChecker } from '../../work/approvals.mjs';
import { createArchivalSweeper } from '../../work/archival.mjs';
import { createArtifactManager } from '../../work/artifacts.mjs';
import { createCheckpointExecutor } from '../../work/checkpoint-executor.mjs';
import { createProcessRegistry } from '../../work/process-registry.mjs';
import { createProjectRegistry } from '../../work/projects.mjs';
import { readPlatformVersion, stampPlatformVersion } from '../../work/platform-version.mjs';
import { readInstalledProcesses, readInstalledResponsibilities } from '../../work/role-packages.mjs';
import { adminEffort, brainSettings, organTemperature } from './settings.mjs';
import { createGatewayClient, readGatewayToken, toolResultDigester } from './gateway-client.mjs';
import { addressFor, addressOf, createEnvelopeStore } from './envelope-store.mjs';
import { capabilityMap, readSkills } from './prompt-assembly.mjs';
import { createMemory, createMemoryFiles } from './memory.mjs';
import { createCompletion, missionDirIn } from './completion.mjs';
import { createMissionContext } from './mission-context.mjs';
import { createEnvelopeRunner } from './envelope-runner.mjs';
import { createIntakeHandlers } from './intake-handlers.mjs';
import { createApprovalReplies } from './approval-replies.mjs';
import { createIntake } from './intake.mjs';
import { createWaits } from './waits.mjs';
import { createResponsibilities } from './responsibilities.mjs';

/** The approvals poller acts on every Nth intake pass (about every 15 seconds at a 3 second poll). */
const APPROVALS_EVERY = 5;
/** How often the admin's effort setting is read again. */
const EFFORT_REFRESH_MS = 60_000;

/** Rewrites a JSON file through a temporary file, so a reader never sees half of it. */
function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
}

/** Token accounting per mission, for the mission_total telemetry line. */
function createUsageMeter(log) {
  const totals = new Map();
  return {
    record(missionId, organ, usage, durationMs) {
      if (!missionId || !usage) return;
      const t = totals.get(missionId) || { calls: 0, input: 0, output: 0, cached: 0, cacheWrites: 0 };
      const input = usage.promptTokenCount || usage.prompt_tokens || 0;
      const output = usage.candidatesTokenCount || usage.completion_tokens || 0;
      t.calls += 1;
      t.input += input;
      t.output += output;
      t.cached += usage.cachedContentTokenCount || 0;
      t.cacheWrites += usage.cacheCreationTokenCount || 0;
      totals.set(missionId, t);
      log('INFO', `[TELEMETRY] llm_usage mission=${missionId} organ=${organ} input=${input} output=${output} cached=${usage.cachedContentTokenCount || 0} cache_write=${usage.cacheCreationTokenCount || 0} duration=${durationMs || 0}ms`);
    },
    summary: (missionId) => totals.get(missionId) || null,
    drop: (missionId) => totals.delete(missionId),
  };
}

/**
 * Wires the brain from a service runtime. Nothing runs until start(); tests call init() and drive
 * tickIntake(), tickRunner() and the scheduler directly.
 *
 * @param {object} runtime - from createServiceRuntime({ service: 'brain' })
 * @param {object} [deps] - overrides for tests
 * @param {object}   [deps.vertexText]   the utility model client
 * @param {string}   [deps.gatewayToken] instead of reading instance.gateway_token_file
 * @param {object|null} [deps.artifacts] the artifact manager; null for none
 * @param {Function} [deps.readText]     (path) => text, for installed files (skills, roles, prompts)
 * @param {object}   [deps.memoryIo]     { readText, appendText } for the memory files
 * @param {Function} [deps.clock]
 * @returns {object} the brain
 */
export function buildBrain(runtime, deps = {}) {
  const { contracts, instance, log, collections, paths } = runtime;
  const clock = deps.clock || Date.now;
  const iso = () => new Date(clock()).toISOString();
  const settings = brainSettings(contracts);
  const readText = deps.readText || ((path) => readFileSync(path, 'utf8'));
  const readOrNull = (path) => { try { return readText(path); } catch { return null; } };
  // Every work envelope this brain creates carries the release it runs, read once, here.
  const platformVersion = readPlatformVersion(paths.installRoot, { readText, log });
  const db = stampPlatformVersion(runtime.db, { version: platformVersion, since: clock() });
  const token = deps.gatewayToken || readGatewayToken(instance.gateway_token_file, readText);
  const effort = { level: settings.effortDefault, checkedAt: -Infinity };
  const missionDir = missionDirIn(paths.data.missions);
  const usage = createUsageMeter(log);
  const author = agentIdentity(instance);
  const roleDirs = { genericDir: paths.genericRole, role: instance.role, roleDir: paths.role };

  const vertexText = deps.vertexText || createVertexText({
    projectId: instance.project,
    location: contracts.utility.location,
    model: contracts.utility.model,
    timeoutMs: contracts.utility.timeout_ms,
    enforceSchemaTimeoutMs: contracts.utility.enforce_schema_timeout_ms,
    enforceSchemaMaxAttempts: contracts.utility.enforce_schema_max_attempts,
    logger: (level, message) => log(level, message),
    getAccessToken: runtime.getAccessToken,
    fetch: runtime.fetch,
  });
  const enforceSchema = (raw, mode) => vertexText.enforceSchema(raw, mode);

  let projects = null;
  const store = createEnvelopeStore({
    db, log, clock, transitionGuard: settings.transitionGuard,
    defaultProjectId: () => projects?.getDefaultId() || null, claimStaleMs: settings.claimStaleMs,
  });
  projects = createProjectRegistry({
    db, logger: log, generateId: store.newId, writeHistory: store.writeHistory, promotionAuto: settings.promotionAuto, clock,
  });
  const processes = createProcessRegistry({
    db, logger: log, clock,
    defaults: readInstalledProcesses(roleDirs, {
      readText, onError: (file, e) => log('WARN', `installed playbook ${file} could not be read: ${e.message}`),
    }),
  });

  const gateway = createGatewayClient({
    url: runtime.gatewayUrl,
    token,
    fetch: runtime.fetch,
    timeoutMs: settings.gatewayTimeoutMs,
    temperatureFor: (organ) => organTemperature(organ, effort.level),
    missionDir,
    toolRecords: { db, policy: settings.toolRecord, digest: toolResultDigester(vertexText), newId: store.newId },
    onUsage: (...args) => usage.record(...args),
    log,
    clock,
  });
  const callAgent = gateway.callAgent;

  const memoryFiles = createMemoryFiles({
    workingMemoryFile: paths.data.workingMemoryFile,
    deepTruthsFile: paths.data.deepTruthsFile,
    hardCapChars: settings.workingMemoryHardCapChars,
    log,
    io: deps.memoryIo || {},
  });
  const memory = createMemory({
    db, callAgent, files: memoryFiles, getProject: (id) => projects.get(id), processes,
    recallLimit: settings.resourceLedger.recallLimit, log, clock,
  });

  const notifier = createNotifier({
    vertexText,
    firestoreWrite: store.firestoreWrite,
    firestoreRead: store.firestoreRead,
    collections,
    addressFromMeta: addressOf,
    generateId: store.newId,
    cachedReadFile: readOrNull,
    getGatewayConfig: () => ({ url: `${gateway.url}/v1/chat/completions`, token, route: 'brain/cortex' }),
    getProjects: () => projects.getAll(),
    logger: log,
    fetch: runtime.fetch,
    now: clock,
    config: { identityPath: join(paths.prompts, 'identity.md') },
  });

  const artifacts = deps.artifacts !== undefined ? deps.artifacts : createArtifactManager({
    gitStore: createGitStore({
      config: {
        bucket: instance.bucket,
        gcpProject: instance.project,
        prefix: contracts.git.prefix,
        defaultBranch: contracts.git.default_branch,
        maxPushRetries: contracts.git.max_push_retries,
      },
      store: createRemoteStore({
        getAccessToken: runtime.getAccessToken, fetch: runtime.fetch, firestoreHost: runtime.firestoreHost, storageHost: runtime.storageHost,
      }),
      author,
      logger: (level, ...args) => log(level, args.join(' ')),
    }),
    db,
    getProjects: () => projects.getAll(),
    fileStore: createFileStore({
      bucket: instance.bucket,
      prefix: contracts.files.prefix,
      maxBytes: contracts.files.max_mb * 1024 * 1024,
      getAccessToken: runtime.getAccessToken,
      fetch: runtime.fetch,
      logger: log,
      storageHost: runtime.storageHost,
    }),
    logger: log,
    config: { missionsRoot: paths.data.missions, workspaceDir: paths.data.workspace, author },
  });

  // An approved gate is handed to the runner: the mission goes back to active with its paused plan,
  // and the runner continues it at the task after the gate. The recall the poller would do first is
  // left to the runner, which has the mission's memory already.
  async function queueApprovedMission(envelope, _memory, approval) {
    const by = approval?.resolvedBy ? ` by ${approval.resolvedBy}` : '';
    await store.setStatus(envelope, 'active', `Approved${by}; continuing at the task after the gate`);
  }
  const approvals = createApprovalChecker({
    db,
    firestoreRead: store.firestoreRead,
    firestoreWrite: store.firestoreWrite,
    writeHistory: store.writeHistory,
    recallMemory: async () => null,
    resumeCheckpointPlan: queueApprovedMission,
    logger: log,
    checkEvery: 1,
    clock,
  });

  const executor = createCheckpointExecutor({
    db,
    callAgent,
    writeHistory: store.writeHistory,
    approvals,
    generateId: store.newId,
    projects,
    artifacts,
    missionDir,
    summarizeForDelivery: notifier.summarizeForDelivery,
    addressFromMeta: addressOf,
    settings: settings.executor,
    logger: log,
    clock,
  });

  const responsibilities = createResponsibilities({
    db, store, contracts,
    defaults: readInstalledResponsibilities(roleDirs, {
      readText, onError: (file, e) => log('WARN', `installed responsibilities at ${file} could not be read: ${e.message}`),
    }),
    recall: memory.recall, processes, projects, log, clock,
  });

  const completion = createCompletion({
    store, memory, projects, artifacts, fireEvent: responsibilities.fireEvent, addressFor, missionDir, usage,
    outgoingFiles: (missionId) => listOutgoing(db, missionId),
    settings: { minDeliverableChars: settings.minDeliverableChars, learningsMaxEntries: settings.compaction.learnings_max_entries },
    log,
  });

  // What each organ can do, re-read at every mission boundary so a skill the agent wrote or a release
  // added is live for the next mission, and fixed for the life of the one running. An empty read is a
  // failed scan (an agent always has its base skills), never adopted over a good map.
  let capMap = '';
  let skillIds = [];
  function refreshCapabilities(reason = 'refresh') {
    const skills = readSkills(skillDirectories(paths));
    if (skills.length === 0 && capMap) {
      log('WARN', `the skill scan came back empty (${reason}); keeping the previous capability map`);
      return;
    }
    const ids = skills.map((s) => s.id).sort();
    if (ids.join(',') !== skillIds.join(',')) {
      log('INFO', `capabilities at ${reason}: ${ids.length} skills (${ids.join(', ')})`);
      skillIds = ids;
    }
    capMap = capabilityMap(skills);
  }
  let planSkillText = null;
  const planSkill = () => {
    if (planSkillText === null) planSkillText = readOrNull(join(paths.skills, 'plan-structuring', 'SKILL.md')) || '';
    return planSkillText;
  };

  const missionContext = createMissionContext({ store, vertexText, settings, missionDir, log });
  const runner = createEnvelopeRunner({
    store, gateway, callAgent, enforceSchema, executor, completion, memory, memoryFiles, missionContext,
    projects, processes, artifacts, responsibilities, writeStatusUpdate: notifier.writeStatusUpdate,
    addressFor, capabilityMap: () => capMap, refreshCapabilities, planSkill, settings, log, clock,
  });
  const handlers = createIntakeHandlers({
    db, store, generateTitle: (text, type) => vertexText.generateTitle(text, type), memory, projects,
    writeStatusUpdate: notifier.writeStatusUpdate, runner, addressFor, log,
  });
  const approvalReplies = createApprovalReplies({ db, store, approvals, addressFor, log });
  const intake = createIntake({
    db, store, gateway, enforceSchema, notifier, memory, memoryFiles, handlers, approvalReplies, projects, processes,
    capabilityMap: () => capMap,
    assembleConversation: ({ threadId }) => assembleConversation({
      projectId: instance.project, threadId, config: settings.conversation,
      getAccessToken: runtime.getAccessToken, fetch: runtime.fetch, firestoreHost: runtime.firestoreHost, log,
    }),
    settings,
    summarize: (text, instruction, opts) => vertexText.summarize(text, instruction, opts),
    log,
    clock,
  });
  const waits = createWaits({ store, log, clock });
  const archiver = createArchivalSweeper({
    firestoreWrite: store.firestoreWrite,
    firestoreRead: store.firestoreRead,
    firestoreQuery: store.firestoreQuery,
    config: settings.archival,
    logger: log,
    clock,
  });

  const healthFile = join(paths.data.services, 'brain', 'health.json');
  const health = {
    service: 'brain',
    pid: process.pid,
    started_at: iso(),
    beat_at: null,
    effort: effort.level,
    intake: { last_poll_at: null, last_ok_at: null, last_error: null, handled: 0 },
    runner: runner.state(),
  };
  function beat() {
    health.beat_at = iso();
    health.effort = effort.level;
    health.runner = runner.state();
    try {
      writeJsonFile(healthFile, health);
    } catch (err) {
      log('WARN', 'health file could not be written', { path: healthFile, error: err.message });
    }
  }

  async function refreshEffort() {
    if (clock() - effort.checkedAt < EFFORT_REFRESH_MS) return;
    effort.checkedAt = clock();
    try {
      const level = adminEffort(await readAdminSettings(db, { strict: true }), settings.effortDefault);
      if (level !== effort.level) {
        log('INFO', `effort: ${effort.level} -> ${level}`);
        effort.level = level;
      }
    } catch (e) {
      log('WARN', `the admin settings could not be read; keeping effort ${effort.level}: ${e.message}`);
    }
  }

  /** Startup: load the registries, recover what a previous process left behind. */
  async function init() {
    await projects.load();
    await projects.ensureDefault();
    await processes.loadProcesses();
    refreshCapabilities('startup');
    await runner.recover();
    await intake.recover();
  }

  let passes = 0;
  /** One intake pass. Returns the delay until the next. */
  async function tickIntake() {
    passes += 1;
    health.intake.last_poll_at = iso();
    try {
      await refreshEffort();
      health.intake.handled += await intake.poll();
      await waits.check();
      if (passes % APPROVALS_EVERY === 0) await approvals.checkPending();
      await responsibilities.checkTriggers();
      health.intake.last_ok_at = iso();
      health.intake.last_error = null;
    } catch (err) {
      health.intake.last_error = err.message;
      log('ERROR', 'intake pass failed', { error: err.message });
    }
    beat();
    return settings.pollIntervalMs;
  }

  /** One runner pass. Returns the delay until the next: short after a mission, the poll otherwise. */
  async function tickRunner() {
    const ran = await runner.tick();
    return ran ? 100 : settings.pollIntervalMs;
  }

  /** The archival sweep, and the thread-turn retention riding its cadence. */
  async function archive() {
    try {
      await archiver.sweep();
      await sweepThreadTurns({ db, config: settings.conversation, log, clock });
    } catch (e) {
      log('WARN', `archival failed: ${e.message}`);
    }
  }

  let running = false;
  const wakers = new Set();
  let loops = [];
  let archiveTimer = null;
  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); wakers.delete(done); resolve(); }
      wakers.add(done);
    });
  }
  async function loop(name, tick, errorDelay) {
    while (running) {
      let delay;
      try {
        delay = await tick();
      } catch (err) {
        log('ERROR', `${name} loop error`, { error: err.message });
        delay = errorDelay;
      }
      if (running) await sleep(delay);
    }
  }

  /** Starts every loop. Resolves when stop() has ended them. */
  async function start() {
    if (running) return;
    running = true;
    log('INFO', 'brain starting', { gateway: gateway.url, role: instance.role, release: platformVersion });
    if (!(await gateway.ping())) log('WARN', 'the gateway is not answering yet; organ turns will fail until it does');
    await init();
    responsibilities.start();
    archiveTimer = setInterval(() => { archive(); }, settings.archivalIntervalMs);
    archive();
    loops = [
      loop('intake', tickIntake, settings.pollIntervalMs),
      loop('runner', tickRunner, settings.pollIntervalMs),
    ];
    await Promise.all(loops);
  }

  async function stop() {
    running = false;
    responsibilities.stop();
    if (archiveTimer) clearInterval(archiveTimer);
    for (const wake of [...wakers]) wake();
    await Promise.all(loops);
  }

  return {
    init,
    tickIntake,
    tickRunner,
    archive,
    start,
    stop,
    health,
    settings,
    effort,
    refreshCapabilities,
    parts: {
      store, gateway, intake, handlers, runner, waits, approvals, approvalReplies, responsibilities, memory,
      memoryFiles, completion, executor, projects, processes, notifier, archiver,
    },
  };
}

/** Starts the brain service: the systemd unit's entry point. */
export async function main() {
  const runtime = createServiceRuntime({ service: 'brain' });
  const brain = buildBrain(runtime);
  const shutdown = (signal) => {
    runtime.log('INFO', `brain stopping on ${signal}`);
    brain.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await brain.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'ERROR', service: 'brain', message: `brain failed: ${err.message}` })}\n`);
    process.exit(1);
  });
}
