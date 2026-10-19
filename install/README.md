# install/

Everything that turns a Google Cloud project into a running paraclete, keeps it current, and takes it
away again.

| File | Runs where | Job |
|---|---|---|
| `install.sh` | Cloud Shell, as the project owner | Prepares the project and creates the agent's VM. Safe to re-run: re-running repairs |
| `uninstall.sh` | Cloud Shell, as the project owner | Removes what `install.sh` created. Keeps the Firestore database, the bucket and the agent's image repository unless `--purge` |
| `bootstrap.sh` | The VM, as root, at every boot | Installs a release onto `/opt/paraclete`, prepares the data root, starts the services |
| `upgrade.sh` | The VM, as root | Moves the instance to another release: fetches that release's own `bootstrap.sh` and runs it |
| `manifest.txt` | Read by `bootstrap.sh` | Which repo paths are installed onto the VM |
| `firestore.indexes.json` | Read by `install.sh` and `uninstall.sh` | Firestore composite indexes and TTL policies |
| `lib/` | Sourced by `install.sh` and `uninstall.sh` | Their shared shell functions: output and the dry-run `run`, JSON reads, resource names, refs, IAM, indexes. And `dashboard.mjs`: the dashboard's build and deploy commands and the bucket's CORS setting for its uploads, which `install.sh` runs as a small Node program and `dev/deploy.mjs` and `dev/status.mjs` import, so there is one definition of them. And `role-access.mjs`: what a role's `role.json` may ask for beyond project roles (its `apis` and `resource_roles`) and the roles never granted project-wide, which `install.sh` runs and `tests/content/packages.test.mjs` imports |
| `vm/` | Run by `bootstrap.sh`, from the release it installs | Its Node helpers: staging what the manifest lists, the command launchers, `release.json`, the instance record, the validation gate, the data migrations (`migrate.mjs`), the readiness document |

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
| `--role <id>` | The existing VM's role, else `generic` | One of `roles/<id>/role.json`. Another role than the VM's moves the instance to it (below) |
| `--name <name>` | The existing VM's agent name, else `Paraclete` | Up to 40 letters, digits, spaces and `. _ ' -` |
| `--region <region>` | The existing VM's region, else `us-central1` | Firestore, the bucket, the dashboard and the VM |
| `--zone <zone>` | The existing VM's zone, else `<region>-a` | Must be in the region |
| `--ref <tag, branch or commit>` | The newest release tag, else the default branch | Resolved with `git ls-remote` to the full commit the VM installs |
| `--repo <owner>/<name>` | This clone's `origin` | A fork must be public |
| `--yes` | | Asks nothing: takes the defaults and skips the confirmation |
| `--dry-run` | | The read-only checks still run |

The steps, each printed as `[n/9]`:

1. **check**: gcloud logged in; the caller can do what an owner does (`testIamPermissions`); billing on;
   the project inside an organization; the role exists, and what `generic`'s and its `role.json` ask for
   is well formed (`lib/role-access.mjs`: short API names, single-resource grants of the two kinds below,
   and no `gcp_roles` entry that acts as any service account or writes to any image repository); the
   ref resolves and has `install/bootstrap.sh`.
2. **apis**: compute, run, firestore, iam, iamcredentials, aiplatform, artifactregistry, cloudbuild,
   secretmanager, storage, iap, drive, cloudresourcemanager (gcloud's `iap web` commands need it); plus chat, gmail, calendar-json, docs, sheets, slides, people and
   admin for a Workspace role; plus the `apis` of `generic`'s and the role's `role.json` (short names,
   `bigquery` for `bigquery.googleapis.com`). Only the ones that are off, each once. None is ever turned
   off, also on a move to another role. Then the **model check**: the contracts'
   cortex model (`vertex.models.cortex`, at `vertex.location`; Gemini 4 is served from the global
   endpoint only) is asked for one word through Vertex AI's `generateContent`, as you. A failure is
   tried again for about a minute (6 tries, 12 seconds apart: a just-enabled API takes a moment), then
   stops the install, saying whether it is quota, the model not being available to the project
   (Model Garden, or an organization policy), or the API still turning on. A dry run skips it.
3. **accounts**: `paraclete-agent@` with the `gcp_roles` of `generic` and of the role;
   `paraclete-dashboard@` with what the dashboard needs; on a Workspace role `paraclete-dwd@`, which
   `paraclete-agent@` alone may sign as (`roles/iam.serviceAccountTokenCreator` on that account) and
   whose client ID `paraclete-dashboard@` may read for its Workspace setup
   (`roles/iam.serviceAccountViewer` on that account only). Then the `resource_roles` of `generic` and
   of the role, each on one resource, granted to `paraclete-agent@`:
   - `on: agent-account`: on `paraclete-agent@` itself (`gcloud iam service-accounts
     add-iam-policy-binding`), so the agent may act as itself and as no other account;
   - `on: agent-repository`: on `agent-images`, an Artifact Registry Docker repository in the region,
     created here the first time a role asks for it (`gcloud artifacts repositories create agent-images
     --repository-format=docker`), where the agent's builds push.

   Each is made only when missing. Never on the project: a role whose `gcp_roles` names act-as or image
   push is refused in step 1, and when the agent's account holds one of those on the project (left by
   an older role definition, or granted by hand), it is taken back here, saying so
   (`remove-iam-policy-binding --condition=None`). Project-wide, act-as would reach
   `paraclete-dashboard@`, whose signature the VM's control service obeys, and image push the
   dashboard's `paraclete` repository.
4. **firestore**: the `(default)` database in Native mode, in the region, with delete protection; the
   indexes and TTL policies in `firestore.indexes.json`.
5. **bucket**: `gs://<project>-paraclete` with uniform access, public access prevention, and a lifecycle
   rule deleting `files.prefix` + `in/` after `files.inbox_retention_days` (`config/contracts.json`);
   object admin for both accounts on this bucket only. Its CORS setting, for uploads from the dashboard,
   is made in step 6, once the dashboard's URLs are known.
