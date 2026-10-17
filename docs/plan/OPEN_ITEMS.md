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

## For the first dev instance (phase 5's live check)

The install code is tested in dry runs and with fakes; these need a real project and VM:

- **The install itself.** `install/install.sh --ref <branch>` on a fresh project in an organization: every
  gcloud call's real output format (`get-ancestors`, `ttls list`), the bucket lifecycle file shape, the
  Firestore location in the region, delete protection, `storage rm` on an empty bucket.
- **The first boot.** apt and NodeSource on Debian 12, `npm ci` as root, the `paraclete` user and its
  `systemd-journal` group under the sandboxed units, `flock`, the codeload archive's top directory,
  whether `control.gateway_ready_timeout_ms` (30 s) is enough while IAM grants still propagate, the
  5-second settle check against a real crash loop, the readiness write with the VM's own credentials,
  `systemd-run --wait` passing the bootstrap's exit status.
- **Fences.** The agent cannot write under `/opt/paraclete` or `/etc/paraclete`; `writeFile`'s check is
  lexical, so file ownership is the real fence.
- **Upgrades.** Through control's transient unit, through `dev/deploy.mjs` over an SSH session (a dropped
  IAP connection kills `upgrade.sh`; switch to `systemd-run` if it happens), and a reboot after an
  upgrade keeping the upgraded release.
- **Indexes.** Every composite index in `install/firestore.indexes.json` builds; the equality-plus-`IN`
  queries (the scheduler guard, approvals, project completion, status notes) run on index merging.
- **The dev scripts.** Remote command quoting through SSH on Windows (plink) and macOS/Linux, non-
  interactive `sudo` for the developer's SSH user, and a `dev/say.mjs` round trip on real Firestore.
- **Gemini 4 reachability.** The installer does not yet check the project can call `gemini-4-argon` (it is
  global-only and new); add that check to step 1 once its quota behavior is known.

- **Behavior only real Firestore can confirm.** The fakes in `tests/fakes/` mark these unverified; check
  them on the first dev instance:
  - the answer to an `updateTime` precondition on a deleted document (FAILED_PRECONDITION, which
    `commit()` maps to StoreConflict, or NOT_FOUND, which it would report as StoreUnavailable);
  - that timestamps read back normalized (`...:00Z` for a whole second) are only ever compared as
    instants, never as strings.

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
