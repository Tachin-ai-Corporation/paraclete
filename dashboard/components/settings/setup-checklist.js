// dashboard/components/settings/setup-checklist.js: what this instance needs, as data for the Setup tab.
// Pure: it takes what the views already fetched (the agent's install record from GET /api/agent, the
// `status` command's result, GET /api/setup, the agent's service-account address from GET /api/me,
// the `drive_check` command's result once someone ran Test Drive, and GET /api/workspace) and says, per
// item, whether it is done and what to do.
// Admins and members see the same states; only the advice differs, since only admins can act.

import { shortCommit, unhealthyServices } from './service-health.js';
import { driveCheckView } from './drive-settings.js';
import { accountSummary } from './workspace/workspace-wizard.js';

/** How each state reads, and the badge it wears. */
export const STATES = Object.freeze({
  done: { label: 'Done', badge: 'badge-ok' },
  problem: { label: 'Needs attention', badge: 'badge-danger' },
  todo: { label: 'Not yet', badge: 'badge-warn' },
  checking: { label: 'Checking', badge: 'badge-info' },
  optional: { label: 'Optional', badge: 'badge-neutral' },
  info: { label: 'How to', badge: 'badge-info' },
  later: { label: 'Later release', badge: 'badge-neutral' },
  not_needed: { label: 'Not needed', badge: 'badge-neutral' },
});

/** The items an instance cannot work without; the rest are optional or informational. */
export const REQUIRED = Object.freeze(['agent', 'services', 'models']);

const askAdmin = (isAdmin, what) => (isAdmin ? what : `Ask a dashboard admin: ${what.charAt(0).toLowerCase()}${what.slice(1)}`);

function agentItem(agent) {
  const item = { key: 'agent', title: 'The agent is installed and ready' };
  if (!agent) return { ...item, state: 'checking', detail: '' };
  if (agent.status === 'ready') {
    const on = agent.release || (agent.commit ? `commit ${shortCommit(agent.commit)}` : '');
    return { ...item, state: 'done', detail: on ? `Ready on ${on}.` : 'Ready.' };
  }
  if (agent.status === 'failed') {
    return {
      ...item,
      state: 'problem',
      detail: `The last install or upgrade on the VM failed${agent.error ? `: ${agent.error}` : '.'}`,
      action: 'Run install/install.sh again from Cloud Shell; it repairs what is missing. The VM\'s startup log says what went wrong.',
    };
  }
  return {
    ...item,
    state: 'todo',
    detail: 'The agent has not reported ready yet.',
    action: 'A new install takes about 15 minutes. If it stays like this, read the VM\'s startup log.',
  };
}

function servicesItem(status, statusError, isAdmin) {
  const item = { key: 'services', title: 'All of its services are running' };
  if (!status) {
    if (statusError) {
      return { ...item, state: 'problem', detail: `The agent's VM did not answer: ${statusError}`, action: 'It may be starting or restarting. Check again in a minute.' };
    }
    return { ...item, state: 'checking', detail: '' };
  }
  const down = unhealthyServices(status);
  if (!down.length) return { ...item, state: 'done', detail: 'Gateway, brain, ears, mouth and control are running.' };
  return {
    ...item,
    state: 'problem',
    detail: down.map(({ service, detail }) => `${service}: ${detail}`).join('; '),
    action: askAdmin(isAdmin, 'Restart it under System, then read its log if it fails again.'),
  };
}

function modelsItem(status, statusError, isAdmin) {
  const item = { key: 'models', title: 'The default models are ready' };
  if (!status) return { ...item, state: statusError ? 'todo' : 'checking', detail: statusError ? 'Waits for the VM to answer.' : '' };
  const gateway = status.gateway || {};
  if (!gateway.reachable) {
    return { ...item, state: 'problem', detail: `The model gateway did not answer${gateway.error ? `: ${gateway.error}` : '.'}`, action: askAdmin(isAdmin, 'Restart the gateway under System.') };
  }
  if (!gateway.ready) {
    const missing = (gateway.required || []).filter((provider) => !gateway.providers?.[provider]?.available);
    return {
      ...item,
      state: 'problem',
      detail: `The model gateway is up but not ready${missing.length ? `: no client for ${missing.join(', ')}` : '.'}`,
      action: askAdmin(isAdmin, 'Restart the gateway under System; if it stays unready, read its log.'),
    };
  }
  const models = gateway.models || {};
  const named = ['cortex', 'strong', 'fast'].filter((tier) => models[tier]).map((tier) => `${tier} ${models[tier]}`);
  return { ...item, state: 'done', detail: named.length ? `Ready: ${named.join(', ')}.` : 'Ready.' };
}