6. **dashboard**, from the release's own `dashboard/cloudbuild.json` (downloaded at the commit; a
   commit from before the first release has none and installs without a dashboard). The image's name,
   the build's timeout and the service's size are the contracts' `dashboard` section, which the
   dashboard's own upgrade reads too:
   - the Artifact Registry Docker repository `paraclete` in the region, where `paraclete-dashboard@` alone
     may push (`roles/artifactregistry.writer` on that repository);
   - the image `<region>-docker.pkg.dev/<project>/paraclete/dashboard:<commit>`, built by Cloud Build
     from GitHub at the commit, as `paraclete-dashboard@` (the account its upgrade button builds as), in
     the region (`--region`: the build, its logs and its record stay beside the image, whatever your own
     `builds/region` says, and an organization that forbids `global` is no obstacle), within
     `dashboard.build_timeout_seconds`. Skipped when the repository already has that tag;
   - IAP's service agent (`service-<number>@gcp-sa-iap.iam.gserviceaccount.com`), asked for with
     `gcloud beta services identity create` while the service does not already let it in;
   - the Cloud Run service `paraclete`: that image, running as `paraclete-dashboard@`, `--iap`,
     `--no-allow-unauthenticated`, ingress `all` (IAP stands in front of the URL itself), 1 CPU, 1 GiB, at
     most 3 instances, scaling to zero, with the environment below. Skipped when the service already
     runs that image with that environment, account and settings and is not open to everyone;
   - who reaches it: IAP's service agent may invoke the service (`roles/run.invoker` on it); on IAP for
     the service, you get `roles/iap.httpsResourceAccessor` and `paraclete-dashboard@` gets
     `roles/iap.admin`, so the dashboard adds and removes its users itself;
   - you, the first admin: `users/<your email, lowercase>` in Firestore,
     `{ email, role: 'admin', added_by: 'install.sh', added_at }`, written through the REST API with the
     `currentDocument.exists=false` precondition. A record that exists is never rewritten;
   - uploads: the browser PUTs a file straight into the bucket through a V4 signed URL, so the bucket's
     CORS setting lets the dashboard's origins do that. The origins are the service's deterministic URL
     `https://paraclete-<project number>.<region>.run.app` (known before the first deploy, so a dry run
     names it) and every URL the service reports (`status.url`, which may be the older
     `paraclete-<hash>-<region code>.a.run.app` form, and the `run.googleapis.com/urls` annotation). One
     rule: methods `PUT`, `GET`, `HEAD`; headers `Content-Type` and `ETag` (Cloud Storage uses the one
     list both for the request headers it allows and for the answer headers it shows); max age 3600
     seconds. It is compared with what the bucket has first and set with
     `gcloud storage buckets update --cors-file` only when it differs, replacing the whole setting. Set
     whenever a dashboard exists or this run deploys one. `uninstall.sh` leaves it: it goes with the
     bucket.
