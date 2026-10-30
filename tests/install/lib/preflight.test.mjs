// Tests for install/lib/preflight.mjs: each check's verdict from Google's answers, the organization
// policies that break the install and the ones that don't, a call that cannot be made (unknown, never
// a blocker), the token kept on curl's standard input, and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORG_POLICY_CHECKS, cli, preflight } from '../../../install/lib/preflight.mjs';

const PROJECT = 'your-gcp-project';
const APIS = ['compute.googleapis.com', 'run.googleapis.com', 'aiplatform.googleapis.com'];
const PERMISSIONS = ['resourcemanager.projects.setIamPolicy', 'compute.instances.create'];
const disabled = (service) => ({ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: `${service} has not been used in project 1 before or it is disabled.`,
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { service } }] } } });

/** A fake curl answering from routes: [url test, answer], where an answer is { status, body } or a function of the url. */
function fakeCurl(overrides = {}) {
  const calls = [];
  const answers = {
    permissions: { status: 200, body: { permissions: PERMISSIONS } },
    billing: { status: 200, body: { billingEnabled: true } },
    ancestry: { status: 200, body: { ancestor: [{ resourceId: { type: 'project', id: PROJECT } }, { resourceId: { type: 'organization', id: '1' } }] } },
    policies: {},
    services: { status: 200, body: { services: [{ config: { name: 'compute.googleapis.com' } }] } },
    ...overrides,
  };
  const curl = (args, input) => {
    const url = args.at(-1);
    calls.push({ args, input, url });
    let answer;
    if (url.endsWith(':testIamPermissions')) answer = answers.permissions;
    else if (url.endsWith('/billingInfo')) answer = answers.billing;
    else if (url.endsWith(':getAncestry')) answer = answers.ancestry;
    else if (url.includes('orgpolicy.googleapis.com')) {
      const constraint = /policies\/([^:]+):/.exec(url)[1];
      answer = typeof answers.policies === 'function' ? answers.policies(constraint)
        : { status: 200, body: { spec: answers.policies[constraint] || {} } };
    } else if (url.includes('serviceusage.googleapis.com')) answer = answers.services;
    else throw new Error(`unexpected call ${url}`);
    assert.ok(args.includes('-i'), 'the status is read from the headers');
    // A 100 Continue block first, as curl prints it for some POSTs.
    const cont = args.includes('--data') ? 'HTTP/1.1 100 Continue\r\n\r\n' : '';
    return `${cont}HTTP/2 ${answer.status}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(answer.body)}`;
  };
  return { curl, calls };
}

const run = (overrides, extra = {}) => {
  const fake = fakeCurl(overrides);
  const { checks } = preflight({ project: PROJECT, region: 'us-central1', zone: 'us-central1-a', apis: APIS, permissions: PERMISSIONS,
    token: 'ya29.secret', account: 'admin@example.com', curl: fake.curl, ...extra });
  return { checks, calls: fake.calls, byId: Object.fromEntries(checks.map((c) => [c.id, c])) };
};

test('a project that can take an install: every check passes, and the APIs to turn on are a note', () => {
  const { checks } = run();
  assert.deepEqual(checks.map((c) => [c.id, c.state]), [
    ['permissions', 'ok'], ['billing', 'ok'], ['organization', 'ok'], ['policy', 'ok'], ['apis', 'note'],
  ]);
  assert.match(checks.at(-1).text, /step 2 turns on 2 APIs: run\.googleapis\.com aiplatform\.googleapis\.com/);
});

test('the token goes on curl\'s standard input, never its arguments, and no call names a project to bill unless asked', () => {
  const { calls } = run();
  assert.ok(calls.length >= 4 + ORG_POLICY_CHECKS.length);
  for (const call of calls) {
    assert.ok(!call.args.join(' ').includes('ya29.secret'), call.url);
    assert.equal(call.input, 'Authorization: Bearer ya29.secret\n');
    assert.ok(call.args.includes('@-'));
  }
  const billed = run({}, { quotaProject: 'caller-project' }).calls;
  assert.ok(billed.every((call) => call.input.includes('x-goog-user-project: caller-project\n')));
});

test('missing permissions, billing off and no organization are blockers, in the words step 1 used', () => {
  const { byId } = run({
    permissions: { status: 200, body: { permissions: ['compute.instances.create'] } },
    billing: { status: 200, body: { billingEnabled: false } },
    ancestry: { status: 200, body: { ancestor: [{ resourceId: { type: 'project', id: PROJECT } }] } },
  });
  assert.equal(byId.permissions.state, 'blocker');
  assert.match(byId.permissions.text, /^admin@example\.com needs roles\/owner on your-gcp-project\. Missing: resourcemanager\.projects\.setIamPolicy$/);
  assert.equal(byId.billing.state, 'blocker');
  assert.match(byId.billing.fix, /billing\/linkedaccount\?project=your-gcp-project/);
  assert.equal(byId.organization.state, 'blocker');
  assert.match(byId.organization.text, /not inside a Google Cloud organization/);
});

