# agent/services/control/

The control service: the dashboard's bridge to the VM. The dashboard writes a command document to
Firestore; control carries it out on the VM and writes the outcome back onto the same document. It
reports status, skills, configuration and the agent's workspace; switches responsibilities and Claude;
restarts services; and upgrades the instance.

**Belongs here:** the command queue, the closed set of commands, and the calls to systemd they need.
**Doesn't:** running missions or responsibilities (the brain service fires a "run now" trigger), model
turns (the gateway), what an upgrade installs (`install/upgrade.sh`), or who may send a command (the
dashboard decides; see [Trust](#trust)).

## Files

| File | Does |
|---|---|
| `main.mjs` | Entry point: builds the runtime, polls the queue every `pollMs`, stops cleanly on SIGTERM |
| `command-queue.mjs` | Claims pending commands, runs each once, records outcomes; recovers and watches after a restart |
| `commands.mjs` | The command set: checks each command's params and calls the module that does the work |
| `systemd.mjs` | The allowlisted units and every `systemctl`, `systemd-run` and `journalctl` call |
| `upgrade.mjs` | Checks a ref, starts the upgrade script in its own unit, reads how it ended |
| `models.mjs` | The Claude switch in `config/settings`, and the model view |
| `responsibilities.mjs` | The responsibility list, the on/off switch, and "run now" |
| `introspection.mjs` | The status, skills, configuration and workspace views |
| `gateway-probe.mjs` | Asks the local gateway whether it is ready and which models it runs |
| `paraclete-control.service` | The systemd unit |

## Privilege

Control is the one paraclete service that runs as root, because restarting services and installing a
release need it. Every other service runs as the `paraclete` user. The privilege is fenced twice.

**In code.**

- The command set is closed. No command names a program, a path or a shell string; params are checked
  for type and form before anything runs, and anything unexpected fails the command.
- Programs run with an argument array, never through a shell, and are only `systemctl`,
  `systemd-run` and `journalctl`.
- Units come from a fixed list: `paraclete-gateway`, `-brain`, `-ears`, `-mouth` and `-control`
  `.service`, plus one transient unit per upgrade, `paraclete-upgrade-<command id letters and
  digits>.service`. `systemd.mjs` refuses any other name.
- An upgrade ref is a release tag that matches the contracts' `versioning.canonical_regex` in full,
  or a full 40-character lowercase commit id. Independently, it may hold only letters, digits and dots
  and may not start with a dash. Branch names and short ids are refused. The repository is the one the
  instance was installed from; a command cannot choose another.
- The upgrade program is fixed: `<install root>/install/upgrade.sh`, which is installed code and
  read-only to the agent.

**In the unit.** `ProtectSystem=strict` with nothing writable (control writes nothing on disk; its
results go to Firestore), `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, and the kernel and cgroup
protections. Talking to systemd over its socket works inside that sandbox.

**Why an upgrade runs in a unit of its own.** The upgrade writes the install root, which control's
sandbox forbids, and restarts every service, control included. As control's child it would be killed
halfway by that restart. `systemd-run` starts it as a transient unit outside control's sandbox and
process group, with `RemainAfterExit=yes` so its outcome can be read and `RuntimeMaxSec` so a hung
upgrade is stopped. The unit name is stored on the command before the unit starts, and the restarted
control service watches it to the end.

## Trust

Control carries out any well-formed command in the `commands` collection. Who may write one is decided
outside it: the dashboard sends the commands that change things only for dashboard admins, and
Firestore access is limited by IAM to the dashboard's and the agent's service accounts.
`requested_by` is recorded on everything a command writes, for the audit trail; control does not
verify it.

## Command protocol

Commands live in the root `commands` collection (`COLLECTIONS.commands`), one document per command.
Control polls for `status == "pending"`, runs commands one at a time, oldest `created_at` first, and
writes the outcome onto the same document.

### Request (written by the dashboard)

| Field | Type | Meaning |
|---|---|---|
| `type` | string | One of the command types below |
| `params` | map | The command's parameters; omitted means none |
| `status` | `"pending"` | Control only picks up pending commands |
| `requested_by` | string | The dashboard user's email; recorded on what the command writes |
| `created_at` | string | ISO 8601 UTC, e.g. `2026-10-17T12:00:00.000Z`. Sets the order |

The document id is the command id: a Firestore auto-id is right. Write timestamps as ISO strings,
not Firestore timestamps: the claim rewrites the document and stores every timestamp as a string.

### Outcome (written by control)

| Field | Type | Meaning |
|---|---|---|
| `status` | string | `running` once claimed, then `done` or `failed` |
| `started_at`, `finished_at` | string | ISO 8601 UTC |
| `result` | map or null | The command's result, below. A failed command keeps a partial result when it has one |
| `error` | string or null | Why it failed, in plain words. Also set on a `done` command whose result could not be stored |
| `detached` | map | Upgrades only: `{ unit, ref, kind, started_at }` while the upgrade runs in its own unit |

Guarantees:

- **Never twice.** A command is claimed (pending to running, only if the document is unchanged since
  it was read) before anything runs.
- **Never stuck.** A command found `running` when control starts was interrupted: it becomes `failed`
  with an error saying so, and is not run again. An upgrade (it has `detached`) is the exception: it
  is still running in its own unit, and control keeps watching it.
- **Always recorded.** If Firestore refuses a result (a document is at most 1 MiB), the outcome is
  written again without it, and `error` says why. The views bound their file contents to stay well
  under the limit, and mark every cut.

### `status`

Params: none.
Result:
```
{ checked_at,
  services: { gateway|brain|ears|mouth|control: { service, unit, load, active, sub, result, main_pid,
              restarts, exit_status, since, heartbeat } | { service, error, heartbeat } },
  gateway:  { reachable, ready, providers, required, models, uptime_sec, requests, sessions, error? },
  release:  <install root>/release.json, or null,
  host:     { hostname, uptime_sec, load_avg, memory_total_bytes, memory_free_bytes },
  control:  { pid, uptime_sec } }
```
`active`/`sub` are systemd's `ActiveState`/`SubState`. `sessions` is a count. `heartbeat` is the
service's health file, `<data root>/services/<service>/health.json`, as the service wrote it, plus
`file`, `age_sec` and `stale` (no `beat_at`, or one older than 60 seconds: the loop is hung even if
systemd shows the unit running); null for a service that writes none. The gateway is probed over HTTP
instead, and control is the one answering.

### `skills`

Params: none.
Result: `{ skills: [{ id, name, version, when_to_use, organs, commands, origin, path, skill_md,
skill_md_truncated, problem? }] }`, in catalog order. `origin` is `base`, `role:generic`,
`role:<role>` or `agent`. `skill_md` is null once the content budget is spent.

### `config`

Params: none.
Result: `{ instance, release, settings: { claude_enabled, effort, claude_updated_at,
claude_updated_by }, contracts }`. `instance` is the instance record; it names the gateway token
file, never its content.

### `workspace`

Params: none.
Result:
```
{ memory:    [{ name, size_bytes, modified_at, content, truncated }],          the .md files in memory/
  prompts:   [{ name, source: "base" | "role:<role>", size_bytes, modified_at, content, truncated }],
  workspace: [{ name, kind: "file" | "dir", size_bytes, modified_at }],         the motor workspace, top level
  workspace_truncated }
```

### `brain_config`

Params: none.
Result: `{ settings, tiers, locations: { google, anthropic }, running, organ_max_steps,
service_models: { utility, ears_preprocess, mouth } }`. `tiers` is the contracts' `vertex.models`;
`running` is the gateway probe, whose `models` are what the gateway actually runs.

### `responsibilities`

Params: none.
Result: `{ responsibilities: [...], issues: [{ id, reason }], store_error }`, each responsibility
`{ id, name, schedule, timezone, enabled, next_fire, min_spacing_minutes, instruction, has_process,
process_steps, triggerable, locked, source, origin, revision, updated_by }`. `origin` is `default`,
`override` or `agent`. With an unreadable store, the installed defaults are listed and
`store_error` says why.

### `set_responsibility_enabled`

Params: `{ id: string, enabled: boolean }`.
Result: `{ id, enabled, revision, message }`. Writes the next revision of
`responsibilities/{id}` and its copy in `responsibilities/{id}/revisions/{revision}`, atomically.
Locked upkeep refuses.

### `run_responsibility`

Params: `{ id: string }`.
Result: `{ id, name, trigger_id, message }`. Creates `responsibility_triggers/{command id}`:
`{ responsibility_id, status: "pending", bypass_spacing: true, requested_by, requested_at,
command_id }`. The brain's scheduler claims it and sets `status` to `fired`, `skipped` or `error`
with `detail` and `fired_at`; follow it by `trigger_id`.

### `set_model`

Params: `{ claude_enabled: boolean }`.
Result: `{ claude_enabled, expected_cortex, gateway }`. Writes `claude_enabled`,
`claude_updated_at` and `claude_updated_by` in `config/settings` (nothing else in it), restarts the
gateway, and waits for it to be ready on the expected cortex model. A gateway that is not ready, or
runs another model, fails the command with the probe in `result`; the setting stays as written.

### `restart_service`

Params: `{ service: "gateway" | "brain" | "ears" | "mouth" | "control" }`.
Result: `{ service, unit, state, gateway? }`. A restarted gateway is waited for until ready.
Restarting `control` records the command as `done` (`{ service, unit, restarting: true, message }`)
first, then queues the restart.

### `upgrade`

Params: `{ ref: string }`, a release tag such as `v2026.10.17.1.1` or a full commit id.
While running: `status: "running"` with `detached: { unit, ref, kind: "release" | "commit",
started_at }`.
Result: `{ ref, kind, unit, exit_status, outcome, output }`, where `output` is the tail of the
upgrade's log. Fails at once while `<install root>/install/upgrade.sh` is not installed. A unit
systemd no longer knows (the VM restarted mid-upgrade) fails with an unknown outcome.

## The admin settings document

`config/settings` holds what a dashboard admin changes:

| Field | Written by | Meaning |
|---|---|---|
| `claude_enabled` | `set_model` | Claude for the cortex and the strong tier. Only `true` turns it on. The gateway reads it at startup |
| `claude_updated_at`, `claude_updated_by` | `set_model` | When and by whom it last changed |
| `effort` | the dashboard | One of the contracts' effort levels; `effort.default` when absent |

## What the installer provides

- This unit, enabled, running as root; `systemctl`, `systemd-run` and `journalctl` on the PATH.
- `<install root>/install/upgrade.sh --ref <ref>`: exits 0 on success, logs to stdout and stderr (the
  unit's journal), fetches that ref's upgrader instead of trusting the installed copy, and restarts
  the services itself, control included. Safe to run twice.
- `<install root>/release.json`, written at install and upgrade: `{ version, ref, commit,
  installed_at }`.

## Timings

`pollMs` 5 s, `readyTimeoutMs` 30 s (waiting for a restarted gateway) and `upgradeMaxSeconds` 1800 are
defaults in `main.mjs`; a `control` section in `config/contracts.json` (`poll_ms`,
`gateway_ready_timeout_ms`, `upgrade_max_seconds`) overrides each one it sets.
