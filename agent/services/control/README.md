# agent/services/control/

The control service: the dashboard's bridge to the VM. The dashboard writes a command document to
Firestore; control carries it out on the VM and writes the outcome back onto the same document. It
reports status, skills, configuration and the agent's workspace; switches responsibilities and Claude;
restarts services; upgrades the instance; checks what the agent can reach in Google Drive; and, on a
role with a Google Workspace account, checks that account and records it on the VM.

**Belongs here:** the command queue, the closed set of commands, the signature check, and the calls to
systemd they need.
**Doesn't:** running missions or responsibilities (the brain service fires a "run now" trigger), model
turns (the gateway), what an upgrade installs (`install/upgrade.sh`), or which dashboard users may ask
for a command (the dashboard decides; see [Trust](#trust)).

## Files

| File | Does |
|---|---|
| `main.mjs` | Entry point: builds the runtime, polls the queue every `pollMs`, stops cleanly on SIGTERM |
| `command-queue.mjs` | Checks each pending command's signature, claims it, runs it once, records the outcome; recovers and watches after a restart |
| `commands.mjs` | The command set: checks each command's params and calls the module that does the work |
| `systemd.mjs` | The allowlisted units and every `systemctl`, `systemd-run` and `journalctl` call |
| `upgrade.mjs` | Checks a ref, starts the upgrade script in its own unit, reads how it ended |
| `models.mjs` | The Claude switch in `config/settings`, and the model view |
| `responsibilities.mjs` | The responsibility list, the on/off switch, and "run now" |
| `introspection.mjs` | The status, skills, configuration and workspace views |
| `gateway-probe.mjs` | Asks the local gateway whether it is ready and which models it runs |
| `drive-check.mjs` | The Drive check: what the agent's Drive identity can reach, whether the output folder takes new files, and advice in plain sentences |
| `workspace-check.mjs` | The Workspace check: a delegated token per API and one read-only call each, and for every failure the one thing to change |
| `workspace-account.mjs` | Records the agent's Workspace account in `/etc/paraclete/workspace.json`, the instance record and `config/workspace_account`, and restarts the services that read it; the address rule and the signer's name |
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
- `drive_check` reaches Google Drive as the agent's own Drive identity, never with more access than
  the agent has, and writes nothing there but its own test file, which it moves to the trash at once.
- `workspace_check` acts only as the agent would: the VM's service account signs as
  `paraclete-dwd@<project>`, which it may already do, and the calls only read.
- On disk, control writes two files and no other: `/etc/paraclete/workspace.json` and
  `/etc/paraclete/instance.json`, from `set_workspace_account`. The paths are constants in
  `workspace-account.mjs`, which refuses any other; the account is checked first (an address in an
  organization's domain, never a personal Gmail account or a service account), the signer is derived
  from the project, every other field of the instance record is kept as it was, and the new record must
  pass `validateInstance()` before it is written. An account is recorded only when the installed role's
  `role.json` sets `workspace`.

**In the unit.** `ProtectSystem=strict` with `/opt/paraclete` read-only and one writable path,
`/etc/paraclete`; `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, and the kernel and cgroup
protections. Talking to systemd over its socket works inside that sandbox.

**Why `/etc/paraclete` may be writable.** It holds only configuration: the instance record, the
gateway token and the Workspace record, nothing that runs. A file can only be replaced atomically by
renaming a sibling into place, which needs the directory, not just the two files, to be writable. And
the sandbox was never what stops code running as control: control asks systemd to start units (an
upgrade runs outside this sandbox by design), so the closed command set above is the fence that
matters, and it names the two files. Everything else on the system stays read-only to control.

**Why an upgrade runs in a unit of its own.** The upgrade writes the install root, which control's
sandbox forbids, and restarts every service, control included. As control's child it would be killed
halfway by that restart. `systemd-run` starts it as a transient unit outside control's sandbox and
process group, with `RemainAfterExit=yes` so its outcome can be read and `RuntimeMaxSec` so a hung
upgrade is stopped. The unit name is stored on the command before the unit starts, and the restarted
control service watches it to the end.

## Trust

Control runs a command only when the dashboard signed it. The agent's own service account can write
to the `commands` collection, so a document there proves nothing by itself; a signature does.

- The dashboard signs each command as its own service account, `paraclete-dashboard@<project>`,
  through IAM Credentials `signJwt`, and stores the JWT in the command's `signature` field. The claims
  (`agent/auth/command-signature.mjs`) name the command id, its type, a digest of its params, who
  asked, the audience `paraclete-control`, and an expiry ten minutes out.
- Control checks the signature against the keys Google publishes for that account, before claiming
  the command: a command copied, edited after signing, signed by any other account, or expired is
  failed with `error: "refused: <why>"` and never runs. While Google's keys cannot be fetched, the
  command stays pending and is checked again next tick.
- The agent's account holds no Token Creator role on the dashboard's, so it cannot sign as it. No
  shared secret exists to leak.
- Who may ask is the dashboard's decision: it signs the commands that change things only for its
  admins. `requested_by` is signed with the command and recorded on everything it writes.

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
| `signature` | string | The dashboard's signature over this command (see [Trust](#trust)). Unsigned commands are refused |

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
Result: `{ skills: [{ id, name, version, when_to_use, organs, commands, requires, unavailable?, origin,
path, skill_md, skill_md_truncated, problem? }] }`, in catalog order. `origin` is `base`, `role:generic`,
`role:<role>` or `agent`. `skill_md` is null once the content budget is spent. `requires` is the
skill's list (`["workspace"]` for a Workspace skill, else `[]`); `unavailable` says why the skill
cannot work on this instance (`needs a Workspace account`), and such a skill is not in the organs'
catalog.

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

### `drive_check`

Params: none. The dashboard's Test Drive button; admins only, because it writes a test file.
Runs as the agent's Drive identity (`agent/providers/drive.mjs`): its Workspace account when it has
one, else the VM's service account.
Result:
```
{ identity:       { kind: "service_account" | "workspace", email },
  reachable:      boolean,             Drive answered the identity at all
  error:          string | null,       why it did not, or why a later step failed
  shared_with_me: { count, capped, sample: [{ id, name, mime_type, owner }] },
  shared_drives:  [{ id, name, can_add_files }],
  output_folder:  null | { id, name, drive_id, writable, error },
  advice:         [string] }
```
`count` stops at 100 (`capped` then says there are more); `sample` names the newest five. `owner` is
the owner's email, or null in a shared drive. `can_add_files` is the membership's `canAddChildren`.
`output_folder` is null when `config/settings` sets no `drive_output_folder`. The writable test
creates `paraclete-drive-check-<time>.txt` in the folder and moves it to the trash (a Content
manager in a shared drive may trash files but not delete them); a test file that cannot be trashed
leaves `writable: true` with `error` naming it. `drive_id` is null for a folder in someone's My
Drive, where a service account can never create files.
`advice` holds plain sentences for the person: nothing shared yet (how to share, with the address,
and, for a service account, the organization-wide sharing block and its three ways out), Drive not
reachable (the API off, the scope missing, the token refused), no output folder (optional), and an
output folder that does not take new files. Empty when nothing needs doing. A Drive failure never
fails the command; a Firestore failure reading the settings does.

### `workspace_check`

Params: `{ account: string }`, the address of the Google user the agent should be. The dashboard's
Workspace Test button; admins only.
Asks Google, the way the agent will, whether that account works for it. The VM's service account has
IAM sign a token request as the delegation signer, `paraclete-dwd@<project>.iam.gserviceaccount.com`,
with `account` as its subject, and exchanges it for a token (`agent/auth/dwd-token.mjs`) for each
API's scopes (`agent/auth/workspace-scopes.mjs`). Then one read-only call per API: Chat
`spaces.list`, Drive `about.get`, Docs `documents.get`, Sheets `spreadsheets.get`, Slides
`presentations.get`, Calendar `calendarList.list` and Gmail `users.getProfile`. Docs, Sheets and
Slides are asked for a file id that cannot exist: their "not found" proves the API is on and took the
token. Google Chat refuses to list the spaces of a user nobody has written to yet; when it refuses,
the check looks up the account's direct message with itself (`spaces.findDirectMessage`), and "not
found" there means Chat took the token: Chat is `ok` and `pending`, with a `note` saying to send the
agent a first message. Nothing in Google is written.
Result:
```
{ account,                        lowercased
  signer,                         paraclete-dwd@<project>.iam.gserviceaccount.com
  client_id:      string | null,  the signer's OAuth client ID, looked up only when the grant is at fault
  checked_at,
  ready:          boolean,        every API answered
  missing_scopes: [string] | null, scopes the Admin console's grant lacks; null when the cause was elsewhere
  apis: [{ api: "chat"|"drive"|"docs"|"sheets"|"slides"|"calendar"|"gmail", name, scopes, ok, error, fix,
           pending?: true, note?: string }] }   pending and note: Chat only, for an account nobody has written to
```
`error` is Google's answer, `fix` the one thing to change, both null when `ok`. When the whole scope
list is refused, each scope is asked for alone, so `fix` names the missing ones; when all are refused,
`fix` says the Admin console has no grant for the signer's client ID (none, or one made for another
client ID). A user Google does not know, or a suspended one, an API off in the project, a Chat app
record missing from the project, Gmail off for the user, and a signer that does not exist or that the agent may not sign as
each get their own `fix`. An address that is not a Workspace user's (not an address, a personal Gmail
account, a service account) fails the command. The result is also written as `last_check` on
[`config/workspace_account`](#the-workspace-account-record), with `checked_by`; a failure to write it is
logged and does not fail the command.

### `set_workspace_account`

Params: `{ account: string | null }`. The dashboard's Save, once a check has passed, and Remove (`null`).
Records the agent's Workspace account on the VM. The address is checked as `workspace_check` checks it,
and an account is refused unless the installed role's `role.json` sets `workspace`. Then:

1. `/etc/paraclete/workspace.json` (root, 0644) becomes `{ account, signer, recorded_at, recorded_by }`
   (`account` and `signer` null after a removal). The VM's bootstrap merges it into the instance
   record at every boot and upgrade while the VM metadata sets no `paraclete-workspace-account`, so the
   account outlives both (install/README.md).
2. `/etc/paraclete/instance.json` is rewritten with `workspace: { account, signer }` (or without
   `workspace`), every other field as it was, once it passes `validateInstance()`. Skipped when the
   record already says so.
3. [`config/workspace_account`](#the-workspace-account-record) gets the same four fields.
4. When the instance record changed: the gateway (waited for until ready), the brain, ears and mouth
   restart, and control itself once the command is recorded.

Result: `{ account, signer, previous, recorded_at, recorded_by, files, restarted, message,
restarting? }`. `previous` is the account the record named before; `files` the files written;
`restarted` the services restarted; `restarting: "control"` when control restarts next. A Firestore or
restart failure fails the command with this result: the files are written by then, and sending the
command again is safe.

## The admin settings document

`config/settings` holds what a dashboard admin changes:

| Field | Written by | Meaning |
|---|---|---|
| `claude_enabled` | `set_model` | Claude for the cortex and the strong tier. Only `true` turns it on. The gateway reads it at startup |
| `claude_updated_at`, `claude_updated_by` | `set_model` | When and by whom it last changed |
| `effort` | the dashboard | One of the contracts' effort levels; `effort.default` when absent |
| `effort_updated_at`, `effort_updated_by` | the dashboard | When and by whom the effort last changed |
| `drive_output_folder` | the dashboard | A Drive folder id, or null: where `drive-put` saves new files when not told a folder, and what `drive_check` tests |
| `drive_output_folder_updated_at`, `drive_output_folder_updated_by` | the dashboard | When and by whom the output folder last changed |

## The Workspace account record

`config/workspace_account` tells the dashboard what the VM holds, since it cannot read the VM's
files. Only control writes it, each command its own fields:

| Field | Written by | Meaning |
|---|---|---|
| `account`, `signer` | `set_workspace_account` | The recorded account and the delegation signer, or null after a removal |
| `recorded_at`, `recorded_by` | `set_workspace_account` | When and by whom |
| `last_check` | `workspace_check` | The last check's result, as above, plus `checked_by`. It may be for an address other than `account`: a check runs before anything is recorded |

## What the installer provides

- This unit, enabled, running as root; `systemctl`, `systemd-run` and `journalctl` on the PATH.
- `<install root>/install/upgrade.sh --ref <ref>`: exits 0 on success, logs to stdout and stderr (the
  unit's journal), fetches that ref's upgrader instead of trusting the installed copy, and restarts
  the services itself, control included. Safe to run twice.
- `<install root>/release.json`, written at install and upgrade: `{ version, ref, commit, repo,
  installed_at, metadata }` (see [install/README.md](../../../install/README.md)).
- On a role flagged `workspace`: the signer `paraclete-dwd@<project>`, on which the agent's account
  holds Service Account Token Creator, and the Workspace APIs turned on in the project. The bootstrap
  merges `/etc/paraclete/workspace.json` into the instance record it writes.

## Timings

`pollMs` 5 s, `readyTimeoutMs` 30 s (waiting for a restarted gateway) and `upgradeMaxSeconds` 1800 are
defaults in `main.mjs`; a `control` section in `config/contracts.json` (`poll_ms`,
`gateway_ready_timeout_ms`, `upgrade_max_seconds`) overrides each one it sets.
