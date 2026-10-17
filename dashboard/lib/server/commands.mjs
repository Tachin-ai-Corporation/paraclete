// dashboard/lib/server/commands.mjs: asking the VM to do something. The dashboard writes a command to
// the `commands` collection, signed as its own service account; the control service on the VM checks
// the signature, runs the command and writes the outcome back onto the same document. The command set,
// its params and results are documented in agent/services/control/README.md.
//
// Read-only commands (the views) are open to every user; commands that change the instance are for
// admins only. The dashboard decides that here, and signs only what it allowed.

import { randomBytes } from 'node:crypto';
import { commandClaims, createCommandSigner } from '../../../agent/auth/command-signature.mjs';
import { HttpError } from './errors.mjs';

/** Commands that only read. Any user may send them. */
export const VIEW_COMMANDS = Object.freeze(['status', 'skills', 'config', 'workspace', 'brain_config', 'responsibilities']);

/** Commands that change the instance. Admins only. */
export const ADMIN_COMMANDS = Object.freeze(['set_responsibility_enabled', 'run_responsibility', 'set_model', 'restart_service', 'upgrade']);

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A 20-character document id, like Firestore's own auto-ids. */
export function newDocId() {
  return [...randomBytes(20)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

const signers = new WeakMap();

function signerFor(runtime) {
  let sign = signers.get(runtime);
  if (!sign) {
    sign = createCommandSigner({ signerEmail: runtime.settings.dashboardAccount, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    signers.set(runtime, sign);
  }
  return sign;
}

/**
 * Signs and writes a command for the control service.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {string} o.type
 * @param {object} [o.params]
 * @param {{email: string, role: string}} o.user  who asks
 * @param {Date}   [o.now]
 * @param {Function} [o.sign]  tests pass their own signer
 * @returns {Promise<{id: string}>}
 */
export async function sendCommand(runtime, { type, params = {}, user, now = new Date(), sign = signerFor(runtime) }) {
  const isView = VIEW_COMMANDS.includes(type);
  if (!isView && !ADMIN_COMMANDS.includes(type)) throw new HttpError(400, `there is no '${type}' command`);
  if (!isView && user.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can do this');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, 'params must be an object');

  const id = newDocId();
  const claims = commandClaims({ id, type, params, requestedBy: user.email, signer: runtime.settings.dashboardAccount, now: now.getTime() });
  let signature;
  try {
    signature = await sign(claims);
  } catch (err) {
    runtime.log('ERROR', `command ${type} could not be signed: ${err.message}`);
    throw new HttpError(502, `the dashboard could not sign the command as ${runtime.settings.dashboardAccount}, so the agent would refuse it. Its account needs the Service Account Token Creator role on itself (install/install.sh grants it)`);
  }
  const data = { type, params, status: 'pending', requested_by: user.email, created_at: now.toISOString(), signature };
  await runtime.db.commit([{ path: `${runtime.collections.commands}/${id}`, data, precondition: { exists: false } }]);
  return { id };
}

/**
 * A command as the dashboard shows it: the request and its outcome, without the signature.
 *
 * @param {object} runtime
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function readCommand(runtime, id) {
  if (!/^[A-Za-z0-9]{1,64}$/.test(String(id))) throw new HttpError(400, 'not a command id');
  const doc = await runtime.db.read(`${runtime.collections.commands}/${id}`, { strict: true });
  if (!doc) throw new HttpError(404, 'no such command');
  return {
    id,
    type: doc.type,
    params: doc.params ?? {},
    status: doc.status,
    requested_by: doc.requested_by ?? null,
    created_at: doc.created_at ?? null,
    started_at: doc.started_at ?? null,
    finished_at: doc.finished_at ?? null,
    result: doc.result ?? null,
    error: doc.error ?? null,
    detached: doc.detached ?? null,
  };
}
