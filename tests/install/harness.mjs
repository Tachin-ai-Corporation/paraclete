// tests/install/harness.mjs: runs install/install.sh and install/uninstall.sh against fake-cloud.mjs.
// Each sandbox is a temporary copy of the files the scripts read (install/, config/contracts.json and
// every roles/*/role.json, plus a Workspace role fixture) with gcloud, git and curl shims first on
// PATH, and a state file describing the project. Also parses the "+ <command>" lines a run prints.
// Used by the tests in tests/install/. Needs bash; on a machine without it, the tests skip.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fakeCloud = fileURLToPath(new URL('./fake-cloud.mjs', import.meta.url));

/** bash on PATH, else Git for Windows' bash, else null. */
function findBash() {
  const candidates = ['bash'];
  if (process.platform === 'win32') candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidates.find((candidate) => spawnSync(candidate, ['-c', 'exit 0']).status === 0) || null;
}

export const bash = findBash();
/** The `skip` option for every test here: a reason when there is no bash, else false. */
export const needsBash = bash ? false : 'bash is not available on this machine';

/** A path the shell and node both accept: forward slashes on Windows. */
const portable = (path) => path.replace(/\\/g, '/');

export const PROJECT = 'your-gcp-project';
export const REPO = 'your-org/paraclete';
export const REMOTE_URL = `https://github.com/${REPO}.git`;

/** Commits in the fake remote. RELEASE_TAG is annotated: its tag object differs from its commit. */
export const COMMITS = {
  main: '1111111111111111111111111111111111111111',
  devBranch: '2222222222222222222222222222222222222222',
  olderRelease: '3333333333333333333333333333333333333333',
  releaseTagObject: '4444444444444444444444444444444444444444',
  release: '5555555555555555555555555555555555555555',
};
export const RELEASE_TAG = 'v2026.10.17.5.1';
export const OLDER_TAG = 'v2026.10.17.4.1';

export const LISTING = [
  'ref: refs/heads/main\tHEAD',
  `${COMMITS.main}\tHEAD`,
  `${COMMITS.devBranch}\trefs/heads/dev-branch`,
  `${COMMITS.main}\trefs/heads/main`,
  `${COMMITS.olderRelease}\trefs/tags/${OLDER_TAG}`,
  `${COMMITS.releaseTagObject}\trefs/tags/${RELEASE_TAG}`,
  `${COMMITS.release}\trefs/tags/${RELEASE_TAG}^{}`,
].join('\n');

/** A project inside an organization, with billing, the caller an owner, and nothing installed. */
export function freshProject() {
  return {
    configProject: PROJECT,
    project: PROJECT,
    projectNumber: '123456789012',
    account: 'owner@example.com',
    ancestors: ['project', 'organization'],
    billingEnabled: true,
    deniedPermissions: [],
    gitRemote: REMOTE_URL,
    remotes: { [REMOTE_URL]: LISTING },
    rawFiles: Object.values(COMMITS).flatMap((commit) => [
      `${REPO}/${commit}/install/bootstrap.sh`,
      `${REPO}/${commit}/dashboard/cloudbuild.yaml`,
    ]),
    services: [],
    accounts: [],
    accountPolicies: {},
    projectPolicy: [['roles/owner', 'user:owner@example.com']],
    database: null,
    indexes: [],
    ttls: [],
    buckets: {},
    runServices: {},
    imageRepositories: [],
    repositoryPolicies: {},
    images: {},
    builds: [],
    iapAgent: false,
    iapPolicies: {},
    users: {},
    modelAnswers: ['ok'],
    networks: { default: { mode: 'auto', description: 'Default network for the project' } },
    firewallRules: {},
    instances: {},
    bootstrapReports: 'ready',
    agentInstance: null,
  };
}

/** A role fixture flagged workspace, which the repo doesn't have yet (build plan phase 8). */
export const WORKSPACE_ROLE = {
  id: 'workspace-example',
  title: 'Workspace example',
  summary: 'A test role with a Workspace account.',
  version: 1,
  workspace: true,
  skills: [],
  gcp_roles: ['roles/aiplatform.user', 'roles/example.viewer'],
  setup: { apt: [], pip: [], npm: [] },
};

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * A copy of the repo's install inputs with fake tools and the given project state.
 * @param {object} [state] - fake-cloud state; freshProject() when omitted
 */
