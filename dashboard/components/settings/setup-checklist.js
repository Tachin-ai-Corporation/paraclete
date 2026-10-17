// dashboard/components/settings/setup-checklist.js: what this instance needs, as data for the Setup tab.
// Pure: it takes what the views already fetched (the agent's install record from GET /api/agent, the
// `status` command's result, GET /api/setup, and the agent's service-account address from GET /api/me)
// and says, per item, whether it is done and what to do.
// Admins and members see the same states; only the advice differs, since only admins can act.

import { shortCommit, unhealthyServices } from './service-health.js';

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

function driveItem(agentAccount) {
  return {
    key: 'drive',
    title: 'Share Drive files with the agent',
    state: 'info',
    detail: 'Share a Drive file or folder with the agent\'s address, as Viewer to let it read or as Editor to let it change, and the agent can open it. A check that sharing works arrives in a later release.',
    address: agentAccount || '',
  };
}

function claudeItem(setup) {
  const item = { key: 'claude', title: 'Claude' };
  if (!setup) return { ...item, state: 'checking', detail: '' };
  if (setup.claude_enabled) return { ...item, state: 'done', detail: 'On: the cortex and the strong tier run on Claude.' };
  return { ...item, state: 'later', detail: 'Off: the agent runs on Gemini. Turning Claude on arrives in a later release.' };
}

function workspaceItem(setup) {
  const item = { key: 'workspace', title: 'A Google Workspace account for the agent' };
  if (!setup) return { ...item, state: 'checking', detail: '' };
  if (setup.workspace === 'not_needed') return { ...item, state: 'not_needed', detail: 'Not needed for this role.' };
  return { ...item, state: 'later', detail: `Whether the ${setup.role} role needs one shows here in a later release.` };
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
 * @param {boolean} o.isAdmin
 * @returns {{items: object[], required: {done: number, total: number}}}
 */
export function setupChecklist({ agent = null, status = null, statusError = null, setup = null, agentAccount = '', isAdmin = false }) {
  const items = [
    agentItem(agent),
    servicesItem(status, statusError, isAdmin),
    modelsItem(status, statusError, isAdmin),
    usersItem(setup, isAdmin),
    driveItem(agentAccount),
    claudeItem(setup),
    workspaceItem(setup),
  ];
  const required = items.filter((item) => REQUIRED.includes(item.key));
  return { items, required: { done: required.filter((item) => item.state === 'done').length, total: required.length } };
}
