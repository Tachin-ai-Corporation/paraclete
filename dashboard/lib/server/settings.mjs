// dashboard/lib/server/settings.mjs: the admin settings the dashboard writes itself: the effort, and
// the Drive output folder. They live in `config/settings`, a document with several writers: the
// dashboard owns `effort` and `drive_output_folder`, each with two fields saying who changed it and
// when; the control service's set_model command owns the Claude fields. So every write here is
// field-masked to one setting's fields, never a whole document.
//
// What a stored value means is the brain's rule, applied the same way here: the brain reads the field
// with adminEffort() (agent/services/brain/settings.mjs), which takes the contracts' `effort.default`
// when the field is absent and turns anything that is not a level into `medium`
// (normalizeEffort in agent/work/effort.mjs). The levels are effort.mjs's. The brain reads the
// document again at most once a minute, at the start of an intake pass, so a change takes effect
// within about a minute, without a restart.
//
// The Drive output folder is where the agent saves files to Drive when nobody named a folder: a Drive
// folder id, or null for none. The drive skill and the control service's drive_check read it. For the
// agent's service account it must sit in a shared drive the account belongs to, since a service
// account has no Drive storage of its own; the Test Drive check says whether it can write there.
//
// Automatic updates (`auto_update`) say whether the dashboard's update job installs new releases by
// itself (auto-update.mjs). Only a stored true or false counts; anything else, the field's absence
// included, is the contracts' `auto_update.enabled_by_default`. install/install.sh --no-auto-update
// stores false. The job reads it at the start of every run, so a change takes effect at the next one.

import { firestoreEncode } from '../../../agent/storage/firestore.mjs';
import { EFFORT_LEVELS, effortScale, normalizeEffort } from '../../../agent/work/effort.mjs';
import { HttpError } from './errors.mjs';

/** The fields of `config/settings` the effort setting writes; nothing else in the document is touched. */
export const EFFORT_FIELDS = Object.freeze(['effort', 'effort_updated_at', 'effort_updated_by']);

/** The fields of `config/settings` the Drive output folder writes. */
export const DRIVE_FIELDS = Object.freeze(['drive_output_folder', 'drive_output_folder_updated_at', 'drive_output_folder_updated_by']);

/** The fields of `config/settings` the automatic-update setting writes. */
export const AUTO_UPDATE_FIELDS = Object.freeze(['auto_update', 'auto_update_updated_at', 'auto_update_updated_by']);

/** A Drive file or folder id: letters, digits, '-' and '_' (a shared drive's own id is 19 characters, a folder's usually 33). */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;

const settingsPath = (runtime) => `${runtime.collections.config}/settings`;

/**
 * The effort level the brain uses when no admin has chosen one.
 *
 * @param {object} runtime
 * @returns {string}
 */
export function defaultEffort(runtime) {
  return normalizeEffort(runtime.contracts.effort?.default);
}

function effortView(runtime, doc) {
  const stored = typeof doc.effort === 'string' ? doc.effort : null;
  return {
    // What the brain runs at, read its way.
    effort: normalizeEffort(stored ?? runtime.contracts.effort?.default),
    stored,
    unknown: stored !== null && !EFFORT_LEVELS.includes(stored),
    default: defaultEffort(runtime),
    levels: EFFORT_LEVELS.map((id) => ({ id, scale: effortScale(id) })),
    updated_at: doc.effort_updated_at ?? null,
    updated_by: doc.effort_updated_by ?? null,
  };
}

/**
 * The effort setting: the level the brain uses, what is stored, the levels to choose from with the
 * factor each applies to an organ's sampling temperature, and who changed it last. Read strictly: an
 * outage is an error, never "the default".
 *
 * @param {object} runtime
 * @returns {Promise<{effort: string, stored: string|null, unknown: boolean, default: string,
 *   levels: Array<{id: string, scale: number}>, updated_at: string|null, updated_by: string|null}>}
 */
export async function readEffort(runtime) {
  const doc = (await runtime.db.read(settingsPath(runtime), { strict: true })) || {};
  return effortView(runtime, doc);
}

/**
 * Sets the effort level. Admins only; the level must be one the brain knows.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {unknown} o.effort
 * @param {{email: string, role: string}} o.user  who asks
 * @param {Date}   [o.now]
 * @returns {Promise<object>} the setting as stored, readEffort()'s shape
 */