export function createSandbox(state = freshProject()) {
  const dir = mkdtempSync(join(tmpdir(), 'paraclete-install-'));
  sandboxes.push(dir);
  const repo = join(dir, 'repo');
  for (const path of ['install/install.sh', 'install/uninstall.sh', 'install/lib', 'install/firestore.indexes.json', 'config/contracts.json']) {
    cpSync(join(repoRoot, path), join(repo, path), { recursive: true });
  }
  for (const role of readdirSync(join(repoRoot, 'roles'))) {
    const file = join(repoRoot, 'roles', role, 'role.json');
    if (existsSync(file)) cpSync(file, join(repo, 'roles', role, 'role.json'));
  }
  mkdirSync(join(repo, 'roles', WORKSPACE_ROLE.id), { recursive: true });
  writeFileSync(join(repo, 'roles', WORKSPACE_ROLE.id, 'role.json'), JSON.stringify(WORKSPACE_ROLE, null, 2));

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of ['gcloud', 'git', 'curl']) {
    const shim = join(bin, tool);
    writeFileSync(shim, `#!/bin/sh\nexec "${portable(process.execPath)}" "${portable(fakeCloud)}" ${tool} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const work = join(dir, 'tmp');
  mkdirSync(work);
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'calls.jsonl');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(logPath, '');

  const readCalls = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

  return {
    repo,
    /** The project's state now. */
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    /** Changes the project's state before the next run. */
    update(change) {
      const next = JSON.parse(readFileSync(statePath, 'utf8'));
      change(next);
      writeFileSync(statePath, JSON.stringify(next, null, 2));
    },
    /**
     * Runs install/<script> with args; input is what the user types, env adds to the environment.
     * Resolves to the exit status, the output, the "+" commands it printed and the fake tool calls it
     * made. Asynchronous, so the tests of one file can run side by side.
     */
    async run(script, args = [], { input = '', env = {} } = {}) {
      const before = readCalls().length;
      const child = spawn(bash, [portable(join(repo, 'install', script)), ...args], {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          FAKE_CLOUD_STATE: statePath,
          FAKE_CLOUD_LOG: logPath,
          TMPDIR: portable(work),
          ...env,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.stdin.end(input);
      const status = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      return { status, stdout, stderr, commands: plannedCommands(stdout), calls: readCalls().slice(before) };
    },
  };
}

/**
 * Runs a bash snippet with words available as "${words[@]}". The words travel in environment
 * variables, not as arguments: Git for Windows re-parses a command line, which would eat quotes and
 * backslashes in them.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function bashWith(snippet, words = [], { input = '', env = {} } = {}) {
  const wordEnv = Object.fromEntries(words.map((word, i) => [`TEST_WORD_${i}`, word]));
  const collect = `words=(); for ((i = 0; i < ${words.length}; i++)); do name="TEST_WORD_$i"; words+=("\${!name}"); done`;
  return spawnSync(bash, ['-c', `set -euo pipefail; ${collect}; ${snippet}`], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env, ...wordEnv },
  });
}

/**
 * Sources install/lib/<name>.sh for each name, then runs one of their functions with args. For the
 * library's pure functions. REPO_ROOT points at the repo, as the scripts set it.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function callLib(libs, fn, args = [], { input = '' } = {}) {
  const sources = libs.map((name) => `source "${portable(join(repoRoot, 'install', 'lib', `${name}.sh`))}"`).join('; ');
  return bashWith(`${sources}; ${fn} "\${words[@]}"`, args, { input, env: { REPO_ROOT: portable(repoRoot) } });
}

/** The words of a line printed by shell_quote: bare words, and single-quoted words with '\'' inside. */
export function shellWords(line) {
  const words = [];
  let word = null;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === "'") quoted = false;
      else word += c;
    } else if (c === "'") {
      quoted = true;
      word ??= '';
    } else if (c === '\\') {
      word = (word ?? '') + line[(i += 1)];
    } else if (c === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** Every "+ <command>" line of a run's output, as argument arrays. */
export function plannedCommands(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('+ ')).map((line) => shellWords(line.slice(2)));
}

/** The value of --name=value in a command's arguments, or undefined. */
export function flag(command, name) {
  const prefix = `--${name}=`;
  return command.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** Commands whose first words are the given ones, e.g. find(commands, 'gcloud', 'services', 'enable'). */
export function find(commands, ...words) {
  return commands.filter((command) => words.every((word, i) => command[i] === word));
}

/** The numbered progress lines of a run, as [number, name] pairs. */
export function steps(stdout) {
  return [...stdout.matchAll(/^\[(\d+)\/\d+\] ([a-z]+):/gm)].map((m) => [Number(m[1]), m[2]]);
}
