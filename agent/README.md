# agent/

Code that runs on the agent's VM, one package per concern. Installed to `/opt/paraclete/agent/` at
the same relative paths.

## Packages

| Package | Job |
|---|---|
| `services/` | The long-running services and their systemd units: brain, ears, mouth and control |
| `gateway/` | Model gateway: runs one organ turn against Vertex AI, with tools, caching and fallbacks |
| `organs/` | The brain's organs, one directory each: what is that organ's own, such as the cerebellum's checkpoint verification and the memory organ's recall |
| `work/` | Missions, checkpoints, approvals and scheduling |
| `context/` | What goes into a model call: memory windows, compaction, prompt blocks, tool records |
| `storage/` | Firestore, the git artifact store and the file store |
| `files/` | Reading, converting and making files with the VM's toolchain, and fetching them from where they were shared |
| `providers/` | Outside services: Vertex text calls, channels, notifications, Google Drive, JSON repair |
| `auth/` | Tokens: the VM's metadata server and domain-wide delegation |
| `release/` | What a release is: versions, their order, and GitHub's release list |
| `cli/` | Commands the agent runs through its shell tool |

## Dependency direction

A package may import only the packages listed after it:

| Package | May import |
|---|---|
| `services/` | `organs`, `work`, `context`, `files`, `storage`, `providers`, `auth`, `release`, and `gateway` from `services/gateway/` only |
| `organs/` | `work`, `context`, `files`, `storage`, `providers`, `auth`, `release`; never another organ |
| `cli/` | `organs`, `work`, `context`, `files`, `storage`, `providers`, `auth`, `release` |
| `work/` | `context`, `files`, `storage`, `providers`, `auth`, `release` |
| `context/` | `storage`, `providers`, `auth` |
| `files/` | `storage`, `providers`, `auth` |
| `storage/` | `auth` |
| `providers/` | `auth` |
| `gateway/` | `context`, `providers`, `auth` |
| `auth/` | nothing in `agent/` |
| `release/` | nothing in `agent/` |

Nothing imports `services/` or `cli/`. Only the gateway service imports `gateway/`, to build and run it;
the brain and everything else reach the gateway over its local HTTP port, never by import. `tests/repo/boundaries.test.mjs` enforces this table.

## npm packages

Only `gateway/` imports npm packages: the Google GenAI and Anthropic Vertex SDKs, pinned to exact
versions in `package.json` with a lockfile. Everything else uses Node built-ins. `npm run setup` at
the repo root installs them; on the VM the bootstrap runs `npm ci` here. Raise a version deliberately,
in its own commit, after checking a real tool turn against each model.

## Status

Every package is in place: the libraries (build plan phase 2), `gateway/` (phase 3), and `services/` and
`cli/` (phase 4).