7. **network**: the `default` network, or a `paraclete` network when there is none; the firewall rule
   `paraclete-allow-iap-ssh` (tcp:22 from IAP's range to the tag `paraclete`, priority 1000) and
   `paraclete-deny-ingress` (deny everything else inbound to that tag, priority 65000, which outranks a
   default network's own allow rules).
8. **vm**: `paraclete`, e2-standard-2, 50 GB pd-balanced, Debian 12, Shielded VM, running as
   `paraclete-agent@` with the cloud-platform and drive scopes, with the metadata below. A VM that already
   exists keeps its disk: only its metadata changes.
9. **wait**: until `agent/instance` reports `ready` (or `failed`) for this commit, up to 20 minutes. A
   first boot takes about 8 to 12, most of it installing the role's packages (the file toolchain
   below).

Re-running repairs: on a project whose VM exists, the role, the agent's name and the region default to
the ones the VM was installed with (its metadata), so a bare re-run never renames the agent, moves it to
`generic` or deploys a second dashboard in another region. Re-running with another `--ref` moves an
existing instance: the dashboard is built and deployed at that commit at once, and the VM installs it at
its next boot, or at once through `upgrade.sh`; the installer prints both commands. Re-running with the
same commit builds and deploys nothing.

### Moving an instance to another role (a developer path)

Changing an instance's role is not a product feature (build plan section 14): an instance has the role
it was installed with. A developer checking several roles on one dev project moves it instead:

```
install/install.sh --role <id> --ref <branch> --yes
```

Pass the `--ref` the instance runs (a bare run installs the newest release). What happens:

| Where | When | What |
|---|---|---|
| The VM's metadata | This run | `paraclete-role` names the new role |
| The agent's account | This run, step 3 | The new role's `gcp_roles` are granted. The `gcp_roles` the previous role declared that neither `generic` nor the new role declares are taken back (`remove-iam-policy-binding --condition=None`), so the agent keeps least privilege. Any other grant the account holds stays. IAM cannot tell the installer's grant from the same role granted by hand, so one the previous role declared goes either way. When this clone has no `role.json` for the previous role, nothing is taken back and the run says so |
| Single-resource grants | This run, step 3 | The new role's `resource_roles` are granted (and `agent-images` created when it asks for it). The previous role's that neither `generic` nor the new role declares are taken back: the binding on `paraclete-agent@` itself (`gcloud iam service-accounts remove-iam-policy-binding`), and the agent's binding on `agent-images` (`gcloud artifacts repositories remove-iam-policy-binding`). The repository and its images stay: they are the agent's builds, and `uninstall.sh --purge` deletes them |
| APIs | This run, step 2 | The new role's `apis` are turned on. None is turned off: the previous role's stay on |
| The Workspace APIs and `paraclete-dwd@` | This run | Turned on and created when the new role is a Workspace role; left as they are when the previous one was |
| The dashboard | This run | Deployed again with `PARACLETE_ROLE` (and `PARACLETE_WORKSPACE_ROLE`) of the new role |
| The VM | Its next bootstrap: `gcloud compute instances reset`, or `upgrade.sh --ref <commit>` without a reboot (the run prints both) | `bootstrap.sh` sees the installed release was staged for another role and installs the same commit again for the new one: its `setup` packages, its skills and their launchers, its organ prompts, playbooks and default responsibilities come in; the previous role's package and launchers go |
| What stays | | The data root: working memory, Core Memory and Deep Truths, missions and files; the agent's own responsibilities and playbooks (in Firestore); its own skills |

Caveats: the agent's working memory was seeded by the previous role and is not reseeded
(`roles/<id>/memory.md` seeds only an empty memory); an agent-written override of one of the previous
role's default responsibilities is ignored from then on (its default is gone); the previous role's
Debian, npm and pip packages stay installed; and a Workspace account recorded for a Workspace role
stays in `/etc/paraclete/workspace.json` after a move to a role without one: the instance record leaves
it out while the role has no Workspace account (`vm/instance-record.mjs` reads the role's `workspace`
flag from the release it installs), and a move back to a Workspace role brings it back. To check a role
after a move: `node dev/smoke.mjs` ([dev/README.md](../dev/README.md)).

To watch the agent:

```
gcloud compute ssh paraclete --zone=<zone> --project=<project> --tunnel-through-iap -- sudo journalctl -u 'paraclete-*' -f
```

To remove it:

```
install/uninstall.sh                   # names exactly what it will delete, then asks
install/uninstall.sh --dry-run
install/uninstall.sh --purge           # also the Firestore database, the bucket and agent-images: asks you to type the project id
```

It removes the VM, the firewall rules (and the network, when the installer made it), the dashboard's
Cloud Run service and its image repository (which holds only the dashboard's images; the grants on the
two go with them), the Firestore indexes and TTL policies, and the service accounts with every project
grant they hold (the dashboard's `roles/logging.logWriter` among them); a grant on an account itself,
such as the agent's act-as on its own account, goes with the account. The dashboard's users records
are Firestore data: they stay unless `--purge`.

The agent's own image repository, `agent-images` (made for a role that asks for it, such as the DevOps
Engineer), holds the agent's builds, so it is listed under what stays and deleted, with every image in
it, only with `--purge`. Kept, it first loses the accounts' grants on it, as the bucket does, so no
binding outlives its account. A grant an admin made by hand to `paraclete-agent@` on another resource
(act-as on a runtime account, for one) is not found: it stays, naming a deleted account, until removed
by hand.

`uninstall.sh` takes `--project`, `--region` (default: the VM's region, else `us-central1`; the dashboard
and `agent-images` are looked for there), `--purge`, `--yes` (which never skips typing the project id for
`--purge`) and `--dry-run`. Its steps: check, vm, network, dashboard, images, firestore, bucket,
accounts. Enabled APIs stay on.

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
| `paraclete-workspace-account`, `paraclete-workspace-signer` | Workspace roles only: the agent's Google account and the delegation signer service account. Never written by `install.sh`: the account exists only after the dashboard's Workspace setup, which records it in `/etc/paraclete/workspace.json` instead (below). When set by hand, these keys win over that file |
| `paraclete-dashboard-url` | The dashboard's Cloud Run URL, once step 6 has deployed it |
| `startup-script` | A short stub: at every boot, read `paraclete-repo` and `paraclete-ref` from metadata, download `install/bootstrap.sh` at that commit, and run it as root in the transient unit `paraclete-bootstrap` (its output goes to the journal) |

The project, zone and region come from the metadata server's own attributes.

### The dashboard's environment (set by `install.sh` on the Cloud Run service, read by the dashboard)

`dashboard/README.md` says what the dashboard does with each. `install.sh` sets them all at every deploy
(`--env-vars-file`, which replaces the whole environment); `dev/deploy.mjs` keeps what the service has
and moves `PARACLETE_REPO`, `PARACLETE_RELEASE` and `PARACLETE_COMMIT`; the dashboard's own upgrade
keeps the rest of the service as it is and moves the image, `PARACLETE_RELEASE` and `PARACLETE_COMMIT`.

| Variable | Value |
|---|---|
| `PARACLETE_PROJECT`, `PARACLETE_PROJECT_NUMBER`, `PARACLETE_REGION` | The project, its number, and the region of the data, the bucket and the service |
| `PARACLETE_SERVICE` | `paraclete`, the Cloud Run service |
| `PARACLETE_BUCKET` | `<project>-paraclete` |
| `PARACLETE_REPO`, `PARACLETE_RELEASE`, `PARACLETE_COMMIT` | As `paraclete-repo`, `paraclete-release` and `paraclete-ref` above: what the image was built from |
| `PARACLETE_AGENT_NAME`, `PARACLETE_ROLE` | As `paraclete-agent-name` and `paraclete-role` |
| `PARACLETE_WORKSPACE_ROLE` | `true` when the role's `role.json` sets `workspace`, else `false` |

`PARACLETE_IAP_AUDIENCE` is never set: it only overrides the audience the dashboard derives from the
project number, region and service. The image is tagged with the same commit, which is how
`dev/status.mjs` reads the dashboard's commit off the service and compares it with the VM's.

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
installs nothing: it puts back any of the role's packages that went missing (a package that cannot be
read or installed then is only a warning), re-checks the user, directories, instance record, token and
units, starts what is not running (restarting everything when one of those changed), and writes
readiness. Any other commit, an upgrade included, is a full install, which installs the packages that
commit's role names: a release that adds a package gets it on upgrade.

