// tests/install/upgrade.test.mjs: install/upgrade.sh, which the control service runs to move the
// instance to a release tag or a commit. It must refuse anything but a tag name or a full commit before
// it touches the network or needs root, resolve an annotated tag to the commit it names, and run the
// target commit's own bootstrap. The script runs in bash on Linux only; nothing here needs root or the
// network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { repoRoot, readRepoFile } from '../repo/repo-files.mjs';
import { checkRef } from '../../agent/services/control/upgrade.mjs';
import { loadContracts } from '../../config/contracts.mjs';

const BASH_AVAILABLE = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const LINUX_ONLY = process.platform !== 'linux' && 'runs bash scripts the way the VM does; Linux only';
const COMMIT = 'c'.repeat(40);

function upgrade(args) {
  return spawnSync('bash', ['install/upgrade.sh', ...args], { cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH } });
}

function withUpgrade(snippet) {
  return spawnSync('bash', ['-c', `source install/upgrade.sh\n${snippet}`], { cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH } });
}

test('upgrade.sh parses', { skip: !BASH_AVAILABLE && 'no bash on this machine' }, () => {
  const r = spawnSync('bash', ['-n', 'install/upgrade.sh'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('upgrade.sh fetches the target commit\'s bootstrap and never runs the installed one', () => {
  const script = readRepoFile('install/upgrade.sh');
  assert.match(script, /https:\/\/raw\.githubusercontent\.com\/\$\{REPO\}\/\$\{commit\}\/install\/bootstrap\.sh/);
  assert.match(script, /PARACLETE_REF="\$commit" PARACLETE_REPO="\$REPO" PARACLETE_RELEASE="\$REF" bash "\$SCRIPT"/);
  assert.doesNotMatch(script, /\$INSTALL_ROOT\/install\/bootstrap\.sh|\/opt\/paraclete\/install\/bootstrap\.sh/);
});

describe('upgrade.sh on the command line', { skip: LINUX_ONLY }, () => {
  test('--help prints the usage', () => {
    const r = upgrade(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: upgrade\.sh --ref <release tag \| 40-character commit> \[--repo <owner>\/<name>\]/);
  });

  test('refuses a malformed ref before anything else', () => {
    const bad = ['main;reboot', '-x', '--ref', '../../etc', 'v1..2', 'a b', 'refs/tags/v1', '$(id)', 'v1.', 'x.lock',
      `${'v'.repeat(129)}`, '', 'abc\ndef'];
    for (const ref of bad) {
      const r = upgrade(['--ref', ref]);
      assert.equal(r.status, 1, JSON.stringify(ref));
      assert.match(r.stderr, /paraclete-upgrade: error: /, JSON.stringify(ref));
      assert.doesNotMatch(r.stderr, /runs as root/, `${JSON.stringify(ref)} is refused before the root check`);
    }
  });

  test('refuses a missing --ref, an unknown argument and a malformed repository', () => {
    for (const [args, message] of [
      [[], /--ref is required/],
      [['--ref'], /--ref needs a value/],
      [['--ref', COMMIT, '--branch', 'main'], /unknown argument '--branch'/],
      [['--ref', COMMIT, '--repo', 'https://github.com/your-org/paraclete'], /--repo must be <owner>\/<name>/],
      [['--ref', COMMIT, '--repo', 'your-org/paraclete;id'], /--repo must be <owner>\/<name>/],
    ]) {
      const r = upgrade(args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, message, args.join(' '));
    }
  });

  test('a well-formed ref still needs root', { skip: process.getuid?.() === 0 && 'running as root' }, () => {
    for (const ref of [COMMIT, 'v2026.10.17.1.1']) {
      const r = upgrade(['--ref', ref, '--repo', 'your-org/paraclete']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /upgrade\.sh runs as root/);
    }
  });
});

describe('upgrade.sh logic', { skip: LINUX_ONLY }, () => {
  test('every ref the control service sends is one upgrade.sh accepts', () => {
    const releasePattern = loadContracts().versioning.canonical_regex;
    for (const ref of [COMMIT, 'v2026.10.17.1.1', 'v2026.12.31.12.3']) {
      assert.ok(checkRef(ref, { releasePattern }).ok, ref);
      assert.equal(withUpgrade(`ref_is_valid '${ref}'`).status, 0, ref);
    }
  });

  test('an annotated tag resolves to the commit it names, a lightweight tag to its own', () => {
    const tagObject = 'd'.repeat(40);
    const annotated = `${tagObject}\trefs/tags/v2026.10.17.1.1\n${COMMIT}\trefs/tags/v2026.10.17.1.1^{}\n`;
    assert.equal(withUpgrade(`tag_commit v2026.10.17.1.1 <<< $'${annotated.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`).stdout.trim(), COMMIT);
    const lightweight = `${COMMIT}\trefs/tags/v2026.10.17.1.1\n`;
    assert.equal(withUpgrade(`tag_commit v2026.10.17.1.1 <<< $'${lightweight.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`).stdout.trim(), COMMIT);
    const otherTag = `${tagObject}\trefs/tags/v2026.10.17.1.10\n`;
    assert.equal(withUpgrade(`tag_commit v2026.10.17.1.1 <<< $'${otherTag.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`).stdout.trim(), '');
  });

  test('a full commit resolves to itself, without asking GitHub', () => {
    const r = withUpgrade(`git() { echo "git called" >&2; return 1; }\nresolve_commit your-org/paraclete ${COMMIT}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), COMMIT);
    assert.doesNotMatch(r.stderr, /git called/);
  });
});
