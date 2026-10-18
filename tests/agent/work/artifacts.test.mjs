// Tests for agent/work/artifacts.mjs. The pure parts run on their own; the artifact manager runs
// the real git binary against an in-memory git store.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createArtifactManager,
  motorWorkspaceSweepPlan,
  renderWorkspaceExcludes,
  resolveCommitAssets,
  sweepMotorWorkspace,
} from '../../../agent/work/artifacts.mjs';
import { createGitStore } from '../../../agent/storage/git-store.mjs';
import { firestoreDecode } from '../../../agent/storage/firestore.mjs';
import {
  commitFile,
  git,
  initWorkingTree,
  isolatedGit,
  memoryStore,
  TEST_AUTHOR,
  TEST_CONFIG,
} from '../storage/git-fixtures.mjs';

const env = isolatedGit('artifacts-test');
after(() => env.cleanup());
const lines = (content) => content.split('\n');

describe('renderWorkspaceExcludes', () => {
  test('emits the managed block on an empty exclude file', () => {
    const { content, changed } = renderWorkspaceExcludes('');
    assert.equal(changed, true);
    assert.match(content, /paraclete: mission scratch/);
  });

  test('ignores mission bookkeeping, root-anchored so nested project paths stay safe', () => {
    const { content } = renderWorkspaceExcludes('');
    assert.match(content, /^\/MISSION\.md$/m);
    assert.match(content, /^\/missions\/$/m);
  });

  test("ignores the agent's identity and memory files and the shared tree", () => {
    const { content } = renderWorkspaceExcludes('');
    for (const pattern of ['/IDENTITY.md', '/MEMORY.md', '/SOUL.md', '/SOUL.base.md', '/SOUL_APPEND.md', '/shared']) {
      assert.ok(lines(content).includes(pattern), `expected ${pattern} in excludes`);
    }
  });

  test('ignores downloaded source material by default', () => {
    const { content } = renderWorkspaceExcludes('');
    for (const pattern of ['*.pdf', '*.docx', '*.png', '*.zip']) {
      assert.ok(lines(content).includes(pattern), `expected ${pattern} in excludes`);
    }
  });

  test('ignores tool caches, dependency trees and merge leftovers, with or without keepAssets', () => {
    for (const opts of [{}, { keepAssets: true }]) {
      const { content } = renderWorkspaceExcludes('', opts);
      for (const pattern of ['.firebase/', 'node_modules/', '*.orig', '*.rej']) {
        assert.ok(lines(content).includes(pattern), `expected ${pattern} in excludes (${JSON.stringify(opts)})`);
      }
    }
  });

  test('is idempotent: a second pass adds nothing', () => {
    const first = renderWorkspaceExcludes('').content;
    const second = renderWorkspaceExcludes(first);
    assert.equal(second.changed, false);
    assert.equal(second.content, first);
  });

  test("appends onto git's default exclude preamble without clobbering it", () => {
    const gitDefault = "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n";
    const { content, changed } = renderWorkspaceExcludes(gitDefault);
    assert.equal(changed, true);
    assert.ok(content.startsWith(gitDefault), 'preserves the existing preamble');
    assert.match(content, /^\/missions\/$/m);
    assert.equal(renderWorkspaceExcludes(content).changed, false);
  });

  test("preserves a project's own exclude rules", () => {
    const { content } = renderWorkspaceExcludes('# project rules\nnode_modules/\ndist/\n');
    assert.match(content, /dist\//);
    assert.match(content, /^\/missions\/$/m);
  });
});

describe('renderWorkspaceExcludes for a project with committed assets (keepAssets)', () => {
  // A website's own images are its deliverable; excluding them shipped an HTML-only site.
  const IMAGE_GLOBS = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp'];

  test('does not exclude image globs', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    for (const pattern of IMAGE_GLOBS) assert.ok(!lines(content).includes(pattern), `${pattern} must not be excluded`);
  });

  test('still excludes archives and office documents', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    for (const pattern of ['*.pdf', '*.docx', '*.xlsx', '*.pptx', '*.zip', '*.gz', '*.tar']) {
      assert.ok(lines(content).includes(pattern), `expected ${pattern} still excluded`);
    }
  });

  test('still excludes bookkeeping and identity files', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    for (const pattern of ['/MISSION.md', '/missions/', '/IDENTITY.md', '/SOUL.md', '/shared']) {
      assert.ok(lines(content).includes(pattern), `expected ${pattern} still excluded`);
    }
  });

  test('is idempotent too', () => {
    const first = renderWorkspaceExcludes('', { keepAssets: true }).content;
    assert.equal(renderWorkspaceExcludes(first, { keepAssets: true }).changed, false);
  });
});

