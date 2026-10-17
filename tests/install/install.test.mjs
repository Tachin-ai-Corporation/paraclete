// Tests for install/install.sh, run with bash against tests/install/fake-cloud.mjs (no Google Cloud,
// no GitHub). A dry run's printed plan is checked step by step: the order, the APIs, the accounts and
// their grants, Firestore, the bucket, the network and the VM with its metadata. Then: a dry run
// changes nothing; a real run followed by a re-run creates nothing twice; a new --ref moves an existing
// VM; and each check in step 1 stops the install before anything changes.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentIdentity } from '../../config/instance.mjs';
import {
  bash, bashWith, createSandbox, find, flag, freshProject, needsBash, repoRoot, steps,
  COMMITS, OLDER_TAG, PROJECT, RELEASE_TAG, REPO, WORKSPACE_ROLE,
} from './harness.mjs';

const readJson = (...path) => JSON.parse(readFileSync(join(repoRoot, ...path), 'utf8'));
const contracts = readJson('config', 'contracts.json');
const genericRole = readJson('roles', 'generic', 'role.json');
const indexesFile = readJson('install', 'firestore.indexes.json');

const AGENT = `paraclete-agent@${PROJECT}.iam.gserviceaccount.com`;
const DASHBOARD = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const DWD = `paraclete-dwd@${PROJECT}.iam.gserviceaccount.com`;
const BUCKET = `${PROJECT}-paraclete`;

const BASE_APIS = ['compute', 'run', 'firestore', 'iam', 'iamcredentials', 'aiplatform', 'artifactregistry',
  'cloudbuild', 'secretmanager', 'storage', 'iap', 'drive'].map((api) => `${api}.googleapis.com`);
const WORKSPACE_APIS = ['chat', 'gmail', 'calendar-json', 'docs', 'sheets', 'slides', 'people', 'admin']
  .map((api) => `${api}.googleapis.com`);

/** Calls that would change something, including any the fake doesn't know (write: null). */
const writes = (calls) => calls.filter((call) => call.write !== false);

const enabledApis = (commands) => find(commands, 'gcloud', 'services', 'enable')
  .flatMap((command) => command.filter((arg) => arg.endsWith('.googleapis.com')));

const projectGrants = (commands, email) => find(commands, 'gcloud', 'projects', 'add-iam-policy-binding')
  .filter((command) => flag(command, 'member') === `serviceAccount:${email}`)
  .map((command) => flag(command, 'role'));

