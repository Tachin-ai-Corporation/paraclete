# agent/work/

How work moves: Request → Mission → Checkpoint → Task, and everything that keeps it honest.

**Belongs here:** mission and checkpoint state, the checkpoint executor, approval gates, the scheduler
and responsibilities, verification verdicts, finalization and deliverables, the resource ledger.
**Doesn't:** model calls (`gateway/`), persistence details (`storage/`), or what goes into a prompt
(`context/`).

Most of this package is pure functions over plain data. Keep it that way: it is the part of the agent
that must be deterministic.

## Files

| Group | Files |
|---|---|
| Envelope state | `work-transitions.mjs` (legal status changes), `work-schema.mjs` (record shapes), `work-ids.mjs`, `validate-schema.mjs`, `platform-version.mjs` (the release stamped on each envelope the brain creates) |
| Planning | `plan-utils.mjs` (plans into checkpoint lists), `plan-lint.mjs`, `checkpoint-spine.mjs` (the verified skeleton of a mission) |
| Verification | `verdict.mjs` (reads the verifier's verdict), `agent-output.mjs` (spots failures in motor output), `result-packet.mjs` (evidence between organs) |
| Finishing | `finalization.mjs`, `deliverable.mjs`, `mission-record.mjs` |
| Mission state | `blackboard.mjs`, `resource-ledger.mjs`, `artifacts.mjs` (mission working trees and publishing), `memory-scope.mjs` |
| Approvals | `approvals.mjs` (the approval gate's lifecycle) |
| Responsibilities | `scheduler.mjs`, `responsibility-store.mjs`, `responsibility-schema.mjs`, `role-packages.mjs` (reads the installed role packages' responsibilities and playbooks, generic first) |
| Library | `process-registry.mjs` (process playbooks), `projects.mjs`, `project-context.mjs`, `deploy-target.mjs` |
| Housekeeping | `archival.mjs` (archives finished work, cancels stale work, never a timed wait before its time), `effort.mjs` |

The checkpoint executor, which runs a mission's checkpoints, arrives with the brain service in
build plan phase 4.
