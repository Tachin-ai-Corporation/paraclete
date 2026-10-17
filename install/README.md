# install/

Everything that turns a Google Cloud project into a running paraclete, keeps it current, and takes it
away again.

| File | Runs where | Job |
|---|---|---|
| `install.sh` | Cloud Shell, as the project owner | Prepares the project and creates the agent's VM. Safe to re-run: re-running repairs |
| `uninstall.sh` | Cloud Shell, as the project owner | Removes what `install.sh` created. Keeps the Firestore database and the bucket unless `--purge` |
| `bootstrap.sh` | The VM, as root, at every boot | Installs a release onto `/opt/paraclete`, prepares the data root, starts the services |
| `upgrade.sh` | The VM, as root | Moves the instance to another release: fetches that release's own `bootstrap.sh` and runs it |
| `manifest.txt` | Read by `bootstrap.sh` | Which repo paths are installed onto the VM |
| `firestore.indexes.json` | Read by `install.sh` and `uninstall.sh` | Firestore composite indexes and TTL policies |
| `lib/` | Sourced by `install.sh` and `uninstall.sh` | Their shared shell functions: output and the dry-run `run`, JSON reads, resource names, refs, IAM, indexes |
| `vm/` | Run by `bootstrap.sh`, from the release it installs | Its Node helpers: staging what the manifest lists, the command launchers, `release.json`, the instance record, the validation gate, the readiness document |

**Installed:** `bootstrap.sh`, `upgrade.sh`, `manifest.txt` and `vm/` are installed on the VM; the rest
stay in the repo.

## Running it

In Cloud Shell, as an owner of the project, from a clone of this repository:

```
install/install.sh                     # asks for the role and the agent's name, shows the plan, asks to go ahead
install/install.sh --dry-run           # prints every command that would change something; changes nothing
install/install.sh --project your-gcp-project --role generic --name Paraclete --yes
```

| Flag | Default | Notes |
|---|---|---|
| `--project <id>` | gcloud's configured project | |
| `--role <id>` | `generic` | One of `roles/<id>/role.json` |
| `--name <name>` | `Paraclete` | Up to 40 letters, digits, spaces and `. _ ' -` |
| `--region <region>` | `us-central1` | Firestore, the bucket and the VM |
| `--zone <zone>` | `<region>-a` | Must be in the region |
| `--ref <tag, branch or commit>` | The newest release tag, else the default branch | Resolved with `git ls-remote` to the full commit the VM installs |
| `--repo <owner>/<name>` | This clone's `origin` | A fork must be public |
| `--yes` | | Asks nothing: takes the defaults and skips the confirmation |
| `--dry-run` | | The read-only checks still run |

The steps, each printed as `[n/9]`:

1. **check**: gcloud logged in; the caller can do what an owner does (`testIamPermissions`); billing on;
   the project inside an organization; the role exists; the ref resolves and has `install/bootstrap.sh`.
2. **apis**: compute, run, firestore, iam, iamcredentials, aiplatform, artifactregistry, cloudbuild,
   secretmanager, storage, iap, drive; plus chat, gmail, calendar-json, docs, sheets, slides, people and
   admin for a Workspace role. Only the ones that are off.
3. **accounts**: `paraclete-agent@` with the `gcp_roles` of `generic` and of the role;
   `paraclete-dashboard@` with what the dashboard needs; on a Workspace role `paraclete-dwd@`, which
   `paraclete-agent@` alone may sign as.
4. **firestore**: the `(default)` database in Native mode, in the region, with delete protection; the
   indexes and TTL policies in `firestore.indexes.json`.
5. **bucket**: `gs://<project>-paraclete` with uniform access, public access prevention, and a lifecycle
   rule deleting `files.prefix` + `in/` after `files.inbox_retention_days` (`config/contracts.json`);
   object admin for both accounts on this bucket only.
