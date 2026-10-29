// dev/harness2/model-runs.mjs: what a real-model run (`--real-model`) needs to measure a harness change.
// In such a run every organ's turn goes to the real model, through the product's own gateway, started
// in-process from one side of the comparison: the baseline, or a candidate. That way the prompts,
// playbooks and contracts the model sees are that side's, and a change shows in the result. The
// scripted in-process gateway (live-runner.mjs) gives every side the same answers, and a `--gateway-url`
// gateway reads its own installed prompts, so neither measures a change (evidence.mjs refuses both).
//
// Here:
// - modelAccess: the Google Cloud project and the access token the model calls use;
// - createSideRoots: one install root per side, as /opt/paraclete is on an instance: the files the
//   install manifest lists, copied from a worktree of HEAD that is removed at once, with the side's file
//   patches written in, so the brain and the gateway read that side's files, and nothing an instance
//   lacks (tests, the harness and its benchmark, history) is within its agent's reach; `prepareRole`
//   gives a root the command launchers of the role a rollout runs (install/vm/launchers.mjs, as an
//   install does);
// - startModelGateway: the gateway (agent/services/gateway/main.mjs buildGateway) for one rollout,
//   on loopback, against the side's checkout and the rollout's data directory;
// - usageFromLog: the brain's per-turn token telemetry line, as a usage record;
// - createSpendMeter and estimateRollouts: the cap on one run's model rollouts and tokens;
// - createModelRunContext: all of the above for one run, shared by its rollouts.
//
// It runs no rollout and scores nothing: live-runner.mjs `runInProcessBrainRollout` does, with the
// tasks of model-suite.mjs. Called by live-runner.mjs and cli.mjs.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelClients } from '../../agent/gateway/model-clients.mjs';
import { buildGateway } from '../../agent/services/gateway/main.mjs';
import { dataPaths, loadInstance } from '../../config/instance.mjs';
import { writeLaunchers } from '../../install/vm/launchers.mjs';
import { resolveVertexAccessToken } from './judge.mjs';
import { classifySurfacePath } from './surface.mjs';

/** The default cap on one run: model rollouts, and tokens across them (input plus output). */
export const DEFAULT_SPEND_LIMITS = Object.freeze({ maxRollouts: 120, maxTokens: 30_000_000 });

/** Links each side's checkout gets to the repo's installed packages, so skill commands still import. */
const LINKED_PACKAGES = Object.freeze(['agent/node_modules']);

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function instanceProject() {
  try {
    return loadInstance().project || null;
  } catch {
    return null;
  }
}

/**
 * The project and token the model calls use: GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT, else the VM's
 * instance.json; the token from the metadata server, else `gcloud auth print-access-token`. A token is
 * fetched for each rollout, so a long run outlives any one token.
 *
 * @param {object} [o]
 * @param {object} [o.env]
 * @param {Function} [o.projectFromInstance]  () => string|null
 * @param {Function} [o.getAccessToken]       () => Promise<string>
 * @returns {{ project: string, getAccessToken: () => Promise<string> }}
 */
export function modelAccess({ env = process.env, projectFromInstance = instanceProject, getAccessToken } = {}) {
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || projectFromInstance();
  if (!project) {
    throw new Error('a real-model run needs a Google Cloud project: set GOOGLE_CLOUD_PROJECT, or run on an instance VM');
  }
  return { project, getAccessToken: getAccessToken || (() => resolveVertexAccessToken()) };
}

/**
 * One checkout per side of a comparison. A side is the repository at one commit (HEAD when the first
 * side is made, unless `commit` names one) with its file patches (repo path -> full text) written over
 * it; the baseline has none. Every path must be on the mutable surface,
 * since a side differs from HEAD only where a harness change may. Sides with the same patches share a
 * checkout. `cleanupAll` removes every checkout this made, and its links first.
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {Function} [o.execGit]   (args, cwd) => stdout
 * @param {string} [o.tmpRoot]
 * @param {string} [o.commit]      the commit every side is cut from; default HEAD, resolved once
 * @returns {{ forPatches: (filePatches?: object) => { root: string, key: string }, prepareRole: Function, cleanupAll: () => void, commit: () => string, roots: () => string[] }}
 */
