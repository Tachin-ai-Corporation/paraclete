# config/

Configuration, and the only code allowed to read it.

| File | Holds |
|---|---|
| `contracts.json` | The product's defaults: every value used in more than one place. Model tiers, budgets, timeouts, limits, intervals |
| `contracts.mjs` | Loads `contracts.json`, checks it (including the storage ceilings), and freezes it |
| `instance.mjs` | Loads this instance's identity from `/etc/paraclete/instance.json`, written at install: project, role, agent name, bucket, install and data roots. Defines where the agent's data lives, and the name and email the agent signs commits and canon entries with |

**Installed:** yes. Services and command-line tools read configuration through these loaders; library
packages in `agent/` never do (`tests/repo/boundaries.test.mjs` enforces it).

## Three kinds of setting

| Kind | Where | Changed by |
|---|---|---|
| Product defaults | `config/contracts.json` | A release |
| Instance identity | `/etc/paraclete/instance.json` | The installer, once |
| Admin settings (effort, Claude on or off, automatic updates) | Firestore `config/settings` | A dashboard admin (automatic updates also `install.sh --no-auto-update`) |

## Rules

- If a value appears in two places, it belongs in `contracts.json`, and both places read it from there.
- No secrets, project IDs or other organization-specific values in `contracts.json`.
- Document a key next to it, in a `_comment` field, when its name doesn't say enough.
- A check that protects a storage limit or a safety property goes in `validateContracts()`, not in a
  comment.
- A change here is a product change: it ships in a release like code.