export async function setEffort(runtime, { effort, user, now = new Date() }) {
  if (user?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can change the effort');
  if (typeof effort !== 'string' || !EFFORT_LEVELS.includes(effort)) {
    throw new HttpError(400, `the effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  }
  const fields = { effort, effort_updated_at: now.toISOString(), effort_updated_by: user.email };
  await runtime.db.patch(settingsPath(runtime), [...EFFORT_FIELDS], firestoreEncode(fields), { strict: true });
  return readEffort(runtime);
}

function driveView(doc) {
  const stored = doc.drive_output_folder;
  return {
    drive_output_folder: typeof stored === 'string' && DRIVE_ID.test(stored) ? stored : null,
    // Something stored that is not a folder id: the agent ignores it, and an admin should replace it.
    invalid: stored !== undefined && stored !== null && !(typeof stored === 'string' && DRIVE_ID.test(stored)),
    updated_at: doc.drive_output_folder_updated_at ?? null,
    updated_by: doc.drive_output_folder_updated_by ?? null,
  };
}

/**
 * The Drive output folder: its id or null, and who changed it last. Read strictly: an outage is an
 * error, never "none".
 *
 * @param {object} runtime
 * @returns {Promise<{drive_output_folder: string|null, invalid: boolean, updated_at: string|null, updated_by: string|null}>}
 */
export async function readDriveSettings(runtime) {
  const doc = (await runtime.db.read(settingsPath(runtime), { strict: true })) || {};
  return driveView(doc);
}

/**
 * Sets or clears the Drive output folder. Admins only. The browser turns a pasted folder link into
 * its id; this takes only an id, or null (or '') to clear it.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {unknown} o.folder  a Drive folder id, or null
 * @param {{email: string, role: string}} o.user  who asks
 * @param {Date}    [o.now]
 * @returns {Promise<object>} the setting as stored, readDriveSettings()'s shape
 */
export async function setDriveOutputFolder(runtime, { folder, user, now = new Date() }) {
  if (user?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can change the Drive output folder');
  const id = folder === null || folder === undefined || folder === '' ? null : folder;
  if (id !== null && (typeof id !== 'string' || !DRIVE_ID.test(id))) {
    throw new HttpError(400, 'the output folder must be a Drive folder id (the part after /folders/ in its link), or empty for none');
  }
  const fields = { drive_output_folder: id, drive_output_folder_updated_at: now.toISOString(), drive_output_folder_updated_by: user.email };
  await runtime.db.patch(settingsPath(runtime), [...DRIVE_FIELDS], firestoreEncode(fields), { strict: true });
  return readDriveSettings(runtime);
}

/**
 * Whether automatic updates are on, from a `config/settings` document: a stored true or false, else
 * the contracts' default.
 *
 * @param {object} runtime
 * @param {object} doc  config/settings as read, or {}
 * @returns {boolean}
 */
export function autoUpdateEnabled(runtime, doc) {
  return typeof doc?.auto_update === 'boolean' ? doc.auto_update : runtime.contracts.auto_update.enabled_by_default === true;
}

function autoUpdateView(runtime, doc) {
  return {
    enabled: autoUpdateEnabled(runtime, doc),
    stored: typeof doc.auto_update === 'boolean' ? doc.auto_update : null,
    default: runtime.contracts.auto_update.enabled_by_default === true,
    updated_at: doc.auto_update_updated_at ?? null,
    updated_by: doc.auto_update_updated_by ?? null,
  };
}

/**
 * The automatic-update setting: whether it is on, what is stored, the default, and who changed it
 * last. Read strictly: an outage is an error, never "the default".
 *
 * @param {object} runtime
 * @returns {Promise<{enabled: boolean, stored: boolean|null, default: boolean, updated_at: string|null, updated_by: string|null}>}
 */
export async function readAutoUpdate(runtime) {
  const doc = (await runtime.db.read(settingsPath(runtime), { strict: true })) || {};
  return autoUpdateView(runtime, doc);
}

/**
 * Turns automatic updates on or off. Admins only.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {unknown} o.enabled  true or false
 * @param {{email: string, role: string}} o.user  who asks
 * @param {Date}    [o.now]
 * @returns {Promise<object>} readAutoUpdate()'s shape
 */
export async function setAutoUpdate(runtime, { enabled, user, now = new Date() }) {
  if (user?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can turn automatic updates on or off');
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  const fields = { auto_update: enabled, auto_update_updated_at: now.toISOString(), auto_update_updated_by: user.email };
  await runtime.db.patch(settingsPath(runtime), [...AUTO_UPDATE_FIELDS], firestoreEncode(fields), { strict: true });
  return readAutoUpdate(runtime);
}