/** The --metadata=key=value,... of a VM command, as an object. */
function metadataOf(command) {
  return Object.fromEntries(flag(command, 'metadata').split(',').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
}

/** The indented file a dry run prints under "<label>:". */
function shownFile(stdout, label) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${label}:`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

test('install.sh, uninstall.sh and their library parse', { skip: needsBash }, () => {
  const scripts = ['install.sh', 'uninstall.sh', ...readdirSync(join(repoRoot, 'install', 'lib')).map((f) => `lib/${f}`)];
  for (const script of scripts) {
    const result = spawnSync(bash, ['-n', join(repoRoot, 'install', script).replace(/\\/g, '/')], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('install.sh and uninstall.sh are committed executable, so install/install.sh runs as written', (t) => {
  const listed = spawnSync('git', ['ls-files', '-s', '--', 'install/install.sh', 'install/uninstall.sh'], { cwd: repoRoot, encoding: 'utf8' });
  const lines = listed.stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return t.skip('not committed yet');
  for (const line of lines) assert.match(line, /^100755 /, `${line}: commit it with git add --chmod=+x`);
});

test("the agent's account is the one config/instance.mjs signs as", { skip: needsBash }, () => {
  const names = join(repoRoot, 'install', 'lib', 'names.sh').replace(/\\/g, '/');
  const email = bashWith(`source "${names}"; account_email "$AGENT_ACCOUNT_ID" "\${words[0]}"`, [PROJECT]).stdout.trim();
  assert.equal(email, agentIdentity({ project: PROJECT, agent_name: 'Paraclete' }).email);
});

describe('a dry run on a fresh project', { skip: needsBash, concurrency: true }, () => {
  let box;
  let run;
  before(async () => {
    box = createSandbox();
    run = await box.run('install.sh', ['--dry-run', '--yes']);
  });

  test('succeeds and walks the nine steps in order', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(steps(run.stdout), [
      [1, 'check'], [2, 'apis'], [3, 'accounts'], [4, 'firestore'], [5, 'bucket'],
      [6, 'dashboard'], [7, 'network'], [8, 'vm'], [9, 'wait'],
    ]);
  });

  test('changes nothing: every call it makes only reads', () => {
    assert.deepEqual(writes(run.calls), []);
    assert.deepEqual(box.state(), freshProject());
    assert.match(run.stdout, /Dry run complete: nothing was changed/);
  });

  test('still runs the read-only checks', () => {
    const made = run.calls.map((call) => call.command);
    for (const check of ['auth list', 'testIamPermissions', 'billing projects describe', 'projects get-ancestors', 'ls-remote', 'raw']) {
      assert.ok(made.includes(check), `missing check: ${check}`);
    }
  });

  test('enables the base APIs only, for a role without Workspace', () => {
    assert.deepEqual(enabledApis(run.commands).sort(), [...BASE_APIS].sort());
    for (const command of find(run.commands, 'gcloud', 'services', 'enable')) {
      assert.equal(flag(command, 'project'), PROJECT);
    }
  });

  test('creates the agent and dashboard accounts, and no Workspace signer', () => {
    const created = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'create').map((command) => command[4]);
    assert.deepEqual(created, ['paraclete-agent', 'paraclete-dashboard']);
  });

  test("grants the agent the generic role's gcp_roles on the project", () => {
    assert.deepEqual(projectGrants(run.commands, AGENT), genericRole.gcp_roles);
  });

  test('grants the dashboard what phase 6 needs, and itself only on its own account', () => {
    assert.deepEqual(projectGrants(run.commands, DASHBOARD), [
      'roles/datastore.user', 'roles/secretmanager.admin', 'roles/cloudbuild.builds.editor', 'roles/run.admin', 'roles/aiplatform.user',
    ]);
    const onAccounts = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'add-iam-policy-binding')
      .map((command) => [command[4], flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(onAccounts, [
      [DASHBOARD, `serviceAccount:${DASHBOARD}`, 'roles/iam.serviceAccountUser'],
      [DASHBOARD, `serviceAccount:${DASHBOARD}`, 'roles/iam.serviceAccountTokenCreator'],
    ]);
    for (const command of find(run.commands, 'gcloud', 'projects', 'add-iam-policy-binding')) {
      assert.equal(flag(command, 'condition'), 'None');
      assert.doesNotMatch(flag(command, 'role'), /^roles\/(owner|editor|storage\..*)$/, 'no basic role, and storage only on the bucket');
    }
  });

  test('creates the Native mode database in the region, with delete protection', () => {
    const [create, ...more] = find(run.commands, 'gcloud', 'firestore', 'databases', 'create');
    assert.equal(more.length, 0);
    assert.equal(flag(create, 'database'), '(default)');
    assert.equal(flag(create, 'location'), 'us-central1');
    assert.equal(flag(create, 'type'), 'firestore-native');
    assert.ok(create.includes('--delete-protection'));
  });

  test('creates every index in firestore.indexes.json, and the TTL policy', () => {
    const created = find(run.commands, 'gcloud', 'firestore', 'indexes', 'composite', 'create').map((command) => ({
      group: flag(command, 'collection-group'),
      scope: flag(command, 'query-scope'),
      fields: command.filter((arg) => arg.startsWith('--field-config=')).map((arg) => arg.slice('--field-config='.length)),
    }));
    assert.deepEqual(created, indexesFile.indexes.map((index) => ({
      group: index.collectionGroup,
      scope: 'collection',
      fields: index.fields.map((f) => `field-path=${f.fieldPath},order=${f.order.toLowerCase()}`),
    })));
    const [ttl, ...moreTtls] = find(run.commands, 'gcloud', 'firestore', 'fields', 'ttls', 'update');
    assert.equal(moreTtls.length, 0);
    assert.equal(ttl[5], 'expire_at');
    assert.equal(flag(ttl, 'collection-group'), 'tool_results');
    assert.ok(ttl.includes('--enable-ttl'));
  });

  test('creates the bucket private, uniform and with the inbox lifecycle from the contracts', () => {
    const [create] = find(run.commands, 'gcloud', 'storage', 'buckets', 'create');
    assert.equal(create[4], `gs://${BUCKET}`);
    assert.equal(flag(create, 'location'), 'us-central1');
    assert.ok(create.includes('--uniform-bucket-level-access'));
    assert.ok(create.includes('--public-access-prevention'));
    assert.match(flag(create, 'lifecycle-file'), /lifecycle\.json$/);
    assert.deepEqual(JSON.parse(shownFile(run.stdout, 'lifecycle.json')), {
      lifecycle: {
        rule: [{
          action: { type: 'Delete' },
          condition: { age: contracts.files.inbox_retention_days, matchesPrefix: [`${contracts.files.prefix}in/`] },
        }],
      },
    });
  });

  test('grants both accounts object admin on the bucket only', () => {
    const grants = find(run.commands, 'gcloud', 'storage', 'buckets', 'add-iam-policy-binding')
      .map((command) => [command[4], flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(grants, [
      [`gs://${BUCKET}`, `serviceAccount:${AGENT}`, 'roles/storage.objectAdmin'],
      [`gs://${BUCKET}`, `serviceAccount:${DASHBOARD}`, 'roles/storage.objectAdmin'],
    ]);
  });

  test('says the dashboard arrives later, and deploys nothing to Cloud Run', () => {
    assert.match(run.stdout, /dashboard: arrives in a later release/);
    assert.deepEqual(find(run.commands, 'gcloud', 'run'), []);
  });

  test('uses the default network, opens SSH from IAP only, and denies everything else inbound', () => {
    assert.deepEqual(find(run.commands, 'gcloud', 'compute', 'networks', 'create'), []);
    const rules = find(run.commands, 'gcloud', 'compute', 'firewall-rules', 'create');
    assert.equal(rules.length, 2);
    const [allow, deny] = rules;
    assert.equal(allow[4], 'paraclete-allow-iap-ssh');
    assert.equal(flag(allow, 'network'), 'default');
    assert.equal(flag(allow, 'direction'), 'INGRESS');
    assert.equal(flag(allow, 'action'), 'ALLOW');
    assert.equal(flag(allow, 'rules'), 'tcp:22');
    assert.equal(flag(allow, 'source-ranges'), '35.235.240.0/20');
    assert.equal(flag(allow, 'target-tags'), 'paraclete');
    assert.equal(flag(allow, 'priority'), '1000');
    // A default network allows SSH and RDP from anywhere at 65534; this deny outranks those for the
    // VM's tag, and the IAP allow outranks the deny.
    assert.equal(deny[4], 'paraclete-deny-ingress');
    assert.equal(flag(deny, 'action'), 'DENY');
    assert.equal(flag(deny, 'rules'), 'all');
    assert.equal(flag(deny, 'source-ranges'), '0.0.0.0/0');
    assert.equal(flag(deny, 'target-tags'), 'paraclete');
    assert.ok(Number(flag(deny, 'priority')) > Number(flag(allow, 'priority')));
    assert.ok(Number(flag(deny, 'priority')) < 65534);
  });

  test('creates the VM as the agent, sized and shielded as the plan says', () => {
    const [vm, ...more] = find(run.commands, 'gcloud', 'compute', 'instances', 'create');
    assert.equal(more.length, 0);
    assert.equal(vm[4], 'paraclete');
    assert.equal(flag(vm, 'zone'), 'us-central1-a');
    assert.equal(flag(vm, 'machine-type'), 'e2-standard-2');
    assert.equal(flag(vm, 'boot-disk-size'), '50GB');
    assert.equal(flag(vm, 'boot-disk-type'), 'pd-balanced');
    assert.equal(flag(vm, 'image-family'), 'debian-12');
    assert.equal(flag(vm, 'image-project'), 'debian-cloud');
    assert.equal(flag(vm, 'service-account'), AGENT);
    assert.equal(flag(vm, 'scopes'), 'cloud-platform,https://www.googleapis.com/auth/drive');
    assert.equal(flag(vm, 'tags'), 'paraclete');
    assert.equal(flag(vm, 'network'), 'default');
    for (const shield of ['--shielded-secure-boot', '--shielded-vtpm', '--shielded-integrity-monitoring']) assert.ok(vm.includes(shield));
    assert.ok(!vm.some((arg) => /no-address|address=/.test(arg)), 'keeps the default external IP for outbound traffic');
  });

  test('writes the contract metadata, with the newest release resolved to its 40-character commit', () => {
    const [vm] = find(run.commands, 'gcloud', 'compute', 'instances', 'create');
    assert.deepEqual(metadataOf(vm), {
      'paraclete-repo': REPO,
      'paraclete-ref': COMMITS.release,
      'paraclete-release': RELEASE_TAG,
      'paraclete-role': 'generic',
      'paraclete-agent-name': 'Paraclete',
      'paraclete-bucket': BUCKET,
    });
    assert.match(metadataOf(vm)['paraclete-ref'], /^[0-9a-f]{40}$/);
    assert.match(flag(vm, 'metadata-from-file'), /^startup-script=.+startup-script\.sh$/);
  });

  test("the startup script fetches bootstrap.sh at the metadata's repo and commit and runs it as root", () => {
    const script = shownFile(run.stdout, 'startup-script');
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.match(script, /attribute paraclete-repo/);
    assert.match(script, /attribute paraclete-ref/);
    assert.match(script, /curl --fail [^\n]*--retry/);
    assert.ok(script.includes('"https://raw.githubusercontent.com/${repo}/${ref}/install/bootstrap.sh"'));
    assert.match(script, /systemd-run --unit=paraclete-bootstrap[^\n]*--wait/);
    assert.match(script, /--property=StandardOutput=journal/);
    assert.match(script, /\/bin\/bash \/run\/paraclete-bootstrap\/bootstrap\.sh\s*$/);
  });

  test('says what it would wait for, and does not poll', () => {
    assert.match(run.stdout, new RegExp(`would wait up to 20 minutes for Firestore agent/instance to report ready on ${COMMITS.release}`));
    assert.ok(!run.calls.some((call) => call.command === 'firestore get agent/instance'));
  });
});

