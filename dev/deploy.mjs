#!/usr/bin/env node
// dev/deploy.mjs: moves your dev instance to a pushed branch, a tag or a full commit. It resolves the
// ref to a 40-character commit on GitHub (the instance installs from there, never from your clone) and
// refuses a branch that is not pushed. Then the VM: it runs
// `sudo /opt/paraclete/install/upgrade.sh --ref <commit> --repo <owner>/<name>` on the VM over IAP
// with its output streamed to you, and waits for the Firestore document agent/instance to report
// ready on that commit. Then the dashboard, the way install/install.sh does it and from the same
// definitions (install/lib/dashboard.mjs): Cloud Build builds that commit's image unless the image
// exists, and Cloud Run deploys it, with the service's environment moved to that commit, unless the
// service already runs it. --vm-only and --dashboard-only move one half. The dashboard service must
// exist already: install/install.sh creates it.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_CONFIG_PATH, NAMES, buildArgs, deployArgs, deployedCommit, deployedEnv, describeArgs, envFileText,
  parseService, serviceDrift, tagsArgs,
} from '../install/lib/dashboard.mjs';
import {
  DevError, REPO_ROOT, VM_PATHS, READINESS_DOC, devContext, failureDetail, isMain, pollUntil, runCommand,
} from './dev-env.mjs';

const USAGE = `Usage: node dev/deploy.mjs <branch|tag|commit> [--repo <owner>/<name>] [--vm-only | --dashboard-only] [--timeout <seconds>]
Moves your dev instance to a pushed branch, a tag or a full 40-character commit: the VM through the
upgrader a release upgrade runs (then waits for agent/instance to report ready on that commit), then
the dashboard, built at that commit by Cloud Build and deployed to Cloud Run as the installer does.
  --repo            the public GitHub repository to install from (default: this clone's origin)
  --vm-only         move the VM only
  --dashboard-only  move the dashboard only
  --timeout         seconds to wait for readiness once the upgrader has finished (default 600)`;

const DEFAULT_TIMEOUT_SECONDS = 600;
const POLL_MS = 5_000;
const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** A ref we pass to git: no leading dash (it would read as an option), no spaces, no `..`. */
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/;

