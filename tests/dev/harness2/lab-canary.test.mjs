// tests/dev/harness2/lab-canary.test.mjs: the harness lab's canary in a project of its own
// (dev/harness2/lab-canary.mjs, and the lab commands in live-runner.mjs and cli.mjs that use it). Against
// a fake gcloud that keeps the state of the projects it is asked to make, never a real one: both
// projects provisioned, each with what its VM needs; the driver's access to the canary's project; the
// canary's coordinates written into the driver's harness checkout as its owner, on a fake VM in a
// directory; the canary's project id, by default and when it must be given; a canary left in the lab's
// own project reported and never deleted; lab-status, lab-follow-main and canary per project, and canary
// failing when no smoke test ran; the region taken from the zone; lab-provision stopping before any
// change when a project cannot be billed or already holds another paraclete; and a second provisioning
// that changes nothing. And the follow-main updater still fast-forwards a checkout that holds the
// coordinates, because .local/ is ignored.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../../dev/harness2/cli.mjs';
import {
  LAB_CANARY,
  canaryInstanceEnv,
  canaryProjectFor,
  driverAccessOnCanary,
  instanceEnvRemoteCommand,
  instanceEnvResult,
  instanceEnvScript,
} from '../../../dev/harness2/lab-canary.mjs';
import { FOLLOW_MAIN, decodeFollowMainRemoteCommand, decodeRemoteRootCommand } from '../../../dev/harness2/lab-updater.mjs';
import { buildGcpLabPlan, createDevCanaryRunner, inspectGcpLabStatus, manageLabFollowMain, provisionGcpLab } from '../../../dev/harness2/live-runner.mjs';
import { loadInstanceEnv, sshArgs } from '../../../dev/dev-env.mjs';
import { bash as bashProgram, needsBash } from '../../install/harness.mjs';

const LAB = 'your-gcp-project';
const CANARY_PROJECT = `${LAB}-canary`;
const ZONE = 'us-central1-a';
const REPO = 'your-org/paraclete';
const COMMIT = '2'.repeat(40);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const UPDATER = fileURLToPath(new URL('../../../dev/harness2/lab-follow-main.sh', import.meta.url));
/** A project's agent account, built here so no address outside the placeholder domains is written down. */
const agentOf = (project) => ['paraclete-agent', `${project}.iam.gserviceaccount.com`].join('@');
const INSTALLED = 'lab-follow-main.installed=changed\nlab-follow-main.interval_minutes=30\nlab-follow-main.timer_enabled=enabled\nlab-follow-main.timer_active=active';
const posix = (path) => path.replace(/\\/g, '/');

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake gcloud for the lab: every call it is asked to make, and the state of the projects those calls
 * make, so a test can see what a run created and a second run can find it. `ssh(vm, project, decoded)`
 * answers `gcloud compute ssh`; by default the follow-main install succeeds, and the canary's
 * coordinates are written once (changed, then unchanged). `projects` exist and `billing` are billed
 * before the run; `listErrors` maps a project to what listing its VMs throws.
 */
function fakeCloud({ ssh, vms = [], projects = [], billing = [], listErrors = {} } = {}) {
  const calls = [];
  const state = {
    projects: new Set(projects),
    billing: new Set(billing),
    apis: new Set(),
    serviceAccounts: new Set(),
    bindings: new Set(),
    roles: new Map(),
    firestore: new Set(),
    buckets: new Set(),
    networks: new Set(projects.map((p) => `${p}/default`)),
    firewalls: new Set(),
    vms: new Map(vms.map((vm) => [`${vm.project}/${vm.name}`, vm])),
    instanceEnvs: new Map(),
    timers: new Set(),
  };
  const flag = (args, name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  /** install.sh's metadata, key=value,..., as a VM listing shows it. */
  const metadataItems = (text) => String(text || '').split(',').filter(Boolean).map((pair) => ({ key: pair.split('=')[0], value: pair.slice(pair.indexOf('=') + 1) }));
  const notFound = (what) => {
    throw Object.assign(new Error(`ERROR: (gcloud) NOT_FOUND: ${what} was not found`), { status: 1 });
  };
  const defaultSsh = (vm, project, decoded) => {
    const key = `${project}/${vm}`;
    if (decoded.name === LAB_CANARY.scriptName) {
      const content = /^CONTENT='([^']*)'$/m.exec(decoded.script)[1];
      const same = state.instanceEnvs.get(key) === content;
      state.instanceEnvs.set(key, content);
      return `lab-canary.instance_env=${same ? 'unchanged' : 'changed'}`;
    }
    const again = state.timers.has(key);
    state.timers.add(key);
    return again ? INSTALLED.replace('installed=changed', 'installed=unchanged') : INSTALLED;
  };
  function execGcloud(args, opts = {}) {
    calls.push({ args, opts });
    const [a, b, c, d] = args;
    const project = flag(args, 'project');
    if (a === 'projects' && b === 'describe') return state.projects.has(c) ? '123456789012' : notFound(c);
    if (a === 'projects' && b === 'create') {
      state.projects.add(c);
      state.networks.add(`${c}/default`);
      return '';
    }
    if (a === 'projects' && b === 'add-iam-policy-binding') {
      state.bindings.add(`project:${c} ${flag(args, 'member')} ${flag(args, 'role')}`);
      return '';
    }
    if (a === 'billing' && c === 'describe') return state.billing.has(d) ? 'True' : 'False';
    if (a === 'billing' && c === 'link') {
      state.billing.add(d);
      return '';
    }
    if (a === 'services' && b === 'enable') {
      for (const api of args.slice(2).filter((x) => !x.startsWith('--'))) state.apis.add(`${project} ${api}`);
      return '';
    }
    if (a === 'iam' && b === 'service-accounts') {
      if (c === 'describe') return state.serviceAccounts.has(d) ? d : notFound(d);
      if (c === 'create') {
        state.serviceAccounts.add([d, `${project}.iam.gserviceaccount.com`].join('@'));
        return '';
      }
      if (c === 'add-iam-policy-binding') {
        assert.ok(state.serviceAccounts.has(d), `${d} exists before it is bound`);
        state.bindings.add(`serviceAccount:${d} ${flag(args, 'member')} ${flag(args, 'role')}`);
        return '';
      }
    }
    if (a === 'iam' && b === 'roles') {
      const name = `projects/${project}/roles/${d}`;
      const role = state.roles.get(name);
      if (c === 'describe') return role ? JSON.stringify({ name, includedPermissions: role.permissions, ...(role.deleted ? { deleted: true } : {}) }) : notFound(name);
      if (c === 'create') {
        state.roles.set(name, { permissions: flag(args, 'permissions').split(','), deleted: false, title: flag(args, 'title') });
        return '';
      }
      if (c === 'undelete') {
        role.deleted = false;
        return '';
      }
      if (c === 'update') {
        role.permissions = flag(args, 'permissions').split(',');
        return '';
      }
    }
    if (a === 'firestore' && c === 'describe') return state.firestore.has(project) ? 'FIRESTORE_NATIVE' : notFound('(default)');
    if (a === 'firestore' && c === 'create') {
      state.firestore.add(project);
      return '';
    }
    if (a === 'storage' && b === 'buckets') {
      if (c === 'describe') return state.buckets.has(d) ? d.slice(5) : notFound(d);
      if (c === 'create') {
        state.buckets.add(d);
        return '';
      }
      if (c === 'add-iam-policy-binding') {
        state.bindings.add(`bucket:${d} ${flag(args, 'member')} ${flag(args, 'role')}`);
        return '';
      }
    }
    if (a === 'compute' && (b === 'networks' || b === 'firewall-rules')) {
      const set = b === 'networks' ? state.networks : state.firewalls;
      if (c === 'describe') return set.has(`${project}/${d}`) ? d : notFound(d);
      if (c === 'create') {
        set.add(`${project}/${d}`);
        return '';
      }
    }
    if (a === 'compute' && b === 'instances') {
      const key = `${project}/${d}`;
      if (c === 'describe') return state.vms.get(key)?.zone === flag(args, 'zone') ? d : notFound(d);
      if (c === 'create') {
        state.vms.set(key, {
          project,
          name: d,
          zone: flag(args, 'zone'),
          status: 'RUNNING',
          serviceAccount: flag(args, 'service-account'),
          network: flag(args, 'network'),
          metadata: flag(args, 'metadata'),
          items: metadataItems(flag(args, 'metadata')),
        });
        return '';
      }
      if (c === 'add-metadata') {
        state.vms.get(key).metadata = flag(args, 'metadata');
        state.vms.get(key).items = metadataItems(flag(args, 'metadata'));
        return '';
      }
      if (c === 'list') {
        if (listErrors[project]) throw listErrors[project];
        return JSON.stringify([...state.vms.values()].filter((vm) => vm.project === project).map((vm) => ({
          name: vm.name,
          status: vm.status,
          zone: `projects/${project}/zones/${vm.zone}`,
          metadata: { items: vm.items || [] },
        })));
      }
    }
    if (a === 'compute' && b === 'ssh') {
      const sshProject = args[args.indexOf('--project') + 1];
      const decoded = decodeRemoteRootCommand(args[args.indexOf('--command') + 1]);
      assert.ok(decoded, 'every remote command is one the lab built');
      assert.ok(state.vms.has(`${sshProject}/${c}`), `${c} is in ${sshProject}`);
      return (ssh || defaultSsh)(c, sshProject, decoded);
    }
    throw new Error(`the fake gcloud has no answer for: gcloud ${args.join(' ')}`);
  }
  /** Everything the state holds, comparable with deepEqual. */
  const snapshot = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v instanceof Map ? [...v.entries()].sort() : [...v].sort()]))));
  return { calls, state, execGcloud, snapshot };
}

