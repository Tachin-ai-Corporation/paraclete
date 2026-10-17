// agent/work/artifacts.mjs: mission working trees and artifact publishing. Each mission works in
// its own git working tree, <installRoot>/shared/<missionId>, on the branch mission/<missionId> of
// its project's repository in the git artifact store. Checkpoints commit and push that branch;
// publish() merges it into the default branch and records a manifest of what changed. It keeps the
// agent's scratch out of every commit. It does not decide when a mission publishes or which project
// it belongs to: the brain service does, and calls this.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COLLECTIONS } from '../storage/collections.mjs';
import { firestoreEncode } from '../storage/firestore.mjs';
import { allocateVersion, sanitizeRepoId } from '../storage/git-store.mjs';

/** Marker for the managed block in a mission tree's local git excludes. */
const WORKSPACE_EXCLUDE_MARKER = '# --- paraclete: mission scratch (inputs + bookkeeping, never artifacts) ---';

/** At most this many changed files are exported as dashboard downloads per mission. */
const MAX_EXPORT_FILES = 20;

/** A mission id becomes a directory name and a branch name, so it is one plain path segment. */
const MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Renders the managed block of a mission working tree's local git excludes (`.git/info/exclude`),
 * merged onto whatever is already there. Pure.
 *
 * It ignores three kinds of file that are never artifacts:
 * - source material downloaded to be read, not produced: office documents, archives and, by default,
 *   images, since a downloaded scan is an input that would bloat every future clone. For a project
 *   whose own images are the deliverable (opts.keepAssets, e.g. a website) the image globs are left
 *   out so its images commit; archives and office documents stay excluded regardless;
 * - mission bookkeeping the brain writes into the tree (MISSION.md and missions/), plus tool caches
 *   and merge leftovers (.firebase/, node_modules/, *.orig, *.rej);
 * - the agent's own identity and memory files and the shared tree, so even a mis-targeted
 *   `git add -A` can never commit them into a project.
 *
 * Bookkeeping and identity paths are root-anchored, so a project's own nested paths with the same
 * names stay committable. Idempotent: if the block is already present, the input comes back unchanged
 * with changed=false.
 *
 * @param {string} [existing] - current exclude-file contents
 * @param {{keepAssets?: boolean}} [opts]
 * @returns {{ content: string, changed: boolean }}
 */
export function renderWorkspaceExcludes(existing = '', opts = {}) {
  if (existing.includes(WORKSPACE_EXCLUDE_MARKER)) return { content: existing, changed: false };
  const mediaLines = opts.keepAssets === true
    ? ['# Project with committed assets: its images are deliverable source, so image globs are',
      '# intentionally not excluded here.']
    : ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp'];
  const block = [
    WORKSPACE_EXCLUDE_MARKER,
    '# Downloaded to be read: publish deliverables through the artifact store; do not commit raw',
    '# source material.',
    '*.pdf', '*.docx', '*.xlsx', '*.pptx',
    ...mediaLines,
    '*.zip', '*.gz', '*.tar',
    '# Tool caches, dependency trees and merge leftovers: never a project artifact. Matched at any',
    '# depth, so a stray add -A cannot commit a deploy cache or node_modules.',
    '.firebase/',
    'node_modules/',
    '*.orig', '*.rej',
    '# Mission bookkeeping the brain writes into the tree. Root-anchored so a project\'s own nested',
    '# paths stay safe.',
    '/MISSION.md',
    '/missions/',
    '# The agent\'s identity and memory files and the shared tree, so a mis-targeted add -A can',
    '# never put them into a project artifact. Root-anchored.',
    '/IDENTITY.md',
    '/MEMORY.md',
    '/SOUL.md',
    '/SOUL.base.md',
    '/SOUL_APPEND.md',
    '/shared',
    '# --- end paraclete block ---',
    '',
  ].join('\n');
  const content = existing ? `${existing.replace(/\n*$/, '\n')}\n${block}` : block;
  return { content, changed: true };
}

/**
 * Whether a project's own images are committable artifacts rather than downloaded scratch. An
 * explicit `commit_assets` flag wins; otherwise a web or site project commits them.
 *
 * @param {object} [project]
 * @returns {boolean}
 */
export function resolveCommitAssets(project) {
  if (project?.commit_assets === true) return true;
  if (project?.commit_assets === false) return false;
  const cls = project?.class || project?.type;
  return cls === 'web' || cls === 'website' || cls === 'site';
}

