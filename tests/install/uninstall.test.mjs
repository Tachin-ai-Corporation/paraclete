// Tests for install/uninstall.sh, run with bash against tests/install/fake-cloud.mjs on a project that
// install/install.sh set up (through the same fake), dashboard included. It names exactly what it will
// delete, deletes that (the dashboard's service, its image repository and every project grant of the
// accounts, the dashboard's log writer among them) and keeps the database and the bucket; --purge
// deletes those too, but only after the project id is typed; a dry run deletes nothing; and it never
// touches what the installer didn't create. The agent's own image repository (a DevOps Engineer
// instance's `agent-images`) is kept with its images, without the agent's grant on it, unless --purge;
// the agent's act-as on its own account goes with the account. The tag paraclete=managed comes off the
// update job and the service before each is deleted, then its value and key go; on a DevOps Engineer
// instance the agent's fenced run.admin goes with its other project grants.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, find, flag, freshProject, needsBash, steps, PROJECT } from './harness.mjs';

const AGENT = `paraclete-agent@${PROJECT}.iam.gserviceaccount.com`;
const DASHBOARD = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const DWD = `paraclete-dwd@${PROJECT}.iam.gserviceaccount.com`;
const BUCKET = `${PROJECT}-paraclete`;
const OWNER_ONLY = [['roles/owner', 'user:owner@example.com']];

const writes = (calls) => calls.filter((call) => call.write !== false);
const position = (commands, ...words) => commands.findIndex((command) => words.every((word, i) => command[i] === word));

/** The "- ..." lines under a heading of the confirmation text. */
function listed(stdout, heading) {
  const lines = stdout.split('\n');
  const out = [];
  for (const line of lines.slice(lines.indexOf(heading) + 1)) {
    if (!line.startsWith('  - ')) break;
    out.push(line.slice(4));
  }
  return out;
}

