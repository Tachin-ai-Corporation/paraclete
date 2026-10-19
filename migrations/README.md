# migrations/

Data migrations: the changes a release makes to an instance's existing data so that the release can
read it. A release that renames a field, moves a document or changes a file's format under the data
root carries a migration here, and the upgrade runs it once on every instance that installs the
release.

**Installed:** yes, at `/opt/paraclete/migrations/`. `install/vm/migrate.mjs` runs them;
[install/README.md](../install/README.md), "Migrations", says when and what a failure does.

**Belongs here:** one file per migration. **Doesn't:** anything the installer or the bootstrap does to
the machine (packages, users, directories, systemd units: `install/bootstrap.sh`), a fix to one
instance's data (a migration runs on every instance), or work the agent does (missions, `roles/`).

There is no migration yet.

## A migration

One file, `migrations/<version>-<slug>.mjs`:

- `<version>` is the version of the commit that adds it, in the release format `vYYYY.MM.DD.N.N`
  (`agent/release/versions.mjs`). Migrations run oldest version first, and by name within one version.
- `<slug>` says what it does, in lowercase words joined by hyphens: `v2026.11.02.1.1-project-summary.mjs`.
- The file name without `.mjs` is the migration's id, the key it is recorded under. Never rename a
  migration once it is in a release: renamed, it runs again everywhere.

It exports two things. An illustration, for a release that reads a project's `summary` where the
release before read `notes`:

```js
// migrations/v2026.11.02.1.1-project-summary.mjs: copies each project's notes to summary, which this
// release reads. notes stays, for the release before; a later release may drop it.
import { firestoreEncode } from '../agent/storage/firestore.mjs';

export const description = "Copies each project's notes to its new summary field.";

export async function migrate({ db, collections, log }) {
  const projects = await db.query('', collections.projects, [], { noOrderBy: true, limit: 1000 });
  let copied = 0;
  for (const project of projects) {
    if (project.notes === undefined || project.summary !== undefined) continue; // nothing to copy, or done
    await db.patch(`${collections.projects}/${project.id}`, ['summary'], firestoreEncode({ summary: project.notes }));
    copied += 1;
  }
  log(`copied the notes of ${copied} of ${projects.length} projects`);
}
```

| It gets | What it is |
|---|---|
| `db` | The release's Firestore client (`agent/storage/firestore.mjs`), as the VM's service account. Every call is strict unless it passes `{ strict: false }`: a Firestore failure throws, and fails the migration, instead of reading as an empty collection |
| `collections` | `COLLECTIONS` from `agent/storage/collections.mjs`. Never write a collection name as a string |
| `dataRoot` | The data root, `/var/lib/paraclete` on the VM: memory, missions, files |
| `log` | `(line) => void`: a line in the upgrade's log, after the migration's id |

`description` is one sentence; the upgrade logs it as the migration starts. `migrate` throws to fail.
A migration may import the release's own modules by relative path (`../agent/storage/firestore.mjs`),
since this directory sits at the release root. Importing the file must do nothing: the upgrade loads
every migration it is about to run before it runs the first.

## Rules

- **Idempotent.** Running it twice leaves the data as running it once did. A migration that succeeded
  but could not be recorded runs again at the next upgrade, and a first install runs every migration
  the release carries, because the project's Firestore may hold an older install's data. Check before
  changing; never assume the data is in the old shape.
- **Readable by the release before.** There is no undoing a migration. A failed upgrade starts the
  previous release again on whatever the migration changed before it failed, and rolling back means
  installing the previous release. Add and copy before you remove: leave the old field until a later
  release no longer reads it.
- **Data only.** It runs as the `paraclete` user, the services' own, while the services are stopped:
  Firestore through the VM's account, and the data root, where what it writes stays the services'.
  It cannot change installed code, `/etc/paraclete` or the machine.
- **Quick.** The services are down while it runs, and the whole upgrade has a time limit (the
  contracts' `control.upgrade_max_seconds`). Touch only what needs changing, and log progress.
- **Tested.** Its tests live at the mirrored path, `tests/migrations/<version>-<slug>.test.mjs`,
  against the Firestore fake in `tests/fakes/`: the old shape migrated, the new shape left alone, and
  a second run changing nothing.

## The record

Firestore `config/migrations` holds what ran on this instance:
`{ applied: { <id>: { applied_at, release } } }`, `release` being the version of the release that
applied it (its commit when it has none). A migration is recorded as soon as it succeeds, and never runs again once recorded. On the
VM, `node /opt/paraclete/install/vm/migrate.mjs --dry-run --project <id> --data-root /var/lib/paraclete`
lists the installed release's migrations that the record lacks, and changes nothing; an upgrade's log
lists the new release's.
