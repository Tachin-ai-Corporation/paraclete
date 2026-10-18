// agent/services/ears/main.mjs: the ears service, the way messages come in. One process serves every
// channel at once: the dashboard always, and Google Chat when the instance has a Workspace account.
// Each channel has its own poll loop, and every message it reads becomes an intake document for the
// brain, carrying the Address its reply must go to. The ears never answer; replies leave through the
// mouth. Started by systemd (paraclete-ears.service); importing this module starts nothing.
//
// Health: after every poll the service rewrites <data root>/services/ears/health.json with when each
// channel last polled and last succeeded. The control service reads it: a beat_at older than a
// minute means a hung loop, a fresh beat_at with a stale last_ok_at means a channel it cannot read.
// The `gchat` block is what the dashboard's System tab shows for Google Chat: its state ('off' with
// no Workspace account, 'connecting' while the account's token fails, 'ready'), the account, how many
// spaces and direct messages it reads, how many it leaves alone because they admit people outside the
// organization, and the last error. How people use Chat with the agent: README.md beside this file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServiceRuntime } from '../service-runtime.mjs';
import { initChannel, listSpaces, findDirectMessage } from '../../providers/channel.mjs';
import { createVertexText } from '../../providers/vertex-text.mjs';
import { createDwdTokenSource } from '../../auth/dwd-token.mjs';
import { CHAT_READ } from '../../auth/workspace-scopes.mjs';
import { appendTurn } from '../../context/thread-ledger.mjs';
import { createInboundGate } from './inbound-gate.mjs';
import { createPreprocessor } from './preprocess.mjs';
import { createInboundHandler } from './inbound.mjs';
import { createDashboardInbox } from './dashboard-inbox.mjs';
import { createChatInbox } from './chat-inbox.mjs';
import { createChatIdentity, dashboardUserEmails } from './chat-identity.mjs';
import { createFileStateStore } from './chat-state.mjs';

/**
 * The ears read Chat and never post to it: they hold read scopes only (spaces.list,
 * spaces.findDirectMessage, spaces.messages.list). The scope that can send a message belongs to the
 * mouth alone. The scopes themselves are agent/auth/workspace-scopes.mjs's.
 */
export const CHAT_READ_SCOPES = CHAT_READ;

/** How long the Chat loop waits before trying the Workspace token again. */
const CHAT_RETRY_MS = 30_000;
/** How long the Chat loop waits after Chat answered 429 (its quota is per minute). */
const CHAT_RATE_LIMIT_MS = 60_000;
/**
 * How long the Chat loop waits at most while Chat keeps refusing the account (401 or 403). A refusal
 * lasts until a person changes something in the Admin console or the Cloud console, so the wait
 * doubles from CHAT_RETRY_MS up to this.
 */
const CHAT_REFUSED_MAX_MS = 300_000;
/** Dashboard user records read at most, for matching Chat senders. */
const USERS_READ_LIMIT = 500;

const PREPROCESS_PROMPT = new URL('./preprocess-prompt.md', import.meta.url);

/** Rewrites a JSON file through a temporary file, so a reader never sees half of it. */
function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
}

/**
 * Wires the ears from a service runtime. Nothing runs until start(); tests drive the ticks directly.
 *
 * @param {object} runtime from createServiceRuntime() (agent/services/service-runtime.mjs)
 * @param {object} [deps]  overrides for tests
 * @param {object}   [deps.vertexText]    a client from agent/providers/vertex-text.mjs
 * @param {Function} [deps.getChatToken]  () => Promise<string>, the Workspace token with read scopes
 * @param {Function} [deps.listSpaces]    (token) => Promise<ChatSpace[]>
 * @param {Function} [deps.findDirectMessage] (token, email) => Promise<string|null>
 * @param {object}   [deps.chatStore]     { load, save } for the Chat state
 * @param {string}   [deps.preprocessPrompt]
 * @param {Function} [deps.now]           clock in milliseconds
 * @returns {{tickDashboard: Function, tickChat: Function|null, start: Function, stop: Function, health: object,
 *   chat: object|null}} `chat` is the Chat inbox when the instance has a Workspace account
 */
