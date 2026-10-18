// agent/services/mouth/main.mjs: the mouth service, the agent's only way out. Every few seconds it
// delivers the envelopes whose delivery is pending, each to exactly its Address, in the agent's
// voice (delivery.mjs), then sends any status notes that are due (status-updates.mjs). It serves the
// dashboard always and Google Chat when the instance has a Workspace account. Deciding what to say
// is the brain's. Started by systemd (paraclete-mouth.service); importing this module starts nothing.
//
// Health: after every poll the service rewrites <data root>/services/mouth/health.json with when it
// last polled, last succeeded and last delivered, and, with a Workspace account, how Google Chat
// answered its posts (`gchat`). The control service reads it: a beat_at older than a minute means a
// hung loop, a fresh beat_at with a stale last_ok_at means the mouth cannot read its work queue.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServiceRuntime } from '../service-runtime.mjs';
import { initChannel } from '../../providers/channel.mjs';
import { createVertexText } from '../../providers/vertex-text.mjs';
import { createDwdTokenSource } from '../../auth/dwd-token.mjs';
import { CHAT_SEND } from '../../auth/workspace-scopes.mjs';
import { appendTurn } from '../../context/thread-ledger.mjs';
import { createOutbound } from './outbound.mjs';
import { createVoice } from './voice.mjs';
import { voicingTail } from './voicing-context.mjs';
import { createDelivery } from './delivery.mjs';
import { createStatusUpdates, parseStatusPrompts } from './status-updates.mjs';

/**
 * The mouth is the one service that posts to Chat, so it alone holds the send scope. The scopes
 * themselves are agent/auth/workspace-scopes.mjs's.
 */
export const CHAT_SEND_SCOPES = CHAT_SEND;

/** How often the mouth polls for pending deliveries when the contracts don't say. */
const DEFAULT_POLL_INTERVAL_MS = 5_000; // default; callers pass the contracts value
/** A liveness line in the log every this many polls (about five minutes). */
const HEARTBEAT_LOG_EVERY = 60;

const VOICE_PROMPT = new URL('./voice-prompt.md', import.meta.url);
const STATUS_PROMPTS = new URL('./status-prompts.md', import.meta.url);

/** Rewrites a JSON file through a temporary file, so a reader never sees half of it. */
function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
}

/**
 * Wires the mouth from a service runtime. Nothing runs until start(); tests drive tick() directly.
 *
 * @param {object} runtime from createServiceRuntime() (agent/services/service-runtime.mjs)
 * @param {object} [deps]  overrides for tests
 * @param {object}   [deps.vertexText]    a client from agent/providers/vertex-text.mjs
 * @param {Function} [deps.getChatToken]  () => Promise<string>, the Workspace token with the send scope
 * @param {Function} [deps.deliver]       deliverToAddress replacement
 * @param {string}   [deps.voicePrompt]
 * @param {string}   [deps.statusPrompts]
 * @param {Function} [deps.now]           clock in milliseconds
 * @returns {{tick: Function, start: Function, stop: Function, health: object}}
 */
