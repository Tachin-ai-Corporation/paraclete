// tests/install/manifest.test.mjs: install/manifest.txt and the parser and stager bootstrap.sh runs on
// it (install/vm/manifest.mjs). The format: one repo path per line, `#` comments, a trailing `/` for a
// directory installed whole except node_modules/, `{role}` for the instance's role. Staging runs on
// temporary directories, and once on the real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseManifest, expandManifest, stageRelease, main } from '../../install/vm/manifest.mjs';
import { repoRoot, readRepoFile } from '../repo/repo-files.mjs';

/** A scratch directory holding the given files ({ 'a/b.txt': 'content' }), removed after the test. */
function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'paraclete-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function sink() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, text: () => text };
}

test('parseManifest reads one path per line, with comments, blank lines and directories', () => {
  const entries = parseManifest('# header\n\nagent/\n  config/contracts.json   # inline comment\nroles/{role}/\n');
  assert.deepEqual(entries.map(({ path, directory }) => ({ path, directory })), [
    { path: 'agent/', directory: true },
    { path: 'config/contracts.json', directory: false },
    { path: 'roles/{role}/', directory: true },
  ]);
  assert.equal(entries[1].line, 4);
});

test('parseManifest refuses anything that is not one repo path, naming every bad line', () => {
  const bad = [
    'agent/a.mjs agent/a.mjs',
    '/etc/passwd',
    '../outside',
    'agent/../config/',
    './agent/',
    'agent//cli/',
    'agent\\cli\\x.mjs',
    'roles/x{role}/',
    'agent/$(reboot)',
  ];
  for (const line of bad) assert.throws(() => parseManifest(`${line}\n`), /install\/manifest\.txt is not valid/, line);
  assert.throws(() => parseManifest('agent/\nagent/\n'), /listed twice/);
  assert.throws(() => parseManifest('agent/a b.mjs\n/x\n'), (err) => /line 1/.test(err.message) && /line 2/.test(err.message));
});

test('expandManifest fills in the role and drops the duplicate the generic role makes', () => {
  const entries = parseManifest('roles/generic/\nroles/{role}/\nskills/\n');
  assert.deepEqual(expandManifest(entries, 'researcher'), ['roles/generic/', 'roles/researcher/', 'skills/']);
  assert.deepEqual(expandManifest(entries, 'generic'), ['roles/generic/', 'skills/']);
  for (const role of ['', '../x', 'Generic', 'a/b', undefined]) {
    assert.throws(() => expandManifest(entries, role), /role id/, String(role));
  }
});

test('the real manifest installs the product and the upgrader, and nothing else', () => {
  const paths = expandManifest(parseManifest(readRepoFile('install/manifest.txt')), 'generic');
  for (const path of ['agent/', 'config/', 'prompts/', 'skills/', 'roles/generic/', 'install/bootstrap.sh',
    'install/upgrade.sh', 'install/manifest.txt', 'install/vm/']) {
    assert.ok(paths.includes(path), `${path} is installed`);
  }
  for (const path of paths) {
    assert.doesNotMatch(path, /^(dashboard|dev|docs|tests|\.github)\//, path);
    assert.ok(!['install/', 'install/install.sh', 'install/uninstall.sh', 'install/firestore.indexes.json'].includes(path),
      `${path} runs in Cloud Shell, not on the VM`);
  }
});

test('stageRelease copies each listed path to the same path, and nothing unlisted', (t) => {
  const source = tree(t, {
    'install/manifest.txt': 'agent/\nconfig/contracts.json\nroles/{role}/\n',
    'agent/cli/a.mjs': 'a',
    'agent/node_modules/pkg/index.js': 'dep',
    'agent/gateway/node_modules/x.js': 'nested dep',
    'config/contracts.json': '{}',
    'config/other.json': 'not listed',
    'roles/writer/role.json': '{}',
    'roles/generic/role.json': 'not listed for this role',
    'dashboard/app.js': 'not listed',
  });
  const stage = join(source, '..', `${source.split(/[\\/]/).pop()}-stage`);
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const staged = stageRelease({ sourceRoot: source, stageRoot: stage, role: 'writer' });
  assert.deepEqual(staged, ['agent/', 'config/contracts.json', 'roles/writer/']);
  assert.equal(readFileSync(join(stage, 'agent/cli/a.mjs'), 'utf8'), 'a');
  assert.equal(readFileSync(join(stage, 'config/contracts.json'), 'utf8'), '{}');
  assert.ok(existsSync(join(stage, 'roles/writer/role.json')));
  for (const absent of ['agent/node_modules', 'agent/gateway/node_modules', 'config/other.json', 'roles/generic', 'dashboard', 'install']) {
    assert.ok(!existsSync(join(stage, absent)), `${absent} is not staged`);
  }
});

test('stageRelease refuses a path the release lacks, and a file listed as a directory', (t) => {
  const missing = tree(t, { 'install/manifest.txt': 'agent/\nprompts/\n', 'agent/a.mjs': 'a' });
  assert.throws(() => stageRelease({ sourceRoot: missing, stageRoot: join(missing, 'out'), role: 'generic' }),
    /prompts\/ is listed but the release does not have it/);
  const mismatch = tree(t, { 'install/manifest.txt': 'agent/\nconfig/\n', 'agent/a.mjs': 'a', config: 'a file' });
  assert.throws(() => stageRelease({ sourceRoot: mismatch, stageRoot: join(mismatch, 'out'), role: 'generic' }),
    /config\/ is listed as a directory but is a file/);
  assert.ok(!existsSync(join(mismatch, 'out')), 'nothing is staged when a path is wrong');
});

test('stageRelease refuses a symbolic link inside a listed directory', (t) => {
  const source = tree(t, { 'install/manifest.txt': 'agent/\n', 'agent/a.mjs': 'a' });
  try {
    symlinkSync(join(source, 'install'), join(source, 'agent', 'link'), 'junction');
  } catch {
    return t.skip('this machine cannot create symbolic links');
  }
  assert.throws(() => stageRelease({ sourceRoot: source, stageRoot: join(source, 'out'), role: 'generic' }), /symbolic link/);
});

test('the command line stages the real repo for the generic role', (t) => {
  const stage = mkdtempSync(join(tmpdir(), 'paraclete-stage-'));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const stdout = sink();
  const stderr = sink();
  const code = main(['stage', `--source=${repoRoot}`, `--dest=${stage}`, '--role=generic'], { stdout, stderr });
  assert.equal(code, 0, stderr.text());
  assert.match(stdout.text(), /^staged \d+ manifest paths/);
  for (const path of ['agent/services/brain/main.mjs', 'agent/package-lock.json', 'config/contracts.json',
    'prompts', 'skills/web-search/web-search.mjs', 'roles/generic/memory.md', 'install/bootstrap.sh', 'install/vm/manifest.mjs']) {
    assert.ok(existsSync(join(stage, path)), `${path} is staged`);
  }
  for (const path of ['agent/node_modules', 'dashboard', 'dev', 'docs', 'tests', 'install/README.md', 'README.md', 'DEVELOPING.md']) {
    assert.ok(!existsSync(join(stage, path)), `${path} is not staged`);
  }
});

test('the command line explains its usage and fails on a bad role', () => {
  const stderr = sink();
  assert.equal(main([], { stdout: sink(), stderr }), 2);
  assert.match(stderr.text(), /^Usage: manifest\.mjs stage/);
  const bad = sink();
  assert.equal(main(['stage', `--source=${repoRoot}`, '--dest=unused', '--role=../etc'], { stdout: sink(), stderr: bad }), 1);
  assert.match(bad.text(), /role id/);
});
