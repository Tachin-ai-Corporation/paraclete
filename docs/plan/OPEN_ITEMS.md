# Open items

What one phase of the [build plan](BUILD_PLAN.md) hands to a later one. Each item names the phase
that resolves it. Delete an item in the commit that resolves it.

## For phase 3 (gateway)

- **Acknowledgment calls.** `agent/providers/notifications.mjs` `generateAck` posts an OpenAI-style
  chat request to the gateway, marked `[BRAIN-ORCHESTRATED]`. The gateway must keep that endpoint
  and marker, or the call must change with it.

## For phase 4 (services and configuration)

- **Git store command line.** `agent/storage/git-store.mjs` is a library. The agent's `ensure`,
  `clone`, `fetch`, `push`, `merge`, `gc`, `manifest`, `read-ref` and `list-refs` commands are rebuilt
  in `agent/cli/`. They print JSON on stdout, log to stderr with a `[git-store]` prefix, exit 1 on
  error, and pass the bucket, prefix, default branch, retry count, project and commit author from
  `config/contracts.json`. `push` calls `pushWithRetry`.
- **A data root apart from the install root.** Mission trees (`shared/<mission>`) and the motor
  workspace live under the install root today, but installed code is read-only to the agent. Give
  them a data root such as `/var/lib/paraclete`.
- **Workspace file names.** The artifact sweep keeps, and the artifact excludes skip, a list of
  workspace file names (organ prompt files, memory files, progress files). Reconcile the list with
  the workspace layout phase 4 defines.
- **Dashboard thread on every address.** Conversation context needs the thread id, so the ears must
  stamp `thread` on every dashboard address. `addressFromMeta` in the brain duplicates
  `parseAddress` in `agent/providers/channel.mjs`; keep one.
- **Respond reads.** The brain's list of reads it can answer from must not include reads of other
  agents.
- **Strict reads.** `createClient` in `agent/storage/firestore.mjs` defaults to logging read
  failures and returning empty results; `readDoc` and `commit` always fail closed. Once every caller
  is ported, decide whether strict should be the default.
- **One Firestore client.** The git store's default store makes its own Firestore REST calls. Fold
  them into `createClient` when the services wire both.
- **Checkpoint executor rules.** When `checkpoint-executor.mjs` arrives in `agent/work/`:
  - A skip whose tasks already completed always marks the checkpoint complete
    (`markCheckpoint(spine, i, 'complete', { now })`), with no switch.
  - A milestone that fails verification halts the mission. Nothing proceeds past a failed milestone,
    and finalization blocks on `finalizeBlockedBySpine` with no probe deferral. Once that holds,
    remove the `unconfirmed` option from `markCheckpoint` and simplify `isVerified` and
    `passedThisRun`.
  - Settle whether the verifier's probe loop is serviced; synthesis uses `extractProbes`.
- **Resuming a timed wait.** `LEGAL_TRANSITIONS` does not allow `waiting → queued`. The brain resumes
  an expired wait to `active`, or the table gains that transition, decided once and tested.
- **Declared record fields.** The schemas in `agent/work/work-schema.mjs` are closed but not yet
  enforced. Before anything validates against them:
  - declare every envelope field the brain, scheduler and archival write (stakes, needs_review,
    context, context_forward, memory_context, recalled_processes, memory_written, archived_reason,
    delivery_address, job_to_be_done and the rest);
  - declare `canon` and `auto_complete` on projects;
  - rewrite `APPROVAL_SCHEMA` in the camelCase shape approvals are actually written in
    (`envelopeId`, `requestedBy`, `resolvedBy`, `_processed`, ...).
  No port writes `owner`, `team`, `ownerAgent` or `participants`.
- **Approval wiring.** The checkpoint executor passes `requestedBy` (the person who asked) when it
  raises a gate; `source_thread` comes from `envelope.source_meta.address.thread`. Anything that
  resolves an approval patches only the fields `approvalResolution()` returns: rewriting the whole
  document drops `_processed`, and the poller never sees the approval.
- **Project ids in the command line.** The project listing command takes each id from the document
  path. Reading it from a stored field once printed a placeholder dash instead of the id.
- **Singleton guard and approvals.** The scheduler's one-run-at-a-time guard counts active, queued,
  pending and waiting missions, not `awaiting_approval`. Decide whether a mission waiting for
  approval should block the next scheduled run.
- **One stakes scale.** `stakesAtLeast` uses routine / consequential / irreversible; the approval
  schema uses routine / consequential / destructive_or_public. Pick one.
- **Effort for every instance.** The brain's effort setting must not be gated on any role.

## For phase 5 (install)

- **Firestore indexes and TTL.**
  - Composite index on `messages`: `thread_id` ascending, `timestamp` descending, for conversation
    context.
  - Composite indexes on `work`: `status` with `created_at` descending (work recall) and ascending
    (archival).
  - TTL policy on `tool_results.expire_at`.
  - The scheduler's guard, the approvals poll and project completion combine equality and `IN`
    filters and rely on index merging. Confirm each on a dev instance.

## For phase 6 (dashboard)

- **Thread documents.** The agent's thread ledger writes field-masked updates (`channel`,
  `last_turn_at`, `summary`, `summary_through_ts`) onto the dashboard's own `threads/{id}` document.
  The dashboard must never rewrite a whole thread document either.
- **Resolving approvals.** Patch only the fields `approvalResolution()` in `agent/work/approvals.mjs`
  returns.
- **Message shape.** Dashboard messages live in the root `messages` collection with fields `text`,
  `timestamp` (a Firestore timestamp), `processed`, `sender` (`agent`, or the user's email),
  `sender_name`, `thread_id` and `attachments` (`[{ name, size, gcsPath }]`). The `threads` document
  schema (for example, ordering by latest activity) is the dashboard's to define.
- **Download list.** `agent/storage/file-store.mjs` writes objects under `files/out/<mission>/` but no
  Firestore records. The dashboard needs either a bucket listing or records in `files`. A re-export
  overwrites objects of the same name, so the latest version wins.

## For phase 7 (files and Drive)

- **Drive wording.** Project and deploy-target context tells the agent to use "the drive skill"
  rather than naming commands. Confirm the wording once the skill exists.
