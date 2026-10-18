// tests/install/bootstrap.test.mjs: install/bootstrap.sh and the Node helpers it runs from a release
// (install/vm/): the command launchers, the instance record, release.json, the role's packages, the
// validation gate and the readiness document. The helpers run here as they run on the VM, on the real
// repo or on scratch directories; the readiness document is written to the in-memory Firestore fake.
// The script's own logic runs by sourcing it in bash, on Linux only; nothing here needs root, the
// metadata server or the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot, readRepoFile } from '../repo/repo-files.mjs';
import { listCommands, launcherScript, writeLaunchers, skillRoots, CLI_RUNTIME } from '../../install/vm/launchers.mjs';
import * as instanceRecord from '../../install/vm/instance-record.mjs';
import * as releaseRecord from '../../install/vm/release-record.mjs';
import * as rolePackagesCli from '../../install/vm/role-packages.mjs';
import { checkRelease } from '../../install/vm/check-release.mjs';
import * as readiness from '../../install/vm/readiness.mjs';
import { validateInstance, loadInstance, dataPaths, DEFAULT_INSTANCE_PATH } from '../../config/instance.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { start as startFirestore } from '../fakes/firestore-server.mjs';

const BASH_AVAILABLE = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const LINUX_ONLY = process.platform !== 'linux' && 'runs bash scripts the way the VM does; Linux only';
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function scratch(t, prefix = 'paraclete-bootstrap-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function sink() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, text: () => text };
}