export function createEars(runtime, deps = {}) {
  const { contracts, instance, log, db, collections } = runtime;
  const cfg = contracts.ears;
  const now = deps.now || Date.now;
  const iso = () => new Date(now()).toISOString();
  const serviceDir = join(runtime.paths.data.root, 'services', 'ears');
  const healthFile = join(serviceDir, 'health.json');

  initChannel({
    firestoreUrl: `${runtime.firestoreHost}/v1/projects/${instance.project}/databases/(default)/documents`,
    collections,
    agentName: instance.agent_name,
    fetch: runtime.fetch,
    now,
  });

  let preprocessPrompt = deps.preprocessPrompt ?? '';
  if (cfg.preprocess?.enabled && deps.preprocessPrompt === undefined) {
    try {
      preprocessPrompt = readFileSync(PREPROCESS_PROMPT, 'utf8');
    } catch (err) {
      log('WARN', 'preprocess is on but its prompt is missing; Chat messages pass through unrepaired', { error: err.message });
    }
  }
  const vertexText = deps.vertexText || createVertexText({
    projectId: instance.project,
    location: contracts.utility.location,
    model: cfg.preprocess?.model,
    timeoutMs: contracts.utility.timeout_ms,
    logger: (level, message) => log(level, message),
    getAccessToken: runtime.getAccessToken,
    fetch: runtime.fetch,
  });
  const preprocess = createPreprocessor({
    enabled: cfg.preprocess?.enabled,
    prompt: preprocessPrompt,
    transform: (text, instruction, opts) => vertexText.transform(text, instruction, opts),
    callOptions: {
      maxTokens: cfg.preprocess?.max_tokens,
      temperature: cfg.preprocess?.temperature,
      disableThinking: contracts.utility.disable_thinking,
    },
    log,
    now,
  });

  const handle = createInboundHandler({
    db,
    collections,
    gate: createInboundGate({ dedupWindowMs: cfg.dedup_window_ms, cooldownMs: cfg.cooldown_ms, now }),
    preprocess,
    log,
    now,
  });
  const dashboard = createDashboardInbox({ db, collections, log });

  let chat = null;
  if (instance.workspace) {
    const getDwdToken = createDwdTokenSource({ fetch: runtime.fetch, getVmAccessToken: runtime.getAccessToken });
    const store = deps.chatStore || createFileStateStore(join(serviceDir, 'chat-state.json'), { log });
    const identity = createChatIdentity({
      readUsers: async () => dashboardUserEmails(await db.query('', collections.users, [],
        { noOrderBy: true, limit: USERS_READ_LIMIT, strict: true })),
      findDirectMessage: deps.findDirectMessage || ((token, email) => findDirectMessage(token, email, { fetch: runtime.fetch })),
      agentAccount: instance.workspace.account,
      people: store.load().people,
      log,
      now,
    });
    chat = createChatInbox({
      getToken: deps.getChatToken || (() => getDwdToken({
        signerServiceAccount: instance.workspace.signer,
        subjectEmail: instance.workspace.account,
        scopes: CHAT_READ_SCOPES,
      })),
      listSpaces: deps.listSpaces || ((token) => listSpaces(token, { fetch: runtime.fetch })),
      identity,
      store,
      appendTurn: (turn) => appendTurn({ db, config: contracts.conversation, log, source: 'backfill', ...turn }),
      agentName: instance.agent_name,
      config: {
        maxPagesPerPoll: cfg.max_pages_per_poll,
        newSpaceSeed: cfg.new_space_seed,
        mentionMatch: cfg.mention_match,
        contextMessages: cfg.gchat_context_messages,
        conversation: contracts.conversation,
      },
      fetch: runtime.fetch,
      log,
      now,
    });
  }

  const health = {
    service: 'ears',
    pid: process.pid,
    started_at: iso(),
    beat_at: null,
    dashboard: { last_poll_at: null, last_ok_at: null, last_error: null, taken_in: 0 },
    gchat: {
      state: chat ? 'connecting' : 'off',
      account: instance.workspace?.account || null,
      last_poll_at: null,
      last_ok_at: null,
      last_error: null,
      spaces: 0,
      direct_messages: 0,
      external_spaces: 0,
      known_users: 0,
      agent_user_id: null,
      rate_limited: false,
      taken_in: 0,
    },
  };

  function beat() {
    health.beat_at = iso();
    try {
      writeJsonFile(healthFile, health);
    } catch (err) {
      log('WARN', 'health file could not be written', { path: healthFile, error: err.message });
    }
  }

  async function takeIn(messages, inbox, channelHealth) {
    for (const msg of messages) {
      const result = await handle(msg, inbox);
      if (result === 'created') channelHealth.taken_in += 1;
    }
  }

  /** One dashboard poll. Returns the delay until the next. */
  async function tickDashboard() {
    health.dashboard.last_poll_at = iso();
    try {
      await takeIn(await dashboard.poll(), dashboard, health.dashboard);
      health.dashboard.last_ok_at = iso();
      health.dashboard.last_error = null;
    } catch (err) {
      health.dashboard.last_error = err.message;
      log('ERROR', 'dashboard poll failed', { error: err.message });
    }
    beat();
    return cfg.firestore_poll_ms;
  }

  // The same Chat failure every few seconds says nothing new: it is logged when it starts or changes.
  let chatError = null;
  let chatRefusals = 0;

  /** One Chat poll, or one attempt to come online. Returns the delay until the next. */
  async function tickChat() {
    if (!chat.ready) {
      if (!(await chat.connect())) {
        const reason = chat.status().tokenError;
        health.gchat.last_error = `waiting for the Workspace token${reason ? `: ${reason}` : ''}`;
        beat();
        return CHAT_RETRY_MS;
      }
      health.gchat.state = 'ready';
    }
    health.gchat.last_poll_at = iso();
    let rateLimited = false;
    let refused = false;
    try {
      await takeIn(await chat.poll(), chat, health.gchat);
      const status = chat.status();
      rateLimited = status.rateLimited;
      if (status.errors === 0 && !rateLimited) {
        health.gchat.last_ok_at = iso();
        health.gchat.last_error = null;
      } else {
        health.gchat.last_error = rateLimited
          ? 'the Chat API quota is spent; reading again in a minute'
          : `${status.errors} space(s) could not be read`;
      }
      if (chatError) log('INFO', 'Chat poll works again', { after: chatError });
      chatError = null;
    } catch (err) {
      rateLimited = err.status === 429;
      refused = err.status === 401 || err.status === 403;
      health.gchat.last_error = err.message;
      if (err.message !== chatError) log('ERROR', 'Chat poll failed', { error: err.message });
      chatError = err.message;
    }
    chatRefusals = refused ? chatRefusals + 1 : 0;
    const status = chat.status();
    Object.assign(health.gchat, {
      spaces: status.spaces,
      direct_messages: status.directMessages,
      external_spaces: status.external,
      known_users: status.knownUsers,
      agent_user_id: status.agentUserId,
      rate_limited: rateLimited,
    });
    beat();
    if (refused) return Math.min(CHAT_RETRY_MS * 2 ** (chatRefusals - 1), CHAT_REFUSED_MAX_MS);
    return rateLimited ? CHAT_RATE_LIMIT_MS : cfg.gchat_poll_ms;
  }

  let running = false;
  const wakers = new Set();
  let loops = [];

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

  /** Starts the poll loops. Resolves when stop() has ended them. */
  async function start() {
    if (running) return;
    running = true;
    log('INFO', 'ears starting', {
      channels: chat ? ['dashboard', 'gchat'] : ['dashboard'],
      preprocess: Boolean(cfg.preprocess?.enabled && preprocessPrompt),
    });
    loops = [loop('dashboard', tickDashboard, cfg.firestore_poll_ms)];
    if (chat) loops.push(loop('gchat', tickChat, CHAT_RETRY_MS));
    await Promise.all(loops);
  }

  async function stop() {
    running = false;
    for (const wake of [...wakers]) wake();
    await Promise.all(loops);
    if (chat) await chat.settle();
  }

  return { tickDashboard, tickChat: chat ? tickChat : null, start, stop, health, chat };
}

async function main() {
  const runtime = createServiceRuntime({ service: 'ears' });
  const ears = createEars(runtime);
  const shutdown = (signal) => {
    runtime.log('INFO', `ears stopping on ${signal}`);
    ears.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await ears.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'ERROR', service: 'ears', message: `ears failed: ${err.message}` })}\n`);
    process.exit(1);
  });
}
