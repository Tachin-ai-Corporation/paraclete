// dashboard/lib/server/workspace.mjs: the dashboard's side of the agent's own Google Workspace account,
// for Settings, Workspace and the Setup checklist. On a role whose role.json sets `workspace`
// (PARACLETE_WORKSPACE_ROLE, which the installer sets), the agent acts as a Google user of the
// organization through domain-wide delegation, which an admin grants by hand in the Admin console:
// Google has no API for it. This module answers what the setup wizard needs to show:
//   - the state, for every user: whether the role needs an account, the account the VM recorded and
//     the last check, from config/workspace_account (only the VM's control service writes it);
//   - the setup, for admins: the delegation signer and its OAuth client ID (IAM
//     projects.serviceAccounts.get, as the dashboard's account, which the installer lets read that one
//     account), the scope list from agent/auth/workspace-scopes.mjs, the Admin console's pages, the
//     Cloud console page of the project's Chat app record, and a suggested address.
// Testing and recording the account are the control service's `workspace_check` and
// `set_workspace_account` commands, which the browser sends through POST /api/commands. Called by the
// /api/workspace routes.

import { WORKSPACE_SCOPES, WORKSPACE_APIS, adminConsoleScopes, chatAppPage, scopeName } from '../../../agent/auth/workspace-scopes.mjs';
import { HttpError } from './errors.mjs';

/**
 * The delegation signer's account id. install/lib/names.sh creates it (DWD_ACCOUNT_ID), and the
 * control service names the same signer (agent/services/control/workspace-account.mjs, which the
 * dashboard may not import); tests pin all three together.
 */
export const SIGNER_ACCOUNT_ID = 'paraclete-dwd';

/** The record the control service keeps for the dashboard, under `config`; pinned to control's by a test. */
export const WORKSPACE_RECORD_DOC = 'workspace_account';

/** The Admin console's pages the wizard sends an admin to. */
export const ADMIN_LINKS = Object.freeze({
  users: 'https://admin.google.com/ac/users',
  delegation: 'https://admin.google.com/ac/owl/domainwidedelegation',
});

const IAM_API = 'https://iam.googleapis.com/v1';
const TIMEOUT_MS = 15_000;

/** The signer of this instance, or '' when the dashboard does not know its project. */
export function signerOf(runtime) {
  const { project } = runtime.settings;
  return project ? `${SIGNER_ACCOUNT_ID}@${project}.iam.gserviceaccount.com` : '';
}

const text = (value) => (typeof value === 'string' && value ? value : null);

/**
 * A check as the dashboard shows it. Admins see Google's error and the fix for each API; members see
 * which APIs work, nothing they could act on. Everyone sees whether an API waits on a first message
 * (`pending`, Chat only) and its `note`, which asks anyone in the organization to write to the agent.
 *
 * @param {object|null} check  config/workspace_account's last_check
 * @param {boolean} admin
 */
export function checkView(check, admin) {
  if (!check || typeof check !== 'object' || !text(check.account)) return null;
  const apis = (Array.isArray(check.apis) ? check.apis : []).map((entry) => ({
    api: String(entry?.api ?? ''),
    name: String(entry?.name ?? entry?.api ?? ''),
    ok: entry?.ok === true,
    pending: entry?.ok === true && entry?.pending === true,
    note: entry?.ok === true ? text(entry?.note) : null,
    ...(admin ? { scopes: Array.isArray(entry?.scopes) ? entry.scopes.map(String) : [], error: text(entry?.error), fix: text(entry?.fix) } : {}),
  }));
  return {
    account: check.account,
    checked_at: text(check.checked_at),
    checked_by: text(check.checked_by),
    ready: check.ready === true && apis.length > 0 && apis.every((entry) => entry.ok),
    apis,
    ...(admin ? {
      signer: text(check.signer),
      client_id: text(check.client_id),
      missing_scopes: Array.isArray(check.missing_scopes) ? check.missing_scopes.map(String) : null,
    } : {}),
  };
}

/**
 * The Workspace state, for any user.
 *
 * @param {object} runtime
 * @param {{role: string}} user
 * @returns {Promise<{needed: boolean, role: string, signer?: string, account?: object|null, last_check?: object|null}>}
 */
