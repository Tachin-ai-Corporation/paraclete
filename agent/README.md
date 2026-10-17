# agent/

Code that runs on the agent's VM, one package per concern. Installed to `/opt/paraclete/agent/` at
the same relative paths.

## Packages

| Package | Job |
|---|---|
| `services/` | The long-running services and their systemd units: brain, ears, mouth and control |
| `gateway/` | Model gateway: runs one organ turn against Vertex AI, with tools, caching and fallbacks |
| `work/` | Missions, checkpoints, approvals, scheduling and verification verdicts |
| `context/` | What goes into a model call: memory windows, compaction, prompt blocks, tool records |
| `storage/` | Firestore, the git artifact store and the file store |
| `providers/` | Outside services: Vertex text calls, channels, notifications, JSON repair |
| `auth/` | Tokens: the VM's metadata server and domain-wide delegation |
| `cli/` | Commands the agent runs through its shell tool |

## Dependency direction

A package may import only the packages listed after it:

| Package | May import |
|---|---|
| `services/` | `work`, `context`, `storage`, `providers`, `auth` |
| `cli/` | `work`, `context`, `storage`, `providers`, `auth` |
| `work/` | `context`, `storage`, `providers`, `auth` |
| `context/` | `storage`, `providers`, `auth` |
| `storage/` | `auth` |
| `providers/` | `auth` |
| `gateway/` | `context`, `providers`, `auth` |
| `auth/` | nothing in `agent/` |

Nothing imports `services/` or `cli/`. The brain reaches the gateway over its local HTTP port, never
by import. `tests/repo/boundaries.test.mjs` enforces this table.

## npm packages

Only `gateway/` imports npm packages: the Google GenAI and Anthropic Vertex SDKs, pinned to exact
versions in `package.json` with a lockfile. Everything else uses Node built-ins. `npm run setup` at
the repo root installs them; on the VM the bootstrap runs `npm ci` here. Raise a version deliberately,
in its own commit, after checking a real tool turn against each model.

## Status

`auth/`, `storage/`, `providers/`, `context/` and `work/` are ported (build plan phase 2), and
`gateway/` (phase 3). `services/` and `cli/` arrive in phase 4.
