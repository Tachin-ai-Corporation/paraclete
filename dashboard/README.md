# dashboard/

The web dashboard: where people talk to the agent and hand it files, follow and approve its work,
download its files, and manage the instance. Next.js (App Router, JavaScript), deployed to Cloud Run behind Identity-Aware
Proxy (IAP).

**Installed:** not onto the VM. `install/install.sh` builds this directory into an image with Cloud
Build at the release being installed (`cloudbuild.json`, `Dockerfile`) and deploys it to Cloud Run;
from then on the dashboard upgrades itself the same way (see [Updates](#updates)).

## What belongs here

- Pages, components and styles
- Server routes that read and write Firestore and the bucket for the signed-in user
- Signing the short-lived URLs through which the browser uploads and downloads files
- IAP sign-in verification and dashboard user management
- Signing the commands it sends the VM
- Release detection, the upgrade button and automatic updates

## What doesn't

- **Agent logic.** The dashboard never plans, decides or runs work. It talks to the agent only
  through Firestore and the bucket; agent behavior lives in `agent/`.
- **Calls to the VM.** There are none. Commands go through Firestore to the agent's control service,
  signed (see below).

## Layout

| Path | Holds |
|---|---|
| `app/` | Routes: a `page.jsx` per page, a `route.js` per API route under `app/api/`. Thin: they call `lib/` |
| `components/` | Client components, one directory per view (`chat/`, `work/`, `settings/`...), and `ui/` for the shared primitives. A component's decisions live in a plain `.js` module beside it, with no JSX (`chat/upload-list.js`, `settings/release-update.js`), which its `.jsx` imports and `tests/dashboard/components/` tests. A test never imports a `.jsx` file: `node --test` cannot parse JSX |
| `lib/server/` | Server-only code: the runtime, sign-in, users, commands, and one module per kind of data. Plain `.mjs` with no Next.js imports, so `tests/dashboard/` runs it under `node --test` against the Firestore fake |
| `lib/client/` | Browser helpers: `api()`, `usePoll()`, `useCommand()`, formatting |
| `app/globals.css` | The design tokens and shared primitives (`.btn`, `.badge`, `.card`, `.table`, `.tabs`, `.markdown`) |

## How a request is trusted

1. **IAP** admits only people holding `roles/iap.httpsResourceAccessor` on the service, and signs a
   JWT into `x-goog-iap-jwt-assertion`. `lib/server/iap.mjs` verifies it (ES256, Google's published
   keys, audience `/projects/<number>/locations/<region>/services/<service>`). The plain email header
   is never read.
2. **The `users` record** (`users/{email}`, `lib/server/users.mjs`) says whether they are a dashboard
   user and whether `admin` or `member`. No record, no access, even with the IAP grant.
3. **Every API route** goes through `route()` in `lib/server/http.mjs`, which does both checks and,
   with `{ admin: true }`, refuses members.

Admins manage users, settings, secrets and upgrades. Members chat, follow and approve missions, and
upload and download files. Adding or removing a user changes the IAP grant and the record together. The last
admin cannot be removed or made a member.

## Commands to the VM

`lib/server/commands.mjs` writes a command to the `commands` collection and signs it as the
dashboard's own service account through IAM Credentials `signJwt`
(`agent/auth/command-signature.mjs`). The VM's control service runs only commands with a valid
signature from that account. Read-only commands (`status`, `skills`, `config`, `workspace`,
`brain_config`, `responsibilities`) are open to every user; the rest are admin-only. In the browser,
`useCommand(type)` sends one and polls until it finishes. The command set and every result shape:
[agent/services/control/README.md](../agent/services/control/README.md).

## What it shares with the agent

The server code imports the agent's Firestore client and collection names (`agent/storage/`), the
command signature (`agent/auth/`), pure work helpers such as `approvalResolution()` (`agent/work/`),
what a release is and which is newer (`agent/release/`), and `config/contracts.json`. One definition of each, so the two sides cannot drift. Nothing else
outside `dashboard/`, and never `config/*.mjs`: `tests/repo/dashboard-boundaries.test.mjs` checks.
The build's root is the repo for this reason (`next.config.mjs`).

## Data it reads and writes

| Collection | The dashboard | Rules it keeps |
|---|---|---|
| `users` | owns | One document per email, lowercase |
| `threads` | creates one per user | Patches only its own fields; the agent writes `channel`, `last_turn_at`, `summary`, `summary_through_ts` |
| `messages` | writes the user's messages; reads all | `{ text, timestamp (Firestore timestamp), processed: false, sender (email), sender_name, thread_id, attachments: [{ name, size, gcsPath }] }`; `text` may be empty when files go alone |
| `files` | writes `'in'` records when an upload completes; marks one used by the message that carries it; reads a mission's `'out'` records | An `'in'` record's id is its upload id and it is created only if absent; `created_by` is the uploader. Marking it used sets `message_id`, in the same commit as the message, only if the record is unchanged since it was read (an `updateTime` precondition). Never writes `'out'` records: the agent does |
| `work`, `processes`, `projects`, `core_memory` | reads | |
| `approvals` | reads; resolves | Patches only the fields `approvalResolution()` returns, only if the gate is unchanged since it was read (an `updateTime` precondition), so two people deciding at once cannot both win |
| `commands` | writes signed commands | Never edits a command after writing it |
| `responsibility_triggers` | reads | Follows a "run now" until the brain fires, skips or fails it |
| `config/settings` | writes `effort`, `effort_updated_at`, `effort_updated_by` and `drive_output_folder`, `drive_output_folder_updated_at`, `drive_output_folder_updated_by` (each setting field-masked to its own three); reads `claude_enabled` | `claude_enabled` and `claude_model` are changed only through the `set_model` command (Settings, Models; see below). `drive_output_folder` is a Drive folder id or null |
| `agent/instance` | reads | Written by the VM's bootstrap |
| `config/workspace_account` | reads | Written only by the control service: the recorded Workspace account and the last check (see [Workspace](#workspace-the-agents-own-google-account)) |
| `config/release_check` | owns | GitHub's release list, `{ repo, checked_at, releases, withdrawn, error }`, replaced only if unchanged since it was read (see [Updates](#updates)) |
| `config/upgrade` | owns | The upgrade in progress or the last one; every write is guarded by the record's update time, or creates it only if absent (see [Updates](#updates)) |

**Threads.** Each user's thread id is `user-` and the first 32 hex digits of the SHA-256 of their
lowercased email: fixed per person, a valid document id, and the same key the agent's thread ledger
uses, so both sides write the same `threads/{id}` document. The thread is created on the user's
first message.

**IAP grants** are read and written on the IAP resource
`projects/<number>/iap_web/cloud_run-<region>/services/<service>` (IAP API v1, policy version 3,
with the etag). The installer grants the dashboard's account `roles/iap.admin` there.

**Secrets** are Secret Manager secrets named exactly as an admin types them (`[A-Za-z0-9_-]`), the
name the agent's `secret-read` takes. The dashboard lists and changes only secrets labeled
`paraclete=agent`, which it creates with access for the agent's account.

## Files: uploads and downloads

File bytes never pass through Cloud Run (whose requests stop at 32 MB). The browser talks to the
instance's bucket directly, through Cloud Storage V4 signed URLs that the dashboard makes without a
key (`lib/server/signed-urls.mjs`): it builds the canonical request itself and has IAM Credentials
`signBlob` sign it as its own account, which holds Token Creator on itself. Each URL names one object
and lasts `files.signed_url_minutes`.

- **Upload** (any user), in three steps (`lib/server/uploads.mjs`): `POST /api/files/uploads
  { name, size, content_type }` checks the size against `files.max_upload_mb` and answers an upload id
  (`u-<ms>-<8 hex>`), the object `files/in/<id>/<name>` and a signed PUT URL with the exact
  `Content-Type` to send; the browser PUTs the bytes there (the bucket's CORS setting, which the
  installer sets, admits the dashboard's origins); `POST /api/files/uploads/:id/complete { gcs_path }`
  checks the object arrived within the limit and writes the `'in'` record. A message then carries
  completed uploads as `attachments`: only the sender's own, each once. The bucket's lifecycle rule
  deletes uploads after `files.inbox_retention_days`.
- **Download** (any user): `GET /api/files/download?path=` answers a redirect to a signed GET URL
  that makes the bucket send the file as an attachment under its own name and type. Only the agent's
  outgoing files (`files/out/<mission>/<name>`) and uploads (`files/in/<upload>/<name>`) qualify.
- **A mission's files**: `GET /api/work/:id/files` lists its `'out'` records (one equality filter on
  `mission_id`, no index needed), which the mission page shows with download and Drive links.

Signed URLs always name `storage.googleapis.com`; `PARACLETE_STORAGE_HOST` redirects only the
dashboard's own calls to the bucket (the existence and size checks), so against the fakes the browser's
PUT and GET have nowhere to go.

## Workspace: the agent's own Google account

On a role whose `role.json` sets `workspace` (`PARACLETE_WORKSPACE_ROLE=true`), the agent acts as a
Google user of the organization through domain-wide delegation. Google has no API for that grant, so
Settings has a Workspace tab (`components/settings/workspace/`) that walks an admin through it; on
other roles the tab is hidden and the Setup checklist says the account is not needed.

1. **The user.** The admin creates it in the Admin console (Directory, Users, with a license that
   includes Chat, Drive, Docs, Sheets, Slides, Calendar and Gmail) and enters its address here. The
   suggested address is the agent's name at the admin's own domain.
2. **Domain-wide delegation.** The client ID of the signer `paraclete-dwd@<project>`, read with IAM
   `projects.serviceAccounts.get` (`oauth2ClientId`) as the dashboard's account (the installer gives it
   `roles/iam.serviceAccountViewer` on that one account), and the full scope list
   (`agent/auth/workspace-scopes.mjs`), each with a copy button and a link to the Admin console page
   where they go.
3. **Test** sends the `workspace_check` command: the VM asks Google for a token per API, as the agent,
   and makes one read-only call each. Every API shows its result and, when it failed, the one thing to
   change.
4. **Save** sends `set_workspace_account`, which records the account on the VM and restarts its
   services. It is offered once a test of that address passed. When only some APIs failed and Drive
   and the token work, the admin may save anyway after a warning naming what will not work: Drive
   moves to the new account the moment it is saved, so a Drive failure always blocks. Remove sends
   `{ account: null }`.

| Route | Who | Does (`lib/server/workspace.mjs`) |
|---|---|---|
| `GET /api/workspace` | any user | Whether the role needs an account, the recorded account and the last check, from `config/workspace_account` (written by the control service) |
| `GET /api/workspace/setup` | admins | The signer, its client ID (or why it cannot be read), the scope list, the Admin console links and a suggested address |

Members see the state only. The commands and the record are in
[agent/services/control/README.md](../agent/services/control/README.md).

## Models: turning Claude on

The agent runs on Gemini. Settings has a Models tab (`components/settings/ModelsTab.jsx`, with its
decisions in `models-settings.js`) where an admin moves the cortex and the strong tier to Claude Opus,
with Gemini as the fallback. Everyone sees whether Claude is on and with which model, from the
`brain_config` command; Agent, Models stays the read-only view of every tier.

1. **Model Garden.** A link per model in the contracts' `vertex.models.claude_candidates`, newest
   first, to its Model Garden page, where a project owner enables it and accepts Anthropic's terms.
2. **Test** sends `claude_check`: the VM sends each of those models one short message, as the agent,
   in the contracts' Claude region, and reports per model whether it answered and the one thing to do
   when it did not.
3. **The switch** sends `set_model { claude_enabled: true, claude_model }` with the newest model that
   answered a test from this page in the last hour, or `{ claude_enabled: false }`. Without such a test
   it is not offered, and the tab says why. The control service accepts only a model the contracts
   list, restarts the model gateway and checks that it runs that model.

No route of its own: the tab sends commands through `POST /api/commands`.

## Updates

Settings, System opens with a version card (`components/settings/UpdateCard.jsx`, its decisions in
`release-update.js`): which release the agent and the dashboard run, the repository's newer releases
with their notes (Markdown from GitHub, shown as plain lines), and, for admins, Install. A release is a
version tag published on GitHub (`agent/release/versions.mjs`).

**Detection** (`lib/server/releases.mjs`). GitHub answers 60 unauthenticated requests an hour per
address, and Cloud Run shares its addresses, so the release list of `PARACLETE_REPO` is asked for at
most once per `dashboard.release_check_ttl_seconds` (contracts) and kept in `config/release_check`;
an admin's Check now asks again, at most every five minutes. A failed check keeps the releases it had
and says why. What the instance runs is the VM's release as `agent/instance` reports it when that is a
ready version, else this dashboard's `PARACLETE_RELEASE`; an instance installed from a branch or a
commit is offered nothing. A withdrawn release (a prerelease on GitHub, after `dev/release.mjs yank`)
is never among the releases offered; the check keeps withdrawn ones apart, in `withdrawn`, so when the
instance runs one the card says so and why, and offers the next newer release as usual.

**Install** (`lib/server/upgrade.mjs`). An admin may install a published release newer than the
installed one, or the same one again to finish an upgrade left half-done. First the release list is
asked for again, every time (one request per attempt), so a release withdrawn since the list was kept
is refused, and so is any install while GitHub cannot be asked; an upgrade already running when its
release is withdrawn finishes. The VM moves first, so a failed VM upgrade leaves the dashboard as it
was:

1. **vm.** The tag's commit is looked up on GitHub, `config/upgrade` is claimed (created, or replaced
   only if unchanged since it was read and not running, so two admins cannot start two), and the signed
   `upgrade { ref: <version> }` command goes to the control service, which runs that release's own
   upgrader.
2. **build.** Once the command is `done` and `agent/instance` reports ready on the commit: Cloud Build
   (REST, in the region, as `paraclete-dashboard@`) builds the image at the commit from GitHub with the
   commit's own `dashboard/cloudbuild.json` (read from GitHub), tagged with the commit, within
   `dashboard.build_timeout_seconds`. Skipped when Artifact Registry has that tag already.
3. **deploy.** Cloud Run's Admin API v2: the service is read, its first container moved to the new image
   with `PARACLETE_RELEASE` and `PARACLETE_COMMIT` changed, everything else (IAP, the account, the size,
   the rest of the environment) sent back as read, and the operation followed to the end.

Nothing runs in the background. `GET /api/upgrade`, which the card polls every five seconds while an
upgrade runs, checks the current step and starts the next when it finished. Each move is claimed with a
write guarded by the record's update time before its call is made, so of two readers one starts the
build or the rollout and the other sees it. A step claimed but never started (the dashboard stopped in
between) fails after two minutes; a VM upgrade that has not finished `control.upgrade_max_seconds` plus
ten minutes after it was asked for fails too. After `done`, the old revision may still answer for a
moment: the card waits until `GET /api/me` names the new commit, then reloads the page.

**Automatic updates** (`lib/server/auto-update.mjs`) are the one part that runs without a request.
- **What starts them.** A Cloud Scheduler job starts the Cloud Run job `contracts.auto_update.job_name`
  on `contracts.auto_update.schedule` (UTC). The job runs `jobs/auto-update.mjs` in this image, as
  `paraclete-dashboard@`, with the service's environment. The image carries `lib/server/` and the
  agent packages as source for it (`Dockerfile`). Both are created by `install/install.sh` and deleted
  by `install/uninstall.sh`.
- **What a run does.** It reads the setting (`config/settings.auto_update`: a stored true or false,
  else `contracts.auto_update.enabled_by_default`, which is on), then decides
  (`autoUpdateDecision`, pure). It follows an upgrade in progress, finishes one left half-done, or
  installs the newest published release, with `startUpgrade` requested by the dashboard's own account.
  So the VM's command is signed exactly as an admin's Install signs it.
- **What it never does.** It never moves an instance installed from a branch or commit (its
  `agent/instance` release is not a version), never moves backward, and starts no new upgrade to a
  withdrawn release: it is not among the published ones, and `startUpgrade` asks GitHub again before
  every start. One already running when its release is withdrawn is followed to its end.
- **A busy agent.** While a mission is active (a `work` envelope with a running status) it waits, for
  at most `idle_wait_max_hours` from the first run that found one, then installs anyway.
- **Following the upgrade.** After starting one, a run moves it on with `readUpgrade` every
  `advance_interval_seconds` until it ends or the run's time is up; the next run picks it up.
- **Keeping the job current.** When an upgrade's rollout is done, the upgrade moves the job to the same
  image, so the job always runs this dashboard's code.
- **What the card shows.** Each run records `{ checked_at, action, reason, version, waiting_since,
  waiting_for, upgrade_state }` in `config/auto_update`, which the version card shows; an admin turns
  automatic updates on or off there.

| Route | Who | Does |
|---|---|---|
| `GET /api/releases` | any user | What the agent and the dashboard run, the newer releases with notes, the release an upgrade left half-done, and when GitHub was asked (`releases.mjs`) |
| `POST /api/releases` | admins | Asks GitHub now, at most every five minutes |
| `GET /api/upgrade` | any user | The upgrade in progress or the last one, moved on when its step finished. Admins also see the command, build and operation ids and the build's log link |
| `POST /api/upgrade { version }` | admins | Starts one |
| `GET /api/settings/auto-update` | any user | Whether automatic updates are on, who changed that last, and the update job's last run |
| `PATCH /api/settings/auto-update { enabled }` | admins | Turns them on or off (only the setting's own fields of `config/settings`) |

`config/upgrade` holds `{ id, version, commit, requested_by, requested_at, state: 'vm' | 'build' |
'deploy' | 'done' | 'failed', vm_command_id, build_id, operation, error, updated_at }`. The dashboard's
account already has what this needs (install/README.md, step 3): Cloud Build Editor and Cloud Run Admin
on the project, act-as on itself (its builds and its revisions run as it), Artifact Registry Writer on
its image repository, and Logging Writer (its builds log to Cloud Logging only).

## Running it locally

```
cd dashboard
npm ci
export PARACLETE_PROJECT=your-dev-project PARACLETE_REGION=us-central1 PARACLETE_PROJECT_NUMBER=<number>
export PARACLETE_DEV_USER=you@example.com      # stands in for IAP; ignored on Cloud Run
export GCP_TOKEN=$(gcloud auth print-access-token)
npm run dev
```

Your dev user needs a `users` record in the dev project's Firestore (the installer writes one for
whoever installed). Commands are signed as the dashboard's account, so locally that needs your
account to hold Token Creator on it; without it, views that need the VM say so.

## Environment (set by `install/install.sh` on the Cloud Run service)

| Variable | Meaning |
|---|---|
| `PARACLETE_PROJECT`, `PARACLETE_PROJECT_NUMBER`, `PARACLETE_REGION` | Where the instance lives |
| `PARACLETE_SERVICE` | The Cloud Run service name (Cloud Run's own `K_SERVICE` otherwise) |
| `PARACLETE_BUCKET` | The instance's bucket |
| `PARACLETE_REPO`, `PARACLETE_RELEASE`, `PARACLETE_COMMIT` | What the dashboard was built from. Its upgrade moves the last two with the image |
| `PARACLETE_AGENT_NAME`, `PARACLETE_ROLE` | The agent's name and role |
| `PARACLETE_WORKSPACE_ROLE` | `true` when the role's `role.json` sets `workspace` (the image carries no `roles/`): Settings then shows the Workspace setup |
| `PARACLETE_IAP_AUDIENCE` | Overrides the IAP audience, which is normally derived; the installer never sets it |

For development only, `PARACLETE_FIRESTORE_HOST` and `PARACLETE_STORAGE_HOST` point the server at the
fakes in `tests/fakes/`.
