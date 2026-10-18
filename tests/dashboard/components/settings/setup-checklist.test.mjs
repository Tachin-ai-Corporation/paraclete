// Tests for dashboard/components/settings/setup-checklist.js: the Setup tab's checklist as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupChecklist, STATES } from '../../../../dashboard/components/settings/setup-checklist.js';

const AGENT_ACCOUNT = 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com';
const service = (name, extra = {}) => ({ service: name, unit: `paraclete-${name}.service`, active: 'active', sub: 'running', heartbeat: null, ...extra });
const healthyStatus = () => ({
  services: Object.fromEntries(['gateway', 'brain', 'ears', 'mouth', 'control'].map((name) => [name, service(name)])),
  gateway: {
    reachable: true,
    ready: true,
    providers: { 'vertex-google': { available: true, location: 'global' }, 'vertex-anthropic': { available: false, location: null } },
    required: ['vertex-google'],
    models: { cortex: 'gemini-4-argon', strong: 'gemini-4-argon', fast: 'gemini-3.8-flash', fallback: 'gemini-3.8-flash' },
  },
});
const readyAgent = { status: 'ready', release: 'v2027.01.15.1.1', commit: '0123456789abcdef0123456789abcdef01234567' };
const setupOf = (overrides = {}) => ({ users: { total: 1, admins: 1 }, role: 'generic', workspace: 'not_needed', claude_enabled: false, ...overrides });
const byKey = (list) => Object.fromEntries(list.items.map((item) => [item.key, item]));

test('a healthy fresh instance: the required steps are done, the rest optional or for later', () => {
  const list = setupChecklist({ agent: readyAgent, status: healthyStatus(), setup: setupOf(), agentAccount: AGENT_ACCOUNT, isAdmin: true });
  assert.deepEqual(list.items.map((i) => [i.key, i.state]), [
    ['agent', 'done'], ['services', 'done'], ['models', 'done'], ['users', 'optional'], ['drive', 'info'], ['claude', 'later'], ['workspace', 'not_needed'],
  ]);
  assert.deepEqual(list.required, { done: 3, total: 3 });
  const items = byKey(list);
  assert.equal(items.agent.detail, 'Ready on v2027.01.15.1.1.');
  assert.equal(items.models.detail, 'Ready: cortex gemini-4-argon, strong gemini-4-argon, fast gemini-3.8-flash.');
  assert.equal(items.users.action, 'Add colleagues under Users.');
  assert.equal(items.drive.address, AGENT_ACCOUNT);
  assert.match(items.claude.detail, /^Off/);
  assert.equal(items.workspace.detail, 'Not needed for this role.');
  for (const item of list.items) assert.ok(STATES[item.state], `${item.state} has a label and a badge`);
});

test('before anything answers, every item that waits on data says it is checking', () => {
  const list = setupChecklist({});
  const items = byKey(list);
  for (const key of ['agent', 'services', 'models', 'users', 'claude', 'workspace']) assert.equal(items[key].state, 'checking', key);
  assert.deepEqual(list.required, { done: 0, total: 3 });
});

test('a failed install and a VM that does not answer need attention', () => {
  const items = byKey(setupChecklist({ agent: { status: 'failed', error: 'npm ci failed' }, statusError: 'the agent has not answered yet', setup: setupOf() }));
  assert.equal(items.agent.state, 'problem');
  assert.match(items.agent.detail, /npm ci failed/);
  assert.equal(items.services.state, 'problem');
  assert.match(items.services.detail, /did not answer: the agent has not answered yet/);
  assert.equal(items.models.state, 'todo');
  assert.equal(byKey(setupChecklist({ agent: { status: 'unknown' } })).agent.state, 'todo');
});

test('a stopped or stuck service is named, and members are told to ask an admin', () => {
  const status = healthyStatus();
  status.services.brain = service('brain', { active: 'failed', sub: 'failed', result: 'exit-code' });
  status.services.mouth = service('mouth', { heartbeat: { stale: true, age_sec: 300 } });
  const member = byKey(setupChecklist({ agent: readyAgent, status, setup: setupOf({ users: { total: 2, admins: 1 } }) }));
  assert.equal(member.services.state, 'problem');
  assert.match(member.services.detail, /^brain: systemd shows failed \(exit-code\); mouth: running, but its heartbeat is 5 min old/);
  assert.match(member.services.action, /^Ask a dashboard admin: restart it under System/);
  assert.equal(member.users.state, 'done');
  assert.equal(member.users.detail, '2 users, 1 admin.');
  const admin = byKey(setupChecklist({ agent: readyAgent, status, isAdmin: true }));
  assert.match(admin.services.action, /^Restart it under System/);
});

test('a gateway that is down or missing a provider is a model problem', () => {
  const down = healthyStatus();
  down.gateway = { reachable: false, ready: false, error: 'the gateway did not answer: ECONNREFUSED' };
  assert.match(byKey(setupChecklist({ status: down })).models.detail, /ECONNREFUSED/);

  const unready = healthyStatus();
  unready.gateway = { ...unready.gateway, ready: false, providers: { 'vertex-google': { available: false } } };
  const models = byKey(setupChecklist({ status: unready })).models;
  assert.equal(models.state, 'problem');
  assert.match(models.detail, /no client for vertex-google/);
});

test('Claude on, and a role whose Workspace needs are not known yet', () => {
  const items = byKey(setupChecklist({ setup: setupOf({ claude_enabled: true, role: 'project-manager', workspace: 'unknown' }) }));
  assert.equal(items.claude.state, 'done');
  assert.equal(items.workspace.state, 'later');
  assert.match(items.workspace.detail, /project-manager role/);
});

test('the Drive item follows Test Drive: checking, what it found, or why it did not finish', () => {
  const drive = (d, isAdmin = true) => byKey(setupChecklist({ agentAccount: AGENT_ACCOUNT, drive: d, isAdmin })).drive;
  const before = drive(null);
  assert.equal(before.state, 'info');
  assert.match(before.detail, /Test Drive checks/);
  assert.equal(before.address, AGENT_ACCOUNT);
  assert.equal(drive({ result: null, error: null, running: true }).state, 'checking');

  const found = {
    identity: { kind: 'workspace', email: 'agent@example.com' },
    reachable: true,
    error: null,
    shared_with_me: { count: 3, capped: false, sample: [] },
    shared_drives: [],
    output_folder: null,
    advice: [],
  };
  const ok = drive({ result: found, error: null, running: false });
  assert.equal(ok.state, 'done');
  assert.equal(ok.detail, 'It reaches Drive as its Google Workspace account, agent@example.com. 3 files and folders are shared with it.');
  assert.equal(ok.address, 'agent@example.com', 'share with the identity the agent actually uses');

  const blocked = drive({ result: { ...found, output_folder: { id: 'f', name: 'Out', drive_id: null, writable: false, error: 'no storage' } } });
  assert.equal(blocked.state, 'problem');
  assert.match(blocked.detail, /cannot be written to: no storage/);
  assert.equal(drive({ result: { ...found, reachable: false, error: 'scope missing' } }).state, 'problem');

  const failed = drive({ result: null, error: 'the agent has not answered yet', running: false }, false);
  assert.equal(failed.state, 'problem');
  assert.match(failed.detail, /did not finish: the agent has not answered yet/);
  assert.match(failed.action, /^Ask a dashboard admin: run Test Drive again/);
  assert.deepEqual(setupChecklist({ drive: { result: { ...found, reachable: false } } }).required, { done: 0, total: 3 }, 'Drive is not a required step');
});