function parseArgs(argv) {
  const opts = { ref: null, repo: null, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, help: false, vm: true, dashboard: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new DevError(`${arg} needs a value\n${USAGE}`, 2);
      return argv[i += 1];
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--repo') opts.repo = value();
    else if (arg === '--vm-only') opts.dashboard = false;
    else if (arg === '--dashboard-only') opts.vm = false;
    else if (arg === '--timeout') {
      const raw = value();
      opts.timeoutSeconds = Number(raw);
      if (!/^\d+$/.test(raw) || opts.timeoutSeconds < 1) throw new DevError(`--timeout must be a whole number of seconds, got '${raw}'`, 2);
    } else if (arg.startsWith('-')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
    else if (opts.ref) throw new DevError(`One ref at a time, got '${opts.ref}' and '${arg}'\n${USAGE}`, 2);
    else opts.ref = arg;
  }
  if (!opts.help && !opts.ref) throw new DevError(`Name the branch, tag or commit to deploy.\n${USAGE}`, 2);
  if (!opts.vm && !opts.dashboard) throw new DevError(`--vm-only and --dashboard-only exclude each other.\n${USAGE}`, 2);
  return opts;
}

/**
 * The GitHub `owner/name` a remote URL points at, or null for anything that is not GitHub.
 * Takes https://github.com/o/n(.git), git@github.com:o/n(.git) and ssh://git@github.com/o/n(.git).
 *
 * @param {string} url
 * @returns {string|null}
 */
export function githubRepoFromUrl(url) {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The public URL the VM fetches a repository from. */
export function repoUrl(repo) {
  return `https://github.com/${repo}.git`;
}

/**
 * Picks a ref out of `git ls-remote` output. A branch and a tag of the same name is ambiguous; an
 * annotated tag resolves to the commit it points at (its `^{}` line).
 *
 * @param {string} output `<sha>\t<refname>` lines
 * @param {string} ref    what was asked for: a short name, or a full `refs/...` name
 * @returns {{commit: string, kind: 'branch'|'tag', name: string}|null}
 */
export function pickRemoteRef(output, ref) {
  const refs = new Map();
  for (const line of String(output).split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name && COMMIT.test(sha)) refs.set(name, sha);
  }
  const branchName = ref.startsWith('refs/') ? (ref.startsWith('refs/heads/') ? ref : null) : `refs/heads/${ref}`;
  const tagName = ref.startsWith('refs/') ? (ref.startsWith('refs/tags/') ? ref : null) : `refs/tags/${ref}`;
  const branch = branchName && refs.get(branchName);
  const tag = tagName && (refs.get(`${tagName}^{}`) || refs.get(tagName));
  if (branch && tag) {
    throw new DevError(`'${ref}' is both a branch and a tag; pass refs/heads/${ref} or refs/tags/${ref}`, 2);
  }
  if (branch) return { commit: branch, kind: 'branch', name: branchName.slice('refs/heads/'.length) };
  if (tag) return { commit: tag, kind: 'tag', name: tagName.slice('refs/tags/'.length) };
  return null;
}

/** This clone's origin as `owner/name`, or null when it has none on GitHub. */
async function originRepo(ctx) {
  const result = await ctx.git(['remote', 'get-url', 'origin']);
  return result.code === 0 ? githubRepoFromUrl(result.stdout) : null;
}

/**
 * Resolves what you asked for to the commit the instance will install. A full commit id is taken as
 * it is; a branch or tag is looked up on GitHub, anonymously, as the VM and Cloud Build will fetch it.
 */
async function resolveRef(ctx, ref, repo) {
  if (COMMIT.test(ref.toLowerCase())) return { commit: ref.toLowerCase(), kind: 'commit', name: ref.toLowerCase() };
  if (!REF.test(ref)) throw new DevError(`'${ref}' is not a branch, tag or commit name`, 2);
  const patterns = ref.startsWith('refs/') ? [ref, `${ref}^{}`] : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
  const result = await ctx.git(['-c', 'credential.helper=', 'ls-remote', repoUrl(repo), ...patterns],
    { env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.code !== 0) {
    throw new DevError(`git ls-remote could not read ${repoUrl(repo)}${failureDetail(result)}\n`
      + 'The repository must exist and be public: the VM fetches it without credentials.');
  }
  const found = pickRemoteRef(result.stdout, ref);
  if (found) return found;
  if (/^[0-9a-f]{7,39}$/i.test(ref)) throw new DevError(`'${ref}' looks like a short commit id: pass the full 40-character id`, 2);
  throw new DevError(`'${ref}' is not a branch or tag on ${repo}. Push it first: git push -u origin ${ref}`);
}

/** Warns when your local copy of the branch is not what GitHub has: the instance gets GitHub's. */
async function checkPushed(ctx, resolved) {
  const local = await ctx.git(['rev-parse', '--verify', '--quiet', `refs/heads/${resolved.name}`]);
  const localCommit = local.code === 0 ? local.stdout.trim() : '';
  if (localCommit && localCommit !== resolved.commit) {
    ctx.warn(`warning: your local ${resolved.name} is at ${localCommit.slice(0, 12)}, but GitHub has ${resolved.commit.slice(0, 12)}. `
      + 'Deploying what GitHub has; push first if you meant your local commits.');
  }
}

/**
 * Waits for agent/instance to say the services are up on `commit`. Prints each state it sees once.
 *
 * @returns {Promise<{ok: boolean, doc: object|null}>}
 */
async function waitForReady(ctx, commit, timeoutMs) {
  const db = ctx.db();
  let last = null;
  let lastKey = '';
  const outcome = await pollUntil(async () => {
    const doc = await db.read(READINESS_DOC, { strict: true });
    last = doc;
    const key = doc ? `${doc.status}|${doc.commit}` : 'missing';
    if (key !== lastKey) {
      lastKey = key;
      ctx.out(doc
        ? `${READINESS_DOC}: ${doc.status} on ${String(doc.commit || 'no commit').slice(0, 12)}${doc.error ? `: ${doc.error}` : ''}`
        : `${READINESS_DOC}: not written yet`);
    }
    if (doc?.commit !== commit) return undefined;
    if (doc.status === 'ready') return { ok: true, doc };
    if (doc.status === 'failed') return { ok: false, doc };
    return undefined;
  }, { timeoutMs, intervalMs: POLL_MS, sleep: ctx.sleep, now: ctx.now });
  return outcome.done ? outcome.value : { ok: false, doc: last, timedOut: true };
}

/** Moves the VM: the upgrader over IAP, then the wait for readiness. */
async function deployVm(ctx, { instance, repo, commit, timeoutSeconds }) {
  ctx.out(`Upgrading VM ${instance.VM} in ${instance.PROJECT_ID} to ${commit.slice(0, 12)}; the upgrader's output follows.`);
  const upgrade = await ctx.ssh(`sudo ${VM_PATHS.upgrade} --ref ${commit} --repo ${repo}`, {
    onStdout: (chunk) => ctx.stdout.write(chunk),
    collect: false,
  });
  if (upgrade.code !== 0) {
    throw new DevError(`the upgrade exited with code ${upgrade.code}. The VM may still run its previous commit; `
      + 'read the output above. Re-running dev/deploy is safe.');
  }

  ctx.out(`Waiting up to ${timeoutSeconds} s for ${READINESS_DOC} to report ready on ${commit.slice(0, 12)}.`);
  const ready = await waitForReady(ctx, commit, timeoutSeconds * 1000);
  if (!ready.ok) {
    const why = ready.timedOut ? `did not report ready on ${commit} within ${timeoutSeconds} s` : `reports failed: ${ready.doc?.error || 'no error given'}`;
    throw new DevError(`${READINESS_DOC} ${why}. See node dev/status.mjs and node dev/logs.mjs all.`);
  }
  const release = ready.doc.release ? ` (release ${typeof ready.doc.release === 'object' ? JSON.stringify(ready.doc.release) : ready.doc.release})` : '';
  ctx.out(`Done: the VM runs ${commit} from ${repo}${release}, ready at ${ready.doc.ready_at || 'an unrecorded time'}.`);
}

/**
 * The commit's own dashboard/cloudbuild.yaml (gcloud reads --config from this machine). From your
 * clone when it has the commit; otherwise the working tree's copy, with a warning.
 */
async function buildConfig(ctx, commit) {
  const shown = await ctx.git(['show', `${commit}:${BUILD_CONFIG_PATH}`]);
  if (shown.code === 0 && shown.stdout.trim()) return shown.stdout;
  if (/does not exist in|exists on disk, but not in/.test(shown.stderr || '')) {
    throw new DevError(`${commit} has no ${BUILD_CONFIG_PATH}: it predates the dashboard. Deploy it with --vm-only.`);
  }
  ctx.warn(`warning: this clone does not have ${commit.slice(0, 12)} (git fetch gets it); building with the working tree's ${BUILD_CONFIG_PATH}.`);
  return readFileSync(join(REPO_ROOT, BUILD_CONFIG_PATH), 'utf8');
}

/** Moves the dashboard: the image at the commit unless it exists, then the service unless it runs it. */
async function deployDashboard(ctx, { instance, repo, commit, release }) {
  const where = { project: instance.PROJECT_ID, region: instance.REGION };
  const short = commit.slice(0, 12);
  const stream = { onStdout: (chunk) => ctx.stdout.write(chunk), onStderr: (chunk) => ctx.stderr.write(chunk), collect: false };

  const described = await ctx.gcloud(describeArgs(where));
  if (described.code !== 0) {
    if (/cannot find service|not found/i.test(described.stderr || '')) {
      throw new DevError(`${instance.PROJECT_ID} has no dashboard service ${NAMES.SERVICE_NAME} in ${instance.REGION}. `
        + 'Install it once with install/install.sh --ref <branch> (DEVELOPING.md section 7); dev/deploy moves it from then on.');
    }
    throw new DevError(`could not read the dashboard service ${NAMES.SERVICE_NAME}${failureDetail(described)}`);
  }
  const service = parseService(described.stdout);
  if (!service) throw new DevError(`gcloud described the dashboard service ${NAMES.SERVICE_NAME} in a form this script cannot read`);
  const before = deployedCommit(service);

  const dir = mkdtempSync(join(tmpdir(), 'paraclete-deploy-'));
  try {
    const tags = await ctx.gcloud(tagsArgs(where));
    if (tags.code === 0 && tags.stdout.split(/\r?\n/).map((line) => line.trim()).includes(commit)) {
      ctx.out(`The dashboard's image for ${short} exists; not building it again.`);
    } else {
      const configFile = join(dir, 'cloudbuild.yaml');
      writeFileSync(configFile, await buildConfig(ctx, commit));
      ctx.out(`Building the dashboard at ${short} with Cloud Build; its output follows.`);
      const build = await ctx.gcloud(buildArgs({ ...where, repo, commit, configFile }), stream);
      if (build.code !== 0) {
        throw new DevError(`the dashboard's build exited with code ${build.code}; read its output above. `
          + `The dashboard still runs ${before || 'what it ran'}.`);
      }
    }

    const env = { ...deployedEnv(service), PARACLETE_REPO: repo, PARACLETE_RELEASE: release, PARACLETE_COMMIT: commit };
    const drift = serviceDrift(service, { ...where, commit, env });
    if (drift.length) {
      const envFile = join(dir, 'dashboard-env.yaml');
      writeFileSync(envFile, envFileText(env));
      ctx.out(`Deploying the dashboard at ${short} (changing: ${drift.join(', ')}); Cloud Run's output follows.`);
      const deploy = await ctx.gcloud(deployArgs({ ...where, commit, envFile }), stream);
      if (deploy.code !== 0) {
        throw new DevError(`the dashboard's deploy exited with code ${deploy.code}; read its output above. `
          + `It still runs ${before || 'what it ran'}; re-running dev/deploy is safe.`);
      }
    } else {
      ctx.out(`The dashboard already runs ${short}.`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  ctx.out(`Done: the dashboard runs ${commit} from ${repo}, at ${service.status?.url || 'its Cloud Run URL'}.`);
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('deploy', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    const instance = ctx.instance();

    const origin = await originRepo(ctx);
    const repo = opts.repo || origin;
    if (!repo) throw new DevError("This clone's origin is not a GitHub repository; pass --repo <owner>/<name>.", 2);
    if (!REPO.test(repo)) throw new DevError(`--repo must be <owner>/<name> on GitHub, got '${repo}'`, 2);

    const resolved = await resolveRef(ctx, opts.ref, repo);
    ctx.out(`${opts.ref} on ${repo} is ${resolved.commit} (${resolved.kind}).`);
    if (resolved.kind === 'branch' && repo === origin) await checkPushed(ctx, resolved);

    if (opts.vm) await deployVm(ctx, { instance, repo, commit: resolved.commit, timeoutSeconds: opts.timeoutSeconds });
    else ctx.out('The VM stays as it is (--dashboard-only).');
    if (opts.dashboard) await deployDashboard(ctx, { instance, repo, commit: resolved.commit, release: resolved.name });
    else ctx.out('The dashboard stays as it is (--vm-only); node dev/status.mjs shows whether the two still match.');
    return 0;
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
