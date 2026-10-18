# agent/storage/

Where the agent's data lives.

**Belongs here:** the Firestore client, the git artifact store (git bundles in the bucket, with
compare-and-swap refs), the file store for files coming in and going out, and entity ids.
**Doesn't:** decisions about what to store. Callers in `work/` and `context/` decide; this package only
reads and writes.

## Files

| File | Does |
|---|---|
| `collections.mjs` | The name of every Firestore collection and subcollection. Never write a collection name anywhere else |
| `firestore.mjs` | The Firestore REST client and its value encoding. Strict callers fail closed on any store error |
| `git-store.mjs` | The git artifact store: repositories as bundles in the bucket, one ref document per branch |
| `file-store.mjs` | Uploads outgoing files to the bucket as a mission's downloads (`files/out/<mission>/`), refusing credentials and oversized files |
| `file-names.mjs` | The object names of outgoing and incoming files (`files/out/<mission>/`, `files/in/<upload>/`), safe file names and content types. No file system access, so the dashboard imports it too |
| `entity-id.mjs` | An entity's id is its document path; helpers that keep stored ids honest |