export async function readWorkspace(runtime, user) {
  const { role, workspaceRole } = runtime.settings;
  if (!workspaceRole) return { needed: false, role };
  const admin = user?.role === 'admin';
  let doc;
  try {
    doc = await runtime.db.read(`${runtime.collections.config}/${WORKSPACE_RECORD_DOC}`, { strict: true });
  } catch (err) {
    // An outage must not read as "no account yet".
    throw new HttpError(503, `the Workspace account's record could not be read: ${err.message}`);
  }
  const account = text(doc?.account)
    ? { account: doc.account, signer: text(doc.signer), recorded_at: text(doc.recorded_at), recorded_by: text(doc.recorded_by) }
    : null;
  return {
    needed: true,
    role,
    signer: signerOf(runtime),
    account,
    // Who removed the last account, and when, while none is recorded.
    removed: !account && text(doc?.recorded_at) ? { recorded_at: doc.recorded_at, recorded_by: text(doc.recorded_by) } : null,
    last_check: checkView(doc?.last_check, admin),
  };
}

/**
 * The signer's OAuth client ID, the number the Admin console's delegation form takes. Never throws:
 * `error` says, in words for an admin, why it could not be read.
 *
 * @param {object} runtime
 * @param {string} signer
 * @returns {Promise<{client_id: string|null, error: string|null}>}
 */
export async function readClientId(runtime, signer) {
  let token;
  try {
    token = await runtime.getAccessToken();
  } catch (err) {
    return { client_id: null, error: `the dashboard has no access token: ${err.message}` };
  }
  let response;
  try {
    response = await runtime.fetch(`${IAM_API}/projects/-/serviceAccounts/${encodeURIComponent(signer)}?fields=oauth2ClientId`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { client_id: null, error: `IAM could not be reached: ${err.message}` };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // no JSON: the status says enough
  }
  if (response.status === 404) {
    return { client_id: null, error: `${signer} does not exist. Run install/install.sh again with this role: it creates the account.` };
  }
  if (response.status === 403) {
    return {
      client_id: null,
      error: `the dashboard may not read ${signer}. Run install/install.sh again: it gives ${runtime.settings.dashboardAccount} the Service Account Viewer role on that account.`,
    };
  }
  if (!response.ok) return { client_id: null, error: `IAM answered ${response.status}: ${body?.error?.message || 'no reason given'}` };
  const id = text(body?.oauth2ClientId);
  return id ? { client_id: id, error: null } : { client_id: null, error: `IAM gave no client ID for ${signer}` };
}

/**
 * The address the wizard suggests for the agent's user: its name, as an address, at the admin's own
 * domain ("Ada Lovelace" and admin@example.com give ada.lovelace@example.com). Null without a domain.
 *
 * @param {string} agentName
 * @param {string} email  the signed-in admin's
 * @returns {string|null}
 */
export function suggestAccount(agentName, email) {
  const at = String(email ?? '').lastIndexOf('@');
  const domain = at > 0 ? String(email).slice(at + 1).toLowerCase() : '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  const local = String(agentName ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '.')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return `${local || 'agent'}@${domain}`;
}

/**
 * What an admin needs to set the account up: the signer, its client ID, the scopes, the Admin
 * console's pages and a suggested address. A 404 on a role without a Workspace account.
 *
 * @param {object} runtime
 * @param {{email: string, role: string}} user
 */
export async function readWorkspaceSetup(runtime, user) {
  if (user?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can set up the Workspace account');
  if (!runtime.settings.workspaceRole) throw new HttpError(404, `the ${runtime.settings.role} role has no Workspace account`);
  const signer = signerOf(runtime);
  if (!signer) throw new HttpError(503, 'the dashboard does not know its project (PARACLETE_PROJECT), so it cannot name the signer');
  const { client_id: clientId, error } = await readClientId(runtime, signer);
  return {
    signer,
    client_id: clientId,
    client_id_error: error,
    scopes: [...WORKSPACE_SCOPES],
    scopes_text: adminConsoleScopes(),
    apis: Object.entries(WORKSPACE_APIS).map(([api, { name, scopes }]) => ({ api, name, scopes: scopes.map(scopeName) })),
    links: { ...ADMIN_LINKS, chat_app: chatAppPage(runtime.settings.project) },
    suggested_account: suggestAccount(runtime.settings.agentName, user.email),
  };
}