describe('a Workspace role', { skip: needsBash, concurrency: true }, () => {
  let run;
  before(async () => {
    run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--role', WORKSPACE_ROLE.id]);
  });

  test('adds the Workspace APIs', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(enabledApis(run.commands).sort(), [...BASE_APIS, ...WORKSPACE_APIS].sort());
  });

  test('adds the signer account, which only the agent may sign as', () => {
    const created = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'create').map((command) => command[4]);
    assert.deepEqual(created, ['paraclete-agent', 'paraclete-dashboard', 'paraclete-dwd']);
    const onSigner = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'add-iam-policy-binding')
      .filter((command) => command[4] === DWD)
      .map((command) => [flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(onSigner, [[`serviceAccount:${AGENT}`, 'roles/iam.serviceAccountTokenCreator']]);
    assert.deepEqual(projectGrants(run.commands, DWD), [], 'the signer holds no project role');
    assert.ok(!projectGrants(run.commands, AGENT).includes('roles/iam.serviceAccountTokenCreator'), 'never project-wide');
  });

  test("adds the role's gcp_roles to the generic ones, each once", () => {
    const expected = [...new Set([...genericRole.gcp_roles, ...WORKSPACE_ROLE.gcp_roles])];
    assert.deepEqual(projectGrants(run.commands, AGENT), expected);
  });

  test('writes the role, and neither Workspace key before the account they pair with exists', () => {
    const metadata = metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0]);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
    assert.ok(!('paraclete-workspace-account' in metadata));
    assert.ok(!('paraclete-workspace-signer' in metadata));
  });

  test('a re-run keeps Workspace keys the VM already has', async () => {
    const state = freshProject();
    const workspace = { 'paraclete-workspace-account': 'agent@example.com', 'paraclete-workspace-signer': DWD };
    state.instances.paraclete = { zone: 'us-central1-a', metadata: { ...workspace } };
    const box = createSandbox(state);
    const again = await box.run('install.sh', ['--yes', '--role', WORKSPACE_ROLE.id]);
    assert.equal(again.status, 0, again.stderr);
    const metadata = box.state().instances.paraclete.metadata;
    assert.equal(metadata['paraclete-workspace-account'], workspace['paraclete-workspace-account']);
    assert.equal(metadata['paraclete-workspace-signer'], DWD);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
  });
});