describe('resolveCommitAssets', () => {
  test('is false for a plain or missing project', () => {
    assert.equal(resolveCommitAssets(undefined), false);
    assert.equal(resolveCommitAssets({}), false);
    assert.equal(resolveCommitAssets({ class: 'code' }), false);
  });

  test('is true for a web, website or site project', () => {
    assert.equal(resolveCommitAssets({ class: 'web' }), true);
    assert.equal(resolveCommitAssets({ type: 'website' }), true);
    assert.equal(resolveCommitAssets({ class: 'site' }), true);
  });

  test('honours an explicit commit_assets flag over the class', () => {
    assert.equal(resolveCommitAssets({ commit_assets: true, class: 'code' }), true);
    assert.equal(resolveCommitAssets({ commit_assets: false, class: 'web' }), false);
  });
});

describe('motorWorkspaceSweepPlan', () => {
  // Scratch left in the motor's working directory shipped with a later mission's deploy.
  const dirent = (name, isSymlink = false) => ({ name, isSymlink });
  const KEEP = ['SOUL.md', 'SOUL.base.md', 'IDENTITY.md', 'MEMORY.md', 'TASK.json', 'config.json',
    'progress.json', 'sessions.json', 'CLASSIFIED_MEMORY.md', 'custom-skills'];

  test('removes scratch but keeps identity, working memory and runtime state', () => {
    const scratch = ['index.html', 'node_modules', '.git', 'report.md', 'site-repo', 'hosting_public'];
    const removed = motorWorkspaceSweepPlan([...KEEP, ...scratch].map((name) => dirent(name))).sort();
    assert.deepEqual(removed, [...scratch].sort());
  });

  test('never sweeps SOUL.base.md', () => {
    assert.deepEqual(motorWorkspaceSweepPlan([dirent('SOUL.base.md')]), []);
  });

  test('never removes a symlink, including the shared link to mission trees', () => {
    const removed = motorWorkspaceSweepPlan([dirent('shared', true), dirent('index.html'), dirent('weird-link', true)]);
    assert.deepEqual(removed, ['index.html']);
  });

  test('is a no-op on a clean workspace and on empty input', () => {
    assert.deepEqual(motorWorkspaceSweepPlan([]), []);
    assert.deepEqual(motorWorkspaceSweepPlan([dirent('SOUL.md'), dirent('MEMORY.md'), dirent('shared', true)]), []);
  });
});

test('sweepMotorWorkspace removes scratch from the motor workspace and keeps the rest', async () => {
  const dataRoot = env.newDir('sweep');
  const workspace = join(dataRoot, 'workspace');
  mkdirSync(join(workspace, 'old-site'), { recursive: true });
  writeFileSync(join(workspace, 'MEMORY.md'), 'memory');
  writeFileSync(join(workspace, 'stray.txt'), 'scratch');
  const { removed } = await sweepMotorWorkspace(workspace);
  assert.deepEqual(removed.sort(), ['old-site', 'stray.txt']);
  assert.ok(existsSync(join(workspace, 'MEMORY.md')));
  assert.deepEqual(await sweepMotorWorkspace(join(env.newDir('no-workspace'), 'workspace')), { removed: [] });
  await assert.rejects(sweepMotorWorkspace(), /workspaceDir is required/);
});

/** An artifact manager over an in-memory git store, a recording db and a recording file store. */
function harness({ projects = {}, fileStore = true } = {}) {
  const store = memoryStore();
  const gitStore = createGitStore({ config: TEST_CONFIG, store, author: TEST_AUTHOR, logger: () => {} });
  const patches = [];
  const writes = [];
  const db = {
    async patch(path, mask, fields) { patches.push({ path, mask, fields }); return {}; },
    async write(path, data) { writes.push({ path, data }); return {}; },
  };
  const uploads = [];
  const files = {
    async uploadOutgoing(missionId, paths) {
      uploads.push({ missionId, paths });
      return paths.map((p) => {
        const name = p.split(/[\\/]/).pop();
        return { name, size: 1, gcsPath: `files/out/${missionId}/${name}`, contentType: 'text/plain', sha256: 'c'.repeat(64) };
      });
    },
  };
  const dataRoot = env.newDir('data');
  const logs = [];
  const manager = createArtifactManager({
    gitStore,
    db,
    getProjects: () => projects,
    fileStore: fileStore ? files : undefined,
    logger: (level, msg) => logs.push(`${level} ${msg}`),
    config: { missionsRoot: join(dataRoot, 'missions'), workspaceDir: join(dataRoot, 'workspace'), author: TEST_AUTHOR },
  });
  return { manager, gitStore, store, patches, writes, uploads, dataRoot, logs };
}