/** Runs a bash snippet with install/bootstrap.sh sourced, from the repo root. */
function bashWithBootstrap(snippet, env = {}) {
  return spawnSync('bash', ['-c', `source install/bootstrap.sh\n${snippet}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('bootstrap.sh parses', { skip: !BASH_AVAILABLE && 'no bash on this machine' }, () => {
  const r = spawnSync('bash', ['-n', 'install/bootstrap.sh'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('bootstrap.sh uses the paths config/instance.mjs and the units use', () => {
  const script = readRepoFile('install/bootstrap.sh');
  const constant = (name) => script.match(new RegExp(`^readonly ${name}=(.+)$`, 'm'))?.[1];
  assert.equal(constant('INSTANCE_FILE'), DEFAULT_INSTANCE_PATH);
  const dirs = constant('DATA_DIRS').replace(/^\(|\)$/g, '').split(' ');
  const expected = Object.values(dataPaths({ data_root: '/d' }))
    .filter((p) => p !== '/d' && !p.endsWith('.md'))
    .map((p) => p.slice('/d/'.length));
  assert.deepEqual(dirs.filter((d) => d !== 'home').sort(), expected.sort(), 'the data directories are the ones dataPaths() names');
  assert.ok(dirs.includes('home'), "the paraclete user's home is under the data root");

  const dir = mkdtempSync(join(tmpdir(), 'paraclete-instance-'));
  try {
    const path = join(dir, 'instance.json');
    writeFileSync(path, JSON.stringify({ project: 'p', region: 'r', zone: 'z', agent_name: 'a', role: 'generic',
      install_root: constant('INSTALL_ROOT'), data_root: constant('DATA_ROOT'), bucket: 'b' }));
    assert.equal(loadInstance({ path }).gateway_token_file, constant('TOKEN_FILE'), 'the token file is where the services look');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const service of ['gateway', 'brain', 'ears', 'mouth']) {
    const unit = readRepoFile(`agent/services/${service}/paraclete-${service}.service`).split('\n');
    assert.ok(unit.includes(`Environment=PATH=${constant('INSTALL_ROOT')}/bin:/usr/local/bin:/usr/bin:/bin`), `${service} finds the launchers`);
    assert.ok(unit.includes(`Environment=HOME=${constant('DATA_ROOT')}/home`), `${service} has a writable home`);
    assert.ok(unit.includes(`ExecStart=${constant('NODE')} ${constant('INSTALL_ROOT')}/agent/services/${service}/main.mjs`));
  }
});

describe('command launchers', () => {
  /** What the README says gets a launcher, worked out from the repo independently of launchers.mjs. */
  function expectedCommands() {
    const expected = {};
    for (const name of readdirSync(join(repoRoot, 'agent', 'cli'))) {
      if (name.endsWith('.mjs') && name !== 'cli-runtime.mjs') expected[name.slice(0, -4)] = `agent/cli/${name}`;
    }
    for (const base of ['skills', 'roles/generic/skills']) {
      if (!existsSync(join(repoRoot, base))) continue;
      for (const skill of readdirSync(join(repoRoot, base))) {
        const manifest = join(repoRoot, base, skill, 'skill.json');
        if (!existsSync(manifest)) continue;
        for (const command of JSON.parse(readFileSync(manifest, 'utf8')).commands) {
          if (existsSync(join(repoRoot, base, skill, `${command}.mjs`))) expected[command] = `${base}/${skill}/${command}.mjs`;
        }
      }
    }
    return expected;
  }

  test('every agent/cli command but cli-runtime, and every skill command file, gets one', () => {
    const commands = listCommands(repoRoot, 'generic');
    assert.deepEqual(Object.fromEntries(commands.map((c) => [c.name, c.file])), expectedCommands());
    const names = commands.map((c) => c.name);
    assert.deepEqual(names, [...names].sort(), 'sorted by name');
    for (const name of ['git-store', 'agent-status', 'web-search', 'web-fetch', 'secret-read', 'work-commit']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes(CLI_RUNTIME.slice(0, -4)), 'cli-runtime is not a command');
  });

  test('a launcher is the two lines install/README.md gives', () => {
    assert.equal(launcherScript('/opt/paraclete', 'agent/cli/git-store.mjs'),
      '#!/bin/sh\nexec /usr/bin/node /opt/paraclete/agent/cli/git-store.mjs "$@"\n');
    assert.ok(readRepoFile('install/README.md').includes('exec /usr/bin/node /opt/paraclete/<path>.mjs "$@"'));
    assert.throws(() => launcherScript('/opt/para clete', 'agent/cli/x.mjs'), /plain absolute/);
    assert.throws(() => launcherScript('/opt/paraclete', 'agent/cli/$(x).mjs'), /plain absolute/);
  });

  test('writeLaunchers writes real files into bin/, naming the install root', (t) => {
    const root = scratch(t);
    writeTree(root, {
      'agent/cli/cli-runtime.mjs': '',
      'agent/cli/core-memory-read.mjs': '',
      'skills/web/skill.json': JSON.stringify({ commands: ['web-get', 'core-memory-read', 'listed-only'] }),
      'skills/web/web-get.mjs': '',
      'roles/generic/skills/notes/skill.json': JSON.stringify({ commands: ['note-add'] }),
      'roles/generic/skills/notes/note-add.mjs': '',
      'roles/writer/skills/draft/skill.json': JSON.stringify({ commands: ['draft-new'] }),
      'roles/writer/skills/draft/draft-new.mjs': '',
    });
    const generic = writeLaunchers({ root, installRoot: '/opt/paraclete', role: 'generic' });
    assert.deepEqual(generic.map((c) => c.name), ['core-memory-read', 'note-add', 'web-get']);
    rmSync(join(root, 'bin'), { recursive: true });
    const writer = writeLaunchers({ root, installRoot: '/opt/paraclete', role: 'writer' });
    assert.deepEqual(writer.map((c) => c.name), ['core-memory-read', 'draft-new', 'note-add', 'web-get']);
    const path = join(root, 'bin', 'draft-new');
    assert.ok(!lstatSync(path).isSymbolicLink());
    assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\nexec /usr/bin/node /opt/paraclete/roles/writer/skills/draft/draft-new.mjs "$@"\n');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o755);
  });

  test('two files claiming one command name, or an unreadable skill.json, stop the install', (t) => {
    const clash = scratch(t);
    writeTree(clash, {
      'agent/cli/web-get.mjs': '',
      'skills/web/skill.json': JSON.stringify({ commands: ['web-get'] }),
      'skills/web/web-get.mjs': '',
    });
    assert.throws(() => listCommands(clash, 'generic'), /'web-get' is claimed by both agent\/cli\/web-get\.mjs and skills\/web\/web-get\.mjs/);
    const broken = scratch(t);
    writeTree(broken, { 'skills/web/skill.json': '{ not json' });
    assert.throws(() => listCommands(broken, 'generic'), /skills\/web\/skill\.json cannot be read/);
    assert.throws(() => skillRoots('../etc'), /role id/);
  });
});

describe('the instance record', () => {
  const metadata = {
    project: 'your-gcp-project',
    zone: 'europe-west4-b',
    agentName: 'Ada',
    role: 'generic',
    bucket: 'your-gcp-project-paraclete',
    release: 'v2026.10.17.1.1',
    sourceRepo: 'your-org/paraclete',
    installRoot: '/opt/paraclete',
    dataRoot: '/var/lib/paraclete',
  };

  test('built from sample metadata, it is a record config/instance.mjs accepts', (t) => {
    const record = instanceRecord.buildInstance(metadata);
    assert.deepEqual(record, {
      project: 'your-gcp-project', region: 'europe-west4', zone: 'europe-west4-b', agent_name: 'Ada', role: 'generic',
      install_root: '/opt/paraclete', data_root: '/var/lib/paraclete', bucket: 'your-gcp-project-paraclete',
      release: 'v2026.10.17.1.1', source_repo: 'your-org/paraclete',
    });
    assert.deepEqual(validateInstance(record), []);
    const path = join(scratch(t), 'instance.json');
    writeFileSync(path, JSON.stringify(record));
    assert.equal(loadInstance({ path }).workspace, null);
  });

  test('a Workspace role and a dashboard add their fields', () => {
    const record = instanceRecord.buildInstance({
      ...metadata,
      dashboardUrl: 'https://paraclete-dashboard.example.com',
      workspaceAccount: 'agent@example.com',
      workspaceSigner: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com',
    });
    assert.equal(record.dashboard_url, 'https://paraclete-dashboard.example.com');
    assert.deepEqual(record.workspace, { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' });
    assert.deepEqual(validateInstance(record), []);
    const half = instanceRecord.buildInstance({ ...metadata, workspaceAccount: 'agent@example.com' });
    assert.ok(validateInstance(half).some((p) => /workspace\.signer/.test(p)), 'an account without a signer is refused');
  });

  test('the region comes from the zone', () => {
    assert.equal(instanceRecord.regionOf('us-central1-a'), 'us-central1');
    assert.equal(instanceRecord.regionOf('northamerica-northeast2-c'), 'northamerica-northeast2');
    for (const zone of ['us-central1', 'projects/1/zones/us-central1-a', '', undefined]) {
      assert.throws(() => instanceRecord.regionOf(zone), /not a Compute Engine zone/, String(zone));
    }
  });

  test('the command line writes the record, or names every problem and writes nothing', (t) => {
    const dir = scratch(t);
    const out = join(dir, 'instance.json');
    const args = ['--project=your-gcp-project', '--zone=us-central1-a', '--agent-name=Ada Lovelace', '--role=generic',
      '--bucket=your-gcp-project-paraclete', '--release=main', '--source-repo=your-org/paraclete',
      '--install-root=/opt/paraclete', '--data-root=/var/lib/paraclete'];
    const stderr = sink();
    assert.equal(instanceRecord.main([`--out=${out}`, ...args], { stdout: sink(), stderr }), 0, stderr.text());
    assert.equal(loadInstance({ path: out }).agent_name, 'Ada Lovelace');
    assert.ok(!existsSync(`${out}.tmp`));

    const bad = join(dir, 'bad.json');
    const errors = sink();
    const code = instanceRecord.main([`--out=${bad}`, ...args.filter((a) => !a.startsWith('--bucket') && !a.startsWith('--release')),
      '--data-root=/opt/paraclete', '--role=Not A Role'], { stdout: sink(), stderr: errors });
    assert.equal(code, 1);
    for (const problem of ['instance.bucket is required', 'instance.role must be a role id', 'data_root must differ', 'instance.release is required']) {
      assert.ok(errors.text().includes(problem), problem);
    }
    assert.ok(!existsSync(bad));
  });
});

describe('release.json', () => {
  const canonicalRegex = loadContracts().versioning.canonical_regex;

  test('the version is the release tag, else the version prefix of the commit message, else null', () => {
    assert.equal(releaseRecord.releaseVersion({ ref: 'v2026.10.17.1.1', canonicalRegex }), 'v2026.10.17.1.1');
    assert.equal(releaseRecord.releaseVersion({ ref: 'my-branch', commitMessage: 'v2026.10.17.5.2: install the agent', canonicalRegex }), 'v2026.10.17.5.2');
    assert.equal(releaseRecord.releaseVersion({ ref: 'v2026.10.17.1.1-rc', commitMessage: 'no prefix', canonicalRegex }), null);
    assert.equal(releaseRecord.releaseVersion({ ref: COMMIT, commitMessage: null, canonicalRegex }), null);
  });

  test("the commit message comes from GitHub, and any failure leaves it unknown", async () => {
    const calls = [];
    const ok = async (url, init) => { calls.push({ url, init }); return Response.json({ commit: { message: 'v2026.10.17.5.2: x' } }); };
    assert.equal(await releaseRecord.lookupCommitMessage({ repo: 'your-org/paraclete', commit: COMMIT, fetch: ok }), 'v2026.10.17.5.2: x');
    assert.equal(calls[0].url, `https://api.github.com/repos/your-org/paraclete/commits/${COMMIT}`);
    assert.equal(calls[0].init.headers['User-Agent'], 'paraclete-bootstrap');
    assert.equal(await releaseRecord.lookupCommitMessage({ repo: 'r/r', commit: COMMIT, fetch: async () => new Response('rate limited', { status: 403 }) }), null);
    assert.equal(await releaseRecord.lookupCommitMessage({ repo: 'r/r', commit: COMMIT, fetch: async () => { throw new Error('offline'); } }), null);
  });

  test('the command line writes the record, with the metadata it was installed under', async (t) => {
    const out = join(scratch(t), 'release.json');
    let fetched = 0;
    const fetch = async () => { fetched += 1; return Response.json({ commit: { message: 'v2026.10.17.5.2: x' } }); };
    const base = ['--repo=your-org/paraclete', `--commit=${COMMIT}`, '--metadata-repo=your-org/paraclete', `--metadata-ref=${OTHER}`];
    const now = () => '2026-10-17T12:00:00.000Z';

    assert.equal(await releaseRecord.main([`--out=${out}`, '--ref=feature/x', ...base], { fetch, now, stdout: sink(), stderr: sink() }), 0);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
      version: 'v2026.10.17.5.2', ref: 'feature/x', commit: COMMIT, repo: 'your-org/paraclete',
      installed_at: '2026-10-17T12:00:00.000Z', metadata: { repo: 'your-org/paraclete', ref: OTHER },
    });
    assert.equal(fetched, 1);

    assert.equal(await releaseRecord.main([`--out=${out}`, '--ref=v2026.10.17.1.1', ...base], { fetch, now, stdout: sink(), stderr: sink() }), 0);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).version, 'v2026.10.17.1.1');
    assert.equal(fetched, 1, 'a release tag needs no lookup');

    const errors = sink();
    assert.equal(await releaseRecord.main([`--out=${out}`, '--ref=main', '--repo=r/r', '--commit=abc', '--metadata-repo=r/r', `--metadata-ref=${OTHER}`],
      { fetch, now, stdout: sink(), stderr: errors }), 1);
    assert.match(errors.text(), /not a 40-character commit/);
  });
});

