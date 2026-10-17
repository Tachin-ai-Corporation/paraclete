#!/usr/bin/env node
// agent/cli/git-store.mjs: the git-store command, the agent's way to move a project's artifact
// repository between the store (bundles in the bucket, refs in Firestore) and a working tree. Each
// subcommand calls one function of agent/storage/git-store.mjs, which holds every rule (objects
// before refs, compare-and-swap refs); this file only reads arguments and configuration. It prints
// one JSON result on stdout, logs to stderr with a [git-store] prefix, and exits 1 on any error.

import { pathToFileURL } from 'node:url';
import { createGitStore, createRemoteStore } from '../storage/git-store.mjs';
import { createCliRuntime } from './cli-runtime.mjs';

const USAGE = `Usage: git-store <command> [args...]

Commands:
  ensure <repoId> [--merge-policy auto|gated]       create the repository record if it is missing
  clone <repoId> [--ref <branch>] [--dir <path>]     clone a branch into a directory (default ./<repoId>)
  fetch <repoId> [branch] [gitDir]                  fetch a branch into a working tree
  push <repoId> [branch] [gitDir] [actor]           push HEAD to a branch, rebasing and retrying if it moved
  merge <repoId> <source> [target] [policy] [actor] merge a branch into another (policy auto or gated)
  gc <repoId> [branch]                              consolidate a branch's bundles into one
  manifest <repoId> [branch] [paths...]             list files on a branch with their blob hashes and sizes
  read-ref <repoId> [branch]                        the commit and bundles a branch points to
  list-refs <repoId>                                every branch and its commit

branch and target default to the default branch, gitDir to the current directory, actor to the
agent's name. Prints JSON on stdout; logs go to stderr.`;

/**
 * A git store wired from the contracts and the instance record: the instance's bucket and project,
 * the contracts' prefix, default branch and retry count, the instance's endpoints, and the agent's
 * identity as the author of merge commits.
 *
 * @param {object} runtime - from createCliRuntime()
 * @param {{logger?: Function, store?: object}} [opts] - store: a bundle and ref backend (tests)
 */
export function gitStoreFromRuntime(runtime, { logger, store } = {}) {
  const { contracts, instance } = runtime;
  return createGitStore({
    config: {
      bucket: instance.bucket,
      gcpProject: instance.project,
      prefix: contracts.git.prefix,
      defaultBranch: contracts.git.default_branch,
      maxPushRetries: contracts.git.max_push_retries,
    },
    store: store || createRemoteStore({
      getAccessToken: runtime.getAccessToken,
      fetch: runtime.fetch,
      firestoreHost: runtime.firestoreHost,
      storageHost: runtime.storageHost,
    }),
    author: runtime.identity,
    logger,
  });
}

const isFlag = (value) => typeof value === 'string' && value.startsWith('--');

/** The value after a flag, or undefined when the flag is absent. A flag with no value is an error. */
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || isFlag(value)) throw new Error(`${flag} needs a value`);
  return value;
}

const COMMANDS = {
  async ensure(args, { store }) {
    const repoId = args[0];
    if (!repoId || isFlag(repoId)) throw new Error('Usage: ensure <repoId> [--merge-policy auto|gated]');
    const policy = flagValue(args, '--merge-policy') || 'auto';
    if (policy !== 'auto' && policy !== 'gated') throw new Error(`--merge-policy must be auto or gated, got '${policy}'`);
    return store.ensureRepo(repoId, { mergePolicy: policy });
  },

  async clone(args, { store }) {
    const repoId = args[0];
    if (!repoId || isFlag(repoId)) throw new Error('Usage: clone <repoId> [--ref <branch>] [--dir <path>]');
    // Flags first. The positional forms (clone <repo> [<branch>] [<dir>]) still work, but a token
    // starting with '--' is never a positional value: reading it as one once made
    // `clone <repo> --dir X` clone a branch named "--dir".
    const posBranch = args[1] && !isFlag(args[1]) ? args[1] : null;
    const posDir = posBranch && args[2] && !isFlag(args[2]) ? args[2] : null;
    const branch = flagValue(args, '--ref') || posBranch || store.defaultBranch;
    const dir = flagValue(args, '--dir') || posDir || `./${repoId}`;
    return store.cloneRepo(repoId, branch, dir);
  },

  async fetch(args, { store }) {
    const [repoId, branch = store.defaultBranch, gitDir = '.'] = args;
    if (!repoId) throw new Error('Usage: fetch <repoId> [branch] [gitDir]');
    return store.fetchBranch(repoId, branch, gitDir);
  },

  async push(args, { store, actor }) {
    const [repoId, branch = store.defaultBranch, gitDir = '.', who = actor] = args;
    if (!repoId) throw new Error('Usage: push <repoId> [branch] [gitDir] [actor]');
    return store.pushWithRetry(repoId, branch, gitDir, who);
  },

  async merge(args, { store, actor }) {
    const [repoId, source, target = store.defaultBranch, policy = 'auto', who = actor] = args;
    if (!repoId || !source) throw new Error('Usage: merge <repoId> <source> [target] [policy] [actor]');
    if (policy !== 'auto' && policy !== 'gated') throw new Error(`policy must be auto or gated, got '${policy}'`);
    return store.mergeBranch(repoId, source, target, policy, who);
  },

  async gc(args, { store }) {
    const [repoId, branch = store.defaultBranch] = args;
    if (!repoId) throw new Error('Usage: gc <repoId> [branch]');
    return store.gc(repoId, branch);
  },

  async manifest(args, { store }) {
    const [repoId, branch = store.defaultBranch, ...paths] = args;
    if (!repoId) throw new Error('Usage: manifest <repoId> [branch] [paths...]');
    return store.buildManifest(repoId, branch, paths);
  },

  async 'read-ref'(args, { store }) {
    const [repoId, branch = store.defaultBranch] = args;
    if (!repoId) throw new Error('Usage: read-ref <repoId> [branch]');
    const ref = await store.readRef(repoId, branch);
    return ref || { sha: null, bundle_keys: [] };
  },

  async 'list-refs'(args, { store }) {
    const [repoId] = args;
    if (!repoId) throw new Error('Usage: list-refs <repoId>');
    return store.listRefs(repoId);
  },
};

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {object} [deps.runtime]  from createCliRuntime() (built on demand)
 * @param {object} [deps.gitStore] a store with the createGitStore() interface (tests)
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const [cmd, ...args] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  if (!handler) {
    stderr.write(`[git-store] Unknown command: ${cmd}\n[git-store] Available: ${Object.keys(COMMANDS).join(', ')}\n`);
    return 1;
  }

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const logger = (...parts) => stderr.write(`[git-store] ${parts.join(' ')}\n`);
    const store = deps.gitStore || gitStoreFromRuntime(runtime, { logger });
    const result = await handler(args, { store, actor: runtime.identity.name });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (e) {
    stderr.write(`[git-store] ERROR: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
