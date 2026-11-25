// agent/services/control/workspace-send-as.mjs: provisions and re-verifies custom Gmail
// Send-As aliases on mail-sending roles (`support-specialist`) through domain-wide delegation
// (`https://www.googleapis.com/auth/gmail.settings.sharing`), so agents never sign in interactively
// just to add a shared group `From:` address. Called by commands.mjs (`workspace_send_as`).

import { createDwdTokenSource } from '../../auth/dwd-token.mjs';
import { GMAIL_SETTINGS_SHARING, MAIL_SEND_ROLES } from '../../auth/workspace-scopes.mjs';
import { checkWorkspaceAccount, signerFor } from './workspace-account.mjs';
import { DELEGATION_PAGE } from './workspace-check.mjs';

const SEND_AS_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';
const TIMEOUT_MS = 15_000;
const MAX_DISPLAY_CHARS = 120;

function readGoogleReason(text, status) {
  try {
    const body = JSON.parse(text);
    return body?.error?.message || body?.error_description || text || `HTTP ${status}`;
  } catch {
    return String(text || '').trim() || `HTTP ${status}`;
  }
}

function cleanDisplayName(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error('params.display_name must be a string');
  const trimmed = value.trim();
  if (/[\r\n]/.test(trimmed)) throw new Error('params.display_name cannot contain line breaks');
  if (trimmed.length > MAX_DISPLAY_CHARS) {
    throw new Error(`params.display_name must be at most ${MAX_DISPLAY_CHARS} characters`);
  }
  return trimmed;
}

/**
 * Registers or triggers verification for a custom Send-As alias on the agent's mailbox.
 *
 * @param {object} o
 * @param {'create'|'verify'} [o.action='create']
 * @param {unknown} o.email
 * @param {string} [o.displayName]
 * @param {object} o.instance
 * @param {Function} o.fetch
 * @param {Function} o.getVmAccessToken
 * @param {Function} [o.now]
 */
export async function manageWorkspaceSendAs({
  action = 'create',
  email,
  displayName = '',
  instance,
  fetch,
  getVmAccessToken,
  now = () => new Date(),
}) {
  if (!MAIL_SEND_ROLES.includes(instance?.role)) {
    throw new Error(`the ${instance?.role || 'installed'} role does not send Gmail mail`);
  }
  const account = instance?.workspace?.account;
  const project = instance?.project;
  if (!account || !project) {
    throw new Error('Save the agent\'s Workspace account first under Workspace before adding Send-As aliases.');
  }
  const signer = instance.workspace.signer || signerFor(project);
  if (action !== 'create' && action !== 'verify') {
    throw new Error(`params.action must be 'create' or 'verify', got ${JSON.stringify(action)}`);
  }

  const cleanEmail = checkWorkspaceAccount(email);
  if (cleanEmail === account.toLowerCase()) {
    throw new Error(`${cleanEmail} is already the agent's primary mailbox.`);
  }
  const cleanDisplay = cleanDisplayName(displayName);

  const dwd = createDwdTokenSource({ fetch, getVmAccessToken, now: () => now().getTime() });
  let token;
  try {
    token = await dwd({ signerServiceAccount: signer, subjectEmail: account, scopes: [...GMAIL_SETTINGS_SHARING] });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/unauthorized_client|access_denied|not authorized|unauthorized to retrieve/i.test(msg)) {
      throw new Error(
        `Domain-wide delegation for ${signer} does not yet include gmail.settings.sharing. Copy the updated OAuth scopes from Settings -> Workspace, update the grant at ${DELEGATION_PAGE}, wait a minute, and try again.`,
      );
    }
    throw new Error(`Could not obtain a delegated Gmail settings token for ${account}: ${msg}`);
  }

  const call = async (method, path = '', jsonBody) => {
    const res = await fetch(`${SEND_AS_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
      },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };

  let resource = null;
  if (action === 'create') {
    const created = await call('POST', '', {
      sendAsEmail: cleanEmail,
      treatAsAlias: true,
      ...(cleanDisplay ? { displayName: cleanDisplay } : {}),
    });
    if (created.ok) {
      resource = created.json;
    } else if (created.status === 409) {
      const existing = await call('GET', `/${encodeURIComponent(cleanEmail)}`);
      if (!existing.ok) {
        throw new Error(`Alias ${cleanEmail} already exists, and reading it failed: ${readGoogleReason(existing.text, existing.status)}`);
      }
      resource = existing.json;
      if (resource?.verificationStatus !== 'accepted') {
        const sentVerify = await call('POST', `/${encodeURIComponent(cleanEmail)}/verify`);
        if (!sentVerify.ok) {
          throw new Error(`Resending verification for ${cleanEmail} failed: ${readGoogleReason(sentVerify.text, sentVerify.status)}`);
        }
      }
    } else {
      throw new Error(`Could not add Send-As alias ${cleanEmail}: ${readGoogleReason(created.text, created.status)}`);
    }
  } else {
    const sentVerify = await call('POST', `/${encodeURIComponent(cleanEmail)}/verify`);
    if (!sentVerify.ok) {
      throw new Error(`Resending verification for ${cleanEmail} failed: ${readGoogleReason(sentVerify.text, sentVerify.status)}`);
    }
    const fetched = await call('GET', `/${encodeURIComponent(cleanEmail)}`);
    resource = fetched.ok ? fetched.json : { sendAsEmail: cleanEmail, verificationStatus: 'pending' };
  }

  const verificationStatus = String(resource?.verificationStatus || 'unknown');
  const accepted = verificationStatus === 'accepted';
  const resolvedDisplay = String(resource?.displayName || cleanDisplay || '');
  return {
    account,
    send_as_email: cleanEmail,
    display_name: resolvedDisplay,
    verification_status: verificationStatus,
    accepted,
    message: accepted
      ? `${cleanEmail} is verified on ${account} and ready to send replies.`
      : `${cleanEmail} was added on ${account} (status: ${verificationStatus}). Google sent a confirmation email to ${cleanEmail}; open it from your own inbox and click the link to verify it.`,
  };
}