describe("the role's packages", () => {
  test("the generic role's apt packages, read from the release", () => {
    const stdout = sink();
    assert.equal(rolePackagesCli.main([`--root=${repoRoot}`, '--role=generic'], { stdout, stderr: sink() }), 0);
    assert.deepEqual(stdout.text().trim().split('\n'), JSON.parse(readRepoFile('roles/generic/role.json')).setup.apt);
  });

  test("a role's packages come after generic's, once each", (t) => {
    const root = scratch(t);
    writeTree(root, {
      'roles/generic/role.json': JSON.stringify({ setup: { apt: ['git', 'jq'], pip: [], npm: [] } }),
      'roles/writer/role.json': JSON.stringify({ setup: { apt: ['jq', 'pandoc'] } }),
    });
    assert.deepEqual(rolePackagesCli.rolePackages(root, 'writer'), ['git', 'jq', 'pandoc']);
  });

  test("the generic role installs the file toolchain the files skill runs", () => {
    const apt = JSON.parse(readRepoFile('roles/generic/role.json')).setup.apt;
    const toolchain = ['pandoc', 'poppler-utils', 'qpdf', 'libreoffice-writer-nogui', 'libreoffice-calc-nogui',
      'libreoffice-impress-nogui', 'chromium', 'fonts-dejavu-core', 'fonts-liberation2', 'fonts-crosextra-carlito',
      'fonts-crosextra-caladea', 'python3-docx', 'python3-openpyxl',
      'python3-pypdf', 'imagemagick', 'file'];
    assert.deepEqual(toolchain.filter((name) => !apt.includes(name)), []);
    assert.ok(!apt.includes('python3-pptx'), 'Debian has no python3-pptx');
    // Installed without recommendations, so what those brought along is named.
    for (const name of ['patch', 'python3-dev', 'build-essential', 'poppler-data', 'libreoffice-math-nogui', 'python3-pil']) {
      assert.ok(apt.includes(name), name);
    }
    assert.equal(new Set(apt).size, apt.length, 'each once');
  });

  test('a missing role, an unpinned npm or pip package, or a name that is not a package stops the install', (t) => {
    const root = scratch(t);
    writeTree(root, {
      'roles/generic/role.json': JSON.stringify({ setup: { apt: ['git'] } }),
      'roles/py/role.json': JSON.stringify({ setup: { apt: [], pip: ['pandas'] } }),
      'roles/js/role.json': JSON.stringify({ setup: { npm: ['firebase-tools@^15.0.0', 'lighthouse@latest', 'left-pad'] } }),
      'roles/evil/role.json': JSON.stringify({ setup: { apt: ['--allow-unauthenticated', 'ok'], npm: ['--prefix=/etc'], pip: ['-e git+https://example.com/x'] } }),
    });
    assert.throws(() => rolePackagesCli.rolePackages(root, 'absent'), /role 'absent' is not in this release/);
    assert.throws(() => rolePackagesCli.rolePackages(root, 'py', 'pip'), /setup\.pip "pandas" is not a pip package pinned to an exact version/);
    for (const spec of ['firebase-tools@^15.0.0', 'lighthouse@latest', 'left-pad']) {
      assert.throws(() => rolePackagesCli.rolePackages(root, 'js', 'npm'), new RegExp(`setup\\.npm "${spec.replace(/[.^$]/g, '\\$&')}" is not an npm package pinned`));
    }
    assert.throws(() => rolePackagesCli.rolePackages(root, 'evil'), /"--allow-unauthenticated" is not a Debian package name/);
    assert.throws(() => rolePackagesCli.rolePackages(root, 'evil'), /"--prefix=\/etc" is not an npm package/);
    assert.throws(() => rolePackagesCli.rolePackages(root, 'evil'), /"-e git\+https:\/\/example\.com\/x" is not a pip package/);
    assert.throws(() => rolePackagesCli.rolePackages(root, 'generic', 'brew'), /the kind must be one of apt, npm, pip/);
  });

  test('npm and pip packages are pinned exactly, generic first, once each', (t) => {
    const root = scratch(t);
    writeTree(root, {
      'roles/generic/role.json': JSON.stringify({ setup: { apt: ['git'], npm: ['left-pad@1.3.0'], pip: ['six==1.16.0'] } }),
      'roles/web/role.json': JSON.stringify({ setup: { apt: [], npm: ['@scope/tool@2.0.0-rc.1', 'left-pad@1.3.0'], pip: ['PyYAML==6.0.1', 'Six==1.16.0'] } }),
      'roles/clash/role.json': JSON.stringify({ setup: { npm: ['left-pad@1.2.0'], pip: ['six==1.15.0'] } }),
    });
    assert.deepEqual(rolePackagesCli.roleSetup(root, 'web'), {
      apt: ['git'], npm: ['left-pad@1.3.0', '@scope/tool@2.0.0-rc.1'], pip: ['six==1.16.0', 'PyYAML==6.0.1'],
    }, 'Six is six to pip, pinned already at that version');
    assert.throws(() => rolePackagesCli.roleSetup(root, 'clash'), (err) =>
      /setup\.npm pins left-pad@1\.2\.0, but left-pad@1\.3\.0 is pinned already/.test(err.message)
      && /setup\.pip pins six==1\.15\.0, but six==1\.16\.0 is pinned already/.test(err.message));
    assert.deepEqual(rolePackagesCli.parsePackage('npm', '@scope/tool@2.0.0-rc.1'), { name: '@scope/tool', version: '2.0.0-rc.1' });
    assert.deepEqual(rolePackagesCli.parsePackage('pip', 'zope.interface==6.0.post1'), { name: 'zope.interface', version: '6.0.post1' });
    for (const bad of ['tool@1.2', 'tool@v1.2.3', 'Tool@1.2.3', 'tool@1.2.3 && reboot']) assert.equal(rolePackagesCli.parsePackage('npm', bad), null, bad);
    for (const bad of ['six>=1.16', 'six==1.*', 'six', 'six==1.16; rm -rf /']) assert.equal(rolePackagesCli.parsePackage('pip', bad), null, bad);
  });

  test('given what is installed, only the pins missing or at another version are printed', (t) => {
    const root = scratch(t);
    writeTree(root, {
      'roles/generic/role.json': JSON.stringify({ setup: { apt: ['git'] } }),
      'roles/web/role.json': JSON.stringify({ setup: { npm: ['firebase-tools@15.32.1', 'lighthouse@13.5.0', 'serve@14.2.4'], pip: ['PyYAML==6.0.1', 'six==1.16.0'] } }),
      'npm-ls.json': JSON.stringify({ name: 'lib', dependencies: { npm: { version: '11.6.0' }, 'firebase-tools': { version: '15.32.1' }, lighthouse: { version: '13.4.0' } } }),
      'pip-list.json': JSON.stringify([{ name: 'pyyaml', version: '6.0.1' }, { name: 'six', version: '1.15.0' }]),
      'garbled.json': '{ not json',
    });
    const run = (args) => {
      const stdout = sink();
      const stderr = sink();
      const code = rolePackagesCli.main([`--root=${root}`, '--role=web', ...args], { stdout, stderr });
      return { code, out: stdout.text(), err: stderr.text() };
    };
    assert.deepEqual(run(['--kind=npm']), { code: 0, out: 'firebase-tools@15.32.1\nlighthouse@13.5.0\nserve@14.2.4\n', err: '' });
    assert.equal(run(['--kind=npm', `--installed=${join(root, 'npm-ls.json')}`]).out, 'lighthouse@13.5.0\nserve@14.2.4\n');
    assert.equal(run(['--kind=pip', `--installed=${join(root, 'pip-list.json')}`]).out, 'six==1.16.0\n', 'PyYAML is pyyaml to pip');
    assert.equal(run(['--kind=npm', `--installed=${join(root, 'garbled.json')}`]).out, 'firebase-tools@15.32.1\nlighthouse@13.5.0\nserve@14.2.4\n',
      'a listing that cannot be read counts as nothing installed');
    assert.equal(run(['--kind=npm', `--installed=${join(root, 'absent.json')}`]).out.split('\n').length, 4);
    assert.equal(run(['--kind=npm', '--installed=x']).code, 0);
    const all = JSON.stringify({ dependencies: { 'firebase-tools': { version: '15.32.1' }, lighthouse: { version: '13.5.0' }, serve: { version: '14.2.4' } } });
    writeFileSync(join(root, 'all.json'), all);
    assert.equal(run(['--kind=npm', `--installed=${join(root, 'all.json')}`]).out, '', 'nothing when every pin is installed');
    assert.equal(run(['--installed=x']).code, 2, 'apt packages are checked by dpkg, not a listing');
    assert.equal(run(['--kind=brew']).code, 2);
  });
});