/**
 * The repo paths an instance installs, from a checkout's install/manifest.txt: each line a path, a
 * trailing / a directory. `roles/<role>/` lines become all of roles/, since one side serves every role
 * its rollouts run. Throws when the checkout has no manifest.
 *
 * @param {string} root  a checkout
 * @returns {string[]}
 */
export function installedPaths(root) {
  const file = path.join(root, 'install', 'manifest.txt');
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: a side is built from the install manifest`);
  const paths = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    paths.add(line.startsWith('roles/') ? 'roles/' : line);
  }
  return [...paths];
}

export function createSideRoots({ repoRoot, execGit = defaultExecGit, tmpRoot = os.tmpdir(), commit } = {}) {
  if (!repoRoot) throw new Error('createSideRoots: repoRoot is required');
  const made = new Map();
  // Every side of one run is cut from one commit, resolved once: a checkout that moves during a long
  // run must not put the baseline and a candidate on different commits.
  let pinned = commit || null;
  const base = () => {
    if (!pinned) pinned = execGit(['rev-parse', 'HEAD'], repoRoot);
    return pinned;
  };

  function forPatches(filePatches = {}) {
    const entries = Object.entries(filePatches || {})
      .map(([rel, text]) => [String(rel).replace(/\\/g, '/'), String(text)])
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [rel] of entries) {
      if (!classifySurfacePath(rel).allowed) throw new Error(`a side may differ from HEAD only on the mutable surface; ${rel} is not on it`);
    }
    const key = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
    if (made.has(key)) return made.get(key);

    // The commit is checked out beside the root, and only what an instance installs is copied in; the
    // checkout goes at once, so neither it nor its history is left within the agent's reach.
    const root = fs.mkdtempSync(path.join(tmpRoot, `paraclete-h2-side-${key}-`));
    const source = fs.mkdtempSync(path.join(tmpRoot, `paraclete-h2-src-${key}-`));
    try {
      execGit(['worktree', 'add', '--detach', '--quiet', source, base()], repoRoot);
      for (const rel of installedPaths(source)) {
        const from = path.join(source, rel);
        if (!fs.existsSync(from)) continue;
        const to = path.join(root, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true });
      }
    } finally {
      try {
        execGit(['worktree', 'remove', '--force', source], repoRoot);
      } catch {
        // removed below
      }
      fs.rmSync(source, { recursive: true, force: true });
    }
    const links = [];
    for (const rel of LINKED_PACKAGES) {
      const target = path.join(repoRoot, rel);
      const link = path.join(root, rel);
      if (fs.existsSync(target) && !fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        links.push(link);
      }
    }
    for (const [rel, text] of entries) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
    }
    const side = { root, key, links, role: null };
    made.set(key, side);
    return side;
  }

  /**
   * The checkout's bin/ holds the launchers of `role`'s commands, so the motor runs them by name as on
   * an instance. A launcher names a POSIX path, so a checkout elsewhere (a Windows temp directory) gets
   * none, and says why.
   *
   * @returns {{ role: string, launchers: number, problem: string|null }}
   */
  function prepareRole(side, role) {
    if (side.role === role) return { role, launchers: side.launchers ?? 0, problem: side.launcherProblem ?? null };
    fs.rmSync(path.join(side.root, 'bin'), { recursive: true, force: true });
    side.role = role;
    try {
      side.launchers = writeLaunchers({ root: side.root, installRoot: side.root, role }).length;
      side.launcherProblem = null;
    } catch (err) {
      side.launchers = 0;
      side.launcherProblem = err.message;
    }
    return { role, launchers: side.launchers, problem: side.launcherProblem };
  }

  function cleanupAll() {
    for (const side of made.values()) {
      // A link goes first: removing the checkout must never reach through it into the repo's packages.
      for (const link of side.links) {
        try {
          fs.unlinkSync(link);
        } catch {
          try {
            fs.rmdirSync(link);
          } catch {
            // already gone
          }
        }
      }
      fs.rmSync(side.root, { recursive: true, force: true });
    }
    made.clear();
    try {
      execGit(['worktree', 'prune'], repoRoot);
    } catch {
      // nothing to prune
    }
  }

  return { forPatches, prepareRole, cleanupAll, commit: base, roots: () => [...made.values()].map((s) => s.root) };
}

/**
 * The product's gateway for one rollout: built by the gateway service's own buildGateway against the
 * side's checkout (its prompts, skills and role) and the rollout's data directory, with a fresh token,
 * listening on a free loopback port. Claude stays off: the rollout's Firestore has no admin settings.
 *
 * @param {object} o
 * @param {string} o.sideRoot
 * @param {string} o.role
 * @param {object} o.contracts      the side's contracts
 * @param {string} o.dataRoot       the rollout's data directory
 * @param {object} o.db             the rollout's Firestore client
 * @param {string} o.project
 * @param {string} [o.accessToken]  a fixed token for the model clients (off the VM)
 * @param {object} [o.env]          the environment the agent's commands start from
 * @param {Function} [o.createClients]
 * @param {Function} [o.log]
 * @returns {Promise<{ url: string, token: string, stop: () => Promise<void> }>}
 */
export async function startModelGateway({
  sideRoot, role, contracts, dataRoot, db, project, accessToken, env, createClients = createModelClients, log = () => {},
}) {
  const token = randomBytes(24).toString('hex');
  const tokenFile = path.join(dataRoot, 'gateway-token');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const instance = {
    project,
    region: 'us-central1',
    zone: 'us-central1-a',
    agent_name: 'Paraclete',
    role,
    install_root: sideRoot,
    data_root: dataRoot,
    bucket: null,
    workspace: null,
    endpoints: {},
    gateway_token_file: tokenFile,
  };
  const runtime = {
    service: 'gateway',
    contracts,
    instance,
    log,
    db,
    paths: {
      installRoot: sideRoot,
      prompts: path.join(sideRoot, 'prompts'),
      skills: path.join(sideRoot, 'skills'),
      roles: path.join(sideRoot, 'roles'),
      genericRole: path.join(sideRoot, 'roles', 'generic'),
      role: path.join(sideRoot, 'roles', role),
      data: dataPaths(instance),
    },
  };
  const gateway = await buildGateway(runtime, {
    createClients: (o) => createClients({ ...o, ...(accessToken ? { accessToken } : {}) }),
    ...(env ? { env } : {}),
  });
  const { port } = await gateway.listen({ port: 0, host: '127.0.0.1' });
  return { url: `http://127.0.0.1:${port}`, token, stop: () => gateway.close() };
}

