# dashboard/

The web dashboard: where people talk to the agent, follow and approve its work, download its files,
and manage the instance. Next.js (App Router, JavaScript), deployed to Cloud Run behind Identity-Aware
Proxy (IAP).

**Installed:** not onto the VM. `install/install.sh` builds this directory into an image with Cloud
Build at the release being installed (`cloudbuild.yaml`, `Dockerfile`) and deploys it to Cloud Run.

## What belongs here

- Pages, components and styles
- Server routes that read and write Firestore and the bucket for the signed-in user
- IAP sign-in verification and dashboard user management
- Signing the commands it sends the VM
- Release detection and the upgrade button

## What doesn't

- **Agent logic.** The dashboard never plans, decides or runs work. It talks to the agent only
  through Firestore and the bucket; agent behavior lives in `agent/`.
- **Calls to the VM.** There are none. Commands go through Firestore to the agent's control service,
  signed (see below).

## Layout

| Path | Holds |
|---|---|
| `app/` | Routes: a `page.jsx` per page, a `route.js` per API route under `app/api/`. Thin: they call `lib/` |
| `components/` | Client components, one directory per view (`chat/`, `work/`, `settings/`...), and `ui/` for the shared primitives |
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
download files. Adding or removing a user changes the IAP grant and the record together. The last
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
and `config/contracts.json`. One definition of each, so the two sides cannot drift. Nothing else
outside `dashboard/`, and never `config/*.mjs`: `tests/repo/dashboard-boundaries.test.mjs` checks.
The build's root is the repo for this reason (`next.config.mjs`).

## Data it reads and writes

| Collection | The dashboard | Rules it keeps |
|---|---|---|
| `users` | owns | One document per email, lowercase |
| `threads` | creates one per user | Patches only its own fields; the agent writes `channel`, `last_turn_at`, `summary`, `summary_through_ts` |
| `messages` | writes the user's messages; reads all | `{ text, timestamp (Firestore timestamp), processed: false, sender (email), sender_name, thread_id, attachments }` |
| `work`, `processes`, `projects`, `core_memory` | reads | |
| `approvals` | reads; resolves | Patches only the fields `approvalResolution()` returns, only if the gate is unchanged since it was read (an `updateTime` precondition), so two people deciding at once cannot both win |
| `commands` | writes signed commands | Never edits a command after writing it |
| `responsibility_triggers` | reads | Follows a "run now" until the brain fires, skips or fails it |
| `config/settings` | writes `effort`, `effort_updated_at`, `effort_updated_by` (field-masked); reads `claude_enabled` | `claude_enabled` is changed only through the `set_model` command |
| `agent/instance` | reads | Written by the VM's bootstrap |

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
| `PARACLETE_REPO`, `PARACLETE_RELEASE`, `PARACLETE_COMMIT` | What the dashboard was built from |
| `PARACLETE_AGENT_NAME`, `PARACLETE_ROLE` | The agent's name and role |
| `PARACLETE_IAP_AUDIENCE` | Overrides the IAP audience, which is normally derived; the installer never sets it |

For development only, `PARACLETE_FIRESTORE_HOST` and `PARACLETE_STORAGE_HOST` point the server at the
fakes in `tests/fakes/`.
