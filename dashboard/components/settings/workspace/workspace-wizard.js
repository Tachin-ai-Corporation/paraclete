// dashboard/components/settings/workspace/workspace-wizard.js: the Workspace setup's decisions, as data
// for WorkspaceTab.jsx and the Setup checklist. Pure: it takes what the views fetched (GET
// /api/workspace, GET /api/workspace/setup, the workspace_check command's result) and what the admin
// typed, and says whether an address will do, what each step's state is, whether the account may be
// saved, and how the account reads in one line.
//
// The address rule repeats the control service's (agent/services/control/workspace-account.mjs), which
// the browser cannot import: the VM checks again, so this copy only spares a round trip.

const ADDRESS = /^[a-z0-9._'+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Drive moves to the agent's account the moment it is recorded, so it must work before a save. */
export const REQUIRED_APIS = Object.freeze(['drive']);

/**
 * The address typed for the agent's user, checked: `{ account }` lowercased, or `{ error }`; both
 * null while nothing is typed.
 *
 * @param {string} value
 * @returns {{account: string|null, error: string|null}}
 */
export function checkAddress(value) {
  const account = String(value ?? '').trim().toLowerCase();
  if (!account) return { account: null, error: null };
  if (account.length > 254 || !ADDRESS.test(account)) return { account: null, error: 'Enter an address like agent@example.com.' };
  const domain = account.slice(account.indexOf('@') + 1);
  if (CONSUMER_DOMAINS.has(domain)) {
    return { account: null, error: 'That is a personal Google account. The agent needs a user in your organization\'s Workspace domain.' };
  }
  if (domain === 'gserviceaccount.com' || domain.endsWith('.gserviceaccount.com')) {
    return { account: null, error: 'That is a service account. The agent needs a user in your organization\'s Workspace domain.' };
  }
  return { account, error: null };
}

/** The APIs of a check that failed. */
export function failedApis(check) {
  return (check?.apis || []).filter((entry) => !entry.ok);
}

/** Whether every API failed with the same error: the token itself, not one API, is the problem. */
function tokenFailed(check) {
  const failed = failedApis(check);
  return failed.length > 0 && failed.length === (check?.apis || []).length && new Set(failed.map((entry) => entry.error)).size === 1;
}

/** "Chat, Gmail and Calendar". */
export function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Whether the account may be saved, after a check of exactly that address:
 *   - every API answered: save;
 *   - the token itself failed, or a required API (Drive) failed: no;
 *   - only other APIs failed: save after a warning that names them.
 *
 * @param {object|null} check    the workspace_check result (or GET /api/workspace's last_check)
 * @param {string|null} account  the address about to be saved
 * @returns {{allowed: boolean, confirm: boolean, reason: string, warning: string}}
 */
export function saveDecision(check, account) {
  const no = (reason) => ({ allowed: false, confirm: false, reason, warning: '' });
  if (!account) return no('Enter the agent\'s address first.');
  if (!check || check.account !== account) return no(`Run Test for ${account} first.`);
  if (check.ready) return { allowed: true, confirm: false, reason: '', warning: '' };
  if (tokenFailed(check)) return no('Google gave no token for this account. Fix what the test says, then test again.');
  const failed = failedApis(check);
  const required = failed.filter((entry) => REQUIRED_APIS.includes(entry.api));
  if (required.length) {
    return no(`${listNames(required.map((entry) => entry.name))} must work first: the agent uses its Google account for Drive the moment it is saved.`);
  }
  return {
    allowed: true,
    confirm: true,
    reason: '',
    warning: `${listNames(failed.map((entry) => entry.name))} did not answer. Saved now, the agent cannot use ${failed.length === 1 ? 'it' : 'them'} until the test passes.`,
  };
}

/**
 * The state of the steps before Save, for their markers: 'done', 'problem' or 'todo'. The delegation
 * is done once a check of this address found every scope granted (`missing_scopes: []`), and a
 * problem when it found some missing or the client ID cannot be read. The Chat app record has no
 * state of its own in Google that the dashboard can read, so its step follows Chat in the check: done
 * when Chat answered, a problem when it did not with every scope granted.
 *
 * @param {object} o
 * @param {string|null} o.account   the checked address typed, or null
 * @param {object|null} o.setup     GET /api/workspace/setup
 * @param {object|null} o.check     the latest check, of any address
 * @returns {{user: string, delegation: string, chat: string, test: string}}
 */
export function stepStates({ account, setup, check }) {
  const checked = account && check?.account === account ? check : null;
  const missing = Array.isArray(checked?.missing_scopes) ? checked.missing_scopes : null;
  let delegation = 'todo';
  if (missing && missing.length === 0) delegation = 'done';
  else if (missing?.length || setup?.client_id_error) delegation = 'problem';
  const chatEntry = (Array.isArray(checked?.apis) ? checked.apis : []).find((entry) => entry?.api === 'chat');
  let chat = 'todo';
  if (chatEntry?.ok === true) chat = 'done';
  else if (chatEntry && delegation === 'done') chat = 'problem';
  return {
    user: account ? 'done' : 'todo',
    delegation,
    chat,
    test: !checked ? 'todo' : checked.ready ? 'done' : 'problem',
  };
}

/**
 * The account in one line, for the Setup checklist and the tab's header: a state and a sentence.
 *
 * @param {object|null} workspace  GET /api/workspace
 * @returns {{state: 'checking'|'not_needed'|'todo'|'done'|'problem', detail: string, failing: string[]}}
 */
export function accountSummary(workspace) {
  if (!workspace) return { state: 'checking', detail: '', failing: [] };
  if (!workspace.needed) return { state: 'not_needed', detail: 'Not needed for this role.', failing: [] };
  const account = workspace.account?.account;
  if (!account) return { state: 'todo', detail: 'The agent has no Google Workspace account yet, so Chat and the Workspace skills are off.', failing: [] };
  const check = workspace.last_check?.account === account ? workspace.last_check : null;
  if (!check) return { state: 'done', detail: `The agent is ${account}. It has not been tested since it was saved.`, failing: [] };
  if (check.ready) return { state: 'done', detail: `The agent is ${account}, and every Workspace API answered.`, failing: [] };
  const failing = failedApis(check).map((entry) => entry.name);
  return { state: 'problem', detail: `The agent is ${account}, but ${listNames(failing)} did not answer at the last test.`, failing };
}