export function createMouth(runtime, deps = {}) {
  const { contracts, instance, log, db, collections } = runtime;
  const cfg = contracts.mouth;
  const pollIntervalMs = cfg.poll_ms > 0 ? cfg.poll_ms : DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now || Date.now;
  const iso = () => new Date(now()).toISOString();
  const healthFile = join(runtime.paths.data.root, 'services', 'mouth', 'health.json');

  initChannel({
    firestoreUrl: `${runtime.firestoreHost}/v1/projects/${instance.project}/databases/(default)/documents`,
    collections,
    agentName: instance.agent_name,
    fetch: runtime.fetch,
    now,
  });

  const readPrompt = (url, name) => {
    try {
      return readFileSync(url, 'utf8');
    } catch (err) {
      log('WARN', `${name} is missing; messages go out as the brain wrote them`, { error: err.message });
      return '';
    }
  };
  const voicePrompt = deps.voicePrompt ?? readPrompt(VOICE_PROMPT, 'voice-prompt.md');
  const statusPrompts = parseStatusPrompts(deps.statusPrompts ?? readPrompt(STATUS_PROMPTS, 'status-prompts.md'));

  const vertexText = deps.vertexText || createVertexText({
    projectId: instance.project,
    location: contracts.utility.location,
    model: cfg.model,
    timeoutMs: contracts.utility.timeout_ms,
    logger: (level, message) => log(level, message),
    getAccessToken: runtime.getAccessToken,
    fetch: runtime.fetch,
  });
  const transform = (text, instruction, opts) => vertexText.transform(text, instruction, opts);
  const callOptions = { maxTokens: cfg.max_tokens, temperature: cfg.temperature, disableThinking: contracts.utility.disable_thinking };
  const llmEnabled = cfg.llm_enabled !== false;

  let getChatToken = deps.getChatToken || null;
  if (!getChatToken && instance.workspace) {
    const getDwdToken = createDwdTokenSource({ fetch: runtime.fetch, getVmAccessToken: runtime.getAccessToken });
    getChatToken = () => getDwdToken({
      signerServiceAccount: instance.workspace.signer,
      subjectEmail: instance.workspace.account,
      scopes: CHAT_SEND_SCOPES,
    });
  }
  const outbound = createOutbound({
    getVmToken: runtime.getAccessToken,
    getChatToken,
    replyInThread: contracts.chat.reply_in_thread !== false,
    ...(deps.deliver ? { deliver: deps.deliver } : {}),
    log,
    now,
  });

  const delivery = createDelivery({
    db,
    collections,
    outbound,
    voice: createVoice({ transform, prompt: voicePrompt, agentName: instance.agent_name, enabled: llmEnabled, callOptions, log }),
    voicingTail: ({ address, envelope }) => voicingTail({ db, address, envelope, config: contracts.conversation, log }),
    appendTurn: (turn) => appendTurn({ db, config: contracts.conversation, log, source: 'delivery', ...turn }),
    retry: contracts.delivery,
    log,
    now,
  });
  const statusUpdates = createStatusUpdates({
    db,
    collections,
    outbound,
    transform,
    prompts: statusPrompts,
    agentName: instance.agent_name,
    schedule: cfg.status_updates?.schedule_ms || [],
    enabled: cfg.status_updates?.enabled !== false,
    llmEnabled,
    callOptions,
    log,
    now,
  });

  const health = {
    service: 'mouth',
    pid: process.pid,
    started_at: iso(),
    beat_at: null,
    channels: getChatToken ? ['dashboard', 'gchat'] : ['dashboard'],
    last_poll_at: null,
    last_ok_at: null,
    last_error: null,
    last_delivery_at: null,
    delivered: 0,
    failed: 0,
    status_notes: 0,
    status_notes_error: null,
    // How Google Chat answered the mouth's posts in this run; the System tab shows it beside the ears'.
    gchat: getChatToken ? outbound.chatStatus() : null,
  };
  let polls = 0;

  function beat() {
    health.beat_at = iso();
    if (getChatToken) health.gchat = outbound.chatStatus();
    try {
      writeJsonFile(healthFile, health);
    } catch (err) {
      log('WARN', 'health file could not be written', { path: healthFile, error: err.message });
    }
  }

  /** One poll: deliveries, then status notes. Returns the delay until the next. */
  async function tick() {
    health.last_poll_at = iso();
    let waiting = 0;
    try {
      const counts = await delivery.pass();
      health.delivered += counts.delivered;
      health.failed += counts.failed;
      waiting = counts.waiting;
      if (counts.delivered > 0) health.last_delivery_at = iso();
      health.last_ok_at = iso();
      health.last_error = null;
    } catch (err) {
      health.last_error = err.message;
      log('ERROR', 'delivery poll failed', { error: err.message });
    }
    try {
      health.status_notes += await statusUpdates.pass();
      health.status_notes_error = null;
    } catch (err) {
      health.status_notes_error = err.message;
      log('WARN', 'status notes poll failed', { error: err.message });
    }
    polls += 1;
    if (polls % HEARTBEAT_LOG_EVERY === 1) {
      log('INFO', 'mouth heartbeat', { polls, delivered: health.delivered, failed: health.failed, waiting });
    }
    beat();
    return pollIntervalMs;
  }

  let running = false;
  let wake = null;
  let loop = null;

  /** Starts the poll loop. Resolves when stop() has ended it. */
  async function start() {
    if (running) return;
    running = true;
    log('INFO', 'mouth starting', { channels: health.channels, voice: llmEnabled && Boolean(voicePrompt) });
    loop = (async () => {
      while (running) {
        let delay = pollIntervalMs;
        try {
          delay = await tick();
        } catch (err) {
          log('ERROR', 'mouth loop error', { error: err.message });
        }
        if (!running) break;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
    await loop;
  }

  async function stop() {
    running = false;
    if (wake) wake();
    if (loop) await loop;
  }

  return { tick, start, stop, health };
}

async function main() {
  const runtime = createServiceRuntime({ service: 'mouth' });
  const mouth = createMouth(runtime);
  const shutdown = (signal) => {
    runtime.log('INFO', `mouth stopping on ${signal}`);
    mouth.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await mouth.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'ERROR', service: 'mouth', message: `mouth failed: ${err.message}` })}\n`);
    process.exit(1);
  });
}
