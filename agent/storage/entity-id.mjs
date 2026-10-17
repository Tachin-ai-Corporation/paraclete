// agent/storage/entity-id.mjs: an entity's id is its Firestore document id. Readers derive the id
// from the document path, which no writer can forget; writers still stamp `id` into the body so the
// two agree. It does not read or write Firestore itself. Loaders of projects and processes call it.
//
// Why: a writer that stored an entity under `doc(id)` but left `id` out of the body produced a record
// every loader that required a truthy `id` silently skipped. The dashboard reported success and the
// agent never saw the record. Deriving identity from the path closes that whole class of bug.

/**
 * Extracts the document id from a Firestore REST resource name.
 *
 * A REST `name` is a full resource path:
 *   projects/{gcp}/databases/(default)/documents/projects/quarterly-report
 *                                                        ^^^^^^^^^^^^^^^^ the id
 *
 * @param {string} name - Firestore document resource name
 * @returns {string} the trailing path segment, or '' when unparseable
 */
export function docIdFromName(name) {
  if (typeof name !== 'string' || name === '') return '';
  const trimmed = name.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Reconciles a decoded entity body with its authoritative document path.
 *
 * The document path wins. A body that carries a different `id` is a real integrity defect (a record
 * copied between documents), so it is reported rather than silently repaired.
 *
 * @param {object} decoded - decoded Firestore fields
 * @param {string} name - Firestore document resource name
 * @returns {{ entity: object|null, id: string, mismatch: string|null }}
 *   `entity` is null when no id can be established at all.
 */
export function reconcileEntityId(decoded, name) {
  const docId = docIdFromName(name);
  const bodyId = decoded && typeof decoded.id === 'string' ? decoded.id : '';
  if (!docId) {
    if (!bodyId) return { entity: null, id: '', mismatch: null };
    return { entity: decoded, id: bodyId, mismatch: null };
  }
  const mismatch = bodyId && bodyId !== docId ? bodyId : null;
  return { entity: { ...decoded, id: docId }, id: docId, mismatch };
}

/**
 * Stamps the canonical id onto an entity about to be written.
 *
 * @param {string} id - the document id the entity will be stored under
 * @param {object} body - the entity body
 * @returns {object} a copy of `body` with `id` set to the document id
 */
export function withCanonicalId(id, body) {
  return { ...body, id };
}
