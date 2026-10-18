// agent/files/outgoing.mjs: the `files` records of a mission's outgoing files. Every file the agent
// hands back, whether the files skill's file-share sent it or the artifact export of a dashboard
// mission did (agent/work/artifacts.mjs), gets one record, `files/out-<mission>-<name>`, so the
// dashboard lists the mission's downloads and the mission's final reply attaches them. The id is
// deterministic: sharing a name again overwrites both the object and its record, and the latest wins.
// The bytes themselves are file-store.mjs's; incoming ('in') records are the dashboard's to write.

import { COLLECTIONS } from '../storage/collections.mjs';

/** The most files a reply carries as attachments. The mission's downloads list shows them all. */
export const MAX_ATTACHMENTS = 20;

/** How many records a mission's listing reads. */
const LIST_LIMIT = 300;

/**
 * The record id of a mission's outgoing file: out-<mission id>-<name, with every character other
 * than letters, digits, '_' and '-' as '_'>.
 *
 * @param {string} missionId
 * @param {string} name the file's name as stored (already sanitized by file-store)
 * @returns {string}
 */
export function outgoingFileId(missionId, name) {
  return `out-${missionId}-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * The record of one outgoing file.
 *
 * @param {object} o
 * @param {string} o.missionId
 * @param {{name: string, size: number, gcsPath: string, contentType: string, sha256?: string|null}} o.file
 *   as file-store's upload returns it
 * @param {'artifact'|'file-share'} o.source
 * @param {string} o.createdBy  the agent's identity email
 * @param {string} o.at         ISO time
 * @param {{file_id: string, link: string|null, folder_id: string|null}|null} [o.drive]
 * @returns {object}
 */
export function outgoingRecord({ missionId, file, source, createdBy, at, drive = null }) {
  return {
    direction: 'out',
    mission_id: missionId,
    name: file.name,
    size: Number(file.size) || 0,
    content_type: file.contentType || 'application/octet-stream',
    gcs_path: file.gcsPath,
    sha256: file.sha256 || null,
    source,
    created_at: at,
    created_by: createdBy || null,
    drive: drive || null,
    expires_at: null,
  };
}

/**
 * Writes the records of a mission's uploaded files. Best effort file by file unless `strict`: a
 * failed write is logged and the rest are still written.
 *
 * @param {object} db a Firestore client (agent/storage/firestore.mjs)
 * @param {object} o
 * @param {string} o.missionId
 * @param {Array<object>} o.files        file-store upload results
 * @param {'artifact'|'file-share'} o.source
 * @param {string} o.createdBy
 * @param {object|null} [o.drive]        for a single file-share that also went to Drive
 * @param {Function} [o.now]             clock in milliseconds
 * @param {boolean} [o.strict]           throw on a failed write instead of logging it
 * @param {Function} [o.log]             (level, message)
 * @returns {Promise<Array<{id: string, record: object}>>} the records written
 */
export async function recordOutgoing(db, { missionId, files, source, createdBy, drive = null, now = Date.now, strict = false, log = () => {} }) {
  const written = [];
  const at = new Date(now()).toISOString();
  for (const file of files || []) {
    const id = outgoingFileId(missionId, file.name);
    const path = `${COLLECTIONS.files}/${id}`;
    let record = outgoingRecord({ missionId, file, source, createdBy, at, drive });
    // The artifact export runs at the end and re-uploads a file the agent may already have shared on
    // purpose. The object is the same; what the agent recorded about sharing it (that it was shared,
    // and its Drive copy) stays.
    if (source === 'artifact' && typeof db.read === 'function') {
      const existing = await db.read(path).catch(() => null);
      if (existing?.source === 'file-share') record = { ...record, source: 'file-share', drive: existing.drive ?? null };
    }
    try {
      const ok = await db.write(path, record, { strict });
      if (!ok) throw new Error('the write was refused');
      written.push({ id, record });
    } catch (err) {
      if (strict) throw err;
      log('WARN', `files record ${id} not written: ${err.message}`);
    }
  }
  return written;
}

/**
 * A mission's outgoing records, oldest first. Strict: an outage throws rather than reading as "none".
 *
 * @param {object} db
 * @param {string} missionId
 * @returns {Promise<Array<object>>} each with its record id as `id`
 */
export async function listOutgoing(db, missionId) {
  const rows = await db.query('', COLLECTIONS.files, [
    { field: 'mission_id', op: 'EQUAL', value: { stringValue: String(missionId) } },
  ], { noOrderBy: true, limit: LIST_LIMIT, strict: true });
  return rows
    .filter((r) => r.direction === 'out' && r.gcs_path)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/**
 * A reply's attachments from a mission's outgoing records and any attachments it already carries:
 * one per object (deduplicated by gcsPath, a record's details winning), files the agent shared on
 * purpose (file-share) before the artifact export's, at most `cap`. Pure.
 *
 * @param {Array<object>} records         listOutgoing's
 * @param {Array<{name: string, size: number, gcsPath: string}>} [existing] e.g. context.attachments_export
 * @param {number} [cap]
 * @returns {Array<{name: string, size: number, gcsPath: string}>}
 */
export function replyAttachments(records, existing = [], cap = MAX_ATTACHMENTS) {
  const rank = (r) => (r.source === 'file-share' ? 0 : 1);
  const fromRecords = [...(records || [])]
    .sort((a, b) => rank(a) - rank(b))
    .map((r) => ({ name: r.name || '', size: Number(r.size) || 0, gcsPath: r.gcs_path }));
  const out = [];
  const seen = new Set();
  for (const a of [...fromRecords, ...(existing || [])]) {
    if (!a || !a.gcsPath || seen.has(a.gcsPath)) continue;
    seen.add(a.gcsPath);
    out.push({ name: a.name || '', size: Number(a.size) || 0, gcsPath: a.gcsPath });
  }
  return out.slice(0, cap);
}
