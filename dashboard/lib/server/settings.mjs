// dashboard/lib/server/settings.mjs: the effort setting, the one admin setting the dashboard writes
// itself. It lives in `config/settings`, a document with several writers: the dashboard owns `effort`
// and the two fields saying who changed it and when; the control service's set_model command owns the
// Claude fields. So every write here is field-masked to the effort fields, never a whole document.
//
// What a stored value means is the brain's rule, applied the same way here: the brain reads the field
// with adminEffort() (agent/services/brain/settings.mjs), which takes the contracts' `effort.default`
// when the field is absent and turns anything that is not a level into `medium`
// (normalizeEffort in agent/work/effort.mjs). The levels are effort.mjs's. The brain reads the
// document again at most once a minute, at the start of an intake pass, so a change takes effect
// within about a minute, without a restart.

import { firestoreEncode } from '../../../agent/storage/firestore.mjs';
import { EFFORT_LEVELS, effortScale, normalizeEffort } from '../../../agent/work/effort.mjs';
import { HttpError } from './errors.mjs';

/** The fields of `config/settings` the dashboard writes; nothing else in the document is touched. */
export const EFFORT_FIELDS = Object.freeze(['effort', 'effort_updated_at', 'effort_updated_by']);

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