function usersItem(setup, isAdmin) {
  const item = { key: 'users', title: 'More than one person can use the dashboard' };
  if (!setup) return { ...item, state: 'checking', detail: '' };
  const { total, admins } = setup.users;
  if (total > 1) return { ...item, state: 'done', detail: `${total} users, ${admins} ${admins === 1 ? 'admin' : 'admins'}.` };
  return { ...item, state: 'optional', detail: 'Only one user so far.', action: isAdmin ? 'Add colleagues under Users.' : '' };
}

/**
 * Drive: how to share with the agent, until Test Drive has run; then what the check found. The address
 * to share with is the identity the check reports, else the Workspace account the VM recorded, else
 * the agent's service account.
 */
function driveItem(agentAccount, drive, workspaceAccount, isAdmin) {
  const result = drive?.result || null;
  const item = {
    key: 'drive',
    title: 'Share Drive files with the agent',
    address: result?.identity?.email || workspaceAccount || agentAccount || '',
  };
  if (drive?.running && !result) return { ...item, state: 'checking', detail: 'Testing Drive…' };
  if (drive?.error && !result) {
    return {
      ...item,
      state: 'problem',
      detail: `The Drive test did not finish: ${drive.error}`,
      action: askAdmin(isAdmin, 'Run Test Drive again; if it fails again, the control service\'s log under System says why.'),
    };
  }
  const view = driveCheckView(result);
  if (!view) {
    return {
      ...item,
      state: 'info',
      detail: 'Share a Drive file or folder with the agent\'s address, as Viewer to let it read or as Editor to let it change, and the agent can open it. Test Drive checks that the agent reaches Drive, and lists what is shared with it.',
    };
  }
  return { ...item, state: view.ok ? 'done' : 'problem', detail: view.headline };
}

function claudeItem(setup) {
  const item = { key: 'claude', title: 'Claude' };
  if (!setup) return { ...item, state: 'checking', detail: '' };
  if (setup.claude_enabled) return { ...item, state: 'done', detail: 'On: the cortex and the strong tier run on Claude.' };
  return { ...item, state: 'later', detail: 'Off: the agent runs on Gemini. Turning Claude on arrives in a later release.' };
}

/**
 * The agent's Workspace account (GET /api/workspace): not needed on most roles; on a Workspace role,
 * whether one is recorded and whether its last test passed, with a link to the Workspace tab.
 */
function workspaceItem(workspace, workspaceError, isAdmin) {
  const item = { key: 'workspace', title: 'A Google Workspace account for the agent' };
  if (!workspace) {
    return workspaceError
      ? { ...item, state: 'problem', detail: `Its state could not be read: ${workspaceError}` }
      : { ...item, state: 'checking', detail: '' };
  }
  const summary = accountSummary(workspace);
  if (summary.state === 'not_needed') return { ...item, state: 'not_needed', detail: summary.detail };
  const link = { href: '#workspace', linkLabel: isAdmin ? 'Open Workspace settings' : 'See Workspace settings' };
  if (summary.state === 'todo') {
    return { ...item, ...link, state: 'todo', detail: summary.detail, action: askAdmin(isAdmin, 'Set it up under Workspace: create its user, grant domain-wide delegation, test, and save.') };
  }
  if (summary.state === 'problem') {
    return { ...item, ...link, state: 'problem', detail: summary.detail, action: askAdmin(isAdmin, 'Workspace shows what to change for each one; then test again.') };
  }
  return { ...item, ...link, state: 'done', detail: summary.detail };
}

/**
 * The checklist, in the order the Setup tab shows it.
 *
 * @param {object} o
 * @param {object|null} o.agent        GET /api/agent
 * @param {object|null} o.status       the status command's result
 * @param {string|null} o.statusError  why the status command gave none
 * @param {object|null} o.setup        GET /api/setup
 * @param {string}  [o.agentAccount]   GET /api/me's dashboard.agentAccount
 * @param {{result?: object|null, error?: string|null, running?: boolean}} [o.drive]  the drive_check command
 * @param {object|null} [o.workspace]       GET /api/workspace
 * @param {string|null} [o.workspaceError]  why it could not be read
 * @param {boolean} o.isAdmin
 * @returns {{items: object[], required: {done: number, total: number}}}
 */
export function setupChecklist({
  agent = null, status = null, statusError = null, setup = null, agentAccount = '', drive = null, workspace = null, workspaceError = null, isAdmin = false,
}) {
  const items = [
    agentItem(agent),
    servicesItem(status, statusError, isAdmin),
    modelsItem(status, statusError, isAdmin),
    usersItem(setup, isAdmin),
    driveItem(agentAccount, drive, workspace?.account?.account || '', isAdmin),
    claudeItem(setup),
    workspaceItem(workspace, workspaceError, isAdmin),
  ];
  // A role with a Workspace account cannot do its work without it.
  const required = items.filter((item) => REQUIRED.includes(item.key) || (item.key === 'workspace' && workspace?.needed === true));
  return { items, required: { done: required.filter((item) => item.state === 'done').length, total: required.length } };
}