### Packages

A full install, before anything is stopped, installs what is missing of:

1. `ca-certificates curl git jq unzip`, and Node.js 24 from NodeSource;
2. the `setup.apt` packages of `roles/generic/role.json` and of the instance's role
   (`vm/role-packages.mjs` reads them from the release being installed);
3. their `setup.npm` packages, installed globally as root: `npm install --global --no-fund --no-audit`,
   into npm's global root (`/usr/lib/node_modules`, commands in `/usr/bin`), which the services can run
   and cannot change;
4. their `setup.pip` packages, installed for the `paraclete` user only:
   `python3 -m pip install --user --break-system-packages`, run as that user (`runuser`), into its home
   under the data root (`/var/lib/paraclete/home/.local`).

npm and pip packages are pinned to exact versions, `name@1.2.3` and `name==1.2.3`; `vm/role-packages.mjs`
refuses a range, a tag, an unpinned name, anything that is not a package name, and one package pinned
at two versions by the generic role and the instance's. A run lists what is installed
(`npm ls --global --depth=0 --json`, `pip list --user --format=json`) and installs only the pins that are
missing or at another version, so a second run installs nothing. Why pip installs per user: pip as root
writes `/usr/local`, which Debian's Python reads ahead of the libraries apt installed, so a pinned
package or one of its dependencies could shadow a library apt or the system's own tools rely on (Debian
marks its Python externally managed for this; `--break-system-packages` is the override, and here its
reach is that one user). A user install is seen only by the `paraclete` user's Python, the agent's own,
and is no more than the agent could install itself; inside it, a pin can still shadow a library the
generic role's Python tools import (`python3-docx` needs `lxml`, for one), so a new pin is checked with
the files skill's conversions before it ships. Its commands land in
`~/.local/bin`, which is not on the services' `PATH`, so a skill runs a pip package as
`python3 -m <module>`. A pin that cannot be read or installed fails a full install like an apt package
(readiness reports it); on the installed commit it is a warning, and the next run tries again.