describe('choosing what to install', { skip: needsBash, concurrency: true }, () => {
  const vmMetadata = (run) => metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0]);

  test('--ref names a branch', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--ref', 'dev-branch']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.devBranch);
    assert.equal(vmMetadata(run)['paraclete-release'], 'dev-branch');
  });

  test('--ref names an older release tag', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', `--ref=${OLDER_TAG}`]);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.olderRelease);
    assert.equal(vmMetadata(run)['paraclete-release'], OLDER_TAG);
  });

  test('--ref names a full commit', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--ref', COMMITS.main]);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.main);
  });

  test('without release tags, the default branch', async () => {
    const state = freshProject();
    state.remotes[Object.keys(state.remotes)[0]] = state.remotes[Object.keys(state.remotes)[0]]
      .split('\n').filter((line) => !line.includes('refs/tags/')).join('\n');
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.main);
    assert.equal(vmMetadata(run)['paraclete-release'], 'main');
  });

  test('--repo installs from a fork', async () => {
    const state = freshProject();
    state.remotes['https://github.com/someone/paraclete.git'] = `${COMMITS.devBranch}\trefs/heads/main`;
    state.rawFiles.push(`someone/paraclete/${COMMITS.devBranch}/install/bootstrap.sh`);
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', '--repo', 'someone/paraclete', '--ref', 'main']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(vmMetadata(run)['paraclete-repo'], 'someone/paraclete');
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.devBranch);
    assert.ok(run.calls.find((call) => call.command === 'ls-remote').args.includes('https://github.com/someone/paraclete.git'));
  });

  test('a ref that does not resolve stops before any change', async () => {
    for (const ref of ['no-such-branch', COMMITS.devBranch.slice(0, 7)]) {
      const run = await createSandbox().run('install.sh', ['--yes', '--ref', ref]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /is not a tag, branch or full 40-character commit/);
      assert.deepEqual(writes(run.calls), []);
    }
  });

  test('a commit without install/bootstrap.sh stops before any change', async () => {
    const state = freshProject();
    state.rawFiles = [];
    const run = await createSandbox(state).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /has no install\/bootstrap\.sh/);
    assert.deepEqual(writes(run.calls), []);
  });

  test('a repository it cannot read, or a clone without a GitHub origin, stops', async () => {
    const state = freshProject();
    state.remotes = {};
    let run = await createSandbox(state).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /must exist and be public/);
    const noOrigin = freshProject();
    noOrigin.gitRemote = '';
    run = await createSandbox(noOrigin).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Pass --repo/);
  });
});