// Entries of the motor's persistent workspace (<installRoot>/workspace, the motor's tool working
// directory) that survive between missions: identity and working memory, live runtime state,
// skills the agent wrote, and the link to the mission trees. Everything else there is one mission's
// scratch. Left in place, a later mission that deploys "the current directory" ships the previous
// mission's files. Symlinks are always kept and never followed, so `shared` is untouched.
const MOTOR_WORKSPACE_KEEP = new Set([
  'SOUL.md', 'SOUL.base.md', 'SOUL_APPEND.md', 'IDENTITY.md', 'MEMORY.md', 'CLASSIFIED_MEMORY.md',
  'TASK.json', 'config.json', 'progress.json', 'sessions.json',
  'custom-skills', 'shared',
]);

/**
 * Decides which top-level entries of the motor's persistent workspace to delete: every entry that is
 * neither in the keep set nor a symlink. Pure.
 *
 * @param {Array<{name: string, isSymlink: boolean}>} entries
 * @returns {string[]}
 */
export function motorWorkspaceSweepPlan(entries) {
  return (entries || [])
    .filter((e) => e && e.name && !e.isSymlink && !MOTOR_WORKSPACE_KEEP.has(e.name))
    .map((e) => e.name);
}

/**
 * Clears one mission's scratch out of the motor's persistent workspace. Best effort and idempotent:
 * a clean workspace sweeps to a no-op, and a failure is logged, never thrown.
 *
 * @param {string} installRoot - e.g. /opt/paraclete
 * @param {Function} [log] - (level, message)
 * @returns {Promise<{removed: string[]}>}
 */
export async function sweepMotorWorkspace(installRoot, log = () => {}) {
  if (!installRoot) throw new Error('sweepMotorWorkspace: installRoot is required');
  try {
    const dir = join(installRoot, 'workspace');
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return { removed: [] }; // no persistent workspace, nothing to sweep
    }
    const toRemove = motorWorkspaceSweepPlan(dirents.map((d) => ({ name: d.name, isSymlink: d.isSymbolicLink() })));
    for (const name of toRemove) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
      } catch (e) {
        log('WARN', `sweepMotorWorkspace: could not remove ${name}: ${e.message}`);
      }
    }
    if (toRemove.length) {
      log('INFO', `Swept motor workspace: removed ${toRemove.length} stale scratch entr${toRemove.length === 1 ? 'y' : 'ies'} (kept identity, runtime state and symlinks)`);
    }
    return { removed: toRemove };
  } catch (e) {
    log('WARN', `sweepMotorWorkspace failed (non-fatal): ${e.message}`);
    return { removed: [] };
  }
}