const USAGE_LINE = /\[TELEMETRY\] llm_usage mission=\S+ organ=(\S+) input=(\d+) output=(\d+) cached=(\d+)/;
const UTILITY_LINE = /TELEMETRY utility_usage(?: stage=\S+)? model=\S+ input=(\d+) output=(\d+) cached=(\d+)/;

/**
 * The usage record in one brain log line, in the shape trajectory.mjs reads, or null for any other
 * line: an organ turn's (`[TELEMETRY] llm_usage ...`, agent/services/brain/main.mjs) or the utility
 * model's (`TELEMETRY utility_usage ...`, agent/providers/vertex-text.mjs).
 *
 * @param {string} message
 * @returns {object|null}
 */
export function usageFromLog(message) {
  const text = String(message || '');
  const organTurn = USAGE_LINE.exec(text);
  const utility = organTurn ? null : UTILITY_LINE.exec(text);
  const m = organTurn || (utility && [utility[0], 'utility', utility[1], utility[2], utility[3]]);
  if (!m) return null;
  const [input, output, cached] = [m[2], m[3], m[4]].map(Number);
  return {
    organ: m[1],
    prompt_tokens: input,
    completion_tokens: output,
    promptTokenCount: input,
    candidatesTokenCount: output,
    cachedContentTokenCount: cached,
    totalTokenCount: input + output,
  };
}

