# dev/

Tools for developing this repo. Nothing here is product, and nothing here is ever installed on an
instance.

| File | Use |
|---|---|
| `instance.env.example` | Copy to `.local/instance.env` and fill in your dev instance |
| `deploy.mjs` | Moves your dev instance's VM to a pushed branch, tag or commit through the release upgrader |
| `status.mjs` | Shows the commit the VM runs, service health, the gateway's models and recent missions |
| `logs.mjs` | Prints a service's journal from the VM, one readable line per log entry |
| `query.mjs` | Reads Firestore. Read-only |
| `trigger.mjs` | Runs a responsibility now, as the dashboard's "run now" does |
| `say.mjs` | Sends the agent a chat message from your account and follows the conversation |
| `dev-env.mjs` | What the commands share: `.local/instance.env`, gcloud and git without a shell, SSH over IAP, Firestore as you |
| `record-gemini-turn.mjs` | Records one live Gemini 4 tool turn as the fixture the gateway's replay test runs. Re-record when the Gemini SDK or model changes |

## The dev loop commands

Run them from the repo root with Node 24, in Git Bash on Windows, or on macOS or Linux. They need
`gcloud` logged in (`gcloud auth login`) as an account that can reach the VM over IAP with sudo and
read and write the dev project's Firestore; the project's owner can. Each reads your instance from
`.local/instance.env` and refuses to run without it. How and when to use them:
[DEVELOPING.md](../DEVELOPING.md) section 7.

| Command | Does |
|---|---|
| `node dev/deploy.mjs <branch\|tag\|commit> [--repo <owner>/<name>] [--timeout <seconds>]` | Resolves the ref to a commit on GitHub (a branch must be pushed), runs `sudo /opt/paraclete/install/upgrade.sh --ref <commit> --repo <owner>/<name>` on the VM with its output streamed, and waits for `agent/instance` to report ready on that commit. `--repo` defaults to this clone's origin, and must be public. The dashboard half arrives in build plan phase 6 |
| `node dev/status.mjs [--json]` | The installed release, each service's unit state and heartbeat age, the gateway's models, `agent/instance` and the five newest missions. Exits 1 when a service is down or hung, or the installed commit and `agent/instance` disagree |
| `node dev/logs.mjs <service\|all> [--lines N] [--follow]` | `journalctl` for `paraclete-<service>.service` (or every unit), 100 lines unless `--lines`; `--follow` until Ctrl+C |
| `node dev/query.mjs <collection> [--where <field><op><value> ...] [--order <field> [desc]] [--limit N]` | Prints matching documents as JSON. `<collection>` may be a subcollection path such as `work/<id>/history`; `--doc <id>` reads one document. `--help` lists the operators and value types |
| `node dev/trigger.mjs <responsibility-id> [--timeout <seconds>]` | Writes the trigger document the control service writes for "run now", then waits for the brain to mark it fired, skipped or error. One still unclaimed when the wait runs out is withdrawn, so it cannot fire later |
| `node dev/say.mjs "<text>" [--thread <id>] [--wait <seconds>]` | Writes a dashboard message from your account (thread `dev-<yyyymmdd>` unless `--thread`), then prints the intake, the mission and the agent's replies as they arrive, for up to 180 seconds |

Every command takes `--help`. Exit codes: 0 done, 1 failed or found a problem, 2 a usage mistake.

**What they change.** `deploy` moves the VM, through the same upgrader a release upgrade runs. `say`
writes one message and `trigger` one trigger document, each exactly as the dashboard would (and
`trigger` deletes its own if the brain never claimed it). Nothing else writes. `query` cannot: its
client only reads.

**On Windows** Node cannot start `gcloud.cmd` without a shell, so the commands start gcloud the way
`gcloud.cmd` does: the SDK's Python running its `lib/gcloud.py`. They find the SDK through `gcloud.cmd`
on `PATH`, or `CLOUDSDK_ROOT_DIR`, and honor `CLOUDSDK_PYTHON`.

Their tests are in `tests/dev/`, against fake programs and the Firestore fake in `tests/fakes/`.