6. **dashboard**: arrives in a later release (build plan phase 6).
7. **network**: the `default` network, or a `paraclete` network when there is none; the firewall rule
   `paraclete-allow-iap-ssh` (tcp:22 from IAP's range to the tag `paraclete`, priority 1000) and
   `paraclete-deny-ingress` (deny everything else inbound to that tag, priority 65000, which outranks a
   default network's own allow rules).
8. **vm**: `paraclete`, e2-standard-2, 50 GB pd-balanced, Debian 12, Shielded VM, running as
   `paraclete-agent@` with the cloud-platform and drive scopes, with the metadata below. A VM that already
   exists keeps its disk: only its metadata changes.
9. **wait**: until `agent/instance` reports `ready` (or `failed`) for this commit, up to 20 minutes.

Re-running with another `--ref` moves an existing instance: the VM installs that commit at its next boot,
or at once through `upgrade.sh`, and the installer prints both commands. To watch the agent:

```
gcloud compute ssh paraclete --zone=<zone> --project=<project> --tunnel-through-iap -- sudo journalctl -u 'paraclete-*' -f
```

To remove it:

```
install/uninstall.sh                   # names exactly what it will delete, then asks
install/uninstall.sh --dry-run
install/uninstall.sh --purge           # also the Firestore database and the bucket: asks you to type the project id
```

`uninstall.sh` takes `--project`, `--region` (default: the VM's region, else `us-central1`), `--purge`,
`--yes` (which never skips typing the project id for `--purge`) and `--dry-run`. Enabled APIs stay on.

## The contract between the pieces

`install.sh` and `bootstrap.sh` never share code; they share this contract. Change it here first.

### VM metadata (written by `install.sh`, read by `bootstrap.sh`)

| Key | Value |
|---|---|
| `paraclete-repo` | The GitHub repository to install from, `owner/name` |
| `paraclete-ref` | The full 40-character commit to install. The installer resolves a tag or branch to it |
| `paraclete-release` | What was asked for (a release tag, a branch name, or the commit), for display |
| `paraclete-role` | The role id, e.g. `generic` |
| `paraclete-agent-name` | The agent's display name |
| `paraclete-bucket` | The instance's bucket, `<project>-paraclete` |
| `paraclete-workspace-account`, `paraclete-workspace-signer` | Workspace roles only: the agent's Google account and the delegation signer service account. Never written by `install.sh`: the account exists only after the dashboard's Workspace setup (build plan phase 8), which records them |
| `paraclete-dashboard-url` | Once the dashboard exists |
| `startup-script` | A short stub: at every boot, read `paraclete-repo` and `paraclete-ref` from metadata, download `install/bootstrap.sh` at that commit, and run it as root in the transient unit `paraclete-bootstrap` (its output goes to the journal) |

The project, zone and region come from the metadata server's own attributes.

### Environment (set by `upgrade.sh`, read by `bootstrap.sh`)

| Variable | Overrides | Value |
|---|---|---|
| `PARACLETE_REF` | `paraclete-ref` | The full 40-character commit to install. When set, it is what the run installs |
| `PARACLETE_REPO` | `paraclete-repo` | `owner/name` the commit comes from |
| `PARACLETE_RELEASE` | `paraclete-release` | What was asked for, for display |

`upgrade.sh --ref <tag or commit> [--repo <owner>/<name>]` resolves the ref (`git ls-remote`), downloads
that commit's own `install/bootstrap.sh` and runs it with these set; the metadata is never changed, so the
agent's service account needs no right to change it. `--repo` defaults to the installed release's
repository.

### Which commit a run installs

1. `PARACLETE_REF`, when set (an upgrade).
2. Otherwise the installed release, when `paraclete-repo` and `paraclete-ref` are still the values
   recorded in its `release.json` `metadata`: nothing new was asked for since, so an upgrade survives a
   reboot.
3. Otherwise `paraclete-ref`: the metadata changed (`install.sh` ran again with another ref), or nothing is
   installed.

A commit is installed by that commit's own `bootstrap.sh`: a run that finds the instance should stay on
an installed upgrade hands over to the installed copy. When that commit is already installed whole, a run
installs nothing: it re-checks the user, directories, instance record, token and units, starts what is
not running (restarting everything when one of those changed), and writes readiness.

### What `bootstrap.sh` produces

| Path | Owner and mode | Holds |
|---|---|---|
| `/opt/paraclete/` | `root:root`, read-only to everyone else | The files `manifest.txt` lists, at their repo paths; `agent/node_modules/` (`npm ci`); `bin/` launchers; `release.json` |
| `/opt/paraclete/bin/<command>` | `root:root 0755` | `#!/bin/sh` + `exec /usr/bin/node /opt/paraclete/<path>.mjs "$@"` for every `agent/cli/<command>.mjs` (not `cli-runtime.mjs`) and every command a skill (in `skills/`, `roles/generic/skills/` or `roles/<role>/skills/`) lists in its `skill.json` and keeps as `<command>.mjs` in its own directory. Never a symlink |
| `/opt/paraclete/release.json` | `root:root 0644` | `{ "version", "ref", "commit", "repo", "installed_at", "metadata": { "repo", "ref" } }`. `version` is the release tag, else the version prefix of the commit's message, else null; `ref` is what was asked for; `metadata` holds `paraclete-repo` and `paraclete-ref` as they were when this release was installed |
| `/etc/paraclete/instance.json` | `root:root 0644` | The instance record (`config/instance.mjs`), from the metadata above, with `release` and `source_repo` naming what is installed. The record an install replaced stays in `instance.json.prev`, for a rollback, until the next install |
| `/etc/paraclete/gateway-token` | `root:paraclete 0640` | A random token, created once, kept across upgrades |
| `/var/lib/paraclete/` | `paraclete:paraclete 0750` | The data root: `memory/`, `missions/`, `workspace/`, `files/`, `skills/`, `services/`, `home/` (the `paraclete` user's home) |
| `/etc/systemd/system/paraclete-*.service` | `root:root 0644` | Copied from `agent/services/*/`, enabled and started, the gateway first |

- The `paraclete` user is a system user whose home is `/var/lib/paraclete/home`, in the
  `systemd-journal` group (telemetry reads the journal).
- An install is staged in `/opt/paraclete.next` and swapped into place; the previous install stays in
  `/opt/paraclete.prev` until the next upgrade.
- **The validation gate.** Before anything is stopped, the staged release must pass
  `vm/check-release.mjs`, run with its own code and npm packages: its contracts load and validate, every
  service has its unit and its `main.mjs` loads with everything it imports, and every launcher's command
  exists and loads. Its instance record must pass its own `validateInstance()`. A release that fails is
  not installed, and the running one is not touched.
- **Rollback.** If the swapped-in release's gateway is not ready within the contracts'
  `control.gateway_ready_timeout_ms`, or a service is not running a few seconds after it started, the
  previous release and instance record are put back and started, and the run reports `failed`.
- One run at a time (`flock` on `/run/paraclete-bootstrap.lock`), so a boot and an upgrade never stage
  over each other.

### Readiness

At the end of every run, `bootstrap.sh` writes the Firestore document `agent/instance` (only these
fields; anything else in the document stays): `{ status: 'ready', release, commit, ready_at }` once the
services are up, or `{ status: 'failed', release, commit, error, failed_at }`. `release` and `commit`
name what the run installed or tried to install; a `ready` clears the last `error`. `install.sh` and
`dev/` scripts wait on it. A first boot that fails before Node.js and the release are on the VM (reading
the metadata, installing packages, downloading) cannot write it; its error is in the VM's journal and
serial console.

### `manifest.txt`

One repo path per line; `#` starts a comment. A path ending in `/` installs everything beneath it except
`node_modules/`. `{role}` stands for the instance's role. The repo path is the VM path: nothing is
renamed on the way.

## Rules

- Every step is idempotent; re-running repairs.
- Scripts read values from `config/contracts.json` where one exists, never a second copy.
- The manifest never lists anything from `dev/`, `docs/`, `tests/`, `dashboard/` or the root guidance
  files (`tests/repo/structure.test.mjs` checks).
- `install.sh --ref <branch>` and `--repo <owner>/paraclete` install a dev instance from a branch or a
  fork. See [DEVELOPING.md](../DEVELOPING.md) section 7.
