// dashboard/lib/server/users.mjs: dashboard users, one document per person in `users/{email}`.
//
//   { email, role: 'admin' | 'member', added_by, added_at, updated_by?, updated_at? }
//
// Admins manage users, settings, secrets and upgrades; members chat, follow and approve missions,
// and download files. install/install.sh writes the first admin: the person who installed. A user
// record alone grants nothing without the IAP grant on the service, and the IAP grant alone grants
// nothing without a record; the users routes change both together.
//
// The last admin can be neither removed nor made a member, so the dashboard always has someone who
// can manage it.

import { firestoreEncode, StoreConflict } from '../../../agent/storage/firestore.mjs';
import { HttpError } from './errors.mjs';

export const DASHBOARD_ROLES = Object.freeze(['admin', 'member']);

const EMAIL_PATTERN = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

/**
 * An email as the dashboard stores it: trimmed and lowercased. Refuses anything that is not one.
 *
 * @param {unknown} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(value)) throw new HttpError(400, `'${String(email ?? '')}' is not an email address`);
  return value;
}

function checkRole(role) {
  if (!DASHBOARD_ROLES.includes(role)) throw new HttpError(400, `the role must be one of ${DASHBOARD_ROLES.join(', ')}`);
}

const pathOf = (runtime, email) => `${runtime.collections.users}/${email}`;

function shape(email, data) {
  if (!data || !DASHBOARD_ROLES.includes(data.role)) return null;
  return {
    email,
    role: data.role,
    added_by: data.added_by ?? null,
    added_at: data.added_at ?? null,
    updated_by: data.updated_by ?? null,
    updated_at: data.updated_at ?? null,
  };
}

/**
 * One user, or null when there is no record (or it holds no valid role).
 *
 * @param {object} runtime
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function getUser(runtime, email) {
  const normalized = normalizeEmail(email);
  return shape(normalized, await runtime.db.read(pathOf(runtime, normalized), { strict: true }));
}

/**
 * Every user, admins first, then by email.
 *
 * @param {object} runtime
 * @returns {Promise<object[]>}
 */
export async function listUsers(runtime) {
  const docs = await runtime.db.query('', runtime.collections.users, [], { noOrderBy: true, limit: 500, strict: true });
  return docs
    .map((doc) => shape(doc.id, doc))
    .filter(Boolean)
    .sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1));
}

/**
 * Adds a user. Refuses one who already exists.
 *
 * @param {object} runtime
 * @param {{email: string, role: string, addedBy: string, now?: Date}} o
 * @returns {Promise<object>} the new user
 */
export async function addUser(runtime, { email, role, addedBy, now = new Date() }) {
  const normalized = normalizeEmail(email);
  checkRole(role);
  const data = { email: normalized, role, added_by: addedBy, added_at: now.toISOString() };
  try {
    await runtime.db.commit([{ path: pathOf(runtime, normalized), data, precondition: { exists: false } }]);
  } catch (err) {
    if (err instanceof StoreConflict) throw new HttpError(409, `${normalized} is already a user`);
    throw err;
  }
  return shape(normalized, data);
}

/**
 * Changes a user's role. Refuses to make the last admin a member.
 *
 * @param {object} runtime
 * @param {{email: string, role: string, changedBy: string, now?: Date}} o
 * @returns {Promise<object>} the user as changed
 */
export async function setUserRole(runtime, { email, role, changedBy, now = new Date() }) {
  const normalized = normalizeEmail(email);
  checkRole(role);
  const current = await getUser(runtime, normalized);
  if (!current) throw new HttpError(404, `${normalized} is not a user`);
  if (current.role === 'admin' && role !== 'admin') await refuseLastAdmin(runtime, normalized, 'made a member');
  const fields = { role, updated_by: changedBy, updated_at: now.toISOString() };
  await runtime.db.patch(pathOf(runtime, normalized), Object.keys(fields), firestoreEncode(fields), { strict: true });
  return { ...current, ...fields };
}

/**
 * Removes a user's record. Refuses to remove the last admin.
 *
 * @param {object} runtime
 * @param {{email: string}} o
 * @returns {Promise<object>} the user as they were
 */
export async function removeUser(runtime, { email }) {
  const normalized = normalizeEmail(email);
  const current = await getUser(runtime, normalized);
  if (!current) throw new HttpError(404, `${normalized} is not a user`);
  if (current.role === 'admin') await refuseLastAdmin(runtime, normalized, 'removed');
  await runtime.db.del(pathOf(runtime, normalized), { strict: true });
  return current;
}

async function refuseLastAdmin(runtime, email, what) {
  const admins = (await listUsers(runtime)).filter((user) => user.role === 'admin' && user.email !== email);
  if (admins.length === 0) throw new HttpError(409, `${email} is the only admin and cannot be ${what}; make someone else an admin first`);
}