test('each organization policy that breaks the install is a blocker naming what it breaks; one that allows it passes', () => {
  const vm = `projects/${PROJECT}/zones/us-central1-a/instances/paraclete`;
  for (const [constraint, refuses, allows] of [
    ['iam.disableServiceAccountCreation', { rules: [{ enforce: true }] }, { rules: [{ enforce: false }] }],
    ['compute.vmExternalIpAccess', { rules: [{ denyAll: true }] }, { rules: [{ values: { allowedValues: [vm] } }] }],
    ['compute.vmExternalIpAccess', { rules: [{ values: { allowedValues: ['projects/other/zones/x/instances/y'] } }] }, { rules: [{ allowAll: true }] }],
    ['compute.trustedImageProjects', { rules: [{ values: { allowedValues: ['projects/my-images'] } }] }, { rules: [{ values: { allowedValues: ['is:projects/debian-cloud'] } }] }],
    ['run.allowedIngress', { rules: [{ values: { allowedValues: ['internal'] } }] }, { rules: [{ values: { allowedValues: ['all'] } }] }],
    ['gcp.restrictServiceUsage', { rules: [{ values: { deniedValues: ['run.googleapis.com'] } }] }, { rules: [{ values: { deniedValues: ['bigquery.googleapis.com'] } }] }],
    ['cloudbuild.allowedWorkerPools', { rules: [{ values: { allowedValues: ['projects/p/locations/l/workerPools/w'] } }] }, {}],
    ['gcp.resourceLocations', { rules: [{ values: { allowedValues: ['in:eu-locations'] } }] }, { rules: [{ values: { allowedValues: ['in:us-locations'] } }] }],
    ['gcp.resourceLocations', { rules: [{ values: { deniedValues: ['us-central1'] } }] }, { rules: [{ values: { allowedValues: ['in:us-central1-locations'] } }] }],
  ]) {
    const blocked = run({ policies: { [constraint]: refuses } }).byId[`policy:${constraint}`];
    assert.equal(blocked?.state, 'blocker', `${constraint} ${JSON.stringify(refuses)}`);
    assert.match(blocked.text, new RegExp(`^${constraint.replace(/\./g, '\\.')}: .+, and `));
    const fine = run({ policies: { [constraint]: allows } });
    assert.equal(fine.byId[`policy:${constraint}`], undefined, `${constraint} ${JSON.stringify(allows)}`);
    assert.equal(fine.byId.policy.state, 'ok');
  }
  const restricted = run({ policies: { 'gcp.restrictServiceUsage': { rules: [{ values: { allowedValues: ['compute.googleapis.com'] } }] } } });
  assert.match(restricted.byId['policy:gcp.restrictServiceUsage'].text, /may not be used: run\.googleapis\.com aiplatform\.googleapis\.com/);
});

test('a rule with a condition is left to a person, as a note', () => {
  const { byId } = run({ policies: { 'run.allowedIngress': { rules: [{ condition: { expression: 'resource.matchTag("x", "y")' }, values: { allowedValues: ['internal'] } }] } } });
  assert.equal(byId['policy:run.allowedIngress'].state, 'note');
  assert.match(byId['policy:run.allowedIngress'].text, /conditions: check by hand/);
});

test('a call that cannot be made is unknown, with what to do, and never blocks', () => {
  const { checks, byId } = run({ billing: disabled('cloudbilling.googleapis.com'), policies: () => disabled('orgpolicy.googleapis.com') });
  assert.equal(byId.billing.state, 'unknown');
  assert.match(byId.billing.text, /could not read the project's billing \(SERVICE_DISABLED/);
  assert.match(byId.billing.fix, /turn on cloudbilling\.googleapis\.com in the project this call is billed to/);
  assert.deepEqual(checks.filter((c) => c.id.startsWith('policy')).map((c) => [c.id, c.state]), [['policy', 'unknown']], 'said once, not per constraint');
  assert.ok(!checks.some((c) => c.state === 'blocker'));
  const broken = run({ permissions: { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'expired' } } } });
  assert.equal(broken.byId.permissions.state, 'unknown');
  assert.match(broken.byId.permissions.text, /UNAUTHENTICATED: expired/);
});

test('the command line: lines or JSON, exit 1 on a blocker, 2 for a usage mistake or no token', () => {
  const args = ['--project', PROJECT, '--region', 'us-central1', '--zone', 'us-central1-a', '--apis', APIS.join(','), '--permissions', PERMISSIONS.join(',')];
  const clean = cli(args, { stdin: 'ya29.secret\n', curl: fakeCurl().curl });
  assert.equal(clean.status, 0);
  assert.deepEqual(clean.output.split('\n').map((line) => line.split('\t').slice(0, 2)),
    [['ok', 'permissions'], ['ok', 'billing'], ['ok', 'organization'], ['ok', 'policy'], ['note', 'apis']]);
  assert.ok(clean.output.split('\n').every((line) => line.split('\t').length === 4));
  const blocked = cli([...args, '--json'], { stdin: 'ya29.secret\n', curl: fakeCurl({ billing: { status: 200, body: { billingEnabled: false } } }).curl });
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.output).checks.find((c) => c.id === 'billing').state, 'blocker');
  assert.equal(cli(args, { stdin: '', curl: fakeCurl().curl }).status, 2);
  assert.equal(cli(['--project', PROJECT], { stdin: 'tok' }).status, 2);
  assert.equal(cli([...args, '--bogus', 'x'], { stdin: 'tok' }).status, 2);
  assert.ok(!clean.output.includes('ya29.secret'));
});
