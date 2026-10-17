# agent/storage/

Where the agent's data lives.

**Belongs here:** the Firestore client, the git artifact store (git bundles in the bucket, with
compare-and-swap refs), the file store for files coming in and going out, and entity ids.
**Doesn't:** decisions about what to store. Callers in `work/` and `context/` decide; this package only
reads and writes.

**Status:** empty. Arrives in build plan phase 2.
