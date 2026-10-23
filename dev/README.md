# dev/

Tools for developing this repo. Nothing here is product, and nothing here is ever installed on an
instance.

| File | Use |
|---|---|
| `instance.env.example` | Copy to `.local/instance.env` and fill in your dev instance |
| `deploy.mjs` | Moves your dev instance to a pushed branch, tag or commit: the VM through the release upgrader, the dashboard through Cloud Build and Cloud Run |
| `status.mjs` | Shows the commit the VM runs, service health, the gateway's models, recent missions, and the dashboard's URL and commit |
| `logs.mjs` | Prints a service's journal from the VM, one readable line per log entry |
| `query.mjs` | Reads Firestore. Read-only |
| `trigger.mjs` | Runs a responsibility now, as the dashboard's "run now" does |
| `say.mjs` | Sends the agent a chat message from your account and follows the conversation |
| `smoke.mjs` | Runs the instance's role through one request in its area that changes nothing, and says PASS or FAIL |
| `release.mjs` | Cuts a release from main's head by pushing its version tag, and writes a release's notes for `.github/workflows/release.yml` |
| `dev-env.mjs` | What the commands share: `.local/instance.env`, gcloud and git without a shell, SSH over IAP, Firestore as you |
| `record-gemini-turn.mjs` | Records one live Gemini 4 tool turn as the fixture the gateway's replay test runs. Re-record when the Gemini SDK or model changes |
| `harness2/cli.mjs` | Offline Loop A evolutionary harness optimizer and Loop B trajectory harvester (`surface`, `validate`, `eval`, `evolve`, `harvest`, `promote`) |

## The dev loop commands

Run them from the repo root with Node 24, in Git Bash on Windows, or on macOS or Linux. They need
`gcloud` logged in (`gcloud auth login`) as an account that can reach the VM over IAP with sudo, read
and write the dev project's Firestore, and (for `deploy`) submit builds and deploy to Cloud Run as the
dashboard's service account; the project's owner can. Each reads your instance from
`.local/instance.env` and refuses to run without it. How and when to use them:
[DEVELOPING.md](../DEVELOPING.md) section 7.

