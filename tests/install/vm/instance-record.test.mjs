// Tests for the Workspace part of install/vm/instance-record.mjs and the bootstrap lines that call it:
// the account the dashboard's setup wizard recorded in /etc/paraclete/workspace.json reaches the
// instance record at every boot and upgrade while the VM metadata names none; metadata keys win; a
// removed account, a missing file and an unusable one record none, the last with a warning instead of
// a failed boot. The file is read only for a role flagged `workspace` in the release (a move to a role
// without one leaves the account out of the record and the file in place, so a move back restores it).
// The record the control service writes is the one this reads (one file name, one shape). The rest of
// the instance record is tested in tests/install/bootstrap.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoFile, repoRoot } from '../../repo/repo-files.mjs';
import { main, parseWorkspaceFile, roleWorkspace, workspaceSource } from '../../../install/vm/instance-record.mjs';
import { WORKSPACE_FILE, signerFor } from '../../../agent/services/control/workspace-account.mjs';
import { loadInstance, agentIdentity } from '../../../config/instance.mjs';

const SIGNER = signerFor('your-gcp-project');
const RECORDED = { account: 'agent@example.com', signer: SIGNER, recorded_at: '2026-10-18T09:00:00.000Z', recorded_by: 'admin@example.com' };
const ARGS = ['--project=your-gcp-project', '--zone=us-central1-a', '--agent-name=Ada', '--role=executive-assistant',
  '--bucket=your-gcp-project-paraclete', '--release=main', '--source-repo=your-org/paraclete',
  '--install-root=/opt/paraclete', '--data-root=/var/lib/paraclete'];

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'paraclete-instance-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sink() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, text: () => text };
}

/**
 * Runs the command line with a workspace.json holding `content` (a string, or an object as JSON).
 * `extra` arguments come last, so `--role=...` there overrides ARGS'. `deps` reach main().
 */
function build(t, { content, extra = [], deps = {} } = {}) {
  const dir = scratch(t);
  const out = join(dir, 'instance.json');
  const file = join(dir, 'workspace.json');
  if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  const stdout = sink();
  const stderr = sink();
  const code = main([`--out=${out}`, ...ARGS, `--workspace-file=${file}`, ...extra], { stdout, stderr, ...deps });
  return { code, out, file, stdout: stdout.text(), stderr: stderr.text(), instance: code === 0 ? loadInstance({ path: out }) : null };
}

/** A release holding only roles/<role>/role.json with these fields, for main()'s releaseRoot. */
function releaseWith(t, role, fields) {
  const root = scratch(t);
  mkdirSync(join(root, 'roles', role), { recursive: true });
  writeFileSync(join(root, 'roles', role, 'role.json'), typeof fields === 'string' ? fields : JSON.stringify({ id: role, ...fields }));
  return root;
}

test('the recorded account reaches the instance record, and the agent signs as it', (t) => {
  const r = build(t, { content: RECORDED });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.instance.workspace, { account: 'agent@example.com', signer: SIGNER });
  assert.equal(agentIdentity(r.instance).email, 'agent@example.com');
  assert.match(r.stdout, /Workspace account agent@example\.com \(from .*workspace\.json\)/);
  assert.equal(r.stderr, '');
});

test('metadata keys win over the file', (t) => {
  const r = build(t, { content: RECORDED, extra: ['--workspace-account=other@example.com', `--workspace-signer=${SIGNER}`] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.instance.workspace.account, 'other@example.com');
  assert.match(r.stdout, /from the metadata/);
});

test('a removed account, or no file at all, records none, silently', (t) => {
  const removed = build(t, { content: { account: null, signer: null, recorded_at: RECORDED.recorded_at, recorded_by: 'admin@example.com' } });
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.instance.workspace, null);
  assert.equal(removed.stderr, '');
  const none = build(t);
  assert.equal(none.code, 0, none.stderr);
  assert.equal(none.instance.workspace, null);
  assert.equal(none.stderr, '');
});

test('an unusable file never stops a boot: the account is left out with a warning', (t) => {
  for (const content of ['{ not json', '[]', JSON.stringify({ account: 'agent@example.com' }), JSON.stringify({ account: 'not an address', signer: SIGNER })]) {
    const r = build(t, { content });
    assert.equal(r.code, 0, `${content}: ${r.stderr}`);
    assert.equal(r.instance.workspace, null, content);
    assert.match(r.stderr, /instance-record: warning: .*the agent starts without its Workspace account/, content);
  }
  // Bad metadata is still an error: the installer wrote it, and it must be fixed there.
  const dir = scratch(t);
  const code = main([`--out=${join(dir, 'x.json')}`, ...ARGS, '--workspace-account=agent@example.com'], { stdout: sink(), stderr: sink() });
  assert.equal(code, 1);
});

