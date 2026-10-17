# agent/cli/

Commands the agent runs through its shell tool: reading and writing memory, managing projects and
responsibilities, reading its own work logs and telemetry.

**Belongs here:** small command-line programs with one job each, documented in the skill that
governs them.
**Doesn't:** skill-specific scripts. A command that only one skill uses lives in that skill's
directory under `skills/` or `roles/<id>/skills/`.

Every command here is part of the agent's tool surface, so its `--help` text is agent-facing product
text.

## Commands

Each is `agent/cli/<command>.mjs`, run on the VM by bare name through a launcher in
`/opt/paraclete/bin/`. `<command> --help` prints its exact syntax.

| Command | Does | Reads or writes |
|---|---|---|
| `git-store` | Moves a project's artifact repository between the store and a working tree: `ensure`, `clone`, `fetch`, `push`, `merge`, `gc`, `manifest`, `read-ref`, `list-refs`. Prints JSON | Bucket, `git_repos` |
| `core-memory-read` | Searches Core Memory, ranked by value | `core_memory` |
| `core-memory-write` | Adds a Core Memory entry, optionally superseding one | `core_memory` |
| `core-memory-retire` | Retires a Core Memory entry with a reason | `core_memory` |
| `session-summary` | Summarizes recently completed missions for memory consolidation | `work` |
| `update-deep-truths` | Lists, adds and removes Deep Truths | `memory/DEEP_TRUTHS.md` under the data root |
| `responsibility-manage` | Authors the agent's own responsibilities over the installed defaults | `responsibilities`; role packages' `responsibilities.json` (read) |
| `project-manage` | Lists, creates and updates projects: status, canon, context, linked playbooks | `projects` |
| `process-ops` | Lists, reads, writes and retires process playbooks | `processes`; role packages' `processes/` (read) |
| `work-log-read` | Lists recent work envelopes, or drills one mission's tree and step ledger | `work` |
| `work-output-read` | Prints one envelope's complete output | `work` |
| `task-log-read` | Lists recent tasks as JSON, or one envelope with its history | `work` |
| `task-log-write` | Adds a delivery record to an envelope's history; never fails the caller | `work/{id}/history` |
| `brain-telemetry-read` | Shows recent organ turns from the gateway's journal | The system journal |
| `brain-telemetry-write` | Records one dispatch in the journal; never fails the caller | The system journal |
| `agent-status` | Reports the instance and its services' states as JSON | Instance record, systemd |

`cli-runtime.mjs` is not a command and gets no launcher: every command starts from it. It loads the
contracts and the instance record and builds the Firestore client, the paths and the agent's
identity. Commands never import `agent/services/`, and nothing outside this directory imports a
command.

## Conventions

- One file per command, starting `#!/usr/bin/env node`, exporting `main(argv, deps)`, which returns
  the exit code. `deps` (runtime, stdout, stderr, now, and whatever else the command lists) lets a
  test run it without a VM.
- Results go to stdout, problems to stderr. An outage is an error, never an empty result.
- An id from the command line is checked before it becomes part of a document path.
