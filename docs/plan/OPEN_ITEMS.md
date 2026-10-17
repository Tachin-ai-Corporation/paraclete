# Open items

What one phase of the [build plan](BUILD_PLAN.md) hands to a later one. Each item names the phase
that resolves it. Delete an item in the commit that resolves it.

## Still open from phase 4 (services and configuration)

- **Status needs the token.** The gateway's `GET /status` requires the bearer token, so `dev/status`
  must send it.
- **Write fences.** `writeFile` checks writable roots lexically and `runCommand` is a full shell, so
  the real fence is file ownership and permissions on the VM (phase 4 and 5).

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

## For phase 5 (install)

- **What the services and commands need from the installer.**
  - The `paraclete` user, with a writable home under the data root (`gcloud` and `npm` write to it under
    `ProtectSystem=strict`) and the `systemd-journal` group (telemetry reads the journal).
  - Data directories: `memory`, `missions`, `workspace`, `files`, `skills`, `services`.
  - `/etc/paraclete/instance.json`, and `/etc/paraclete/gateway-token` readable by `paraclete` and root.
  - `npm ci` in `agent/`, then the units enabled.
  - A launcher per command in `/opt/paraclete/bin/`: `exec /usr/bin/node <file> "$@"`, not a symlink
    (a symlink breaks each command's run-directly check). One for every `agent/cli/<name>.mjs` except
    `cli-runtime.mjs`, and every command a skill governs.
  - `install/upgrade.sh --ref <ref>`: exits 0 on success, is idempotent, restarts the services (control
    included), and fetches the target ref's own upgrader. Plus `<install root>/release.json`
    (`{version, ref, commit, installed_at}`), written at install and every upgrade.
  - The agent's service account is named `paraclete-agent` (`agentIdentity` in `config/instance.mjs`
    derives the agent's identity from it).
- **Command signing key.** See phase 6: generate it at install, store it in Secret Manager readable only
  by the dashboard's service account, and write it to a root-only file on the VM for the control
  service.

- **Firestore indexes and TTL.**
  - Composite index on `messages`: `thread_id` ascending, `timestamp` descending, for conversation
    context.
  - Composite indexes on `work`: `status` with `created_at` descending (work recall) and ascending
    (archival), and `type` with `created_at` descending (session summary and the work log commands).
  - Composite index on `intake`: `status` with `created_at` ascending (the brain's intake poll).
  - TTL policy on `tool_results.expire_at`.
  - The scheduler's guard, the approvals poll and project completion combine equality and `IN`
    filters and rely on index merging. Confirm each on a dev instance.
- **Behavior only real Firestore can confirm.** The fakes in `tests/fakes/` mark these unverified; check
  them on the first dev instance:
  - the answer to an `updateTime` precondition on a deleted document (FAILED_PRECONDITION, which
    `commit()` maps to StoreConflict, or NOT_FOUND, which it would report as StoreUnavailable);
  - that timestamps read back normalized (`...:00Z` for a whole second) are only ever compared as
    instants, never as strings.

## For phase 6 (dashboard)

- **Commands must be signed.** The agent's own service account can write to the `commands` collection,
  so today the agent could restart services, switch Claude or start an upgrade on its own instance.
  Control must accept only commands signed with a key the agent cannot read: an HMAC over the command,
  keyed by a secret only the dashboard's service account (Secret Manager) and root (a 0600 file on the
  VM) hold. The dashboard signs; control verifies and refuses anything else.
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

## For phase 7 (files and Drive)

- **Drive wording.** Project and deploy-target context tells the agent to use "the drive skill"
  rather than naming commands. Confirm the wording once the skill exists.