test('a role without a Workspace account leaves the recorded account out, and the file where it is', (t) => {
  // generic, in this release, is not flagged workspace: the state after a move away from a Workspace role.
  const r = build(t, { content: RECORDED, extra: ['--role=generic'] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.instance.workspace, null);
  assert.equal(r.instance.role, 'generic');
  assert.match(r.stdout, /workspace\.json left out: role generic has no Workspace account \(the file stays, for a move back\)/);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(readFileSync(r.file, 'utf8')), RECORDED, 'the file is never touched');

  // Moving back: the same file, a Workspace role again, and the account is back.
  const back = build(t, { content: RECORDED, extra: ['--role=executive-assistant'] });
  assert.deepEqual(back.instance.workspace, { account: 'agent@example.com', signer: SIGNER });
});

test("the role's flag is read from the release being installed", (t) => {
  const flagged = build(t, { content: RECORDED, extra: ['--role=generic'], deps: { releaseRoot: releaseWith(t, 'generic', { workspace: true }) } });
  assert.deepEqual(flagged.instance.workspace, { account: 'agent@example.com', signer: SIGNER }, 'that release flags generic');
  const unflagged = build(t, { content: RECORDED, deps: { releaseRoot: releaseWith(t, 'executive-assistant', { workspace: false }) } });
  assert.equal(unflagged.instance.workspace, null, 'that release does not flag executive-assistant');

  // A release that cannot tell never stops a boot: the account is left out, with a warning.
  for (const root of [scratch(t), releaseWith(t, 'executive-assistant', '{ not json'), releaseWith(t, 'executive-assistant', { workspace: 'yes' })]) {
    const r = build(t, { content: RECORDED, deps: { releaseRoot: root } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.instance.workspace, null);
    assert.match(r.stderr, /instance-record: warning: .*role\.json .*workspace\.json is left out, and the agent starts without its Workspace account/);
  }

  // Metadata keys set by hand are not the file: they still win, whatever the role.
  const byHand = build(t, { content: RECORDED, extra: ['--role=generic', '--workspace-account=other@example.com', `--workspace-signer=${SIGNER}`] });
  assert.equal(byHand.instance.workspace.account, 'other@example.com');
});

test('roleWorkspace reads one flag, and only from a role id', () => {
  const files = { [join('/release', 'roles', 'designer', 'role.json')]: '{"workspace":true}' };
  const read = (path) => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return files[path];
  };
  assert.deepEqual(roleWorkspace('/release', 'designer', read), { workspace: true });
  assert.match(roleWorkspace('/release', 'qa-engineer', read).error, /cannot be read/);
  for (const role of ['../etc', 'Not A Role', '', undefined]) assert.match(roleWorkspace('/release', role, read).error, /is not a role id/);
});

test('the file is read only through its record shape', () => {
  assert.deepEqual(parseWorkspaceFile(JSON.stringify(RECORDED)), { account: 'agent@example.com', signer: SIGNER });
  assert.equal(parseWorkspaceFile('{"account":null}'), null);
  assert.throws(() => parseWorkspaceFile('nope'), /not JSON/);
  assert.throws(() => parseWorkspaceFile('"agent@example.com"'), /not a JSON object/);
  assert.throws(() => parseWorkspaceFile('{"account":"a@example.com","signer":7}'), /must both be email addresses/);

  const unreadable = workspaceSource({ file: '/x', readFile: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.equal(unreadable.source, 'none');
  assert.match(unreadable.warning, /cannot be read/);
  assert.deepEqual(workspaceSource({ file: '/x', readFile: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), { source: 'none' });
  assert.deepEqual(workspaceSource({}), { source: 'none' });
});

test('bootstrap.sh names the file control writes, and passes it only when it exists', () => {
  const script = readRepoFile('install/bootstrap.sh');
  assert.equal(/^readonly WORKSPACE_FILE=(.+)$/m.exec(script)?.[1], WORKSPACE_FILE);
  const fn = script.slice(script.indexOf('build_instance_record() {'), script.indexOf('\n}\n', script.indexOf('build_instance_record() {')));
  assert.match(fn, /if \[\[ -f "\$WORKSPACE_FILE" \]\]; then args\+=\("--workspace-file=\$WORKSPACE_FILE"\); fi/);
});

test('without the file, bootstrap.sh passes no --workspace-file', { skip: process.platform !== 'linux' && 'runs bash the way the VM does; Linux only' }, () => {
  const r = spawnSync('bash', ['-c', `source install/bootstrap.sh
node_step() { shift; printf '%s\\n' "$@"; }
PROJECT=p ZONE=us-central1-a AGENT_NAME=a ROLE=generic BUCKET=b TARGET_RELEASE=main TARGET_REPO=o/r
build_instance_record /opt/paraclete /tmp/out.json`], { cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('--workspace-file'), 'this test machine has no /etc/paraclete/workspace.json');
});