`apt-get install` runs with `--no-install-recommends`, so a role names every package its tools need:
only those and what they depend on land on the VM, and a Debian point release cannot add to them
through a new recommendation. The generic role's list holds
the file toolchain: pandoc, poppler-utils with poppler-data, qpdf, LibreOffice's `-nogui` Writer, Calc,
Impress and Math (`soffice --headless`), chromium (`--headless=new --no-sandbox --disable-gpu`; the
services run with `NoNewPrivileges`, so the setuid sandbox it would recommend could not work anyway),
fonts-dejavu-core and fonts-liberation2, python3-docx, python3-openpyxl, python3-pypdf with python3-pil
and python3-pycryptodome, imagemagick and file; and, named because they used to come only as
recommendations, patch, python3-dev and build-essential. `roles/generic/README.md` lists them by use.

The toolchain is about 300 MB to download and 1 GB on disk (of 50 GB), a few minutes of `apt-get` on an
e2-standard-2: a first boot takes about 8 to 12 minutes in all, and an upgrade that adds the toolchain
a few minutes more than one that adds nothing. The services keep running while an upgrade installs packages.
`apt-get` waits up to 10 minutes for another apt or dpkg run to let go of its lock (a first boot's own
daily apt job), and tries each download 3 times. A dpkg run that was cut off (a reset during a first
boot, or an upgrade stopped at the contracts' `control.upgrade_max_seconds`) is finished with
`dpkg --configure -a` before anything else is installed. A package that cannot be installed fails the
run before anything is stopped: the running release is not touched.

### What `bootstrap.sh` produces

| Path | Owner and mode | Holds |
|---|---|---|
| `/opt/paraclete/` | `root:root`, read-only to everyone else | The files `manifest.txt` lists, at their repo paths; `agent/node_modules/` (`npm ci`); `bin/` launchers; `release.json` |
| `/opt/paraclete/bin/<command>` | `root:root 0755` | `#!/bin/sh` + `exec /usr/bin/node /opt/paraclete/<path>.mjs "$@"` for every `agent/cli/<command>.mjs` (not `cli-runtime.mjs`) and every command a skill (in `skills/`, `roles/generic/skills/` or `roles/<role>/skills/`) lists in its `skill.json` and keeps as `<command>.mjs` in its own directory. Never a symlink |
| `/opt/paraclete/release.json` | `root:root 0644` | `{ "version", "ref", "commit", "repo", "installed_at", "metadata": { "repo", "ref" } }`. `version` is the release tag, else the version prefix of the commit's message, else null; `ref` is what was asked for; `metadata` holds `paraclete-repo` and `paraclete-ref` as they were when this release was installed |
| `/etc/paraclete/instance.json` | `root:root 0644` | The instance record (`config/instance.mjs`), from the metadata above, with `release` and `source_repo` naming what is installed. The record an install replaced stays in `instance.json.prev`, for a rollback, until the next install |
| `/etc/paraclete/gateway-token` | `root:paraclete 0640` | A random token, created once, kept across upgrades |
| `/etc/paraclete/workspace.json` | `root:root 0644` | Not written by the bootstrap: the control service's `set_workspace_account` writes it when an admin saves the agent's Workspace account in the dashboard (`{ account, signer, recorded_at, recorded_by }`). Every run merges it into `instance.json` while the metadata sets no `paraclete-workspace-account` and the installed role is flagged `workspace` (its `roles/<role>/role.json` in the release being installed), so the account survives upgrades and reboots; one that cannot be used is left out with a warning. For a role without a Workspace account it is left out of the record and left in place, so a move back restores the account |
| `/var/lib/paraclete/` | `paraclete:paraclete 0750` | The data root: `memory/`, `missions/`, `workspace/`, `files/`, `skills/`, `services/`, `home/` (the `paraclete` user's home) |
| `/etc/systemd/system/paraclete-*.service` | `root:root 0644` | Copied from `agent/services/*/`, enabled and started, the gateway first |

- The `paraclete` user is a system user whose home is `/var/lib/paraclete/home`, in the
  `systemd-journal` group (telemetry reads the journal).
- An install is staged in `/opt/paraclete.next` and swapped into place; the previous install stays in
  `/opt/paraclete.prev` until the next upgrade.
- **The validation gate.** Before anything is stopped, the staged release must pass
  `vm/check-release.mjs`, run with its own code and npm packages: its contracts load and validate, every
  service has its unit and its `main.mjs` loads with everything it imports, and every launcher's command
  exists and loads. Its data migrations must pass a dry run (below). Its instance record must pass its
  own `validateInstance()`. A release that fails is not installed, and the running one is not touched.
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
the metadata, installing the base packages or Node.js, downloading) cannot write it; its error is in the
VM's journal and serial console. The role's packages come after the download, so a failure there is
reported.

### Migrations

A release may carry data migrations: `migrations/<version>-<slug>.mjs` at the repo root, installed with
the release. Each changes data the release reads differently from the ones before it, in Firestore or
under the data root; [migrations/README.md](../migrations/README.md) has the format and the rules for
writing one. Firestore `config/migrations` records which ran on this instance:
`{ applied: { <id>: { applied_at, release } } }`.

| When | What `bootstrap.sh` runs, from the staged release | It |
|---|---|---|
| The validation gate, before anything is stopped | `vm/migrate.mjs --dry-run`, as root | Checks that every `.mjs` file in `migrations/` is named as a migration, that every one still to run loads and exports `description` and `migrate`, and that `config/migrations` can be read (a release that carries none reads nothing). Lists what will run; changes nothing |
| The switch, after the services stop and before the swap | `vm/migrate.mjs`, as the `paraclete` user (`runuser`) | Runs every migration `config/migrations` does not record, oldest version first and by name within a version, and records each as soon as it succeeds |

- **Only on a full install.** A run on the installed commit (the fast path) runs none. A first install
  runs every migration the release carries: the project's Firestore may hold an older install's data.
- **With the services' rights.** As the `paraclete` user, a migration reaches Firestore through the VM's
  account and writes the data root as the services do, and cannot change installed code or
  `/etc/paraclete`.
- **Idempotent.** A recorded migration never runs again, but every migration is written to be safe to
  run twice: one that succeeded and could not be recorded runs again at the next upgrade.
- **Strict.** `config/migrations` is read strictly, and a migration's Firestore client is strict unless
  it says otherwise: when Firestore cannot answer, the run fails rather than finding "nothing applied"
  or an empty collection.
- **A failure** stops the run at that migration: the ones before it stay recorded, it and the ones after
  it are not. The swap does not happen, the installed release starts again, and the run reports
  `failed` with the migration's reason (`the data migrations stopped: <id> failed: ...`). There is no
  undoing a migration, so the release before must still read whatever it changed, after a failure here
  as after a rollback; a fixed release runs it again.

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
