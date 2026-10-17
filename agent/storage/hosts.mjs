// agent/storage/hosts.mjs: the production API origins the storage clients call. Every client takes
// an override (firestoreHost, storageHost), which integration tests use to point it at the local
// fakes in tests/fakes/ and which the instance record's `endpoints` can set. Nothing else should
// write these URLs.

/** The Firestore API origin. */
export const FIRESTORE_HOST = 'https://firestore.googleapis.com';

/** The Cloud Storage JSON API origin. */
export const STORAGE_HOST = 'https://storage.googleapis.com';