describe('the validation gate', () => {
  test('the repo, with its launchers, passes', { skip: !existsSync(join(repoRoot, 'agent', 'node_modules')) && 'run npm run setup first' }, async (t) => {
    const bin = scratch(t);
    for (const { name, file } of listCommands(repoRoot, 'generic')) writeFileSync(join(bin, name), launcherScript('/opt/paraclete', file));
    const { problems, services, commands: checked } = await checkRelease({ root: repoRoot, installRoot: '/opt/paraclete', binDir: bin });
    assert.deepEqual(problems, []);
    assert.deepEqual(services, ['brain', 'control', 'ears', 'gateway', 'mouth']);
    assert.equal(checked.length, listCommands(repoRoot, 'generic').length);
  });

  test('a release whose contracts, services or launchers are broken is refused, with every reason', async (t) => {
    const root = scratch(t);
    writeTree(root, {
      'config/contracts.mjs': readRepoFile('config/contracts.mjs'),
      'config/contracts.json': readRepoFile('config/contracts.json').replace('"port": 18789', '"port": 0'),
      'agent/services/brain/main.mjs': 'export const ok = true;\n',
      'agent/services/brain/paraclete-brain.service': '[Unit]\n',
      'agent/services/ears/main.mjs': "import './missing.mjs';\n",
      'agent/services/ears/paraclete-ears.service': '[Unit]\n',
      'agent/services/mouth/main.mjs': 'export const ok = true;\n',
      'agent/cli/fine.mjs': 'export const ok = true;\n',
      'bin/fine': launcherScript('/opt/paraclete', 'agent/cli/fine.mjs'),
      'bin/gone': launcherScript('/opt/paraclete', 'agent/cli/gone.mjs'),
      'bin/other': '#!/bin/sh\nexec /bin/rm -rf / "$@"\n',
    });
    const { problems, commands } = await checkRelease({ root, installRoot: '/opt/paraclete' });
    const expected = [/contracts do not validate: .*gateway\.port must be a TCP port/s, /service ears .* does not load/,
      /service mouth has no unit/, /bin\/gone runs agent\/cli\/gone\.mjs, which the release does not have/,
      /bin\/other is not a launcher/];
    for (const pattern of expected) assert.ok(problems.some((p) => pattern.test(p)), `${pattern} in ${problems.join(' | ')}`);
    assert.equal(problems.length, expected.length, problems.join(' | '));
    assert.deepEqual(commands, ['fine']);
  });
});

