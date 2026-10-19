// agent/services/gateway/main.mjs: the gateway service's entry point. It reads the contracts, the
// instance record, the gateway token and the admin's Claude switch and Claude model, builds the model
// clients, organs, tools and sessions from agent/gateway/, and listens on loopback. It runs no turns
// itself; the server in agent/gateway/server.mjs does. systemd starts it (paraclete-gateway.service);
// the control service restarts it when an admin turns Claude on or off, which is when the switch is
// read again.

import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServiceRuntime, readAdminSettings, skillDirectories } from '../service-runtime.mjs';
import { createModelClients } from '../../gateway/model-clients.mjs';
import { createOrganRegistry } from '../../gateway/organs.mjs';
import { createToolRegistry } from '../../gateway/tools.mjs';
import { createSessionStore } from '../../gateway/sessions.mjs';
import { buildSkillCatalog } from '../../gateway/skill-catalog.mjs';
import { createGatewayServer } from '../../gateway/server.mjs';
import { isClaudeEnabled, claudeModel, organModels, gatewaySettings, toolLimits, sessionLimits, memoryPolicy } from './settings.mjs';

/** The exit code for a configuration the service cannot start with (sysexits EX_CONFIG). */
export const EXIT_CONFIG = 78;

/**
 * The bearer token every model and session request must carry. A missing or empty token file is a
 * broken install, and a broken install must not start: binding to loopback is not an authorization
 * decision, since every process on the VM is a local caller.
 *
 * @param {string}   path     the instance's gateway_token_file
 * @param {Function} readText (path) => string
 * @returns {string}
 */
export function readGatewayToken(path, readText) {
  let token;
  try {
    token = String(readText(path)).trim();
  } catch (err) {
    throw configError(`cannot read the gateway token at ${path} (${err.code || err.message}); refusing to serve an unauthenticated gateway`);
  }
  if (!token) throw configError(`the gateway token file ${path} is empty; refusing to serve an unauthenticated gateway`);
  return token;
}

/**
 * Builds the gateway from a service runtime, without listening.
 *
 * The admin's Claude switch is read strictly: a Firestore failure stops startup (systemd starts the
 * service again) rather than guessing which models the admin chose. No settings document means
 * Claude is off. With Claude on, a stored Claude model the contracts do not list is logged once, here
 * at startup, and the contracts' Claude model runs instead (claudeModel() in settings.mjs).
 *
 * @param {object}   runtime                from createServiceRuntime({ service: 'gateway' })
 * @param {object}   [deps]                 injectable for tests
 * @param {Function} [deps.readText]        (path) => string; reads the token file
 * @param {Function} [deps.createClients]   createModelClients or a fake of its shape
 * @param {Function} [deps.ensureDir]       (path) => void; creates a data directory if it is missing
 * @param {object}   [deps.env]             the environment the agent's commands start from
 * @returns {Promise<{server: import('node:http').Server, claudeEnabled: boolean, models: object,
 *   settings: object, skillCatalog: string, listen: Function, close: Function}>}
 */
export async function buildGateway(runtime, deps = {}) {
  const {
    readText = (path) => readFileSync(path, 'utf8'),
    createClients = createModelClients,
    ensureDir = (path) => mkdirSync(path, { recursive: true }),
    env = process.env,
  } = deps;
  const { contracts, instance, paths, log, db } = runtime;

  const token = readGatewayToken(instance.gateway_token_file, readText);
  const adminSettings = await readAdminSettings(db, { strict: true });
  const claudeEnabled = isClaudeEnabled(adminSettings);
  const claude = claudeModel(contracts.vertex.models, adminSettings);
  if (claudeEnabled && claude.ignored !== null) {
    log('WARN', `the stored Claude model ${JSON.stringify(claude.ignored)} is not one of the contracts' claude_candidates; running ${claude.model} instead`,
      { claude_model_ignored: claude.ignored });
  }
  const models = organModels(contracts.vertex.models, { claudeEnabled, claude: claude.model });

  const clients = createClients({
    project: instance.project,
    googleLocation: contracts.vertex.location,
    ...(claudeEnabled ? { anthropicLocation: contracts.vertex.anthropic_location } : {}),
    logger: log,
  });
  const organs = createOrganRegistry({
    models,
    maxSteps: contracts.organs.max_steps,
    promptsDir: paths.prompts,
    rolePromptsDir: join(paths.role, 'prompts'),
  });

  // The motor organ's commands run in the workspace, and the memory organ's in the memory directory.
  // A missing one would fail every command with a spawn error that names neither.
  ensureDir(paths.data.workspace);
  ensureDir(paths.data.memory);
  const skillDirs = skillDirectories(paths);
  // Child commands start from this service's own environment and fetch their own access token from
  // the metadata server when they need one: a token handed down in a variable could expire while a
  // long command still runs.
  const tools = createToolRegistry({
    workspaceDir: paths.data.workspace,
    writableRoots: [paths.data.root],
    skillDirs,
    binDir: join(paths.installRoot, 'bin'),
    env,
    limits: toolLimits(contracts.tools),
    memory: memoryPolicy(paths, contracts.memory),
    logger: log,
  });

  const settings = gatewaySettings(contracts);
  // The instance record says whether there is a Workspace account: without one, the Workspace skills
  // stay out of the catalog.
  const skillCatalog = buildSkillCatalog(skillDirs, { instance });
  const server = createGatewayServer({
    token,
    clients,
    organs,
    tools,
    settings,
    sessions: createSessionStore(sessionLimits(contracts)),
    skillCatalog,
    logger: log,
  });
  log('INFO', `models: claude ${claudeEnabled ? 'on' : 'off'}; cortex=${models.cortex} strong=${models.strong} fast=${models.fast} fallback=${models.fallback}`,
    { claude_enabled: claudeEnabled, models });

  return {
    server,
    claudeEnabled,
    models,
    settings,
    skillCatalog,
    /**
     * Listens on the contracts' loopback address and port.
     * @param {{port?: number, host?: string}} [at] overrides, for tests
     * @returns {Promise<{address: string, port: number}>}
     */
    listen({ port = contracts.gateway.port, host = contracts.gateway.bind } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    /**
     * Stops accepting requests, drops idle connections, and resolves once every request in flight
     * has been answered.
     * @returns {Promise<void>}
     */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}

/**
 * Starts the gateway: runtime, build, listen, and a clean close on SIGTERM or SIGINT.
 *
 * @param {object}   [deps]
 * @param {Function} [deps.createRuntime] createServiceRuntime or a fake
 * @param {object}   [deps.processRef]    the process whose signals stop the service
 * @returns {Promise<object>} the running gateway
 */
export async function main({ createRuntime = createServiceRuntime, processRef = process, ...deps } = {}) {
  const runtime = createRuntime({ service: 'gateway' });
  const gateway = await buildGateway(runtime, deps);
  const { address, port } = await gateway.listen();
  runtime.log('INFO', `listening on ${address}:${port}`);

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    runtime.log('INFO', `${signal}: no new requests; closing once the requests in flight are answered`);
    gateway.close().then(() => processRef.exit(0));
  };
  processRef.once('SIGTERM', () => stop('SIGTERM'));
  processRef.once('SIGINT', () => stop('SIGINT'));
  return gateway;
}

function configError(message) {
  const err = new Error(message);
  err.exitCode = EXIT_CONFIG;
  return err;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'ERROR', service: 'gateway', message: `cannot start: ${err.message}` })}\n`);
    process.exit(err.exitCode || 1);
  });
}