describe('createArtifactManager', () => {
  test('requires a git store, a db, a project source, the data directories and an author', () => {
    const dirs = { missionsRoot: '/var/lib/paraclete/missions', workspaceDir: '/var/lib/paraclete/workspace' };
    const base = { gitStore: {}, db: {}, getProjects: () => ({}), config: { ...dirs, author: TEST_AUTHOR } };
    assert.throws(() => createArtifactManager({ ...base, gitStore: undefined }), /gitStore is required/);
    assert.throws(() => createArtifactManager({ ...base, db: undefined }), /db is required/);
    assert.throws(() => createArtifactManager({ ...base, getProjects: undefined }), /getProjects is required/);
    assert.throws(() => createArtifactManager({ ...base, config: { author: TEST_AUTHOR } }), /missionsRoot is required/);
    assert.throws(() => createArtifactManager({ ...base, config: { missionsRoot: '/x', author: TEST_AUTHOR } }), /workspaceDir is required/);
    assert.throws(() => createArtifactManager({ ...base, config: { ...dirs, author: { name: 'n' } } }), /author/);
  });

  test('resolveMergePolicy: the project setting wins, code projects are gated, the rest auto', () => {
    const { manager } = harness();
    assert.equal(manager.resolveMergePolicy({ merge_policy: 'auto', class: 'code' }), 'auto');
    assert.equal(manager.resolveMergePolicy({ class: 'code' }), 'gated');
    assert.equal(manager.resolveMergePolicy({ type: 'code' }), 'gated');
    assert.equal(manager.resolveMergePolicy(undefined), 'auto');
  });

  test('a mission works on its own branch, commits per checkpoint, and publishes into main', async () => {
    const projects = { 'Quarterly Report': { name: 'Quarterly report' } };
    const { manager, gitStore, patches, writes, uploads, dataRoot } = harness({ projects });
    const missionId = 'w-1700000000000-abcd1234';
    const tree = join(dataRoot, 'missions', missionId);

    await manager.initWorkspace(missionId, { projectId: 'Quarterly Report' });
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], tree), `mission/${missionId}`);
    assert.match(readFileSync(join(tree, '.git', 'info', 'exclude'), 'utf8'), /paraclete: mission scratch/);

    writeFileSync(join(tree, 'summary.md'), '# Summary\n');
    writeFileSync(join(tree, 'MISSION.md'), 'bookkeeping, never committed');
    const checkpoint = await manager.commitAndSync(missionId, 'Quarterly Report', 'v2026.10.17.1.1: draft `summary` with $vars');
    assert.equal(checkpoint.committed, true);
    assert.equal(checkpoint.synced, true);
    assert.equal(git(['log', '-1', '--format=%s'], tree), 'v2026.10.17.1.1: draft `summary` with $vars');
    assert.equal(git(['ls-files'], tree).split('\n').includes('MISSION.md'), false, 'bookkeeping stays out of the commit');
    assert.equal((await gitStore.readRef('quarterly-report', `mission/${missionId}`)).sha, checkpoint.sha);

    writeFileSync(join(tree, 'table.csv'), 'a,b\n1,2\n');
    const envelope = { id: missionId, type: 'M', project_id: 'Quarterly Report', title: 'Quarterly numbers', source_channel: 'dashboard' };
    const manifest = await manager.publish(envelope);

    assert.equal(manifest.kind, 'artifact_manifest');
    assert.equal(manifest.summary, 'Quarterly numbers');
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['summary.md', 'table.csv']);
    assert.equal((await gitStore.readRef('quarterly-report', 'main')).sha, manifest.commit);
    assert.equal(envelope.context.artifacts, manifest);
    assert.equal(projects['Quarterly Report'].context.artifacts, manifest);

    assert.equal(uploads.length, 1, 'a dashboard mission exports its changed files as downloads');
    assert.equal(uploads[0].missionId, missionId);
    assert.deepEqual(uploads[0].paths.map((p) => p.split(/[\\/]/).pop()).sort(), ['summary.md', 'table.csv']);
    assert.equal(envelope.context.attachments_export.length, 2);
    assert.deepEqual(Object.keys(envelope.context.attachments_export[0]).sort(), ['contentType', 'gcsPath', 'name', 'size'], 'no checksum on the envelope');

    // Every exported file gets the same `files` record file-share writes, sourced 'artifact'.
    assert.deepEqual(writes.map((w) => w.path).sort(), [`files/out-${missionId}-summary_md`, `files/out-${missionId}-table_csv`]);
    const record = writes.find((w) => w.path.endsWith('table_csv')).data;
    assert.deepEqual([record.direction, record.mission_id, record.source, record.created_by, record.gcs_path, record.sha256],
      ['out', missionId, 'artifact', TEST_AUTHOR.email, `files/out/${missionId}/table.csv`, 'c'.repeat(64)]);

    assert.equal(patches.length, 1);
    assert.equal(patches[0].path, 'projects/Quarterly Report');
    assert.deepEqual(patches[0].mask, ['context']);
  });

  test("the project's manifest is written as a Firestore map value", async () => {
    // The project update used to send the encoded fields bare, which is not a Firestore value: the
    // write was refused and the response never checked, so the project never got its manifest.
    const projects = { proj: {} };
    const { manager, patches, dataRoot } = harness({ projects });
    await manager.initWorkspace('w-2', { projectId: 'proj' });
    writeFileSync(join(dataRoot, 'missions', 'w-2', 'out.md'), 'out');
    const manifest = await manager.publish({ id: 'w-2', type: 'M', project_id: 'proj', title: 'Out' });
    const { context } = patches[0].fields;
    assert.ok(context.mapValue, 'context is a map value');
    assert.deepEqual(firestoreDecode(context.mapValue.fields).artifacts, manifest);
  });

  test('a gated project parks the merge instead of landing it', async () => {
    const projects = { code: { class: 'code' } };
    const { manager, gitStore, dataRoot } = harness({ projects });
    await manager.initWorkspace('w-3', { projectId: 'code' });
    writeFileSync(join(dataRoot, 'missions', 'w-3', 'main.js'), 'export {};\n');
    const envelope = { id: 'w-3', type: 'M', project_id: 'code', title: 'Code change' };
    assert.equal(await manager.publish(envelope), null);
    assert.equal(envelope.context.pending_merge.sourceBranch, 'mission/w-3');
    assert.equal(envelope.context.pending_merge.targetBranch, 'main');
    assert.match(envelope.context.pending_merge.missionSha, /^[0-9a-f]{40}$/);
    assert.equal(await gitStore.readRef('code', 'main'), null, 'nothing landed on main');
  });

  test('a commit the motor made itself is pushed even when there is nothing new to stage', async () => {
    const { manager, gitStore, dataRoot } = harness({ projects: { p: {} } });
    await manager.initWorkspace('w-4', { projectId: 'p' });
    const tree = join(dataRoot, 'missions', 'w-4');
    const sha = commitFile(tree, 'own.md', 'motor commit', 'motor committed this');
    const result = await manager.commitAndSync('w-4', 'p', 'unused');
    assert.deepEqual(result, { committed: false, synced: true, sha });
    assert.equal((await gitStore.readRef('p', 'mission/w-4')).sha, sha);
  });

  test('a tree with no commits reports unborn and pushes nothing', async () => {
    const { manager, dataRoot } = harness();
    const tree = join(dataRoot, 'missions', 'w-5');
    mkdirSync(tree, { recursive: true });
    git(['init'], tree);
    assert.deepEqual(await manager.commitAndSync('w-5', 'p', 'nothing'), { committed: false, synced: true, sha: null, unborn: true });
  });

  test('a mission tree that is not its own repository is never committed into an enclosing one', async () => {
    // Asking git from a plain directory finds the repository it sits in, so `git add -A` used to
    // stage the mission into whatever checkout held the install root.
    const { manager, dataRoot } = harness();
    initWorkingTree(dataRoot);
    const before = git(['rev-parse', 'HEAD'], dataRoot);
    const tree = join(dataRoot, 'missions', 'w-6');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'stray.md'), 'mission output');
    assert.deepEqual(await manager.commitAndSync('w-6', 'p', 'should not happen'), { committed: false, synced: false, sha: null });
    assert.equal(git(['rev-parse', 'HEAD'], dataRoot), before);
    assert.equal(git(['status', '--porcelain'], dataRoot), '?? missions/');
  });

  test('a failed git setup marks the envelope degraded, and publish then skips git', async () => {
    const { manager, gitStore } = harness({ projects: { p: {} } });
    gitStore.ensureRepo = async () => { throw new Error('store unavailable'); };
    const envelope = { id: 'w-7', type: 'M', project_id: 'p' };
    await manager.initWorkspace('w-7', { projectId: 'p', envelope });
    assert.match(envelope.context.git_status, /^degraded: store unavailable/);
    assert.equal(await manager.publish(envelope), null);
  });

  test('cleanupWorkspace removes a mission tree and refuses an id that leaves the shared directory', async () => {
    const { manager, dataRoot } = harness();
    const tree = join(dataRoot, 'missions', 'w-8');
    mkdirSync(tree, { recursive: true });
    await manager.cleanupWorkspace('w-8');
    assert.equal(existsSync(tree), false);

    const outside = join(dataRoot, 'keep-me');
    mkdirSync(outside, { recursive: true });
    await manager.cleanupWorkspace('../keep-me');
    assert.ok(existsSync(outside), 'a path outside shared/ is never removed');
  });

  test('publish ignores envelopes that are not missions with a project', async () => {
    const { manager } = harness();
    assert.equal(await manager.publish(null), null);
    assert.equal(await manager.publish({ id: 'w-9', type: 'T', project_id: 'p' }), null);
    assert.equal(await manager.publish({ id: 'w-9', type: 'M' }), null);
  });
});