/** Thrown when a run would pass its cap. Nothing measured after it counts, so the run stops. */
export class SpendCapReached extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpendCapReached';
  }
}

/**
 * The cap on one run's spend: model rollouts, and tokens across them. Both are checked before each
 * rollout: `startRollout` throws SpendCapReached once the run has made `maxRollouts` rollouts or spent
 * `maxTokens`, so a rollout already running may pass the token cap by what it spends. Tokens are the
 * brain's own count (input plus output); a model's thinking tokens, which it does not report, are not
 * in it.
 *
 * @param {object} [limits]  DEFAULT_SPEND_LIMITS, or others
 * @returns {{ startRollout: () => void, addTokens: (n: number) => void, summary: () => object }}
 */
export function createSpendMeter(limits = {}) {
  const maxRollouts = Number.isFinite(Number(limits.maxRollouts)) && Number(limits.maxRollouts) > 0
    ? Math.floor(Number(limits.maxRollouts)) : DEFAULT_SPEND_LIMITS.maxRollouts;
  const maxTokens = Number.isFinite(Number(limits.maxTokens)) && Number(limits.maxTokens) > 0
    ? Math.floor(Number(limits.maxTokens)) : DEFAULT_SPEND_LIMITS.maxTokens;
  let rollouts = 0;
  let tokens = 0;
  return {
    startRollout() {
      if (rollouts >= maxRollouts) throw new SpendCapReached(`the run reached its cap of ${maxRollouts} model rollouts (--max-rollouts)`);
      if (tokens >= maxTokens) throw new SpendCapReached(`the run reached its cap of ${maxTokens} tokens (--max-tokens)`);
      rollouts += 1;
    },
    addTokens(n) {
      tokens += Math.max(0, Number(n) || 0);
    },
    summary() {
      return { rollouts, tokens, maxRollouts, maxTokens };
    },
  };
}

/** How long one real mission may run before its workspace is checked as it stands. */
export const DEFAULT_ROLLOUT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Everything one real-model run shares across its rollouts: the model access, the side checkouts,
 * the spend meter, the gateway starter and the rollout timeout. `cleanup` removes the checkouts; the
 * run's owner (cli.mjs) calls it once, when the run ends.
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {object} [o.access]         modelAccess()'s result; default modelAccess()
 * @param {object} [o.limits]         DEFAULT_SPEND_LIMITS, or others
 * @param {object} [o.sides]          createSideRoots()'s result; default one for repoRoot
 * @param {Function} [o.startGateway] startModelGateway, or a fake in tests
 * @param {number} [o.timeoutMs]
 * @returns {{ access: object, sides: object, meter: object, startGateway: Function, timeoutMs: number, cleanup: () => void }}
 */
export function createModelRunContext({
  repoRoot, access, limits = {}, sides, startGateway = startModelGateway, timeoutMs = DEFAULT_ROLLOUT_TIMEOUT_MS,
} = {}) {
  const ctx = {
    access: access || modelAccess(),
    sides: sides || createSideRoots({ repoRoot }),
    meter: createSpendMeter(limits),
    startGateway,
    timeoutMs,
  };
  ctx.cleanup = () => ctx.sides.cleanupAll();
  return ctx;
}

/**
 * At most how many model rollouts a run makes: every task, every trial, on each baseline evaluation
 * (a promotion evaluates the baseline twice: its own, and the evolution's), each candidate and, when
 * the measurement is calibrated, its known-bad change (calibration.mjs; its A/A check reuses the two
 * baselines).
 *
 * @param {object} o
 * @param {number} o.tasks
 * @param {number} o.trials
 * @param {number} o.candidates
 * @param {number} [o.baselines]
 * @param {boolean} [o.calibration]
 * @returns {number}
 */
export function estimateRollouts({ tasks, trials, candidates, baselines = 1, calibration = false }) {
  return Math.max(0, tasks) * Math.max(1, trials) * (Math.max(1, baselines) + Math.max(0, candidates) + (calibration ? 1 : 0));
}