describe('step 1 stops a project that cannot hold a paraclete', { skip: needsBash, concurrency: true }, () => {
  const cases = [
    ['gcloud is not logged in', (s) => { s.account = ''; }, /not logged in/],
    ['no project is given or configured', (s) => { s.configProject = ''; }, /no project given/],
    ['the caller is not an owner', (s) => { s.deniedPermissions = ['resourcemanager.projects.setIamPolicy', 'compute.instances.create']; },
      /needs roles\/owner on your-gcp-project\. Missing: resourcemanager\.projects\.setIamPolicy compute\.instances\.create/],
    ['billing is off', (s) => { s.billingEnabled = false; }, /billing is not enabled/],
    ['the project is outside an organization', (s) => { s.ancestors = ['project']; }, /not inside a Google Cloud organization/],
  ];
  for (const [name, change, message] of cases) {
    test(name, async () => {
      const state = freshProject();
      change(state);
      const run = await createSandbox(state).run('install.sh', ['--yes']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, message);
      assert.deepEqual(writes(run.calls), []);
      assert.deepEqual(steps(run.stdout).map(([n]) => n), [1]);
    });
  }

  test('an unknown role, a bad name or a zone outside the region', async () => {
    for (const [args, message] of [
      [['--role', 'no-such-role'], /there is no role 'no-such-role'\. Roles: generic workspace-example/],
      [['--name', 'Bad,Name'], /the agent's name must be/],
      [['--region', 'europe-west1', '--zone', 'us-central1-a'], /the zone must be in europe-west1/],
    ]) {
      const run = await createSandbox().run('install.sh', ['--yes', ...args]);
      assert.equal(run.status, 1, args.join(' '));
      assert.match(run.stderr, message);
      assert.deepEqual(writes(run.calls), []);
    }
  });

  test('a database in Datastore mode', async () => {
    const state = freshProject();
    state.database = { type: 'DATASTORE_MODE', location: 'us-central1' };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is in DATASTORE_MODE\. paraclete needs Native mode/);
  });

  test('an unknown option', async () => {
    const run = await createSandbox().run('install.sh', ['--colour', 'blue']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unknown option: --colour/);
    assert.deepEqual(run.calls, []);
  });
});

describe('questions', { skip: needsBash, concurrency: true }, () => {
  test('asks for the role and the name when no flag or --yes answers them', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run'], { input: `${WORKSPACE_ROLE.id}\nAda Lovelace\n` });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Which role should the agent have\? \[generic\]/);
    assert.match(run.stderr, /What should the agent be called\? \[Paraclete\]/);
    const metadata = metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0]);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
    assert.equal(metadata['paraclete-agent-name'], 'Ada Lovelace');
  });

  test('asks nothing the flags answered', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--role', 'generic', '--name', 'Ada']);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /Which role|What should/);
  });

  test('changes nothing unless the confirmation is answered yes', async () => {
    const run = await createSandbox().run('install.sh', ['--role', 'generic', '--name', 'Ada'], { input: 'n\n' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Go ahead\? \[y\/N\]/);
    assert.match(run.stderr, /nothing was changed/);
    assert.deepEqual(writes(run.calls), []);
  });
});