describe('uninstall.sh', { skip: needsBash, concurrency: true }, () => {
  let installed;
  before(async () => {
    const box = createSandbox();
    const run = await box.run('install.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    installed = box.state();
  });

  test('on a project without paraclete, there is nothing to remove', async () => {
    const run = await createSandbox(freshProject()).run('uninstall.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Nothing of paraclete's is left to remove from your-gcp-project/);
    assert.deepEqual(writes(run.calls), []);
  });

  test('a dry run names exactly what it would delete and keep, and deletes nothing', async () => {
    const box = createSandbox(installed);
    const run = await box.run('uninstall.sh', ['--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(listed(run.stdout, 'This deletes from your-gcp-project:'), [
      'VM paraclete in us-central1-a, with its disk',
      'firewall rule paraclete-allow-iap-ssh',
      'firewall rule paraclete-deny-ingress',
      'Cloud Scheduler job paraclete-auto-update in us-central1 (starts the automatic update)',
      'Cloud Run job paraclete-auto-update in us-central1 (the automatic update)',
      'Cloud Run service paraclete in us-central1 (the dashboard)',
      "Artifact Registry repository paraclete in us-central1 (the dashboard's images)",
      'tag paraclete=managed on the project (it marks the dashboard and its update job)',
      'Firestore index messages|collection|thread_id:ascending,timestamp:descending',
      'Firestore index messages|collection|sender:ascending,timestamp:descending',
      'Firestore index work|collection|status:ascending,created_at:descending',
      'Firestore index work|collection|status:ascending,created_at:ascending',
      'Firestore index work|collection|type:ascending,created_at:descending',
      'Firestore index intake|collection|status:ascending,created_at:ascending',
      'Firestore TTL policy on tool_results.expire_at',
      `service account ${AGENT} and its grants`,
      `service account ${DASHBOARD} and its grants`,
    ]);
    assert.deepEqual(listed(run.stdout, 'It keeps:'), [
      `bucket gs://${BUCKET} and its files`,
      'the Firestore (default) database and its data',
      'the enabled APIs',
    ]);
    assert.deepEqual(writes(run.calls), []);
    assert.deepEqual(box.state(), installed);
    assert.deepEqual(steps(run.stdout).map(([, name]) => name), ['check', 'vm', 'network', 'dashboard', 'images', 'firestore', 'bucket', 'accounts']);
    assert.match(run.stdout, /no image repository agent-images in us-central1/);
  });

  test('the plan deletes the VM first and the accounts last, and keeps the data', async () => {
    const { commands } = await createSandbox(installed).run('uninstall.sh', ['--dry-run']);
    const [vm] = find(commands, 'gcloud', 'compute', 'instances', 'delete');
    assert.equal(vm[4], 'paraclete');
    assert.equal(flag(vm, 'zone'), 'us-central1-a');
    assert.equal(find(commands, 'gcloud', 'compute', 'firewall-rules', 'delete')[0][4], 'paraclete-allow-iap-ssh');
    assert.deepEqual(find(commands, 'gcloud', 'compute', 'networks', 'delete'), [], 'the default network stays');
    assert.deepEqual(find(commands, 'gcloud', 'firestore', 'indexes', 'composite', 'delete').map((c) => c[5]),
      installed.indexes.map((index) => index.name.split('/').pop()));
    const [ttl] = find(commands, 'gcloud', 'firestore', 'fields', 'ttls', 'update');
    assert.deepEqual([ttl[5], flag(ttl, 'collection-group'), ttl.includes('--disable-ttl')], ['expire_at', 'tool_results', true]);
    assert.deepEqual(find(commands, 'gcloud', 'firestore', 'databases'), []);
    assert.deepEqual(find(commands, 'gcloud', 'storage', 'rm'), []);
    assert.deepEqual(find(commands, 'gcloud', 'storage', 'buckets', 'remove-iam-policy-binding').map((c) => flag(c, 'member')),
      [`serviceAccount:${AGENT}`, `serviceAccount:${DASHBOARD}`]);
    const projectRoles = installed.projectPolicy.filter(([, member]) => member === `serviceAccount:${AGENT}`).map(([role]) => role);
    assert.deepEqual(find(commands, 'gcloud', 'projects', 'remove-iam-policy-binding')
      .filter((c) => flag(c, 'member') === `serviceAccount:${AGENT}`).map((c) => flag(c, 'role')), projectRoles);
    assert.deepEqual(find(commands, 'gcloud', 'iam', 'service-accounts', 'delete').map((c) => c[4]), [AGENT, DASHBOARD]);
    const accountsDeleted = position(commands, 'gcloud', 'iam', 'service-accounts', 'delete');
    assert.ok(position(commands, 'gcloud', 'compute', 'instances', 'delete') < accountsDeleted);
    assert.ok(position(commands, 'gcloud', 'storage', 'buckets', 'remove-iam-policy-binding') < accountsDeleted);
  });

  test("the plan deletes the dashboard's service and images, and every project grant of its account, logs included", async () => {
    const { commands } = await createSandbox(installed).run('uninstall.sh', ['--dry-run']);
    const [service, ...moreServices] = find(commands, 'gcloud', 'run', 'services', 'delete');
    assert.equal(moreServices.length, 0);
    assert.deepEqual([service[4], flag(service, 'region'), flag(service, 'project')], ['paraclete', 'us-central1', PROJECT]);
    const [images, ...moreImages] = find(commands, 'gcloud', 'artifacts', 'repositories', 'delete');
    assert.equal(moreImages.length, 0);
    assert.deepEqual([images[4], flag(images, 'location'), flag(images, 'project')], ['paraclete', 'us-central1', PROJECT]);
    const dashboardRoles = find(commands, 'gcloud', 'projects', 'remove-iam-policy-binding')
      .filter((c) => flag(c, 'member') === `serviceAccount:${DASHBOARD}`).map((c) => flag(c, 'role'));
    const granted = installed.projectPolicy.filter(([, member]) => member === `serviceAccount:${DASHBOARD}`).map(([role]) => role);
    assert.ok(granted.includes('roles/logging.logWriter'), 'the installer granted it');
    assert.deepEqual(dashboardRoles, granted);
    const accountsDeleted = position(commands, 'gcloud', 'iam', 'service-accounts', 'delete');
    assert.ok(position(commands, 'gcloud', 'run', 'services', 'delete') < accountsDeleted, 'the service runs as the account');
    // The automatic update: the schedule first, so it cannot start the job, then the job, then the service.
    const [schedule] = find(commands, 'gcloud', 'scheduler', 'jobs', 'delete');
    const [job] = find(commands, 'gcloud', 'run', 'jobs', 'delete');
    assert.deepEqual([schedule[4], flag(schedule, 'location'), job[4], flag(job, 'region')],
      ['paraclete-auto-update', 'us-central1', 'paraclete-auto-update', 'us-central1']);
    assert.ok(commands.indexOf(schedule) < commands.indexOf(job));
    assert.ok(commands.indexOf(job) < position(commands, 'gcloud', 'run', 'services', 'delete'));
  });

  test('the plan takes the tag off the job and the service before each goes, then deletes its value and key', async () => {
    const { commands } = await createSandbox(installed).run('uninstall.sh', ['--dry-run']);
    const value = `${PROJECT}/paraclete/managed`;
    const resource = (kind, name) => `//run.googleapis.com/projects/${PROJECT}/locations/us-central1/${kind}/${name}`;
    assert.deepEqual(find(commands, 'gcloud', 'resource-manager'), [
      ['gcloud', 'resource-manager', 'tags', 'bindings', 'delete', `--tag-value=${value}`,
        `--parent=${resource('jobs', 'paraclete-auto-update')}`, '--location=us-central1', '--quiet'],
      ['gcloud', 'resource-manager', 'tags', 'bindings', 'delete', `--tag-value=${value}`,
        `--parent=${resource('services', 'paraclete')}`, '--location=us-central1', '--quiet'],
      ['gcloud', 'resource-manager', 'tags', 'values', 'delete', value, '--quiet'],
      ['gcloud', 'resource-manager', 'tags', 'keys', 'delete', `${PROJECT}/paraclete`, '--quiet'],
    ]);
    const [jobTag, serviceTag, valueGone] = find(commands, 'gcloud', 'resource-manager');
    assert.ok(commands.indexOf(jobTag) < position(commands, 'gcloud', 'run', 'jobs', 'delete'));
    assert.ok(commands.indexOf(serviceTag) < position(commands, 'gcloud', 'run', 'services', 'delete'));
    assert.ok(commands.indexOf(valueGone) > position(commands, 'gcloud', 'run', 'services', 'delete'));
  });

  test('without --yes, a no deletes nothing', async () => {
    const run = await createSandbox(installed).run('uninstall.sh', [], { input: 'n\n' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Delete these\? \[y\/N\]/);
    assert.match(run.stderr, /nothing was deleted/);
    assert.deepEqual(writes(run.calls), []);
  });

  test('removes everything the installer made and keeps the database and the bucket', async () => {
    const box = createSandbox(installed);
    const run = await box.run('uninstall.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    const after = box.state();
    assert.deepEqual(after.instances, {});
    assert.deepEqual(after.firewallRules, {});
    assert.deepEqual(after.runServices, {});
    assert.deepEqual(after.runJobs, {});
    assert.deepEqual(after.schedules, {});
    assert.deepEqual(after.imageRepositories, []);
    assert.deepEqual(after.images, {});
    assert.deepEqual(after.users, installed.users, "the dashboard's users stay with the database");
    assert.deepEqual(after.accounts, []);
    assert.deepEqual(after.projectPolicy, OWNER_ONLY);
    assert.deepEqual(after.indexes, []);
    assert.deepEqual(after.ttls, []);
    assert.deepEqual(after.database, installed.database);
    assert.deepEqual(after.buckets[BUCKET].policy, []);
    assert.deepEqual(after.services, installed.services, 'the APIs stay on');
    assert.deepEqual(after.networks, installed.networks);
    assert.deepEqual([after.tagKeys, after.tagValues], [[], {}]);

    const again = await box.run('uninstall.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Nothing of paraclete's is left/);
  });

  test('--purge --dry-run plans to delete the database and the bucket, and asks nothing', async () => {
    const run = await createSandbox(installed).run('uninstall.sh', ['--purge', '--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(listed(run.stdout, 'This deletes from your-gcp-project:').some((line) => /Firestore \(default\) database and ALL its data/.test(line)));
    assert.ok(listed(run.stdout, 'This deletes from your-gcp-project:').includes(`bucket gs://${BUCKET} and ALL its files (irreversible)`));
    const protection = position(run.commands, 'gcloud', 'firestore', 'databases', 'update');
    const deletion = position(run.commands, 'gcloud', 'firestore', 'databases', 'delete');
    assert.ok(run.commands[protection].includes('--no-delete-protection'));
    assert.ok(protection < deletion);
    const [rm] = find(run.commands, 'gcloud', 'storage', 'rm');
    assert.deepEqual(rm.slice(3, 6), ['--recursive', '--all-versions', `gs://${BUCKET}`]);
    assert.deepEqual(find(run.commands, 'gcloud', 'firestore', 'indexes'), [], 'deleting the database takes its indexes');
    assert.doesNotMatch(run.stderr, /Type the project id/);
    assert.deepEqual(writes(run.calls), []);
  });

  test('--purge deletes nothing unless the project id is typed, even with --yes', async () => {
    for (const input of ['yes\n', `${PROJECT}x\n`, '']) {
      const box = createSandbox(installed);
      const run = await box.run('uninstall.sh', ['--purge', '--yes'], { input });
      assert.equal(run.status, 1, `typed ${JSON.stringify(input)}`);
      assert.match(run.stderr, /Type the project id \(your-gcp-project\) to confirm/);
      assert.match(run.stderr, /the project id did not match; nothing was deleted/);
      assert.deepEqual(writes(run.calls), []);
      assert.deepEqual(box.state(), installed);
    }
  });

  test('--purge with the project id typed deletes the data too', async () => {
    const box = createSandbox(installed);
    const run = await box.run('uninstall.sh', ['--purge'], { input: `${PROJECT}\n` });
    assert.equal(run.status, 0, run.stderr);
    const after = box.state();
    assert.equal(after.database, null);
    assert.deepEqual(after.buckets, {});
    assert.deepEqual(after.accounts, []);
    assert.deepEqual(after.instances, {});
    assert.deepEqual(after.runServices, {});
    assert.deepEqual(after.imageRepositories, []);
    assert.deepEqual(after.projectPolicy, OWNER_ONLY);
  });

  test("removes the installer's network, the dashboard and the Workspace signer when they exist", async () => {
    const state = structuredClone(installed);
    state.networks = {
      paraclete: { mode: 'auto', description: 'Created by the paraclete installer' },
    };
    state.instances.paraclete.zone = 'europe-west1-b';
    state.runServices.paraclete = { region: 'europe-west1', url: 'https://paraclete-xxxxxxxxxx-ew.a.run.app' };
    state.imageRepositories.push('europe-west1/paraclete');
    state.accounts.push(DWD);
    state.accountPolicies[DWD] = [['roles/iam.serviceAccountTokenCreator', `serviceAccount:${AGENT}`]];
    const run = await createSandbox(state).run('uninstall.sh', ['--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(find(run.commands, 'gcloud', 'compute', 'networks', 'delete')[0][4], 'paraclete');
    const [service] = find(run.commands, 'gcloud', 'run', 'services', 'delete');
    assert.deepEqual([service[4], flag(service, 'region')], ['paraclete', 'europe-west1'], 'the region follows the VM');
    const [images] = find(run.commands, 'gcloud', 'artifacts', 'repositories', 'delete');
    assert.deepEqual([images[4], flag(images, 'location')], ['paraclete', 'europe-west1']);
    assert.deepEqual(find(run.commands, 'gcloud', 'iam', 'service-accounts', 'delete').map((c) => c[4]), [AGENT, DASHBOARD, DWD]);
    const network = position(run.commands, 'gcloud', 'compute', 'networks', 'delete');
    assert.ok(position(run.commands, 'gcloud', 'compute', 'firewall-rules', 'delete') < network);
    assert.ok(position(run.commands, 'gcloud', 'compute', 'instances', 'delete') < network);
  });

  test('keeps a network named paraclete that the installer did not create', async () => {
    const state = structuredClone(installed);
    state.networks.paraclete = { mode: 'custom', description: 'our own' };
    const run = await createSandbox(state).run('uninstall.sh', ['--dry-run']);
    assert.deepEqual(find(run.commands, 'gcloud', 'compute', 'networks', 'delete'), []);
  });
});

describe("uninstall.sh on a DevOps Engineer instance: the agent's image repository", { skip: needsBash, concurrency: true }, () => {
  const REPOSITORY = 'us-central1/agent-images';
  const BUILT = `us-central1-docker.pkg.dev/${PROJECT}/agent-images/api`;
  const KEPT = "Artifact Registry repository agent-images in us-central1 and the agent's images";
  let installed;
  before(async () => {
    const box = createSandbox();
    const run = await box.run('install.sh', ['--yes', '--role', 'devops-engineer']);
    assert.equal(run.status, 0, run.stderr);
    box.update((state) => { state.images[BUILT] = ['v1', 'v2']; });
    installed = box.state();
    assert.deepEqual(installed.accountPolicies[AGENT], [['roles/iam.serviceAccountUser', `serviceAccount:${AGENT}`]]);
  });

  test('a dry run keeps the repository and names it, and plans only to take the grant on it back', async () => {
    const run = await createSandbox(installed).run('uninstall.sh', ['--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(listed(run.stdout, 'It keeps:').includes(KEPT));
    assert.ok(!listed(run.stdout, 'This deletes from your-gcp-project:').some((line) => line.includes('agent-images')));
    assert.match(run.stdout, /--purge deletes the database, the bucket and the agent's image repository too/);
    assert.deepEqual(find(run.commands, 'gcloud', 'artifacts', 'repositories', 'delete').map((c) => c[4]), ['paraclete'], "only the dashboard's");
    assert.deepEqual(find(run.commands, 'gcloud', 'artifacts', 'repositories', 'remove-iam-policy-binding'), [
      ['gcloud', 'artifacts', 'repositories', 'remove-iam-policy-binding', 'agent-images', '--location=us-central1',
        `--project=${PROJECT}`, `--member=serviceAccount:${AGENT}`, '--role=roles/artifactregistry.writer', '--quiet'],
    ]);
    const grantGone = position(run.commands, 'gcloud', 'artifacts', 'repositories', 'remove-iam-policy-binding');
    assert.ok(grantGone < position(run.commands, 'gcloud', 'iam', 'service-accounts', 'delete'), 'before the account it names');
    assert.deepEqual(writes(run.calls), []);
  });

  test('without --purge, the repository and its images stay; the grants on it and on the agent\'s account go', async () => {
    const box = createSandbox(installed);
    const run = await box.run('uninstall.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    const after = box.state();
    assert.deepEqual(after.imageRepositories, [REPOSITORY]);
    assert.deepEqual(after.images, { [BUILT]: ['v1', 'v2'] });
    assert.deepEqual(after.repositoryPolicies[REPOSITORY], []);
    assert.deepEqual(after.accounts, []);
    assert.equal(after.accountPolicies[AGENT], undefined, "the act-as on its own account went with the account");
    assert.deepEqual(after.projectPolicy, OWNER_ONLY);
    assert.match(run.stdout, /the repository and its images stay/);
  });

  test('--purge deletes the repository and every image in it, after the project id is typed', async () => {
    const plan = await createSandbox(installed).run('uninstall.sh', ['--purge', '--dry-run']);
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(listed(plan.stdout, 'This deletes from your-gcp-project:')
      .includes("Artifact Registry repository agent-images in us-central1 and ALL the agent's images (irreversible)"));
    assert.ok(!listed(plan.stdout, 'It keeps:').includes(KEPT));
    assert.deepEqual(find(plan.commands, 'gcloud', 'artifacts', 'repositories', 'delete').map((c) => [c[4], flag(c, 'location')]),
      [['paraclete', 'us-central1'], ['agent-images', 'us-central1']]);
    assert.deepEqual(find(plan.commands, 'gcloud', 'artifacts', 'repositories', 'remove-iam-policy-binding'), [], 'it goes whole');

    const refused = createSandbox(installed);
    const no = await refused.run('uninstall.sh', ['--purge', '--yes'], { input: '\n' });
    assert.equal(no.status, 1);
    assert.deepEqual(refused.state(), installed);

    const box = createSandbox(installed);
    const run = await box.run('uninstall.sh', ['--purge'], { input: `${PROJECT}\n` });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(box.state().imageRepositories, []);
    assert.deepEqual(box.state().images, {});
  });

  test('--purge alone is enough for a repository left by an earlier uninstall', async () => {
    const state = structuredClone(freshProject());
    state.imageRepositories = [REPOSITORY];
    state.images = { [BUILT]: ['v1'] };
    const box = createSandbox(state);
    const kept = await box.run('uninstall.sh', ['--yes']);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /Nothing of paraclete's is left to remove/);
    const purged = await box.run('uninstall.sh', ['--purge'], { input: `${PROJECT}\n` });
    assert.equal(purged.status, 0, purged.stderr);
    assert.deepEqual(box.state().imageRepositories, []);
  });
});
