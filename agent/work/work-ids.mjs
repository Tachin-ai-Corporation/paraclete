// agent/work/work-ids.mjs: the id and digest grammars the work record schemas check fields
// against. Firestore collection names live in agent/storage/collections.mjs, not here. Used by
// work-schema.mjs.

/**
 * A record id: lowercase kebab-case, 1 to 64 characters, starting and ending with a letter or
 * digit. Deliberately narrow: these ids appear in Firestore document paths, git artifact paths,
 * file paths and URLs, and what all four accept safely is small.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/** A digest always names its algorithm, so the algorithm is never implied: `sha256:<64 hex>`. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