/** The calls that create, link, bring back, change or delete something. */
const writes = (calls) => calls.map((c) => c.args).filter((a) => a[1] === 'create' || ['create', 'link', 'undelete', 'update', 'delete'].includes(a[2]));

const provision = (cloud, extra = {}) => provisionGcpLab({
  projectId: LAB,
  billingAccount: '000000-000000-000000',
  repo: REPO,
  commit: COMMIT,
  sleep: () => {},
  execGcloud: cloud.execGcloud,
  ...extra,
});

describe('the canary\'s project', () => {
  it('is the lab\'s with -canary, unless --canary-project names one, and is never the lab\'s own', () => {
    assert.equal(canaryProjectFor('paraclete-h2-lab'), 'paraclete-h2-lab-canary');
    assert.equal(canaryProjectFor(LAB), CANARY_PROJECT);
    assert.equal(canaryProjectFor('a'.repeat(23)), `${'a'.repeat(23)}-canary`, '23 characters leave room for -canary');
    assert.equal(canaryProjectFor('paraclete-h2-evolution-lab-01', 'h2-canary-01'), 'h2-canary-01');

    assert.throws(() => canaryProjectFor('paraclete-h2-evolution-lab-01'),
      /^Error: --canary-project is required: the default, paraclete-h2-evolution-lab-01-canary, is 36 characters, and a project id has at most 30\. Name the canary's project with --canary-project <id>\.$/);
    assert.throws(() => canaryProjectFor('a'.repeat(24)), /--canary-project is required: .* is 31 characters/);
    assert.throws(() => canaryProjectFor('example.com:lab'), /--canary-project is required: the default, example\.com:lab-canary, is not a project id/);
    assert.throws(() => canaryProjectFor(LAB, LAB), /must name a project of its own, not the lab's \(your-gcp-project\): one project holds one paraclete/);
    for (const bad of ['Canary', 'short', 'ends-with-', '1-starts-with-a-digit', 'x'.repeat(31)]) {
      assert.throws(() => canaryProjectFor(LAB, bad), /is not a project id \(6 to 30 lowercase letters/, bad);
    }
    assert.throws(() => canaryProjectFor(LAB, true), /--canary-project needs a project id/);
  });

  it('every lab command refuses, with what to do, when it cannot be worked out', async () => {
    const long = ['--project', 'paraclete-h2-evolution-lab-01'];
    const touched = [];
    const execGcloud = (args) => {
      touched.push(args);
      return '';
    };
    for (const command of [['lab-plan'], ['lab-provision'], ['lab-provision', '--dry-run'], ['lab-status'], ['lab-follow-main', '--status'], ['canary']]) {
      const res = await runCli([...command, ...long], { execGcloud });
      assert.equal(res.ok, false, command.join(' '));
      assert.match(res.error, /^--canary-project is required: /, command.join(' '));
    }
    assert.deepEqual(touched, [], 'nothing reached gcloud');

    const named = await runCli(['lab-plan', ...long, '--canary-project', 'h2-canary-01']);
    assert.equal(named.ok, true);
    assert.equal(named.plan.canaryProjectId, 'h2-canary-01');
    assert.match((await runCli(['lab-plan', '--canary-project', 'paraclete-h2-lab'])).error, /a project of its own/);
    assert.match((await runCli(['lab-plan', '--canary-project'])).error, /--canary-project needs a project id/);
  });
});

describe('lab-provision: two projects, one paraclete each', () => {
  it('provisions each project with what its VM needs, and each VM in its own project', () => {
    const cloud = fakeCloud();
    const res = provision(cloud);
    assert.equal(res.ok, true, JSON.stringify(res, null, 2));
    assert.deepEqual(res.plan.projects.map((p) => p.projectId), [LAB, CANARY_PROJECT]);

    const s = cloud.state;
    for (const project of [LAB, CANARY_PROJECT]) {
      assert.ok(s.projects.has(project), `${project} exists`);
      assert.ok(s.billing.has(project), `${project} is billed`);
      for (const api of res.plan.apis) assert.ok(s.apis.has(`${project} ${api}`), `${api} on ${project}`);
      assert.ok(s.serviceAccounts.has(agentOf(project)), `${project} has its own agent account`);
      for (const role of res.plan.projectRoles) {
        assert.ok(s.bindings.has(`project:${project} serviceAccount:${agentOf(project)} ${role}`), `${role} for ${project}'s agent`);
      }
      assert.ok(s.firestore.has(project), `${project} has its own Firestore`);
      assert.ok(s.buckets.has(`gs://${project}-paraclete`), `${project} has its own bucket`);
      assert.ok(s.bindings.has(`bucket:gs://${project}-paraclete serviceAccount:${agentOf(project)} roles/storage.objectAdmin`));
      assert.ok(s.firewalls.has(`${project}/paraclete-allow-iap-ssh`) && s.firewalls.has(`${project}/paraclete-deny-ingress`), `${project}'s IAP firewall`);
      for (const step of ['project', 'billing', 'apis', 'service-account', 'iam', 'firestore', 'bucket', 'network']) {
        assert.ok(res.stepsExecuted.some((e) => e.step === step && e.project === project), `${step} for ${project}`);
      }
    }
    assert.equal(s.projects.size, 2);
    assert.equal(s.firestore.size, 2, 'one Firestore database per paraclete');

    const driver = s.vms.get(`${LAB}/paraclete-h2-driver`);
    const canary = s.vms.get(`${CANARY_PROJECT}/paraclete-h2-canary`);
    assert.equal(driver.serviceAccount, agentOf(LAB));
    assert.equal(canary.serviceAccount, agentOf(CANARY_PROJECT));
    assert.match(driver.metadata, new RegExp(`paraclete-role=paraclete-h2,.*paraclete-bucket=${LAB}-paraclete$`));
    assert.match(canary.metadata, new RegExp(`paraclete-role=software-engineer,.*paraclete-bucket=${CANARY_PROJECT}-paraclete$`));
    assert.equal(s.vms.has(`${LAB}/paraclete-h2-canary`), false, 'no canary in the lab\'s project');
    assert.equal(s.vms.has(`${CANARY_PROJECT}/paraclete-h2-driver`), false);

    // The follow-main timer goes on each VM in its own project.
    assert.deepEqual(res.followMain.map((r) => [r.name, r.project, r.ok]), [
      ['paraclete-h2-driver', LAB, true],
      ['paraclete-h2-canary', CANARY_PROJECT, true],
    ]);
  });

  it('gives the driver\'s agent account, on the canary\'s project only, what the dev/ commands need', () => {
    const cloud = fakeCloud();
    const res = provision(cloud);
    const driverMember = `serviceAccount:${agentOf(LAB)}`;
    const sshRole = `projects/${CANARY_PROJECT}/roles/paracleteLabDriverSsh`;

    const onCanary = [...cloud.state.bindings].filter((b) => b.includes(` ${driverMember} `) && b.startsWith(`project:${CANARY_PROJECT} `));
    assert.deepEqual(onCanary.map((b) => b.split(' ')[2]).sort(), [
      sshRole,
      'roles/datastore.user',
      'roles/iap.tunnelResourceAccessor',
      'roles/run.viewer',
    ].sort());
    assert.ok(cloud.state.bindings.has(`serviceAccount:${agentOf(CANARY_PROJECT)} ${driverMember} roles/iam.serviceAccountUser`),
      'actAs on the canary\'s account, which setting its VM\'s metadata takes');
    assert.equal([...cloud.state.bindings].filter((b) => b.includes(` ${driverMember} `) && !b.startsWith(`project:${LAB} `) && !b.startsWith(`bucket:gs://${LAB}-paraclete `) && !b.startsWith(`serviceAccount:${agentOf(LAB)} `)).length, 5,
      'nothing else outside its own project');
    assert.equal([...cloud.state.bindings].some((b) => b.includes(`serviceAccount:${agentOf(CANARY_PROJECT)}`) && b.startsWith(`project:${LAB} `)), false,
      'the canary gets nothing in the driver\'s project');

    // The SSH role holds only what gcloud compute ssh calls: no create, delete, start or stop.
    const role = cloud.state.roles.get(sshRole);
    assert.deepEqual(role.permissions, [...LAB_CANARY.sshRole.permissions].sort());
    assert.ok(role.permissions.includes('compute.instances.setMetadata'));
    assert.equal(role.permissions.some((p) => /\.(create|delete|start|stop|reset|setServiceAccount|setIamPolicy)$/.test(p)), false);
    assert.equal(role.permissions.some((p) => p.startsWith('compute.projects.setCommonInstanceMetadata')), false, 'never the project\'s metadata, which every VM reads');
    assert.ok(res.stepsExecuted.some((e) => e.step === 'driver-access:ssh-role' && e.project === CANARY_PROJECT && e.status === 'created'));
    assert.ok(res.stepsExecuted.some((e) => e.step === 'driver-access' && e.project === CANARY_PROJECT && e.status === 'bound'));
    assert.deepEqual(res.plan.driverAccess, driverAccessOnCanary({
      canaryProjectId: CANARY_PROJECT,
      driverServiceAccountEmail: agentOf(LAB),
      canaryServiceAccountEmail: agentOf(CANARY_PROJECT),
    }));
  });

  it('a custom role someone changed or deleted is put back as it should be', () => {
    const cloud = fakeCloud();
    provision(cloud);
    const name = `projects/${CANARY_PROJECT}/roles/paracleteLabDriverSsh`;
    cloud.state.roles.get(name).permissions = ['compute.instances.get', 'compute.instances.delete'];
    const changed = provision(cloud);
    assert.ok(changed.stepsExecuted.some((e) => e.step === 'driver-access:ssh-role' && e.status === 'updated'));
    assert.deepEqual(cloud.state.roles.get(name).permissions, [...LAB_CANARY.sshRole.permissions].sort());

    cloud.state.roles.get(name).deleted = true;
    const deleted = provision(cloud);
    assert.ok(deleted.stepsExecuted.some((e) => e.step === 'driver-access:ssh-role' && e.status === 'undeleted'));
    assert.equal(cloud.state.roles.get(name).deleted, false);
  });

  it('writes the canary\'s coordinates into the driver\'s harness checkout, over IAP SSH to the driver', () => {
    const cloud = fakeCloud();
    const res = provision(cloud);
    const envCalls = cloud.calls.filter((c) => c.args[1] === 'ssh' && decodeRemoteRootCommand(c.args.at(-1)).name === LAB_CANARY.scriptName);
    assert.equal(envCalls.length, 1);
    const [call] = envCalls;
    const plan = buildGcpLabPlan({ projectId: LAB });
    assert.deepEqual(call.args, sshArgs({ VM: 'paraclete-h2-driver', ZONE, PROJECT_ID: LAB }, instanceEnvRemoteCommand({ text: plan.instanceEnv.text, checkout: FOLLOW_MAIN.harnessCheckout })));
    assert.equal(call.opts.interactive, true, 'as the follow-main install step runs');
    const followMainCalls = cloud.calls.filter((c) => c.args[1] === 'ssh' && decodeFollowMainRemoteCommand(c.args.at(-1)));
    assert.ok(cloud.calls.indexOf(followMainCalls.at(-1)) < cloud.calls.indexOf(call), 'after the timer is on both VMs');

    assert.equal(res.instanceEnv.ok, true);
    assert.equal(res.instanceEnv.state, 'changed');
    assert.equal(res.instanceEnv.path, '/var/lib/paraclete/harness2-repo/.local/instance.env');
    assert.ok(res.stepsExecuted.some((e) => e.step === 'instance-env:paraclete-h2-driver' && e.project === LAB && e.status === 'changed'));

    // The file is what dev-env.mjs reads: the canary, in its project, logged in to as lab-driver.
    const env = loadInstanceEnv({ readFile: () => plan.instanceEnv.text });
    assert.deepEqual(env, { PROJECT_ID: CANARY_PROJECT, REGION: 'us-central1', ZONE, VM: 'paraclete-h2-canary', DASHBOARD_URL: null, SSH_USER: 'lab-driver' });
    assert.deepEqual(sshArgs(env, 'sudo -n true').slice(0, 7), ['compute', 'ssh', 'lab-driver@paraclete-h2-canary', '--zone', ZONE, '--project', CANARY_PROJECT]);
    assert.equal(plan.instanceEnv.text, canaryInstanceEnv({ projectId: CANARY_PROJECT, region: 'us-central1', zone: ZONE }));
  });

  it('a driver without its harness checkout yet leaves the result not ok, with the command to run later', () => {
    const cloud = fakeCloud({
      ssh: (vm, project, decoded) => (decoded.name === LAB_CANARY.scriptName ? 'lab-canary.instance_env=no-checkout' : INSTALLED),
    });
    const res = provision(cloud);
    assert.equal(res.ok, false);
    assert.deepEqual(res.followMain.map((r) => r.ok), [true, true], 'the timer is on');
    assert.equal(res.instanceEnv.state, 'no-checkout');
    assert.equal(res.instanceEnv.error, 'paraclete-h2-driver: there is no harness checkout at /var/lib/paraclete/harness2-repo yet');
    assert.match(res.instanceEnv.hint, /node dev\/harness2\/cli\.mjs lab-provision --project your-gcp-project --canary-project your-gcp-project-canary --region us-central1 --zone us-central1-a --interval 30$/);
    assert.equal(cloud.calls.filter((c) => c.args[1] === 'ssh' && decodeRemoteRootCommand(c.args.at(-1)).name === LAB_CANARY.scriptName).length, 1,
      'a missing checkout is an answer, not tried again');
  });

  it('a second run changes nothing', () => {
    const cloud = fakeCloud();
    const first = provision(cloud);
    assert.equal(first.ok, true);
    const before = cloud.snapshot();
    const callsBefore = cloud.calls.length;

    const second = provision(cloud);
    assert.equal(second.ok, true);
    assert.deepEqual(cloud.snapshot(), before);
    assert.deepEqual(writes(cloud.calls.slice(callsBefore)), [], 'nothing created, linked, changed or deleted');
    const status = (step, project) => second.stepsExecuted.find((e) => e.step === step && e.project === project)?.status;
    for (const project of [LAB, CANARY_PROJECT]) {
      assert.equal(status('project', project), 'exists');
      assert.equal(status('billing', project), 'enabled');
      assert.equal(status('service-account', project), 'exists');
      assert.equal(status('firestore', project), 'exists');
      assert.equal(status('bucket', project), 'exists');
    }
    assert.equal(status('driver-access:ssh-role', CANARY_PROJECT), 'exists');
    assert.equal(status('vm:paraclete-h2-driver', LAB), 'updated');
    assert.equal(status('vm:paraclete-h2-canary', CANARY_PROJECT), 'updated');
    assert.equal(status('follow-main:paraclete-h2-driver', LAB), 'unchanged');
    assert.equal(status('follow-main:paraclete-h2-canary', CANARY_PROJECT), 'unchanged');
    assert.equal(status('instance-env:paraclete-h2-driver', LAB), 'unchanged');
  });

  it('a dry run plans both projects and calls nothing', async () => {
    const cloud = fakeCloud();
    const res = await runCli(['lab-provision', '--project', LAB, '--dry-run'], { execGcloud: cloud.execGcloud });
    assert.equal(res.ok, true);
    assert.deepEqual(res.plan.vms.map((vm) => [vm.name, vm.projectId]), [['paraclete-h2-driver', LAB], ['paraclete-h2-canary', CANARY_PROJECT]]);
    assert.deepEqual(cloud.calls, []);
  });
});

describe('a canary left in the lab\'s own project', () => {
  const OLD = { project: LAB, name: 'paraclete-h2-canary', zone: 'us-central1-b', status: 'RUNNING', items: [{ key: 'paraclete-role', value: 'software-engineer' }] };
  const DELETE = 'gcloud compute instances delete paraclete-h2-canary --project=your-gcp-project --zone=us-central1-b';

  it('lab-provision makes the new one in its own project, and names the old one with the command that deletes it', () => {
    // An existing lab: its billed project holds the old canary, installed as a paraclete.
    const cloud = fakeCloud({ vms: [OLD], projects: [LAB], billing: [LAB] });
    const res = provision(cloud);
    assert.equal(res.ok, true, 'the old canary, a paraclete in the lab\'s project, does not stop the lab');
    assert.ok(cloud.state.vms.has(`${LAB}/paraclete-h2-canary`), 'the old canary stands');
    assert.ok(cloud.state.vms.has(`${CANARY_PROJECT}/paraclete-h2-canary`), 'the new one is in the canary\'s project');
    assert.equal(cloud.calls.some((c) => c.args.includes('delete')), false, 'nothing is deleted');
    assert.equal(cloud.calls.some((c) => c.args[1] === 'ssh' && c.args.includes(LAB) && c.args[2] === 'paraclete-h2-canary'), false, 'the old one is not touched over SSH');
    assert.equal(res.oldCanary.name, 'paraclete-h2-canary');
    assert.equal(res.oldCanary.project, LAB);
    assert.equal(res.oldCanary.zone, 'us-central1-b');
    assert.equal(res.oldCanary.deleteCommand, DELETE);
    assert.match(res.oldCanary.note, /two paracletes share its Firestore and bucket/);
    assert.match(res.oldCanary.note, new RegExp(`Once the canary in ${CANARY_PROJECT} is up`));
    assert.ok(res.stepsExecuted.some((e) => e.step === 'old-canary' && e.status === 'kept' && e.detail === DELETE));

    const clean = provision(fakeCloud());
    assert.equal('oldCanary' in clean, false);
    assert.ok(clean.stepsExecuted.some((e) => e.step === 'old-canary' && e.status === 'none'));
  });

  it('lab-status flags it, and reads the timers of the lab\'s own VMs only', async () => {
    const cloud = fakeCloud({ vms: [OLD], projects: [LAB], billing: [LAB] });
    provision(cloud);
    const statusCalls = cloud.calls.length;
    const res = await runCli(['lab-status', '--project', LAB], { execGcloud: cloud.execGcloud });
    assert.equal(res.ok, false);
    assert.equal(res.problems.length, 1);
    assert.match(res.problems[0], new RegExp(`paraclete-h2-canary still runs in ${LAB}, the driver's project`));
    assert.ok(res.problems[0].endsWith(DELETE));
    assert.equal(res.oldCanary.deleteCommand, DELETE);
    const old = res.vms.find((vm) => vm.project === LAB && vm.name === 'paraclete-h2-canary');
    assert.equal(old.oldCanary, true);
    assert.equal('followMain' in old, false);
    const probed = cloud.calls.slice(statusCalls).filter((c) => c.args[1] === 'ssh').map((c) => [c.args[2], c.args[c.args.indexOf('--project') + 1]]);
    assert.deepEqual(probed, [['paraclete-h2-driver', LAB], ['paraclete-h2-canary', CANARY_PROJECT]]);

    cloud.state.vms.delete(`${LAB}/paraclete-h2-canary`);
    const cleaned = await runCli(['lab-status', '--project', LAB], { execGcloud: cloud.execGcloud });
    assert.equal(cleaned.ok, true);
    assert.deepEqual(cleaned.problems, []);
    assert.equal('oldCanary' in cleaned, false);
  });
});

describe('the commands that address the canary use its project', () => {
  it('lab-status lists each project, and says when one cannot be listed', () => {
    const cloud = fakeCloud();
    provision(cloud, { canaryProjectId: 'your-canary-01' });
    const res = inspectGcpLabStatus({ projectId: LAB, canaryProjectId: 'your-canary-01', execGcloud: cloud.execGcloud });
    assert.equal(res.ok, true);
    assert.equal(res.canaryProjectId, 'your-canary-01');
    assert.deepEqual(res.vms.map((vm) => [vm.name, vm.project, vm.followMain?.ok]), [
      ['paraclete-h2-driver', LAB, true],
      ['paraclete-h2-canary', 'your-canary-01', true],
    ]);

    const missing = inspectGcpLabStatus({
      projectId: LAB,
      execGcloud: (args, opts) => {
        if (args.includes(`--project=${CANARY_PROJECT}`)) throw Object.assign(new Error('Command failed: gcloud compute instances list ...'), { status: 1 });
        return cloud.execGcloud(args, opts);
      },
    });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.problems, [`the VMs of ${CANARY_PROJECT} could not be listed: gcloud exited with code 1`]);
  });

  it('lab-follow-main --install, --uninstall and --status reach each VM in its own project', async () => {
    for (const action of ['install', 'uninstall', 'status']) {
      const seen = [];
      const res = await runCli(['lab-follow-main', `--${action}`, '--project', LAB, '--canary-project', 'your-canary-01', '--zone', 'us-central1-b'], {
        execGcloud: (args) => {
          seen.push([args[2], args[args.indexOf('--zone') + 1], args[args.indexOf('--project') + 1], decodeFollowMainRemoteCommand(args.at(-1)) !== null]);
          if (action === 'install') return INSTALLED;
          if (action === 'uninstall') return 'lab-follow-main.removed=yes\nlab-follow-main.service_active=inactive';
          return 'lab-follow-main.timer_active=active\nlab-follow-main.installed=';
        },
      });
      assert.equal(res.ok, true, action);
      assert.equal(res.canaryProjectId, 'your-canary-01');
      assert.deepEqual(seen, [
        ['paraclete-h2-driver', 'us-central1-b', LAB, true],
        ['paraclete-h2-canary', 'us-central1-b', 'your-canary-01', true],
      ], action);
      assert.deepEqual(res.vms.map((vm) => vm.project), [LAB, 'your-canary-01']);
    }
    assert.equal(manageLabFollowMain({ action: 'status', execGcloud: () => '' }).vms[1].project, 'paraclete-h2-lab-canary', 'the default lab\'s canary');
  });

  it('lab-plan prints every command with both projects', () => {
    const plan = buildGcpLabPlan({ projectId: LAB, billingAccount: '000000-000000-000000' });
    const flags = `--project ${LAB} --canary-project ${CANARY_PROJECT} --region us-central1 --zone ${ZONE}`;
    for (const project of [LAB, CANARY_PROJECT]) {
      assert.ok(plan.commands.some((c) => c.startsWith(`gcloud projects create ${project} `)), project);
      assert.ok(plan.commands.includes(`gcloud billing projects link ${project} --billing-account=000000-000000-000000`), project);
      assert.ok(plan.commands.some((c) => c.startsWith('gcloud services enable ') && c.endsWith(`--project=${project}`)), project);
    }
    assert.ok(plan.commands.some((c) => c.startsWith(`gcloud compute instances create paraclete-h2-driver --project=${LAB} `)));
    assert.ok(plan.commands.some((c) => c.startsWith(`gcloud compute instances create paraclete-h2-canary --project=${CANARY_PROJECT} `)));
    assert.ok(plan.commands.includes(`node dev/harness2/cli.mjs lab-follow-main --install --interval 30 ${flags}`));
    assert.ok(plan.commands.includes(`node dev/harness2/cli.mjs lab-status ${flags}`));
    assert.equal(plan.commands.some((c) => c.includes('cli.mjs canary')), false, 'not a command that reaches no VM');
    assert.equal(plan.commands.some((c) => c.includes('gcloud config set project')), false, 'no one project is the default');
  });

  it('canary runs against the lab\'s canary in its project by default', async () => {
    const smokes = [];
    const runSmoke = async (target) => {
      smokes.push(target);
      return { pass: true };
    };
    const res = await runCli(['canary', '--role', 'software-engineer'], { runSmoke });
    assert.equal(res.ok, true);
    assert.equal(res.canaryAgent, 'paraclete-h2-canary');
    assert.equal(res.canaryProject, 'paraclete-h2-lab-canary');
    assert.deepEqual(smokes[0], { canaryAgent: 'paraclete-h2-canary', role: 'software-engineer', projectId: 'paraclete-h2-lab-canary', zone: ZONE });

    await runCli(['canary', '--project', LAB, '--zone', 'us-central1-b', '--role', 'software-engineer'], { runSmoke });
    assert.deepEqual(smokes[1], { canaryAgent: 'paraclete-h2-canary', role: 'software-engineer', projectId: CANARY_PROJECT, zone: 'us-central1-b' });
    await runCli(['canary', '--agent', 'other-vm', '--canary-project', 'your-canary-01', '--role', 'software-engineer'], { runSmoke });
    assert.deepEqual(smokes[2], { canaryAgent: 'other-vm', role: 'software-engineer', projectId: 'your-canary-01', zone: ZONE });
  });

  it('canary with no smoke test wired fails and says nothing ran, never a pass it did not check', async () => {
    const res = await runCli(['canary', '--role', 'software-engineer']);
    assert.equal(res.ok, false);
    assert.equal(res.ran, false);
    assert.equal(res.canaryProject, 'paraclete-h2-lab-canary');
    assert.match(res.error, /^canary ran nothing: no smoke test is wired to a VM here, so there is no result\..*node dev\/smoke\.mjs$/);
    assert.equal('smokePassed' in res, false);

    const tasksRun = [];
    const runner = createDevCanaryRunner({ runTask: async (task) => tasksRun.push(task) });
    assert.deepEqual(await runner({ canaryAgent: LAB_CANARY.vm, tasks: [{ id: 't1', expectedClauses: ['x'] }] }), { smokePassed: false, rollouts: [] });
    assert.deepEqual(tasksRun, [], 'no task runs, and no rollout is made up');
  });
});

describe('the lab\'s region and zone', () => {
  it('--zone alone sets its region, so the canary\'s instance.env is one every dev/ command takes', () => {
    const cloud = fakeCloud();
    const res = provision(cloud, { zone: 'europe-west1-b' });
    assert.equal(res.ok, true);
    assert.equal(res.plan.region, 'europe-west1');
    const env = loadInstanceEnv({ readFile: () => res.plan.instanceEnv.text });
    assert.deepEqual([env.REGION, env.ZONE], ['europe-west1', 'europe-west1-b']);
    const located = cloud.calls.map((c) => c.args).filter((a) => a[1] === 'databases' || a[1] === 'buckets').filter((a) => a[2] === 'create');
    assert.equal(located.length, 4, 'a database and a bucket in each project');
    assert.ok(located.every((a) => a.includes('--location=europe-west1')), 'in the zone\'s region');
    assert.ok(cloud.calls.filter((c) => c.args[1] === 'instances' && c.args[2] === 'create').every((c) => c.args.includes('--zone=europe-west1-b')));

    const regionOnly = buildGcpLabPlan({ projectId: LAB, region: 'asia-east1' });
    assert.deepEqual([regionOnly.region, regionOnly.zone], ['asia-east1', 'asia-east1-a']);
    const neither = buildGcpLabPlan({ projectId: LAB });
    assert.deepEqual([neither.region, neither.zone], ['us-central1', 'us-central1-a']);
  });

  it('a zone outside --region, or a malformed one, is refused before anything runs; printed commands keep the region', async () => {
    const touched = [];
    const execGcloud = (args) => {
      touched.push(args);
      return '';
    };
    for (const command of [['lab-plan'], ['lab-provision'], ['lab-status'], ['lab-follow-main', '--status'], ['canary']]) {
      const res = await runCli([...command, '--region', 'us-central1', '--zone', 'europe-west1-b'], { execGcloud });
      assert.equal(res.ok, false, command.join(' '));
      assert.equal(res.error, '--zone europe-west1-b is not in --region us-central1: give a zone in the region, or --zone alone', command.join(' '));
    }
    assert.deepEqual(touched, []);
    assert.match((await runCli(['lab-plan', '--zone', 'central'])).error, /--zone must be a zone such as us-central1-a, got 'central'/);
    assert.match((await runCli(['lab-plan', '--region', 'US'])).error, /--region must be a region such as us-central1, got 'US'/);
    assert.match((await runCli(['lab-plan', '--zone'])).error, /--zone must be a zone/);

    const plan = buildGcpLabPlan({ projectId: LAB, zone: 'europe-west1-b' });
    assert.ok(plan.commands.includes(`node dev/harness2/cli.mjs lab-status --project ${LAB} --canary-project ${CANARY_PROJECT} --region europe-west1 --zone europe-west1-b`));
    const unreachable = provision(fakeCloud({ ssh: () => { throw Object.assign(new Error('Command failed'), { status: 255 }); } }), { zone: 'europe-west1-b', sshAttempts: 1 });
    assert.match(unreachable.hint, /--region europe-west1 --zone europe-west1-b$/, 'a retry keeps the region');
    assert.match(unreachable.instanceEnv.hint, /--region europe-west1 --zone europe-west1-b --interval 30$/);
  });
});

describe('lab-provision stops before it changes anything', () => {
  it('when the canary\'s new project would have no billing and no --billing is given, naming the project and the flag', () => {
    // An existing lab moving to two projects, run again without --billing.
    const cloud = fakeCloud({ projects: [LAB], billing: [LAB] });
    const res = provision(cloud, { billingAccount: undefined });
    assert.equal(res.ok, false);
    assert.equal(res.error, `${CANARY_PROJECT} does not exist yet, and a new project has no billing account, so its APIs cannot be enabled. Run lab-provision again with --billing <account-id>, and --org <org-id> too if the lab is in an organization. Nothing was changed.`);
    assert.deepEqual(res.stepsExecuted, []);
    assert.deepEqual(writes(cloud.calls), [], 'no project created');
    assert.equal(cloud.calls.some((c) => c.args[0] === 'services'), false, 'no raw gcloud error from services enable');

    const unbilled = fakeCloud({ projects: [LAB, CANARY_PROJECT], billing: [LAB] });
    assert.match(provision(unbilled, { billingAccount: undefined }).error, new RegExp(`^${CANARY_PROJECT} has no billing account linked, so its APIs cannot be enabled\\. Run lab-provision again with --billing`));

    // With the billing account, the same lab goes ahead; after that, a run without it does too.
    assert.equal(provision(cloud).ok, true);
    assert.equal(provision(cloud, { billingAccount: undefined }).ok, true, 'both projects are billed now');
  });

  it('when a project already holds a paraclete other than its own lab VM', () => {
    const paraclete = (project, name) => ({ project, name, zone: ZONE, status: 'RUNNING', items: [{ key: 'paraclete-role', value: 'generic' }, { key: 'paraclete-ref', value: COMMIT }] });
    const taken = fakeCloud({ projects: [LAB, 'your-canary-01'], billing: [LAB, 'your-canary-01'], vms: [paraclete('your-canary-01', 'paraclete')] });
    const res = provision(taken, { canaryProjectId: 'your-canary-01' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'your-canary-01 already holds a paraclete (paraclete), and one project holds one paraclete. Name another project with --canary-project. Nothing was changed.');
    assert.deepEqual(writes(taken.calls), []);
    assert.equal(taken.calls.some((c) => c.args.includes('add-iam-policy-binding')), false, 'no grant in another instance\'s project');

    const labTaken = fakeCloud({ projects: [LAB], billing: [LAB], vms: [paraclete(LAB, 'paraclete')] });
    assert.match(provision(labTaken).error, /^your-gcp-project already holds a paraclete \(paraclete\), .* Name another project with --project\./);

    // A VM that is not a paraclete, or the lab's own VM from an earlier run, is no reason to stop.
    const plain = fakeCloud({ projects: [LAB, CANARY_PROJECT], billing: [LAB, CANARY_PROJECT], vms: [{ project: CANARY_PROJECT, name: 'build-box', zone: ZONE, status: 'RUNNING' }, paraclete(CANARY_PROJECT, 'paraclete-h2-canary')] });
    assert.equal(provision(plain).ok, true);
  });

  it('when a project\'s VMs cannot be listed, unless Compute Engine is simply not enabled there yet', () => {
    const disabled = Object.assign(new Error('Command failed'), { status: 1, stderr: 'ERROR: (gcloud.compute.instances.list) API [compute.googleapis.com] not enabled on project [123456789012].' });
    const fresh = fakeCloud({ projects: [LAB, CANARY_PROJECT], billing: [LAB, CANARY_PROJECT], listErrors: { [CANARY_PROJECT]: disabled } });
    assert.equal(provision(fresh).ok, true, 'a project without Compute Engine has no VM to be another paraclete');

    const denied = fakeCloud({ projects: [LAB, CANARY_PROJECT], billing: [LAB, CANARY_PROJECT], listErrors: { [CANARY_PROJECT]: Object.assign(new Error('Command failed: gcloud compute instances list'), { status: 1, stderr: 'PERMISSION_DENIED' }) } });
    const stopped = provision(denied);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, `the VMs of ${CANARY_PROJECT} could not be listed (gcloud exited with code 1), so it is not known whether it already holds a paraclete. Nothing was changed.`);
    assert.deepEqual(writes(denied.calls), []);
  });
});

describe('the instance.env script on a fake driver', { skip: needsBash }, () => {
  const realProgram = (name) => spawnSync(bashProgram, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  const REAL_GIT = realProgram('git');
  const REAL_STAT = realProgram('stat');
  const SHIMS = {
    runuser: String.raw`[[ "$1" == -u && "$3" == -- ]] || { echo 'runuser: unexpected arguments' >&2; exit 64; }
printf 'runuser %s\n' "$2" >> "$FAKE_LOG"
shift 3
exec "$@"`,
    stat: String.raw`if [[ "$1" == -c && "$2" == %U ]]; then printf '%s\n' "$FAKE_OWNER"; exit 0; fi
exec "$REAL_STAT" "$@"`,
    getent: String.raw`[[ "$1" == passwd && "$2" == paraclete ]] || exit 2
printf 'paraclete:x:999:999::%s:/usr/sbin/nologin\n' "$FAKE_HOME"`,
    git: String.raw`if [[ "$1" == ls-remote ]]; then printf '%s\trefs/heads/main\n' "$FAKE_MAIN_HEAD"; exit 0; fi
exec "$REAL_GIT" "$@"`,
    pgrep: 'exit 1',
    flock: 'exit 0',
  };

  /** A fake driver in a directory: the data root, the install root, /run, /var/log, and the shims. */
  function driverSandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'paraclete-lab-canary-'));
    sandboxes.push(dir);
    for (const sub of ['bin', 'opt/paraclete', 'var/lib/paraclete/services/brain', 'var/log', 'run', 'home']) mkdirSync(join(dir, sub), { recursive: true });
    for (const [name, body] of Object.entries(SHIMS)) writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'calls.log'), '');
    const at = (rel = '') => posix(join(dir, rel));
    const env = (extra = {}) => ({
      ...process.env,
      PATH: [join(dir, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
      MSYS_NO_PATHCONV: '1',
      FAKE_LOG: at('calls.log'),
      FAKE_OWNER: 'paraclete',
      FAKE_HOME: at('home'),
      FAKE_MAIN_HEAD: '',
      REAL_GIT,
      REAL_STAT,
      ...extra,
    });
    return {
      dir,
      at,
      checkout: join(dir, 'var/lib/paraclete/harness2-repo'),
      calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean),
      /** Runs a root script the lab sent, with its ROOT moved under this directory, as the VM's root would. */
      runSent(command, extra = {}) {
        return this.runDecoded(decodeRemoteRootCommand(command), extra);
      },
      runDecoded(decoded, extra = {}) {
        const rooted = decoded.script.replace(/^ROOT=''$/m, `ROOT='${at()}'`);
        assert.notEqual(rooted, decoded.script, 'the script is moved under the sandbox');
        const file = join(dir, `payload-${Math.random().toString(36).slice(2)}.sh`);
        writeFileSync(file, rooted);
        const r = spawnSync(bashProgram, [posix(file), ...decoded.args], { encoding: 'utf8', env: env(extra) });
        rmSync(file, { force: true });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, result: instanceEnvResult(r.stdout) };
      },
      /** Sources the follow-main updater, points it at this directory and runs main with args. */
      follow(args, extra = {}) {
        const snippet = [
          'source "$T_SCRIPT"',
          'INSTALL_ROOT="$T_ROOT/opt/paraclete"',
          'DATA_ROOT="$T_ROOT/var/lib/paraclete"',
          'LOCK_FILE="$T_ROOT/run/paraclete-lab-follow-main.lock"',
          'BOOTSTRAP_LOCK="$T_ROOT/run/paraclete-bootstrap.lock"',
          'UPGRADE_LOG="$T_ROOT/var/log/paraclete-lab-follow-main-upgrade.log"',
          `main ${args.map((_, i) => `"$T_ARG_${i}"`).join(' ')}`,
        ].join('; ');
        const words = Object.fromEntries(args.map((arg, i) => [`T_ARG_${i}`, arg]));
        const r = spawnSync(bashProgram, ['-c', snippet, FOLLOW_MAIN.unit], {
          encoding: 'utf8',
          env: env({ T_SCRIPT: posix(UPDATER), T_ROOT: at(), ...words, ...extra }),
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, line: r.stdout.trim() };
      },
    };
  }

  function gitIn(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.name=Lab Test', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** The driver's checkout, a clone one commit behind an origin whose main carries this repo's own .gitignore. */
  function harnessCheckout(vm) {
    const dir = mkdtempSync(join(tmpdir(), 'paraclete-lab-canary-origin-'));
    sandboxes.push(dir);
    const origin = join(dir, 'origin.git');
    gitIn(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    const work = join(dir, 'work');
    gitIn(dir, 'clone', '--quiet', origin, work);
    writeFileSync(join(work, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8'));
    writeFileSync(join(work, 'README.md'), 'one\n');
    gitIn(work, 'add', '.gitignore', 'README.md');
    gitIn(work, 'commit', '--quiet', '-m', 'one');
    const first = gitIn(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'README.md'), 'two\n');
    gitIn(work, 'commit', '--quiet', '-am', 'two');
    gitIn(work, 'push', '--quiet', 'origin', 'HEAD:main');
    const second = gitIn(work, 'rev-parse', 'HEAD');
    gitIn(vm.dir, 'clone', '--quiet', '--branch', 'main', origin, vm.checkout);
    gitIn(vm.checkout, 'reset', '--quiet', '--hard', first);
    return { first, second };
  }

  const plan = buildGcpLabPlan({ projectId: LAB });
  const command = instanceEnvRemoteCommand({ text: plan.instanceEnv.text, checkout: FOLLOW_MAIN.harnessCheckout });
  const envFile = (vm) => join(vm.checkout, '.local', 'instance.env');

  it('parses in bash', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'paraclete-lab-canary-parse-')), 'script.sh');
    sandboxes.push(dirname(file));
    writeFileSync(file, instanceEnvScript({ text: plan.instanceEnv.text }));
    const r = spawnSync(bashProgram, ['-n', posix(file)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  it('writes the coordinates as the paraclete user, by rename, and a second run changes nothing', () => {
    const vm = driverSandbox();
    harnessCheckout(vm);
    const first = vm.runSent(command);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.result, { ok: true, state: 'changed' });
    assert.equal(readFileSync(envFile(vm), 'utf8'), plan.instanceEnv.text);
    assert.deepEqual(vm.calls(), ['runuser paraclete'], 'written as the checkout\'s owner, never as root');
    assert.deepEqual(loadInstanceEnv({ path: envFile(vm) }).PROJECT_ID, CANARY_PROJECT);

    const second = vm.runSent(command);
    assert.deepEqual(second.result, { ok: true, state: 'unchanged' });
    assert.deepEqual(readdirSync(join(vm.checkout, '.local')), ['instance.env'], 'no temporary file is left');

    writeFileSync(envFile(vm), 'PROJECT_ID=someone-elses\n');
    assert.deepEqual(vm.runSent(command).result, { ok: true, state: 'changed' });
    assert.equal(readFileSync(envFile(vm), 'utf8'), plan.instanceEnv.text, 'a changed file is put back');
  });

  it('writes nothing without a checkout, or into one the paraclete user does not own', () => {
    const empty = driverSandbox();
    const none = empty.runSent(command);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.result.state, 'no-checkout');
    assert.equal(existsSync(join(empty.checkout, '.local')), false, 'a later clone into the directory is not blocked');

    const foreign = driverSandbox();
    harnessCheckout(foreign);
    const notOwned = foreign.runSent(command, { FAKE_OWNER: 'root' });
    assert.equal(notOwned.result.state, 'not-owned-by-paraclete');
    assert.equal(notOwned.result.ok, false);
    assert.equal(existsSync(envFile(foreign)), false);
  });

  it('lab-provision\'s own command writes it on the driver', () => {
    const vm = driverSandbox();
    harnessCheckout(vm);
    const cloud = fakeCloud({
      ssh: (name, project, decoded) => {
        if (decoded.name !== LAB_CANARY.scriptName) return INSTALLED;
        assert.deepEqual([name, project], ['paraclete-h2-driver', LAB]);
        return vm.runDecoded(decoded).stdout;
      },
    });
    const res = provision(cloud);
    assert.equal(res.ok, true, JSON.stringify(res.instanceEnv));
    assert.equal(readFileSync(envFile(vm), 'utf8'), plan.instanceEnv.text);
  });

  it('the coordinates never block the updater\'s fast-forward: .local/ is ignored, so the checkout has no changes', () => {
    const vm = driverSandbox();
    const { first, second } = harnessCheckout(vm);
    assert.equal(vm.runSent(command).result.state, 'changed');
    assert.equal(gitIn(vm.checkout, 'status', '--porcelain'), '', 'git status sees no change');
    assert.match(gitIn(vm.checkout, 'status', '--porcelain', '--ignored'), /^!! \.local\/$/m, 'the file is there, ignored');

    writeFileSync(join(vm.dir, 'opt/paraclete/release.json'), JSON.stringify({ commit: second, repo: REPO }));
    writeFileSync(join(vm.dir, 'var/lib/paraclete/services/brain/health.json'), JSON.stringify({ runner: { active_mission: null } }));
    const run = vm.follow(['--harness-checkout', posix(vm.checkout)], { FAKE_MAIN_HEAD: second });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.line, new RegExp(`upgrade=current checkout=fast-forwarded:${first.slice(0, 12)}\\.\\.${second.slice(0, 12)}$`));
    assert.equal(gitIn(vm.checkout, 'rev-parse', 'HEAD'), second);
    assert.equal(readFileSync(envFile(vm), 'utf8'), plan.instanceEnv.text, 'and the coordinates stay');
  });
});