| Command | Does |
|---|---|
| `node dev/deploy.mjs <branch\|tag\|commit> [--repo <owner>/<name>] [--vm-only \| --dashboard-only] [--timeout <seconds>]` | Resolves the ref to a commit on GitHub (a branch must be pushed), runs `sudo /opt/paraclete/install/upgrade.sh --ref <commit> --repo <owner>/<name>` on the VM with its output streamed, and waits for `agent/instance` to report ready on that commit. Then the dashboard, with the same commands `install/install.sh` uses (`install/lib/dashboard.mjs`): Cloud Build builds the commit's image with that commit's own `dashboard/cloudbuild.json` (from `git show`; the working tree's copy, with a warning, when your clone lacks the commit) unless the image exists, and Cloud Run deploys it with the service's environment moved to the commit, unless it already runs it. Both stream their output. `--vm-only` and `--dashboard-only` move one half. `--repo` defaults to this clone's origin, and must be public. The dashboard service must exist: `install/install.sh` creates it |
| `node dev/status.mjs [--json]` | The installed release, each service's unit state and heartbeat age, the gateway's models, `agent/instance`, the five newest missions, and the dashboard's URL and the commit its image was built from. Exits 1 when a service is down or hung, the installed commit and `agent/instance` disagree, or the dashboard is missing or on another commit than the VM |
| `node dev/logs.mjs <service\|all> [--lines N] [--follow]` | `journalctl` for `paraclete-<service>.service` (or every unit), 100 lines unless `--lines`; `--follow` until Ctrl+C |
| `node dev/query.mjs <collection> [--where <field><op><value> ...] [--order <field> [desc]] [--limit N]` | Prints matching documents as JSON. `<collection>` may be a subcollection path such as `work/<id>/history`; `--doc <id>` reads one document. `--help` lists the operators and value types |
| `node dev/trigger.mjs <responsibility-id> [--timeout <seconds>]` | Writes the trigger document the control service writes for "run now", then waits for the brain to mark it fired, skipped or error. One still unclaimed when the wait runs out is withdrawn, so it cannot fire later |
| `node dev/say.mjs "<text>" [--thread <id>] [--wait <seconds>]` | Writes a dashboard message from your account (thread `dev-<yyyymmdd>` unless `--thread`), then prints the intake, the mission and the agent's replies as they arrive, for up to 180 seconds |
| `node dev/smoke.mjs [--role <id>] [--doc <link>] [--request "<text>" [--expect <regex>]] [--wait <seconds>]` | Reads the role the VM runs (`/etc/paraclete/instance.json`, over IAP SSH; `--role` names one instead), sends a request in that role's area that changes nothing, as `say` sends one, in a thread of its own (`smoke-<role>-<time>`), and follows it for up to 900 seconds. PASS when the mission completes, its result is delivered and the answer matches what a correct one must (`--expect`, with `--request`); FAIL, with the reason, when it fails, asks a question, raises an approval gate or runs out of time. The requests: generic, a short research answer; the technical roles, a read-only check in their area (Cloud Run, IAM, BigQuery, a repository, the test tools, a web page); a Workspace role, today's events on its own calendar, or with `--doc` a summary of that Google Doc (its Workspace account must be set up first). The check after a move between roles with `install/install.sh --role` ([install/README.md](../install/README.md)). Exits 0 on PASS, 1 on FAIL |

Every command takes `--help`. Exit codes: 0 done, 1 failed or found a problem, 2 a usage mistake.

**What they change.** `deploy` moves the VM, through the same upgrader a release upgrade runs, and the
dashboard: a build pushes one image to its repository and a deploy makes a new Cloud Run revision. `say`
writes one message and `trigger` one trigger document, each exactly as the dashboard would (and
`trigger` deletes its own if the brain never claimed it). Nothing else writes. `query` cannot: its
client only reads.

**On Windows** Node cannot start `gcloud.cmd` without a shell, so the commands start gcloud the way
`gcloud.cmd` does: the SDK's Python running its `lib/gcloud.py`. They find the SDK through `gcloud.cmd`
on `PATH`, or `CLOUDSDK_ROOT_DIR`, and honor `CLOUDSDK_PYTHON`.

## Cutting a release

`release.mjs` is for maintainers and touches no instance: it needs `git` and the GitHub CLI, logged in
(`gh auth login`), and neither gcloud nor `.local/instance.env`. When and why:
[DEVELOPING.md](../DEVELOPING.md) section 10.

| Command | Does |
|---|---|
| `node dev/release.mjs [--dry-run]` | Refuses unless this clone is on `main` with a clean tree, `origin` has `main` at the same commit, the head commit's subject starts with a version (`vYYYY.MM.DD.N.N: ...`), that version is newer than every version tag here and on `origin` and not taken, and every check run GitHub has for the head commit finished with success (`gh api repos/<owner>/<name>/commits/<sha>/check-runs`; it refuses while one is queued or running). Then it shows the release notes, makes an annotated tag of the version at the head and pushes it to `origin`, which starts the release workflow. `--dry-run` stops before the tag. A run after a failed push pushes the tag it made; a run after a finished one says so and does nothing |
| `node dev/release.mjs notes <tag>` | Prints a release's notes to stdout: the line `Changes in <tag> since <previous tag>`, then one line per commit after the previous version tag up to the tag, oldest first, each the commit's subject as written. The previous version tag is the newest version tag older than `<tag>`, in version order. It follows main's own line of commits (`git log --first-parent`), and lists a merge commit there as the commits it brought in (those its later parents reach and its first parent and the previous tag do not, merges left out, `--topo-order`), never as the merge itself. A pull request merged without squashing still shows its changes. The release workflow publishes this |
| `node dev/release.mjs check <tag>` | Exits 0 when `<tag>` is a version whose commit is on `origin/main`, 1 otherwise. The release workflow's first step |

**What it changes.** One annotated tag in this clone and on `origin`, and only without `--dry-run`.
`notes` and `check` only read.

## Continual harness improvement (`dev/harness2/`)

`dev/harness2/cli.mjs` runs the offline evolutionary harness optimizer (Loop A) and version-aware
trajectory harvester (Loop B → Loop A):

- `dev/harness2/surface.mjs` and `dev/harness2/validate.mjs`: the 8-component mutable surface (`c1..c8`), immutable spine guards, contract ceiling checks, and the 24,000-character assembled organ prompt budget gate.
- `dev/harness2/judge.mjs`: Frontier Model Committee judge (`vertex-google/gemini-4-argon` and `vertex-anthropic/claude-opus-5-5`, extensible via `registerJudgeAdapter`) scoring blind rollout dossiers across 5 weighted dimensions (`clauseScore`, `craftScore`, `groundingScore`, `rigorScore`, `clarityScore`) with hard-fixture gating and pairwise tie-breaking.
- `dev/harness2/trajectory.mjs` and `dev/harness2/substrate.mjs`: multi-organ trajectory extraction, 3D scoring (`capability`, `reliability`, `efficiency`), Tier-1 hermetic evaluation (`tests/fakes/firestore-server.mjs` and `tests/fakes/gcs-server.mjs`), and Tier-2 canary evaluation.
- `dev/harness2/lenses.mjs`, `dev/harness2/recursion.mjs`, and `dev/harness2/selection.mjs`: Capability-First Credo (`CAPABILITY_CREDO`: capability overrides all other metrics and cannot regress; reliability and efficiency are optimized only after capability), Dual-Lens mutation proposers (`INV` and `DOM`), within-generation recursion with regression revert, Pareto frontier selection, and cross-lens synthesis.
- `dev/harness2/library.mjs`, `dev/harness2/harvest.mjs`, `dev/harness2/promote.mjs`, and `dev/harness2/live-runner.mjs`: candidate lineage archiving, version-filtered trajectory harvesting, isolated git worktree mutations (`--live`), and promotion readiness reports.
- `dev/harness2/evidence.mjs`: the measured evidence a promotion carries. `--trials <n>` runs every task n times (default 1, or 3 with `--push-pr`), each run tagged with its task and trial. `buildPromotionEvidence` compares the winner's runs with the baseline's per task, and `judgeEvidence` passes only when all of these hold: a model proposed the change (`proposal.source`: never `template`/`fallback`, the fixed edits of `applyDefaultCandidateMutation`); no run was the synthetic dry run; every task ran at least 3 times on both sides; the capability gain is at least 0.01 and above 2 standard errors of the difference; and no task fell by more than 0.05. `pushAndCreatePullRequest` opens nothing without a passing verdict. It also refuses when the lines a candidate adds to product prompts (`prompts/`, `roles/*/prompts/` except `paraclete-h2`) use harness vocabulary, or paste one block into several prompts (`validate.mjs` `promptAdditionProblems`). The PR body carries a per-task table and a ```` ```json paraclete-h2-evidence ```` block that `parseEvidenceBlock` reads back, so a merger can check the evidence instead of trusting the title.
- Promotion pull requests (`--push-pr`): `promote.mjs` fetches main and the tags first. It then starts the commit subject and the pull request title with the next version (`vYYYY.MM.DD.N.1`, by UTC date), newer than every version on main or tagged. Merge them with **Squash and merge** so that version becomes main's head and `dev/release.mjs` can release it ([DEVELOPING.md](../DEVELOPING.md) section 10). Each PR body says so too. A version is chosen when the PR is opened or updated. If main gains that version or a newer one before the merge, promote again so the PR's title moves on; a head whose version is already tagged cannot be released.
- `roles/paraclete-h2`: the self-hosting harness engineer role (`harness-cycle`, `harness-eval`, `harness-promote`) that equips a single Paraclete agent to run Loop A and Loop B end to end.

Their tests are in `tests/dev/`, against fake programs and the Firestore fake in `tests/fakes/`.