function git(args, cwd, timeout = 10_000) {
  return execFileSync('git', args, { cwd, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Creates the artifact manager the brain uses for mission working trees.
 *
 * @param {object}   deps
 * @param {object}   deps.gitStore      a git store from createGitStore()
 * @param {object}   deps.db            a Firestore client from createClient(); records a project's latest manifest
 * @param {Function} deps.getProjects   () => live map of project id to project
 * @param {object}   [deps.fileStore]   a file store from createFileStore(); without it, nothing is exported for download
 * @param {Function} [deps.logger]      (level, message)
 * @param {object}   deps.config
 * @param {string}   deps.config.installRoot  e.g. /opt/paraclete
 * @param {{name: string, email: string}} deps.config.author  identity on the agent's commits
 * @returns {{initWorkspace: Function, cleanupWorkspace: Function, commitAndSync: Function,
 *   publish: Function, resolveMergePolicy: Function}}
 */
export function createArtifactManager(deps) {
  const { gitStore, db, getProjects, fileStore, config } = deps;
  if (!gitStore) throw new Error('createArtifactManager: gitStore is required');
  if (!db) throw new Error('createArtifactManager: db is required');
  if (typeof getProjects !== 'function') throw new Error('createArtifactManager: getProjects is required');
  if (!config?.installRoot) throw new Error('createArtifactManager: config.installRoot is required');
  if (!config.author?.name || !config.author?.email) {
    throw new Error('createArtifactManager: config.author { name, email } is required');
  }
  const { installRoot, author } = config;
  const mainBranch = gitStore.defaultBranch;
  const log = deps.logger || ((level, msg) => console.log(`[artifacts] ${level}: ${msg}`));

  /** A mission's working tree. Refuses an id that is not one plain path segment. */
  function missionDir(envelopeId) {
    if (!MISSION_ID_RE.test(String(envelopeId || ''))) throw new Error(`Invalid mission id: "${envelopeId}"`);
    return join(installRoot, 'shared', envelopeId);
  }

  /**
   * Picks the merge policy for a project: its own setting wins, code projects are gated, and
   * everything else merges automatically.
   *
   * @param {object} [project]
   * @returns {'auto'|'gated'}
   */
  function resolveMergePolicy(project) {
    if (project?.merge_policy) return project.merge_policy;
    if (project?.class === 'code' || project?.type === 'code') return 'gated';
    return 'auto';
  }

  /**
   * Seeds the mission tree's local git excludes so scratch never enters the project repo. The rules
   * go into `.git/info/exclude`, not a tracked `.gitignore`, so they are never committed and the
   * merged diff carries only the real change. Idempotent.
   */
  function ensureWorkspaceExcludes(sharedDir, opts = {}) {
    try {
      const infoDir = join(sharedDir, '.git', 'info');
      mkdirSync(infoDir, { recursive: true });
      const path = join(infoDir, 'exclude');
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
      const { content, changed } = renderWorkspaceExcludes(existing, opts);
      if (changed) writeFileSync(path, content);
    } catch (e) {
      log('WARN', `Could not seed workspace git excludes in ${sharedDir}: ${e.message}`);
    }
  }

  /**
   * Prepares a mission's working tree: sweeps the motor workspace, creates the tree, and, when the
   * mission has a project, clones the project's default branch and checks out mission/<id>. A git
   * failure is not fatal: it marks `envelope.context.git_status` as degraded, and publish() then
   * skips git.
   *
   * @param {string} envelopeId
   * @param {{projectId?: string, envelope?: object}} [opts]
   */
  async function initWorkspace(envelopeId, opts = {}) {
    await sweepMotorWorkspace(installRoot, log);
    let sharedDir;
    try {
      sharedDir = missionDir(envelopeId);
      mkdirSync(sharedDir, { recursive: true });
    } catch (e) {
      log('WARN', `Failed to init shared workspace for ${envelopeId}: ${e.message}`);
      return;
    }

    const projectId = opts.projectId;
    if (!projectId) return;
    try {
      const repoId = sanitizeRepoId(projectId);
      const project = getProjects()[projectId];
      await gitStore.ensureRepo(repoId, { mergePolicy: resolveMergePolicy(project) });
      const branch = `mission/${envelopeId}`;
      const ref = await gitStore.readRef(repoId, mainBranch);
      await gitStore.cloneRepo(repoId, mainBranch, sharedDir);
      try {
        git(['checkout', '-b', branch], sharedDir, 5000);
      } catch {
        try { git(['checkout', branch], sharedDir, 5000); } catch { /* resuming on the branch already */ }
      }
      ensureWorkspaceExcludes(sharedDir, { keepAssets: resolveCommitAssets(project) });
      log('INFO', `Git workspace initialized: repo=${repoId} branch=${branch} base=${ref?.sha?.slice(0, 8) || 'empty'}`);
    } catch (e) {
      log('WARN', `Git workspace init failed (non-fatal): ${e.message}`);
      const env = opts.envelope;
      if (env) {
        env.context = env.context || {};
        env.context.git_status = `degraded: ${e.message.slice(0, 100)}`;
      }
    }
  }

  /**
   * Removes a mission's working tree after the mission ends.
   *
   * @param {string} envelopeId
   */
  async function cleanupWorkspace(envelopeId) {
    try {
      rmSync(missionDir(envelopeId), { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      log('WARN', `Failed to cleanup shared workspace for ${envelopeId}: ${e.message}`);
    }
  }

  /**
   * Commits the mission tree's changes and pushes the mission branch. The brain calls it after each
   * checkpoint.
   *
   * @param {string} envelopeId - mission id
   * @param {string} projectId  - project id (sanitized to a repo id)
   * @param {string} message    - commit message, `vYYYY.MM.DD.N.M: ...`
   * @returns {Promise<{committed: boolean, synced: boolean, sha: string|null, unborn?: boolean}>}
   */
  async function commitAndSync(envelopeId, projectId, message) {
    const nothing = { committed: false, synced: false, sha: null };
    if (!projectId) return nothing;
    try {
      const repoId = sanitizeRepoId(projectId);
      const sharedDir = missionDir(envelopeId);
      const branch = `mission/${envelopeId}`;

      // The tree must be its own repository. Asking git from a plain directory would find an
      // enclosing repository (a checkout the tree sits inside) and commit the mission there.
      if (!existsSync(join(sharedDir, '.git'))) return nothing;

      git(['add', '-A'], sharedDir);
      const status = git(['status', '--porcelain'], sharedDir);
      if (!status) {
        log('DEBUG', `commitAndSync: nothing new to stage for ${envelopeId}`);
        let head = '';
        try { head = git(['rev-parse', '--verify', '-q', 'HEAD'], sharedDir); } catch { /* unborn */ }
        if (!head) return { committed: false, synced: true, sha: null, unborn: true };
        // A commit the motor made itself leaves nothing to stage, but it has not necessarily reached
        // the store. Returning without a push leaves the mission branch behind, and the final merge
        // finds nothing to land. Push the existing HEAD.
        const pushResult = await gitStore.pushWithRetry(repoId, branch, sharedDir, author.name);
        const synced = pushResult.status === 'pushed' || pushResult.status === 'up_to_date';
        if (synced) log('INFO', `commitAndSync: pushed pre-existing commit ${head.slice(0, 8)} on ${branch} (${pushResult.status})`);
        else log('WARN', `commitAndSync: push of pre-existing commit ${head.slice(0, 8)} failed (${pushResult.status})`);
        return { committed: false, synced, sha: head };
      }

      // Argument lists, never a shell: the message comes from the mission goal and can carry
      // backticks, $, quotes or newlines.
      git(['config', 'user.name', author.name], sharedDir);
      git(['config', 'user.email', author.email], sharedDir);
      git(['commit', '-m', message], sharedDir);
      const sha = git(['rev-parse', 'HEAD'], sharedDir);
      log('INFO', `commitAndSync: committed ${sha.slice(0, 8)} on ${branch}`);

      const pushResult = await gitStore.pushWithRetry(repoId, branch, sharedDir, author.name);
      if (pushResult.status === 'pushed' || pushResult.status === 'up_to_date') {
        log('INFO', `commitAndSync: synced ${branch} (${pushResult.status}, ${pushResult.attempts} attempts)`);
        return { committed: true, synced: true, sha };
      }
      log('WARN', `commitAndSync: sync failed (${pushResult.status})`);
      return { committed: true, synced: false, sha };
    } catch (e) {
      log('WARN', `commitAndSync failed: ${e.message}`);
      return nothing;
    }
  }

  /** The files that differ between two commits of the default branch, or every file if there is no base. */
  async function changedPathsBetween(repoId, before, after) {
    const tmp = mkdtempSync(join(tmpdir(), 'artifacts-diff-'));
    try {
      await gitStore.cloneRepo(repoId, mainBranch, tmp);
      const args = before
        ? ['diff', '--name-only', `${before}..${after}`]
        : ['ls-tree', '-r', '--name-only', after];
      return git(args, tmp).split('\n').filter(Boolean);
    } finally {
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  }

  /**
   * Publishes a finished mission's artifacts: commits what is left, merges mission/<id> into the
   * default branch under the project's merge policy, and records a manifest of the changed files on
   * the envelope (`context.artifacts`) and the project (`context.artifacts`). A gated merge is parked
   * in `context.pending_merge`; a failed one is recorded in `context.merge_failed`. For a mission
   * that came from the dashboard, the changed files are also exported as downloads
   * (`context.attachments_export`).
   *
   * @param {object} envelope - the mission envelope (type 'M'); its context is updated in place
   * @returns {Promise<object|null>} the artifact manifest, or null when nothing was published
   */
  async function publish(envelope) {
    if (!envelope || envelope.type !== 'M') return null;
    if (!envelope.project_id) return null;
    if (envelope.context?.git_status?.startsWith('degraded')) {
      log('WARN', `publish: skipping degraded workspace (${envelope.context.git_status})`);
      return null;
    }

    try {
      const sharedDir = missionDir(envelope.id);
      const repoId = sanitizeRepoId(envelope.project_id);
      const branch = `mission/${envelope.id}`;

      const d = new Date();
      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '.');
      const versionIndex = envelope.context?.git_version_index || allocateVersion(sharedDir, mainBranch, d) || 1;
      const nextStep = (envelope.context?.git_checkpoint_count || 0) + 1;
      const title = (envelope.title || 'mission complete').slice(0, 80);
      const commitResult = await commitAndSync(envelope.id, envelope.project_id, `v${dateStr}.${versionIndex}.${nextStep}: ${title}`);
      if (!commitResult.sha) {
        log('DEBUG', 'publish: no changes to publish');
        return null;
      }

      const mainBefore = (await gitStore.readRef(repoId, mainBranch))?.sha || null;
      const projects = getProjects();
      const project = projects[envelope.project_id];
      const mergeResult = await gitStore.mergeBranch(repoId, branch, mainBranch, resolveMergePolicy(project), author.name);

      if (mergeResult.status === 'AWAITING_APPROVAL') {
        log('INFO', `Git: merge ${branch} -> ${mainBranch} requires approval (gated policy)`);
        envelope.context = envelope.context || {};
        envelope.context.pending_merge = {
          repoId,
          sourceBranch: branch,
          targetBranch: mainBranch,
          missionSha: commitResult.sha,
          mainBefore,
          parkedAt: new Date().toISOString(),
        };
        return null;
      }
      if (mergeResult.status !== 'merged') {
        const conflicts = mergeResult.conflicts || [];
        log('WARN', `Git: merge ${branch} -> ${mainBranch} returned ${mergeResult.status}`
          + (conflicts.length ? `; conflicting files: ${conflicts.join(', ')}` : '')
          + ' (the mission work is committed on its branch but NOT merged)');
        // Recorded on the envelope so the failure is visible and queryable, not swallowed.
        envelope.context = envelope.context || {};
        envelope.context.merge_failed = {
          status: mergeResult.status,
          reason: mergeResult.reason || null,
          conflicts,
          branch,
          at: new Date().toISOString(),
        };
        return null;
      }
      log('INFO', `Git: merged ${branch} -> ${mainBranch} (sha: ${mergeResult.sha?.slice(0, 8)})`);

      let changedPaths;
      try {
        changedPaths = await changedPathsBetween(repoId, mainBefore, mergeResult.sha);
      } catch (e) {
        log('WARN', `Changed-path computation failed, using empty list: ${e.message}`);
        changedPaths = [];
      }
      const gitManifest = await gitStore.buildManifest(repoId, mainBranch, changedPaths, { summary: title });

      if (fileStore && envelope.source_channel === 'dashboard' && changedPaths.length > 0) {
        try {
          if (changedPaths.length > MAX_EXPORT_FILES) {
            log('WARN', `Attachment export capped at ${MAX_EXPORT_FILES} of ${changedPaths.length} changed files`);
          }
          const exportPaths = changedPaths.slice(0, MAX_EXPORT_FILES).map((p) => join(sharedDir, p));
          const attachments = await fileStore.uploadOutgoing(envelope.id, exportPaths);
          if (attachments.length > 0) {
            envelope.context = envelope.context || {};
            envelope.context.attachments_export = attachments;
            log('INFO', `Uploaded ${attachments.length} attachment(s) for dashboard delivery`);
          }
        } catch (e) {
          log('WARN', `Dashboard attachments upload failed: ${e.message}`);
        }
      }

      envelope.context = envelope.context || {};
      envelope.context.artifacts = gitManifest;

      if (project) {
        project.context = project.context || {};
        project.context.artifacts = gitManifest;
        projects[envelope.project_id] = project;
        try {
          const updated = await db.patch(`${COLLECTIONS.projects}/${envelope.project_id}`, ['context'], {
            context: { mapValue: { fields: firestoreEncode(project.context) } },
          });
          if (!updated) log('WARN', `Failed to update project artifacts context for ${envelope.project_id}`);
        } catch (e) {
          log('WARN', `Failed to update project artifacts context: ${e.message}`);
        }
      }

      log('INFO', `Published git artifacts for mission ${envelope.id} (${changedPaths.length} changed files)`);
      return gitManifest;
    } catch (e) {
      log('WARN', `publish failed: ${e.message}`);
      return null;
    }
  }

  return { initWorkspace, cleanupWorkspace, commitAndSync, publish, resolveMergePolicy };
}
