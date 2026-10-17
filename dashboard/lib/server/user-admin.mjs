// dashboard/lib/server/user-admin.mjs: managing dashboard users the way an admin sees it. Reaching the
// dashboard takes two things, and this module changes them together: the IAP grant on the Cloud Run
// service (iap-access.mjs), which lets a person through Google sign-in, and their `users` record
// (users.mjs), which says what they may do. Called by the /api/users routes; admins only.
//
// Order and failure:
//   - Adding grants IAP first, then writes the record. If the record cannot be written, a grant made a
//     moment ago is taken back, so a failed add leaves nothing behind.
//   - Removing deletes the record first, then the grant. The record is what lets someone use the
//     dashboard, so once it is gone they see "no access" even if IAP still lets them through; a grant
//     that could not be removed is reported, and listed as access without a user until it is.
//   - Nobody removes themself: another admin does. The last-admin rule in users.mjs already keeps the
//     dashboard manageable; this keeps an admin from cutting off their own session by accident.
//
// The list joins both sides, so an admin can see and fix a record without a grant (grant it) and a
// grant without a record (someone let through in the Cloud console: add them, or revoke it).

import { HttpError } from './errors.mjs';
import { addUser, DASHBOARD_ROLES, getUser, listUsers, normalizeEmail, removeUser, setUserRole } from './users.mjs';
import { grantIapAccess, readIapAccess, revokeIapAccess } from './iap-access.mjs';

function requireAdmin(actor) {
  if (actor?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can manage users');
}

/**
 * The email in a route's path segment (/api/users/<email>). Next.js decodes segments, but an email
 * always has its '@', so one still percent-encoded is decoded here rather than refused.
 *
 * @param {unknown} segment
 * @returns {string} not yet normalized
 */
export function emailFromPath(segment) {
  const value = String(segment ?? '');
  if (value.includes('@')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Every user with whether IAP lets them through, plus the people IAP lets through who have no record.
 * When the IAP policy cannot be read, the users still list, with `iap: null`, and `access.error` says
 * why.
 *
 * @param {object} runtime
 * @param {{actor: {email: string, role: string}}} o
 * @returns {Promise<{users: object[], access: {checked: boolean, error: string|null, resource: string|null,
 *   without_user: string[], other_members: string[]}}>}
 */
export async function listUserAccess(runtime, { actor }) {
  requireAdmin(actor);
  const users = await listUsers(runtime);
  let iap = null;
  let error = null;
  try {
    iap = await readIapAccess(runtime);
  } catch (err) {
    error = err.message;
    runtime.log('WARN', `the IAP policy could not be read: ${err.message}`);
  }
  const granted = new Set(iap?.users || []);
  const recorded = new Set(users.map((user) => user.email));
  return {
    users: users.map((user) => ({ ...user, iap: iap ? granted.has(user.email) : null })),
    access: {
      checked: Boolean(iap),
      error,
      resource: iap?.resource ?? null,
      without_user: iap ? iap.users.filter((email) => !recorded.has(email)) : [],
      other_members: iap?.others ?? [],
    },
  };
}

/**
 * Adds a dashboard user: the IAP grant, then the record.
 *
 * @param {object} runtime
 * @param {{email: string, role: string, actor: {email: string, role: string}, now?: Date}} o
 * @returns {Promise<{user: object, access: 'granted'|'already_granted'}>}
 */
export async function addDashboardUser(runtime, { email, role, actor, now = new Date() }) {
  requireAdmin(actor);
  const normalized = normalizeEmail(email);
  if (!DASHBOARD_ROLES.includes(role)) throw new HttpError(400, `the role must be one of ${DASHBOARD_ROLES.join(', ')}`);
  if (await getUser(runtime, normalized)) throw new HttpError(409, `${normalized} is already a user`);

  const { changed } = await grantIapAccess(runtime, normalized);
  try {
    const user = await addUser(runtime, { email: normalized, role, addedBy: actor.email, now });
    return { user, access: changed ? 'granted' : 'already_granted' };
  } catch (err) {
    // Someone else added them in the meantime: they are a user, and a user keeps the grant.
    const addedMeanwhile = err instanceof HttpError && err.status === 409;
    if (changed && !addedMeanwhile) await undoGrant(runtime, normalized, err);
    throw err;
  }
}

async function undoGrant(runtime, email, cause) {
  try {
    await revokeIapAccess(runtime, email);
  } catch (undoErr) {
    runtime.log('ERROR', `${email} was granted IAP access but no user record; taking the grant back failed: ${undoErr.message}`);
    throw new HttpError(500, `${email} could not be added (${cause.message}), and the sign-in access granted a moment ago could not be taken back (${undoErr.message}). They show under access without a user; revoke it there`);
  }
}

/**
 * Changes a user's role. Only the record changes: both roles hold the same IAP grant. The last admin
 * stays an admin (users.mjs).
 *
 * @param {object} runtime
 * @param {{email: string, role: string, actor: {email: string, role: string}, now?: Date}} o
 * @returns {Promise<object>} the user as changed
 */
export async function setDashboardUserRole(runtime, { email, role, actor, now = new Date() }) {
  requireAdmin(actor);
  return setUserRole(runtime, { email, role, changedBy: actor.email, now });
}

/**
 * Removes a dashboard user: the record, then the IAP grant. A grant that could not be removed is
 * reported in `access_error`, not thrown: the person is no longer a user either way.
 *
 * @param {object} runtime
 * @param {{email: string, actor: {email: string, role: string}}} o
 * @returns {Promise<{user: object, access: 'revoked'|'not_granted'|'revoke_failed', access_error?: string}>}
 */
export async function removeDashboardUser(runtime, { email, actor }) {
  requireAdmin(actor);
  const normalized = normalizeEmail(email);
  if (normalized === actor.email) throw new HttpError(409, 'you cannot remove yourself; another admin can');
  const user = await removeUser(runtime, { email: normalized });
  try {
    const { changed } = await revokeIapAccess(runtime, normalized);
    return { user, access: changed ? 'revoked' : 'not_granted' };
  } catch (err) {
    runtime.log('WARN', `${normalized} was removed, but their IAP grant could not be: ${err.message}`);
    return { user, access: 'revoke_failed', access_error: err.message };
  }
}

/**
 * Grants IAP access to someone who has a user record but no grant.
 *
 * @param {object} runtime
 * @param {{email: string, actor: {email: string, role: string}}} o
 * @returns {Promise<{email: string, changed: boolean}>}
 */
export async function grantUserAccess(runtime, { email, actor }) {
  requireAdmin(actor);
  const normalized = normalizeEmail(email);
  if (!(await getUser(runtime, normalized))) throw new HttpError(404, `${normalized} is not a user; add them as one instead`);
  const { changed } = await grantIapAccess(runtime, normalized);
  return { email: normalized, changed };
}

/**
 * Revokes the IAP access of someone who has no user record (let through in the Cloud console, say).
 * A user's access goes only with the user: remove the user instead.
 *
 * @param {object} runtime
 * @param {{email: string, actor: {email: string, role: string}}} o
 * @returns {Promise<{email: string, changed: boolean}>}
 */
export async function revokeAccessWithoutUser(runtime, { email, actor }) {
  requireAdmin(actor);
  const normalized = normalizeEmail(email);
  if (await getUser(runtime, normalized)) throw new HttpError(409, `${normalized} is a user; remove the user to take their access away`);
  const { changed } = await revokeIapAccess(runtime, normalized);
  return { email: normalized, changed };
}