describe('the readiness document', () => {
  test('ready, failed, then ready again: each write sets only its own fields', async (t) => {
    const firestore = await startFirestore();
    t.after(() => firestore.stop());
    const db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 'vm-token' });
    const doc = () => firestore.dump()['agent/instance'].fields;

    await db.write('agent/instance', { set_by_someone_else: 'kept' });
    await readiness.writeReadiness(db, { status: 'ready', release: 'v2026.10.17.1.1', commit: COMMIT, now: '2026-10-17T12:00:00.000Z' });
    assert.deepEqual(doc(), {
      set_by_someone_else: { stringValue: 'kept' },
      status: { stringValue: 'ready' },
      release: { stringValue: 'v2026.10.17.1.1' },
      commit: { stringValue: COMMIT },
      ready_at: { stringValue: '2026-10-17T12:00:00.000Z' },
    });

    await readiness.writeReadiness(db, { status: 'failed', release: 'v2026.10.18.1.1', commit: OTHER, error: 'x'.repeat(5000), now: '2026-10-18T09:00:00.000Z' });
    assert.equal(doc().status.stringValue, 'failed');
    assert.equal(doc().commit.stringValue, OTHER);
    assert.equal(doc().ready_at.stringValue, '2026-10-17T12:00:00.000Z', 'a failure keeps when it was last ready');
    assert.equal(doc().failed_at.stringValue, '2026-10-18T09:00:00.000Z');
    assert.equal(doc().error.stringValue.length, readiness.MAX_ERROR_CHARS + 1);

    await readiness.writeReadiness(db, { status: 'ready', release: 'v2026.10.18.1.1', commit: OTHER, now: '2026-10-18T09:05:00.000Z' });
    assert.equal(doc().status.stringValue, 'ready');
    assert.ok(!('error' in doc()) && !('failed_at' in doc()), 'ready clears the last error');
    assert.ok(firestore.requests.every((r) => r.token === 'vm-token'));
  });

  test('the command line writes through the given Firestore, and refuses an unknown status', async (t) => {
    const firestore = await startFirestore();
    t.after(() => firestore.stop());
    const deps = { firestoreHost: firestore.origin, getAccessToken: async () => 'vm-token', now: () => '2026-10-17T12:00:00.000Z', stdout: sink() };
    const errors = sink();
    const code = await readiness.main([`--project=${firestore.projectId}`, '--status=failed', '--release=main', `--commit=${COMMIT}`, '--error=-step stage failed'],
      { ...deps, stderr: errors });
    assert.equal(code, 0, errors.text());
    assert.equal(firestore.dump()['agent/instance'].fields.error.stringValue, '-step stage failed');
    assert.equal(await readiness.main([`--project=${firestore.projectId}`, '--status=done'], { ...deps, stderr: sink() }), 1);
    assert.equal(await readiness.main([], { ...deps, stderr: sink() }), 2);
  });
});

