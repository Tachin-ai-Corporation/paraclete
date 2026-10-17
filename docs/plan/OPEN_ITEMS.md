# Open items

What one phase of the [build plan](BUILD_PLAN.md) hands to a later one. Each item names the phase
that resolves it. Delete an item in the commit that resolves it.

## Still open from phase 4 (services and configuration)

- **Workspace file names.** The artifact sweep keeps, and the artifact excludes skip, a list of
  workspace file names (organ prompt files, memory files, progress files). Reconcile the list with
  the workspace layout phase 4 defines.
- **Strict reads.** `createClient` in `agent/storage/firestore.mjs` defaults to logging read
  failures and returning empty results; `readDoc` and `commit` always fail closed. Once every caller
  is ported, decide whether strict should be the default.
- **One Firestore client.** The git store's default store makes its own Firestore REST calls. Fold
  them into `createClient` when the services wire both.
- **An approval gate as a checkpoint's last task.** On resume the checkpoint is skipped and marked
  complete without judging the work done before the gate, which then reaches the next checkpoint as
  established evidence. Decide whether that checkpoint should be verified on resume.
- **Documented commands.** `project-manage canon-set`, `canon-remove` and `canon-authority` exist but no
  skill documents them. Decide whether the agent should use them.
- **Smaller duplicates left after phase 4.** The control service reads `responsibilities.json` its own
  way (`rolePackages()`, accepting a bare array) and rebuilds the skill-directory order in
  `introspection.mjs`; `instancePaths()` in `agent/cli/cli-runtime.mjs` repeats the paths
  `service-runtime.mjs` builds (a shared builder could live in `config/instance.mjs`); the Core Memory
  fetch limit of 300 is a constant in two places. Fold each into its single home when touched next.
- **A long-running mission versus the active timeout.** Archival cancels a mission active for more
  than `archival.active_timeout_hours`. A mission waiting for the runner that long (the brain runs one
  at a time) could be cancelled. Unlikely; revisit if missions queue for hours.
- **Retiring a playbook.** Retiring an agent-written override brings the installed playbook back, and an
  installed playbook cannot be retired. Decide whether that is the intent.
- **Structured gateway log lines.** `brain-telemetry-read` parses the gateway's log text; give those
  lines structured fields so a wording change can't break it.

## Phase 5's live check (first run: 2026-10-17)

A fresh project in an organization, `install/install.sh --yes` from Git Bash on Windows at `main`:
every step ran first time, and the agent reported ready about three minutes after its VM was created.
A dashboard-style chat message then ran a full research mission on `gemini-4-argon` (cortex,
prefrontal, cerebellum) and `gemini-3.8-flash` (memory, research): 15 model calls, no fallbacks, no
errors, the answer delivered with a Markdown file in `files/out/<mission>/`. Confirmed on the way:

- every gcloud call's real output (`get-ancestors`, `ttls list`, the lifecycle file, delete protection);
- the first boot: apt and NodeSource on Debian 12, `npm ci` as root, the `paraclete` user and its
  journal group, the validation gate, the swap, the 30-second gateway wait, the readiness write;
- the fences: the `paraclete` user cannot write `/opt/paraclete` or `/etc/paraclete`; it can read the
  gateway token and write only its data root;
- the indexes build, and the queries that need them run;
- real Firestore answers an `updateTime` precondition on a deleted document with FAILED_PRECONDITION
  (`StoreConflict`), and reads timestamps back normalized (`...:00Z`), so comparing them as instants is
  required, as the code does;
- `dev/status`, `dev/logs`, `dev/query` and `dev/say` over IAP SSH and Firestore from Windows.

Still to check on a dev instance:

- **Upgrades.** Through control's transient unit (needs a signed command: phase 6), through
  `dev/deploy.mjs` over an SSH session (a dropped IAP connection kills `upgrade.sh`; switch to
  `systemd-run` if it happens), and a reboot after an upgrade keeping the upgraded release.
- **Gemini 4 reachability.** The installer does not yet check the project can call `gemini-4-argon` (it is
  global-only and new); add that check to step 1. A fresh project reached it with no quota request.
- **Index builds after install.** The installer starts the index builds and moves on; for the first
  minute or two after the first boot the brain logs `The query requires an index ... currently
  building` every three seconds, with the full error. Either wait for the indexes in step 4 or have the
  services log a building index once, quietly.
- **npm install scripts.** npm 11 on the VM skips install scripts that `allowScripts` does not cover
  and warns about two (`@google/genai`'s no-op, `protobufjs`'s version check). Harmless today; declare
  them in `agent/package.json` or silence the warning.

## For phase 6 (dashboard)

- **Commands must be signed.** The agent's own service account can write to the `commands` collection,
  so today the agent could restart services, switch Claude or start an upgrade on its own instance. The
  dashboard signs each command as its own service account through IAM Credentials `signJwt` (claims: the
  command id, type and a digest of its params, a short expiry, audience `paraclete-control`); control
  verifies the JWT against Google's published certificates for `paraclete-dashboard@` and refuses
  anything unsigned, expired, or signed by any other account. The agent's account has no
  `iam.serviceAccountTokenCreator` on the dashboard's, so it cannot sign; no shared secret exists to
  leak or distribute. Developer tools that send commands sign the same way, as the developer (an owner
  can be granted token-creator on the dashboard account) or reach the VM over SSH instead.
- **The command protocol** is in [agent/services/control/README.md](../../agent/services/control/README.md).
  Until `commit()` supports field masks, write `created_at` as an ISO string: the claim rewrites the whole
  document.

- **Thread documents.** The agent's thread ledger writes field-masked updates (`channel`,
  `last_turn_at`, `summary`, `summary_through_ts`) onto the dashboard's own `threads/{id}` document.
  The dashboard must never rewrite a whole thread document either.
- **Resolving approvals.** Patch only the fields `approvalResolution()` in `agent/work/approvals.mjs`
  returns.
- **Message shape.** Dashboard messages live in the root `messages` collection with fields `text`,
  `timestamp` (a Firestore timestamp), `processed`, `sender` (`agent`, or the user's email),
  `sender_name`, `thread_id` and `attachments` (`[{ name, size, gcsPath }]`). The `threads` document
  schema (for example, ordering by latest activity) is the dashboard's to define.
- **Unaddressed messages.** Work with no address reaches the dashboard as a message without a
  `thread_id`. Decide where such messages show.
- **Secret names.** `secret-read` reads a secret by its plain name; settle the naming convention the
  dashboard's secret store uses.
- **Download list.** `agent/storage/file-store.mjs` writes objects under `files/out/<mission>/` but no
  Firestore records. The dashboard needs either a bucket listing or records in `files`. A re-export
  overwrites objects of the same name, so the latest version wins.

## For phase 9 (models and upgrades)

- **Platform version on envelopes.** `platform_version` is declared on envelopes but nothing stamps it.
  Stamp it from `<install root>/release.json` once releases exist.

## For phase 8 (roles)

- **The Workspace account on the VM.** `install.sh` never writes the Workspace metadata keys: the agent's
  Google account exists only after the setup wizard. The wizard records it through a signed control
  command that writes it where `bootstrap.sh` keeps it across upgrades (a file under `/etc/paraclete`
  the bootstrap merges into `instance.json`), then restarts ears and mouth.
- **Role setup packages.** `bootstrap.sh` refuses a role whose `setup` lists `pip` or `npm` packages;
  add support when a role first needs them.

## For phase 7 (files and Drive)

- **Drive wording.** Project and deploy-target context tells the agent to use "the drive skill"
  rather than naming commands. Confirm the wording once the skill exists.