describe('a real run, then re-runs', { skip: needsBash, concurrency: false }, () => {
  let box;
  let first;
  before(async () => {
    box = createSandbox();
    first = await box.run('install.sh', ['--yes']);
  });

  test('installs, waits for the agent and says how to watch it', () => {
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`the agent is ready on ${RELEASE_TAG} \\(${COMMITS.release}\\)`));
    assert.match(first.stdout, /gcloud compute ssh paraclete --zone=us-central1-a --project=your-gcp-project --tunnel-through-iap -- sudo journalctl -u 'paraclete-\*' -f/);
    const state = box.state();
    assert.equal(state.instances.paraclete.metadata['paraclete-ref'], COMMITS.release);
    assert.match(state.instances.paraclete.metadata['startup-script'], /bootstrap\.sh/);
    assert.deepEqual(state.buckets[BUCKET].policy.map(([role]) => role), ['roles/storage.objectAdmin', 'roles/storage.objectAdmin']);
    assert.equal(state.indexes.length, indexesFile.indexes.length);
    assert.equal(state.database.deleteProtection, true);
  });

  test('a re-run creates nothing again and only repairs the bucket settings', async () => {
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(writes(again.calls).map((call) => call.command), ['storage buckets update']);
    assert.match(again.stdout, /paraclete exists and its metadata already names/);
    assert.match(again.stdout, /the agent is ready/);
  });

  test('a re-run with another --ref moves the VM instead of creating one', async () => {
    const moved = await box.run('install.sh', ['--yes', '--ref', 'dev-branch']);
    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(writes(moved.calls).map((call) => call.command), ['storage buckets update', 'compute instances add-metadata']);
    const [update] = find(moved.commands, 'gcloud', 'compute', 'instances', 'add-metadata');
    assert.equal(flag(update, 'zone'), 'us-central1-a');
    assert.equal(metadataOf(update)['paraclete-ref'], COMMITS.devBranch);
    assert.equal(box.state().instances.paraclete.metadata['paraclete-release'], 'dev-branch');
    assert.match(moved.stdout, /picks up dev-branch \([0-9a-f]{40}\) at its next boot/);
    assert.match(moved.stdout, /gcloud compute instances reset paraclete --zone=us-central1-a --project=your-gcp-project/);
    assert.match(moved.stdout, new RegExp(`sudo /opt/paraclete/install/upgrade\\.sh --ref ${COMMITS.devBranch}`));
    assert.ok(!moved.calls.some((call) => call.command === 'firestore get agent/instance'), 'nothing to wait for yet');
  });
});

describe('the VM and the network as found', { skip: needsBash, concurrency: true }, () => {
  test('a VM in another zone is updated where it is', async () => {
    const state = freshProject();
    state.instances.paraclete = { zone: 'us-central1-f', metadata: { 'paraclete-ref': COMMITS.olderRelease } };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(find(run.commands, 'gcloud', 'compute', 'instances', 'create'), []);
    assert.equal(flag(find(run.commands, 'gcloud', 'compute', 'instances', 'add-metadata')[0], 'zone'), 'us-central1-f');
    assert.match(run.stdout, /already runs in us-central1-f/);
  });

  test("without a default network, it creates paraclete's own and puts the VM on it", async () => {
    const state = freshProject();
    state.networks = {};
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    const [network] = find(run.commands, 'gcloud', 'compute', 'networks', 'create');
    assert.equal(network[4], 'paraclete');
    assert.equal(flag(network, 'subnet-mode'), 'auto');
    assert.equal(flag(network, 'description'), 'Created by the paraclete installer');
    assert.equal(flag(find(run.commands, 'gcloud', 'compute', 'firewall-rules', 'create')[0], 'network'), 'paraclete');
    assert.equal(flag(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0], 'network'), 'paraclete');
  });

  test('a bootstrap that reports failure fails the install, with its reason', async () => {
    const state = freshProject();
    state.bootstrapReports = 'failed';
    state.bootstrapError = 'npm ci failed';
    const run = await createSandbox(state).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /the agent's install failed: npm ci failed/);
    assert.match(run.stdout, /journalctl -u 'paraclete-\*' -u google-startup-scripts/);
  });
});