describe('bootstrap.sh logic', { skip: LINUX_ONLY }, () => {
  const meta = { META_REPO: 'your-org/paraclete', META_REF: COMMIT, META_RELEASE: 'v2026.10.17.1.1' };
  const assignments = (vars) => Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n');

  function target({ installed = {}, env = {} } = {}) {
    const r = bashWithBootstrap(`${assignments(meta)}\n${assignments(installed)}
choose_target
printf '%s|%s|%s|%s|%s' "$TARGET_COMMIT" "$TARGET_REPO" "$TARGET_RELEASE" "$TARGET_SOURCE" "$SELF_COMMIT"`, env);
    assert.equal(r.status, 0, r.stderr);
    const [commit, repo, release, source, self] = r.stdout.split('|');
    return { commit, repo, release, source, self };
  }

  test('a first boot installs what the metadata names', () => {
    assert.deepEqual(target(), { commit: COMMIT, repo: 'your-org/paraclete', release: 'v2026.10.17.1.1', source: 'the VM metadata', self: COMMIT });
  });

  test('after an upgrade, a reboot keeps the upgraded release while the metadata is unchanged', () => {
    const installed = { INSTALLED_COMMIT: OTHER, INSTALLED_REPO: 'your-org/paraclete', INSTALLED_REF: 'v2026.10.18.1.1',
      INSTALLED_META_REPO: 'your-org/paraclete', INSTALLED_META_REF: COMMIT };
    assert.deepEqual(target({ installed }), { commit: OTHER, repo: 'your-org/paraclete', release: 'v2026.10.18.1.1', source: 'the installed release', self: COMMIT },
      'the target differs from this script, so it hands over to the installed bootstrap');
    const changed = target({ installed: { ...installed, INSTALLED_META_REF: OTHER } });
    assert.equal(changed.commit, COMMIT, 'a changed paraclete-ref (install.sh run again) wins');
    assert.equal(changed.source, 'the VM metadata');
  });

  test('PARACLETE_REF, PARACLETE_REPO and PARACLETE_RELEASE override everything', () => {
    const installed = { INSTALLED_COMMIT: COMMIT, INSTALLED_REPO: 'your-org/paraclete', INSTALLED_REF: 'x', INSTALLED_META_REPO: 'your-org/paraclete', INSTALLED_META_REF: COMMIT };
    const env = { PARACLETE_REF: OTHER, PARACLETE_REPO: 'someone/paraclete', PARACLETE_RELEASE: 'v2026.10.18.1.1' };
    assert.deepEqual(target({ installed, env }), { commit: OTHER, repo: 'someone/paraclete', release: 'v2026.10.18.1.1', source: 'PARACLETE_REF', self: OTHER });
  });

  test('a malformed ref, repository or label is refused before anything is installed', () => {
    for (const env of [{ PARACLETE_REF: 'main' }, { PARACLETE_REF: COMMIT.toUpperCase() }, { PARACLETE_REF: OTHER, PARACLETE_REPO: 'no-slash' },
      { PARACLETE_REF: OTHER, PARACLETE_RELEASE: 'v1; reboot' }]) {
      const r = bashWithBootstrap(`${assignments(meta)}\nchoose_target`, env);
      assert.equal(r.status, 1, JSON.stringify(env));
      assert.match(r.stderr, /paraclete-bootstrap: error: /);
    }
  });

  test('the metadata must name a full commit, a repository, a role, a name and a bucket', () => {
    const good = { PROJECT: 'your-gcp-project', ZONE: 'us-central1-a', ROLE: 'generic', AGENT_NAME: 'Ada', BUCKET: 'b', ...meta };
    assert.equal(bashWithBootstrap(`${assignments(good)}\ncheck_metadata`).status, 0);
    const cases = [
      [{ META_REF: 'main' }, /paraclete-ref must be a full 40-character commit, got 'main'/],
      [{ META_REF: COMMIT.slice(0, 12) }, /paraclete-ref must be a full 40-character commit/],
      [{ META_REPO: 'https://github.com/your-org/paraclete' }, /paraclete-repo must be owner\/name/],
      [{ ROLE: '../etc' }, /paraclete-role must be a role id/],
      [{ AGENT_NAME: '' }, /paraclete-agent-name is not set/],
      [{ BUCKET: '' }, /paraclete-bucket is not set/],
    ];
    for (const [change, message] of cases) {
      const r = bashWithBootstrap(`${assignments({ ...good, ...change })}\ncheck_metadata`);
      assert.equal(r.status, 1, JSON.stringify(change));
      assert.match(r.stderr, message);
    }
  });

  test('a release archive must hold one top directory named for the commit', (t) => {
    const dir = scratch(t);
    mkdirSync(join(dir, 'one', `paraclete-${COMMIT}`), { recursive: true });
    mkdirSync(join(dir, 'two', 'a'), { recursive: true });
    mkdirSync(join(dir, 'two', 'b'), { recursive: true });
    const one = bashWithBootstrap(`archive_top_directory '${join(dir, 'one')}'`);
    assert.equal(one.stdout.trim(), `${join(dir, 'one')}/paraclete-${COMMIT}`);
    assert.equal(bashWithBootstrap(`archive_top_directory '${join(dir, 'two')}'`).status, 1);
    assert.equal(bashWithBootstrap(`archive_top_directory '${join(dir, 'missing')}'`).status, 1);
  });

  /** apt-get and dpkg stand-ins: `git` is installed, apt-get and dpkg calls are logged to <dir>/apt, an
   * install exits with $APT_STATUS, and dpkg was cut off when $DPKG_INTERRUPTED is 1. */
  const fakeApt = (dir) => `
package_installed() { [[ "$1" == git ]]; }
apt_get() { printf '%s\\n' "$*" >> '${dir}/apt'; [[ "$1" == update ]] || return "\${APT_STATUS:-0}"; }
dpkg_was_interrupted() { [[ "\${DPKG_INTERRUPTED:-0}" == 1 ]]; }
dpkg() { printf 'dpkg %s\\n' "$*" >> '${dir}/apt'; }`;
  const aptCalls = (dir) => (existsSync(join(dir, 'apt')) ? readFileSync(join(dir, 'apt'), 'utf8').trim().split('\n') : []);

  test('packages are installed without recommended ones, and only those missing', (t) => {
    const dir = scratch(t);
    const r = bashWithBootstrap(`${fakeApt(dir)}
ensure_packages git pandoc '' chromium
ensure_packages git`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(aptCalls(dir), ['update', 'install -y --no-install-recommends pandoc chromium'], 'nothing at all when every package is there');
  });

  test('a dpkg run that was cut off is finished before anything is installed', (t) => {
    const dir = scratch(t);
    const r = bashWithBootstrap(`${fakeApt(dir)}
ensure_packages pandoc`, { DPKG_INTERRUPTED: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(aptCalls(dir), ['dpkg --force-confdef --force-confold --configure -a', 'update', 'install -y --no-install-recommends pandoc']);
    assert.match(r.stderr, /an earlier package install was cut off; finishing it first/);

    // dpkg_was_interrupted looks for numbered journal files, as apt-get does; dpkg's own tmp.i is not one.
    assert.match(readRepoFile('install/bootstrap.sh'), /compgen -G "\$\{DPKG_UPDATES_DIR\}\/\[0-9\]\*"/);
    const journal = scratch(t);
    const cut = () => bashWithBootstrap(`compgen -G '${journal.replace(/\\/g, '/')}/[0-9]*' >/dev/null && echo cut || echo whole`).stdout.trim();
    writeFileSync(join(journal, 'tmp.i'), '');
    assert.equal(cut(), 'whole');
    writeFileSync(join(journal, '0001'), '');
    assert.equal(cut(), 'cut');
  });

  test('an upgrade to another commit is a full install, so packages its role adds are installed', () => {
    const r = bashWithBootstrap(`INSTALLED_COMMIT='${OTHER}' INSTALLED_REPO='your-org/paraclete' TARGET_COMMIT='${COMMIT}' TARGET_REPO='your-org/paraclete'
installed_release_is_target && echo fast || echo full`);
    assert.equal(r.stdout.trim(), 'full');
    assert.match(readRepoFile('install/bootstrap.sh'), /STEP=role-packages\n {2}install_role_packages\n/, 'the full install reads the new release\'s role packages');
  });

  test('a run on the installed commit puts back a role package that went missing, and only warns when it cannot', (t) => {
    const recheck = (dir, { list = 'printf \'%s\\n\' git pandoc chromium', env = {} } = {}) => bashWithBootstrap(`${fakeApt(dir)}
WORK_DIR='${dir}' ROLE=generic
role_package_list() { ${list}; }
pinned_package_list() { :; }
recheck_role_packages
echo "carried on"`, env);

    const fixed = scratch(t);
    let r = recheck(fixed);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(aptCalls(fixed), ['update', 'install -y --no-install-recommends pandoc chromium']);
    assert.match(r.stderr, /the role's packages pandoc chromium are not installed; installing them/);

    const failing = scratch(t);
    r = recheck(failing, { env: { APT_STATUS: '100' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /carried on/);
    assert.match(r.stderr, /could not install pandoc chromium; the services start without them/);

    const unreadable = scratch(t);
    r = recheck(unreadable, { list: 'echo "role-packages: no roles/generic/role.json" >&2; return 1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /the packages of role generic cannot be read, so they were not checked: role-packages: no roles\/generic\/role\.json/);
    assert.deepEqual(aptCalls(unreadable), []);

    const whole = scratch(t);
    r = recheck(whole, { list: 'echo git' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(aptCalls(whole), []);
  });

  /** A release whose role pins npm and pip packages, read by the real role-packages.mjs; npm and pip
   * stand-ins list what <dir>/npm.json and <dir>/pip.json say is installed, log installs to
   * <dir>/installs, and exit with $PIN_STATUS. */
  function pinnedRelease(t) {
    const dir = scratch(t);
    writeTree(dir, {
      'release/install/vm/role-packages.mjs': readRepoFile('install/vm/role-packages.mjs'),
      'release/roles/generic/role.json': JSON.stringify({ setup: { apt: ['git'], npm: [], pip: [] } }),
      'release/roles/web/role.json': JSON.stringify({ setup: { apt: [], npm: ['firebase-tools@15.32.1', 'lighthouse@13.5.0'], pip: ['PyYAML==6.0.1'] } }),
      'npm.json': JSON.stringify({ dependencies: { 'firebase-tools': { version: '15.32.1' }, lighthouse: { version: '13.4.0' } } }),
      'pip.json': '[]',
    });
    const bash = (snippet, env = {}) => bashWithBootstrap(`
WORK_DIR='${dir}' ROLE=web RELEASE_DIR='${dir}/release'
pinned_package_list() {
  local args=("--root=$RELEASE_DIR" "--role=$ROLE" "--kind=$2")
  if [[ -n "\${3:-}" ]]; then args+=("--installed=$3"); fi
  '${process.execPath}' "$RELEASE_DIR/install/vm/role-packages.mjs" "\${args[@]}"
}
npm_list_installed() { cat '${dir}/npm.json'; }
pip_list_installed() { cat '${dir}/pip.json'; }
npm_install_pinned() { printf 'npm %s\\n' "$*" >> '${dir}/installs'; return "\${PIN_STATUS:-0}"; }
pip_install_pinned() { printf 'pip %s\\n' "$*" >> '${dir}/installs'; return "\${PIN_STATUS:-0}"; }
${snippet}`, env);
    const installs = () => (existsSync(join(dir, 'installs')) ? readFileSync(join(dir, 'installs'), 'utf8').trim().split('\n') : []);
    return { dir, bash, installs };
  }

  test('pinned npm and pip packages: only those missing or at another version are installed', (t) => {
    const { dir, bash, installs } = pinnedRelease(t);
    let r = bash(`ensure_pinned "$RELEASE_DIR" npm && ensure_pinned "$RELEASE_DIR" pip && echo done`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(installs(), ['npm lighthouse@13.5.0', 'pip PyYAML==6.0.1']);
    assert.match(r.stdout, /installing npm packages: lighthouse@13\.5\.0/);

    writeFileSync(join(dir, 'npm.json'), JSON.stringify({ dependencies: { 'firebase-tools': { version: '15.32.1' }, lighthouse: { version: '13.5.0' } } }));
    writeFileSync(join(dir, 'pip.json'), JSON.stringify([{ name: 'pyyaml', version: '6.0.1' }]));
    rmSync(join(dir, 'installs'));
    r = bash(`ensure_pinned "$RELEASE_DIR" npm && ensure_pinned "$RELEASE_DIR" pip && echo done`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(installs(), [], 'nothing at all when every pin is installed');

    r = bash(`ROLE=generic; ensure_pinned "$RELEASE_DIR" npm && echo done`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'done', 'a role with no pins lists nothing installed');
  });

  test('a pin that cannot be installed stops a full install, and is a warning on the installed commit', (t) => {
    const { dir, bash, installs } = pinnedRelease(t);
    const full = bash(`node_step() { :; }
ensure_packages() { :; }
install_role_packages
echo "carried on"`, { PIN_STATUS: '1' });
    assert.equal(full.status, 1);
    assert.doesNotMatch(full.stdout, /carried on/);
    assert.match(full.stderr, /paraclete-bootstrap: error: the npm packages lighthouse@13\.5\.0 of role web could not be installed/);
    assert.deepEqual(installs(), ['npm lighthouse@13.5.0']);

    const fast = bash(`${fakeApt(dir)}
role_package_list() { echo git; }
recheck_role_packages
echo "carried on"`, { PIN_STATUS: '1' });
    assert.equal(fast.status, 0, fast.stderr);
    assert.match(fast.stdout, /carried on/);
    assert.match(fast.stderr, /warning: the npm packages lighthouse@13\.5\.0 of role web could not be installed; the services start without them/);
    assert.match(fast.stderr, /warning: the pip packages PyYAML==6\.0\.1 of role web could not be installed; the services start without them/);
    assert.deepEqual(aptCalls(dir), [], 'the Debian packages were all there');

    const unreadable = bash(`ROLE=absent; ensure_pinned "$RELEASE_DIR" npm || echo "failed: $PINNED_FAILURE"`);
    assert.match(unreadable.stdout, /failed: the npm packages of role absent cannot be read: role-packages: cannot read the role's packages/);
  });

  test('bootstrap.sh installs npm pins globally as root, and pip pins for the paraclete user only', () => {
    const script = readRepoFile('install/bootstrap.sh');
    assert.match(script, /npm install --global --no-fund --no-audit "\$@"/);
    assert.match(script, /runuser -u "\$SERVICE_USER" -- env HOME="\$DATA_ROOT\/home" python3 -m pip/);
    assert.match(script, /install --user --break-system-packages --no-cache-dir --no-warn-script-location "\$@"/);
    assert.doesNotMatch(script, /pip install (?!--user)/, 'never a system-wide pip install');
    assert.match(script, /for kind in npm pip; do\n {4}ensure_pinned "\$RELEASE_DIR" "\$kind" \|\| die "\$PINNED_FAILURE"/, 'a full install stops on a pin it cannot install');
  });

  test('bootstrap.sh refuses to run as anyone but root', { skip: process.getuid?.() === 0 && 'running as root' }, () => {
    const r = spawnSync('bash', ['install/bootstrap.sh'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bootstrap\.sh runs as root/);
  });
});

describe('moving an instance to another role', { skip: LINUX_ONLY }, () => {
  /** A release root whose roles/ holds these role packages. */
  function rolesTree(t, roles) {
    const root = scratch(t);
    for (const role of roles) writeTree(root, { [`roles/${role}/role.json`]: '{}' });
    return root;
  }
  const staged = (root, role) => bashWithBootstrap(`ROLE='${role}'
staged_for_role '${root}' && echo same || echo other`).stdout.trim();

  test('a release staged for generic and the role is this role\'s; one with another role, a missing one, or one more, is not', (t) => {
    assert.equal(staged(rolesTree(t, ['generic', 'devops-engineer']), 'devops-engineer'), 'same');
    assert.equal(staged(rolesTree(t, ['generic']), 'generic'), 'same');
    assert.equal(staged(rolesTree(t, ['generic', 'designer']), 'devops-engineer'), 'other', 'staged for the old role');
    assert.equal(staged(rolesTree(t, ['generic', 'designer']), 'generic'), 'other', 'back to generic drops the old role');
    assert.equal(staged(rolesTree(t, ['generic']), 'designer'), 'other');
    assert.equal(staged(rolesTree(t, ['generic', 'designer', 'devops-engineer']), 'designer'), 'other');
  });

  test('the installed commit staged for another role is a full install of the same commit, never the fast path', () => {
    const script = readRepoFile('install/bootstrap.sh');
    const check = script.slice(script.indexOf('installed_release_is_target() {'), script.indexOf('hand_off() {'));
    assert.match(check, /if ! staged_for_role "\$INSTALL_ROOT"; then\n\s+warn "the installed release was installed for another role than \$\{ROLE\}; installing it again for \$\{ROLE\}"\n\s+return 1/);
    assert.match(script, /manifest\.mjs" stage \\\n\s+"--source=\$RELEASE_DIR" "--dest=\$STAGE_ROOT" "--role=\$ROLE"/,
      'the new stage holds only the role the metadata names');
  });
});
