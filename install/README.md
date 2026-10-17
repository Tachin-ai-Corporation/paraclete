# install/

Everything that turns a Google Cloud project into a running paraclete, and back.

| File | Job |
|---|---|
| `install.sh` | Run once by the project owner in Cloud Shell. Creates the service accounts, Firestore, bucket, dashboard and VM. Safe to re-run: re-running repairs. |
| `uninstall.sh` | Removes what `install.sh` created. Keeps the bucket unless `--purge`. |
| `bootstrap.sh` | Runs on the VM at first boot: installs the release onto `/opt/paraclete/` and starts the services. |
| `manifest.txt` | Which repo files go onto the VM. One `<src> <dest>` per line; both columns are the same path. |
| `firestore.indexes.json` | Firestore indexes and TTL policies, applied by `install.sh`. |

## Rules

- Every step is idempotent.
- Nothing here hardcodes a value from `config/contracts.json`; scripts read it.
- The manifest never lists anything from `dev/`, `docs/`, `tests/` or the root guidance files.
- `install.sh --ref <branch>` and `--repo <owner>/paraclete` install a dev instance from a branch or
  fork. See [DEVELOPING.md](../DEVELOPING.md) section 7.

## Status

Empty. Arrives in build plan phase 5.
