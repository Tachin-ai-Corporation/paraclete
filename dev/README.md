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
| `release.mjs` | Cuts a release from main's head by pushing its version tag, writes a release's notes for `.github/workflows/release.yml`, and withdraws a bad release |
| `release-check.mjs` | Checks main's head on your dev instance (deploy, status, smoke) and only then cuts it as a release, with the check in the tag's message |
| `dev-env.mjs` | What the commands share: `.local/instance.env`, gcloud and git without a shell, SSH over IAP, Firestore as you (a request Firestore refuses with 401 is sent once more with a new token from gcloud, so a long follow outlives its token) |
| `record-gemini-turn.mjs` | Records one live Gemini 4 tool turn as the fixture the gateway's replay test runs. Re-record when the Gemini SDK or model changes |
| `harness2/cli.mjs` | Offline Loop A evolutionary harness optimizer and Loop B trajectory harvester (`surface`, `validate`, `eval`, `evolve`, `harvest`, `promote`), the merger of its promotion pull requests (`merge`), and the harness lab, two projects with one paraclete each (`lab-plan`, `lab-provision`, `lab-status`, `lab-follow-main`) |
| `loop/` | The self-improvement loop: one cycle has a coding agent change a checkout of main to resolve a `loop` issue, checks and reviews the change, and opens a pull request its merger merges ([loop/README.md](loop/README.md)) |

## The dev loop commands

Run them from the repo root with Node 24, in Git Bash on Windows, or on macOS or Linux. They need
`gcloud` logged in (`gcloud auth login`) as an account that can reach the VM over IAP with sudo, read
and write the dev project's Firestore, and (for `deploy`) submit builds and deploy to Cloud Run as the
dashboard's service account; the project's owner can. Each reads your instance from
`.local/instance.env` and refuses to run without it. How and when to use them:
[DEVELOPING.md](../DEVELOPING.md) section 7. SSH goes in as your local user name, unless the file sets
`SSH_USER` (never `paraclete`, the agent's own user on the VM); the harness lab's driver sets it.

| Command | Does |
|---|---|
| `node dev/deploy.mjs <branch\|tag\|commit> [--repo <owner>/<name>] [--vm-only \| --dashboard-only] [--timeout <seconds>]` | Resolves the ref to a commit on GitHub (a branch must be pushed), runs `sudo /opt/paraclete/install/upgrade.sh --ref <commit> --repo <owner>/<name>` on the VM with its output streamed, and waits for `agent/instance` to report ready on that commit. Then the dashboard, with the same commands `install/install.sh` uses (`install/lib/dashboard.mjs`): Cloud Build builds the commit's image with that commit's own `dashboard/cloudbuild.json` (from `git show`; the working tree's copy, with a warning, when your clone lacks the commit) unless the image exists, and Cloud Run deploys it with the service's environment moved to the commit, unless it already runs it. The automatic-update job, when the instance has it, is moved to the same image and environment the same way. Each streams its output. `--vm-only` and `--dashboard-only` move one half. `--repo` defaults to this clone's origin, and must be public. The dashboard service must exist: `install/install.sh` creates it |
| `node dev/status.mjs [--json] [--vm-only]` | The installed release, each service's unit state and heartbeat age, the gateway's models, `agent/instance`, the five newest missions, and the dashboard's URL and the commit its image was built from. Exits 1 when a service is down or hung, the installed commit and `agent/instance` disagree, or the dashboard is missing or on another commit than the VM. `--vm-only` leaves the dashboard out, for an instance without one: it is neither read nor counted |
| `node dev/logs.mjs <service\|all> [--lines N] [--follow]` | `journalctl` for `paraclete-<service>.service` (or every unit), 100 lines unless `--lines`; `--follow` until Ctrl+C |
| `node dev/query.mjs <collection> [--where <field><op><value> ...] [--order <field> [desc]] [--limit N]` | Prints matching documents as JSON. `<collection>` may be a subcollection path such as `work/<id>/history`; `--doc <id>` reads one document. `--help` lists the operators and value types |
| `node dev/trigger.mjs <responsibility-id> [--timeout <seconds>]` | Writes the trigger document the control service writes for "run now", then waits for the brain to mark it fired, skipped or error. One still unclaimed when the wait runs out is withdrawn, so it cannot fire later |
| `node dev/say.mjs "<text>" [--thread <id>] [--wait <seconds>]` | Writes a dashboard message from your account (thread `dev-<yyyymmdd>` unless `--thread`), then prints the intake, the mission and the agent's replies as they arrive, for up to 180 seconds |
| `node dev/smoke.mjs [--role <id>] [--doc <link>] [--request "<text>" [--expect <regex>]] [--wait <seconds>]` | Reads the role the VM runs (`/etc/paraclete/instance.json`, over IAP SSH; `--role` names one instead), sends a request in that role's area that changes nothing, as `say` sends one, in a thread of its own (`smoke-<role>-<time>`), and follows it for up to 900 seconds. PASS when the mission completes, its result is delivered and the answer matches what a correct one must (`--expect`, with `--request`); FAIL, with the reason, when it fails, asks a question, raises an approval gate or runs out of time. A message the ears marked processed that still has no intake 10 seconds later was dropped (a duplicate, or one too soon after your last), and it says so. The requests: generic, a short research answer; the technical roles, a read-only check in their area (Cloud Run, IAM, BigQuery, a repository, the test tools, a web page); a Workspace role, today's events on its own calendar, or with `--doc` a summary of that Google Doc (its Workspace account must be set up first). The check after a move between roles with `install/install.sh --role` ([install/README.md](../install/README.md)). Exits 0 on PASS, 1 on FAIL |

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
(`gh auth login`), and neither gcloud nor `.local/instance.env`. `release-check.mjs` checks a release
on your dev instance first, so it needs both, as the dev loop commands do. When and why:
[DEVELOPING.md](../DEVELOPING.md) section 10.

| Command | Does |
|---|---|
| `node dev/release.mjs [--dry-run]` | Refuses unless this clone is on `main` with a clean tree, `origin` has `main` at the same commit, the head commit's subject starts with a version (`vYYYY.MM.DD.N.N: ...`), that version is newer than every version tag here and on `origin` and not taken, and every check run GitHub has for the head commit finished with success (`gh api repos/<owner>/<name>/commits/<sha>/check-runs`; it refuses while one is queued or running), except the hourly harness merger's own job (`HARNESS_MERGE_JOB`), which runs on main's head and is not CI. Then it shows the release notes, makes an annotated tag of the version at the head and pushes it to `origin`, which starts the release workflow. `--dry-run` stops before the tag. A run after a failed push pushes the tag it made; a run after a finished one says so and does nothing |
| `node dev/release.mjs notes <tag>` | Prints a release's notes to stdout: the line `Changes in <tag> since <previous tag>`, then one line per commit after the previous version tag up to the tag, oldest first, each the commit's subject as written. The previous version tag is the newest version tag older than `<tag>`, in version order, that was not withdrawn (the releases GitHub lists as prereleases, read with `gh api`, so it needs the GitHub CLI logged in, or `GH_TOKEN`): an instance on the release before a withdrawn one moves straight to `<tag>`, so its notes list the withdrawn one's changes too. It follows main's own line of commits (`git log --first-parent`), and lists a merge commit there as the commits it brought in (those its later parents reach and its first parent and the previous tag do not, merges left out, `--topo-order`), never as the merge itself. A pull request merged without squashing still shows its changes. The release workflow publishes this |
| `node dev/release.mjs check <tag>` | Exits 0 when `<tag>` is a version whose commit is on `origin/main`, 1 otherwise. The release workflow's first step |
| `node dev/release.mjs yank <tag> --reason "<why>"` | Withdraws a published release (`gh release view`, then `gh release edit --prerelease --notes-file`): GitHub lists it as a prerelease, and its notes start with `Withdrawn: <why>` (one line, at most 200 characters), the notes as they were below it. Dashboards leave prereleases out (`agent/release/versions.mjs`), so each stops offering it at its next look at GitHub. One that checks for withdrawn releases starts no new install to it, since every upgrade asks GitHub first; an upgrade to it already running finishes, and a dashboard on an older release may still install it within the hour it keeps GitHub's list. An instance that runs it says so on its System tab and moves on to the next newer release as usual. It reads the tag's own `.github/workflows/release.yml` (`git show`) and warns when it lacks the guard (`WORKFLOW_RERUN_GUARD`) that keeps a rerun from publishing a withdrawn release again: never rerun the release workflow of such a tag. A second run with the same reason changes nothing; another reason replaces the line. It refuses a tag that is not a version (2), and a release that is not published or is a draft (1). The tag stays, so every later version must still be newer |
| `node dev/release-check.mjs [--vm-only] [--no-release] [--wait <seconds>] [--json]` | Checks main's head on your dev instance, then cuts it. Step 1 makes the checks `dev/release.mjs` makes (a head whose version `origin` has tagged already has nothing to release: it says so and exits 0). Step 2 runs `node dev/deploy.mjs <commit>`, step 3 `node dev/status.mjs --json`, which must report no problem and the VM, `agent/instance` and the dashboard on the commit, and step 4 `node dev/smoke.mjs`, which must PASS (its verdict read back with `readSmokeVerdict`). Each runs as a child process with its output streamed. Step 5 makes step 1's checks once more, so a newer release cut or `main` moved meanwhile refuses it (and this commit tagged meanwhile leaves nothing to do), then tags and pushes as `dev/release.mjs` does, with the check's summary in the annotated tag's message: the time, the commit, the status and the smoke test's role and mission, never the project, the VM or a URL. Any failure stops before the tag, exit 1. `--vm-only` is passed to deploy and status, for an instance without a dashboard (the harness lab's canary); `--wait` to smoke; `--no-release` stops before the tag; `--json` prints the summary as one JSON object on stdout and everything else on stderr |

**What it changes.** `release.mjs`: one annotated tag in this clone and on `origin`, and only without
`--dry-run`; `yank` edits one published release on GitHub; `notes` and `check` only read.
`release-check.mjs`: your dev instance, moved to the head by `deploy`, and one smoke message, as
`smoke` sends it; then, without `--no-release`, the tag.

## The self-improvement loop (`dev/loop/`)

`node dev/loop/cycle.mjs [--issue <n> [--retry]] [--dry-run] [--json]` runs one cycle of the loop. It takes the
oldest open GitHub issue labelled `loop` (when none waits, its planner, `dev/loop/planner.mjs`, opens one:
from a training task of the model suite that main's head fails in the latest baseline, or from
`docs/plan/OPEN_ITEMS.md`), has a coding agent (named in `.local/loop.json`, never in the
repo) change a fresh checkout of main to resolve it, and checks the change. A change is refused when it
touches the referee (what judges a change, and the loop itself), changes an existing test, changes
code without adding a test, fails the suite, is found by its reviewer model to miss a point of the
issue's "Done when", or changes the agent's behaviour without a real-model measurement that shows nothing got worse
(and, for an issue planned from a failing task, that the task scores higher).
Otherwise the cycle opens a pull request; a refused change gets a comment on the issue. It stops while
`dev/harness2/PAUSED` exists, and after `maxCyclesPerDay` cycles. No person merges: CI's Loop guard
(`dev/loop/guard.mjs`) checks every loop pull request again, and the loop's merger
(`dev/loop/merger.mjs`, each hour in `.github/workflows/harness-merge.yml`) merges a passing one, at
most 3 a day, or closes one that cannot pass with the reasons. A loop merge that breaks CI on main is
reverted by the next cycle (`dev/loop/sentinel.mjs`), its issue reopened, and a second revert in a day
pauses the loop (the repository variable `PARACLETE_LOOP_PAUSED`). On the lab driver, with `release.enabled` in
its local settings, a cycle also releases main once the loop's merges since the last release ran healthy
on the lab (`dev/loop/releaser.mjs`); with `baseline.enabled`, a cycle measures main's head on the model
suite once a day at most (`dev/loop/baseline.mjs`), so the planner finds the tasks the agent fails.
How it works, its settings and the driver's timer: [loop/README.md](loop/README.md).

## Continual harness improvement (`dev/harness2/`)

`dev/harness2/cli.mjs` runs the offline evolutionary harness optimizer (Loop A) and version-aware
trajectory harvester (Loop B → Loop A):

- `dev/harness2/surface.mjs` and `dev/harness2/validate.mjs`: the mutable surface, immutable spine guards, contract ceiling checks, and the 24,000-character assembled organ prompt budget gate. The surface is seven components, `c1..c7`: contracts tunables (`c1`); base organ prompts (`c2`), except the cerebellum's (`c3`) and temporal-memory's, which `c4` holds with the `memory-consolidate` skill's playbook; role prompt appends (`c5`); skill playbooks (`c6`: each skill's `SKILL.md` and `skill.json`); and role playbooks (`c7`: a role's `README.md`, `processes/*.json` and `responsibilities.json`). `classifySurfacePath` refuses everything else, including a skill's command code (`<cmd>.mjs`, executable on the VM) and a role's `role.json` (its grants: `gcp_roles`, `resource_roles`, `apis`). `validateTouchedPaths`, promotion readiness and the conflict resolver (`resolveHarnessMergeConflict`) all classify with it, so none of them lets a promotion change code or grants. The shell tool's output is tuned only through `c1`'s `tools.output_*` keys; its code (`agent/gateway/tools.mjs`) is on the spine. The `scaffold-skill` command stub and the `scaffold-role` `role.json` are for a person to commit.
- `dev/harness2/judge.mjs`: Frontier Model Committee judge (`vertex-google/gemini-4-argon` and `vertex-anthropic/claude-opus-5-5`, extensible via `registerJudgeAdapter`) scoring blind rollout dossiers across 5 weighted dimensions (`clauseScore`, `craftScore`, `groundingScore`, `rigorScore`, `clarityScore`) with hard-fixture gating and pairwise tie-breaking.
- `dev/harness2/trajectory.mjs` and `dev/harness2/substrate.mjs`: multi-organ trajectory extraction, 3D scoring (`capability`, `reliability`, `efficiency`), Tier-1 hermetic evaluation (`tests/fakes/firestore-server.mjs` and `tests/fakes/gcs-server.mjs`), and Tier-2 canary evaluation.
- `dev/harness2/lenses.mjs`, `dev/harness2/recursion.mjs`, and `dev/harness2/selection.mjs`: Capability-First Credo (`CAPABILITY_CREDO`: capability overrides all other metrics and cannot regress; reliability and efficiency are optimized only after capability), Dual-Lens mutation proposers (`INV` and `DOM`), within-generation recursion with regression revert, Pareto frontier selection, and cross-lens synthesis.
- `dev/harness2/library.mjs`, `dev/harness2/harvest.mjs`, `dev/harness2/promote.mjs`, and `dev/harness2/live-runner.mjs`: candidate lineage archiving, version-filtered trajectory harvesting, isolated git worktree mutations (`--live`), and promotion readiness reports.
- What a `--live` run measures. Without `--gateway-url`, the brain runs against an in-process gateway that scripts every organ's answer and writes each curriculum unit's reference artifacts. The answers are the same for every harness, so the baseline and any candidate score alike. Such a run checks the pipeline and is never evidence: each run is marked `scripted`, and `judgeEvidence` refuses it. With `--gateway-url`, the organs answer through that gateway's models. That gateway reads its own installed organ prompts (`agent/gateway/server.mjs`), so a candidate's prompt changes do not reach the model either. Only the candidate's contract values that the brain reads do.
- What a `--real-model` run measures (`eval`, `judge`, `evolve`, `promote`, `curriculum`): a prompt change. `dev/harness2/model-runs.mjs` makes one checkout per side, a detached git worktree of HEAD with the side's file patches written in (only mutable-surface paths) and the repo's `agent/node_modules` linked in, with the command launchers of the rollout's role (`install/vm/launchers.mjs`; none on Windows, which it reports). Each rollout starts the product's own gateway (`agent/services/gateway/main.mjs` `buildGateway`) from that checkout on a free loopback port, with real Vertex AI clients; the brain reads the same checkout and builds its own utility client, on the wall clock. So the baseline's runs send the baseline's prompts, playbooks and contracts to the model, and a candidate's send the candidate's. The project comes from `GOOGLE_CLOUD_PROJECT`, or the VM's `instance.json`; a token is fetched for each rollout (the metadata server, else `gcloud auth print-access-token`). The tasks are the model suite (`dev/harness2/model-suite.mjs`): ten requests a person could send (fix a failing test, implement from a spec, reproduce then fix a bug, fix a service config, summarize an incident log, summarize and dedupe CSV data, extract action items and contacts, remove a hard-coded key), each seeded into the motor's workspace and checked there afterwards by deterministic checks (tests that must pass, files that must not change, values a correct answer holds). A run's capability is the share of its task's checks that passed (`checkScore`). A role with tasks runs its own; any other role runs the generic tasks as that role. A curriculum unit is measured on its role's model-suite tasks, not its scripted task. Each task is `train` or `holdout`: selection inside a run scores the training tasks only, and a held-out run's results never reach the proposer (`recursion.mjs`), which hears a failed training run's checks as a prescription. Each run is marked `measured`; it is the only kind `judgeEvidence` accepts. Every rollout is isolated: it gets a Firestore of its own (so a mission another rollout left active is never picked up and run in its workspace), and its agent's commands read an instance record of their own (`PARACLETE_INSTANCE`: that Firestore, its data root, the side's checkout), never the instance the harness runs on. All sides of one run are cut from one commit, resolved once. A checkout without its role's command launchers (on Windows) runs a different agent than an instance does, so its runs are not `measured`. Runs are capped (`--max-rollouts`, default 120; `--max-tokens`, default 30,000,000, counted from the brain's token telemetry, input plus output; a model's unreported thinking tokens are not in it). Both caps are checked before each rollout, so a rollout already running can pass the token cap by what it spends. A run whose estimate (every baseline, candidate and calibration rollout) is over its rollout cap is refused before it spends anything, with `spendCapWouldBeReached` and how to make it fit; a run that still reaches a cap stops with `spendCapReached`. A mission gets 20 minutes; past that its gateway is stopped before its workspace is checked, and the run says it timed out (`timedOut`). The checkouts are removed when the run ends, links first. Run it on the lab driver (Linux): its command launchers need POSIX paths, and its missions run model-chosen commands in temporary workspaces.
- `dev/harness2/calibration.mjs`: whether the measurement can be trusted. Before a real-model promotion relies on its evidence, and only when that evidence would pass otherwise, two checks run on the same tasks and trials: the baseline against itself (A/A: the evolution's own baseline runs against the promotion's, so it costs nothing extra) must show no change beyond the noise, and the baseline with a known-bad change (`KNOWN_BAD_CHANGE`, the motor told to do nothing) must lose at least 0.1 capability, beyond the noise. A calibration holds for one baseline commit, role, suite version, task set and trial count for 24 hours, kept in `.local/harness2/calibration/`; `--recalibrate` runs it again. Its verdict is in the evidence, and `judgeEvidence` refuses a measured promotion without a passing one.
- `dev/harness2/health.mjs`: whether the loop as a whole works. Every `evolve`, `promote` and `curriculum` a person or the driver starts, refused or not, appends one record to `.local/harness2/cycles.jsonl` (what ran, each proposal's source and outcome, the evidence's verdict and calibration, the spend, the pull request). `node dev/harness2/cli.mjs health [--days <n>] [--repo <owner/name>] [--open-issues] [--dry-run] [--markdown]` reads that log, the repository's harness pull requests (`gh pr list`) and the promotions on main since the newest version tag, and raises an alarm for each way the loop has been seen to fail quietly: `stalled` (no cycle for 26 hours, or none recorded, unless paused), `unmeasured` (no `--real-model` cycle in the window), `all-fallback` (every proposal fell back to the template), `spend-cap` (cycles stopped at their cap), `calibration-failed`, `zero-variance` (measured runs with no run-to-run variance that spent no tokens), `identical-deltas` (three promotions claiming the same gain, as #3 to #13 once did), `merged-without-evidence` (a harness promotion merged whose evidence block is missing or fails `judgeEvidence`), `release-stalled` (promotions on main older than three days without a release), and `loop-idle` (the self-improvement loop's last 3 cycles, the newest within a day, all found no issue to take and released nothing, with the planner's reasons). It exits 1 when there is an alarm. `--open-issues` keeps one GitHub issue per alarm, labelled `harness-alarm` and titled `Harness alarm: <key>`: it opens one for a new alarm, comments while it lasts, and closes it once it clears (never on a run that could not read its inputs); `--dry-run` only says what it would do. The development role runs it daily (`r-harness-health`, `harness-cycle --action health`).
- `dev/harness2/pause.mjs`: the off switch. While `dev/harness2/PAUSED` exists in the checkout (its first line is the reason), or `PARACLETE_H2_PAUSED` is set to anything but empty or `0`, `evolve`, `promote` and `curriculum` refuse to start and return `paused: true` with the reason (read-only commands still run), and `merge` comments on and merges nothing and exits 0. `merge` also refuses while the file is on `origin/main`, once fetched (`git cat-file -e`). The merge workflow passes the repository variable `PARACLETE_H2_PAUSED`, so setting it in the repository's settings pauses the merger without a commit. Committed to main, the file pauses the lab driver within one follow-main interval. A promotion cannot add or remove it: `dev/` is off the mutable surface.
- `dev/harness2/proposer.mjs`: the model proposer behind `--vertex`. Each step's request holds the lens (its focus, components and rules, and the contract keys it may tune with their bounds), the judge's prescriptions, the generation's earlier attempts, and the current text of the files the lens may change: the curriculum unit's target file, then for INV `config/contracts.json` and the base organ prompts, for DOM the role's organ prompts, up to 120,000 characters. The request goes to the contracts' strong-tier Gemini model (`vertex.models.strong`) through the brain's utility client (`agent/providers/vertex-text.mjs` `transform`). The project comes from `GOOGLE_CLOUD_PROJECT`, or the VM's `instance.json`; the token comes from the metadata server, or `gcloud auth print-access-token`. The model answers with a hypothesis and `edits` (text that occurs once in a shown file, and its replacement) or `patches` (a new file's full text). The answer is written all or nothing. It is refused when a path is off the mutable surface, a `find` text is missing or repeated, or a JSON file would be left invalid.
- When there is no project, the call fails, or the answer is refused or changes nothing, `proposeVertexMutation` (`live-runner.mjs`) applies the template edits instead and records why in the candidate's `proposal.fallbackReason`. `recursion.mjs` neither validates nor evaluates such a candidate, nor a `template` or no-change one, since the evidence gate would refuse it; the step is recorded as `not_evaluated: <reason>`. The output of `evolve`, `curriculum` and `promote --live` lists every step under `attempts`: its proposal, whether it was evaluated, and its outcome. Each step not evaluated is also printed to stderr as `[WARN]`. A cross-lens merge (`SYN`) carries its lenses' source when they agree; when they differ, a refused source wins.
- `dev/harness2/evidence.mjs`: the measured evidence a promotion carries. `--trials <n>` runs every task n times (default 1, or 3 with `--push-pr`), each run tagged with its task and trial. `buildPromotionEvidence` compares the winner's runs with the baseline's per task, and `judgeEvidence` passes only when all of these hold: a model proposed the change (`proposal.source`: never `template`/`fallback`, the fixed edits of `applyDefaultCandidateMutation`); no run was the synthetic dry run, or `scripted` by the in-process gateway; every run was `measured` (a `--real-model` run of its own side); the measurement passed its calibration; every task ran at least 3 times on both sides; the capability gain is at least 0.01 and above 2 standard errors of the difference; no task fell by more than 0.05; and the held-out tasks' mean fell by no more than 0.01. `pushAndCreatePullRequest` opens nothing without a passing verdict. It also refuses when the lines a candidate adds to product prompts (`prompts/`, `roles/*/prompts/` except `paraclete-h2`) use harness vocabulary, or paste one block into several prompts (`validate.mjs` `promptAdditionProblems`). The PR body carries a per-task table and a ```` ```json paraclete-h2-evidence ```` block that `parseEvidenceBlock` reads back, so a merger can check the evidence instead of trusting the title.
- `dev/harness2/evidence-check.mjs` and `.github/workflows/promotion-evidence.yml`: CI's check on every harness promotion pull request (a `harness2/` or `h2/` branch of this repository). It passes only when the description's evidence block passes `judgeEvidence`, judged afresh (a stored `verdict` counts for nothing), and names every file the pull request changes. It runs again on every push to the branch and every edit of the description, with the base branch's code, so a promotion rewritten after it was measured, or whose description loses its evidence, fails CI, and whatever merges on CI alone cannot merge it. Any other pull request passes at once. `node dev/harness2/evidence-check.mjs --pr <n> [--repo <owner/name>] [--json]` runs it by hand.
- Promotion pull requests (`--push-pr`): `promote.mjs` fetches main and the tags first. It then starts the commit subject and the pull request title with the next version (`vYYYY.MM.DD.N.1`, by UTC date), newer than every version on main or tagged. They are merged with **Squash and merge**, by the merger below, so that version becomes main's head and `dev/release.mjs` can release it ([DEVELOPING.md](../DEVELOPING.md) section 10). Each PR body says so too. A version is chosen when the PR is opened or updated. If main gains that version or a newer one before the merge, the merger moves the title on to the next version first; a head whose version is already tagged cannot be released. Once the promotion is committed, the checkout goes back to the branch it was on, so the next cycle's baseline is that branch (on the lab driver, main), not the promotion, and the follow-main timer can still move it.
- `roles/paraclete-h2`: the self-hosting harness engineer role (`harness-cycle`, `harness-eval`, `harness-promote`) that equips a single Paraclete agent to run Loop A and Loop B end to end. It is a development role (`listed: false`): the installer installs it only when `--role paraclete-h2` names it, and its commands load `dev/harness2/` from a checkout of this repo.
- `dev/harness2/merge.mjs` (`node dev/harness2/cli.mjs merge (--pr <n> | --all) [--dry-run] [--json]`): the merge step. `.github/workflows/harness-merge.yml` runs it as `node dev/harness2/merge.mjs --all --json` (its own command line, the same run: the job installs no packages, which the rest of `cli.mjs` needs) from main at 20 minutes past every hour, and from the Actions tab on demand, with the workflow's own token. It considers only open pull requests against `main` from this repository's `harness2/` and `h2/` branches, in number order, and never touches another. It merges at most one per run: the next run checks the rest against the main that merge made, so every merge is judged against the main it lands on, and once a merge has been tried (even one GitHub reports as failed) the rest are not read. It merges none while CI on main's head failed or is still running; when main's head has no CI at all, it dispatches `ci.yml` there and merges nothing until it passes. It squash-merges a promotion only when all of these hold: every CI check run on its head commit finished with success (`dev/release.mjs` `checkRuns` and `ciVerdict`); its head contains main's head (`gh api repos/<owner>/<name>/compare/<main>...<head>`, `behind_by` 0: main has no branch protection, so GitHub's `mergeStateStatus` CLEAN, also required, does not mean current); its body's evidence block parses and `judgeEvidence` passes on it, judged afresh (the verdict written into the block counts for nothing), and the block's `touchedPaths` name every file it changes; every file it changes passes `validateTouchedPaths`, a rename's old path included; it removes and renames no file; GitHub shows a patch for every file it adds or edits, and the lines those patches add pass `promptAdditionProblems`; and a change to `config/contracts.json` passes `validateContractsMutation` against the file at the merge base (only tunable keys, within their ceilings: `brain.transition_guard`, say, is refused). Its title must start with a version newer than every version on main and every version tag; otherwise the title gets the next one first (`nextPromotionVersion`), the rest of it kept. The squashed commit's subject is the title and its body keeps the evidence's capability line. The merge is pinned to the head commit that was checked (`--match-head-commit` with the full sha). After a merge it runs `gh workflow run ci.yml --ref main`: a merge made with a workflow's token starts no push run, and `dev/release.mjs` releases a head only once CI passed on it. A promotion that breaks a rule gets one comment with the reasons and a hidden marker of them (`<!-- paraclete-h2-merge: <reasons> -->`), and no other while a comment of the merger's own (`github-actions`, `github-actions[bot]`, or `GITHUB_ACTOR` when set) carries that marker, so no one else can silence it by posting the marker; one that is only waiting (CI still running, GitHub still working out whether it can merge, a draft, main's CI, an earlier merge this run) gets none. The workflow's job is named `HARNESS_MERGE_JOB` (`dev/release.mjs`): its own check run on main's head is not CI, so neither this merger nor a release waits on it. `--dry-run` fetches main and the tags and reads GitHub, judges as a real run would, and changes nothing there. A run fails (exit 1) only when git or gh did; a refusal is a normal outcome.
- The merger replaces the scheduled job outside this repo that squash-merged promotions once CI passed without reading their evidence. Once the workflow runs, the developer retires that job, so that only one merger acts on a promotion.

Their tests are in `tests/dev/` (`tests/dev/harness2/` for `merge.mjs` and `pause.mjs`), against fake programs and the Firestore fake in `tests/fakes/`.

### The harness lab: two projects, one paraclete each

`lab-provision` creates two VMs, each in a GCP project of its own: `paraclete-h2-driver`, role
`paraclete-h2`, in the lab's project (`paraclete-h2-lab` unless `--project`), which runs the harness
from its checkout at `/var/lib/paraclete/harness2-repo` (owned by the `paraclete` user); and
`paraclete-h2-canary`, role `software-engineer`, in the canary's project (`<lab project>-canary` unless
`--canary-project`, which a lab project id longer than 23 characters needs, since a project id has at
most 30). Each boots install.sh's startup stub, so a full paraclete install runs at the commit in its
`paraclete-ref` metadata. There is no dashboard, so the upgrade path a product instance takes never
reaches them. A timer keeps them on main's head instead (below).

**Why two projects.** Each VM is a whole paraclete, and one project holds one paraclete
([PRODUCT.md](../docs/canon/PRODUCT.md), P-1): in one project, both brains would read the same `intake`
and `work` collections and share one bucket. So `lab-provision` gives each project what its VM needs,
the same steps in both, each checked first so a second run changes nothing: the project and its billing
(`--org` and `--billing` apply to both), the APIs, the `paraclete-agent` service account and its roles,
Firestore, the `<project>-paraclete` bucket, the network and the IAP SSH firewall. Every command that
addresses the canary uses its project: `lab-status`, `lab-follow-main`, `canary` (whose defaults are
`paraclete-h2-canary` in the canary's project) and the commands `lab-plan` prints. Each takes
`--canary-project`.

**The canary runs main's head.** Its follow-main timer (below) moves it back there within one
interval, so it is where main's head is checked, as a release is checked on a dev instance before it
goes out, and never where a branch is tested: test a branch on a dev instance of your own. The driver
checks the canary with the dev/ commands you run against a dev instance, from its checkout: `status`,
`smoke`, `say`, `query`, `logs` and `trigger`, and `node dev/deploy.mjs <main's head> --vm-only`, which
the timer agrees with. `dev/harness2/lab-canary.mjs` holds what follows. `lab-provision` gives the
driver's agent account, on the canary's project only:

| Grant | For |
|---|---|
| `roles/iap.tunnelResourceAccessor` | `gcloud compute ssh --tunnel-through-iap` (deploy, status, smoke, logs) |
| `roles/datastore.user` | Firestore reads (all of them) and writes (say, smoke, trigger) |
| `roles/run.viewer` | status's dashboard check, which then says there is no dashboard instead of being refused |
| the custom role `paracleteLabDriverSsh`: `compute.instances.get`, `compute.instances.getGuestAttributes`, `compute.instances.setMetadata`, `compute.projects.get`, `compute.zoneOperations.get` | gcloud putting the driver's SSH key in the canary VM's metadata (the lab does not use OS Login). The predefined roles that may do that can also create and delete VMs |
| `roles/iam.serviceAccountUser` on the canary's `paraclete-agent` account only | setting metadata on a VM that runs as that account |

SSH with sudo on the canary is root there, so the driver can do whatever the canary's agent account
can, in the canary's project. That is what a developer has on a dev instance, and it stops at the
canary's project. Then, over the same IAP SSH step as the follow-main timer, `lab-provision` writes the
canary's coordinates to `/var/lib/paraclete/harness2-repo/.local/instance.env` in the
[dev/instance.env.example](instance.env.example) format, as the `paraclete` user, so it is theirs:
`PROJECT_ID` the canary's project, `VM=paraclete-h2-canary`, no `DASHBOARD_URL`, and
`SSH_USER=lab-driver`, because gcloud would otherwise log in as the driver's local user, `paraclete`,
which on the canary is its agent's own user. The file is replaced only when it differs. `.local/` is
gitignored, so the file never counts as a change to the checkout and never stops the timer's
fast-forward. Until the checkout exists, nothing is written and the result is not ok, with the
`lab-provision` command to run again once it does. `status` on the canary always reports that there is
no dashboard, and `deploy` needs `--vm-only`. `node dev/harness2/cli.mjs canary` reaches no VM yet: on
its own it fails and says that nothing ran, rather than report a smoke check it never made.

**Where and what.** `--zone` alone puts the lab in the region that zone is in, `--region` alone in that
region's `-a` zone, and neither in `us-central1-a`; a zone outside `--region` is refused, since the
canary's `instance.env` would name both. Every command the lab prints names both projects, the region
and the zone. Before it changes anything, `lab-provision` reads both projects and stops, saying why,
when one cannot be billed (it does not exist yet, or has no billing account, and no `--billing` was
given), or already holds a paraclete other than its own lab VM, since one project holds one paraclete:
name another one with `--project` or `--canary-project`.

**Moving an existing lab to two projects.** Run `lab-provision` again with the lab's own flags, and with
`--billing` (and `--org`, if the lab is in an organization) given again: the canary's project is new, and
without them it stops before it changes anything. A canary from before stays where it was:
`lab-provision` never deletes a `paraclete-h2-canary` it finds in the lab's own project. Its result
names it (`oldCanary`) with the command that deletes it, and `lab-status` lists it as a problem, until it
is gone. Retire it once the canary in its own project is up (`lab-status` shows it running and on main's
head): `gcloud compute instances delete paraclete-h2-canary --project=<lab project> --zone=<its zone>`, as
`lab-status` prints it. What it wrote to the lab's Firestore and bucket stays there.

### The harness lab follows main (lab only)

**This is for the lab only.** A product instance updates through releases, from its dashboard, and never
follows main. Nothing of this is in `install/manifest.txt`, and no install has it.

`paraclete-lab-follow-main.timer` runs `dev/harness2/lab-follow-main.sh` (installed as
`/usr/local/sbin/paraclete-lab-follow-main`) as root on both VMs, every 30 minutes unless `--interval`.
Each run:

1. reads the repository from `/opt/paraclete/release.json`, and main's head from
   `git ls-remote https://github.com/<repo> refs/heads/main`;
2. skips while the brain reports a mission running (`runner.active_mission` in
   `/var/lib/paraclete/services/brain/health.json`), and records the first skip in
   `/var/lib/paraclete/lab-follow-main.busy-since`. Once that skip is 24 hours old, it goes ahead anyway;
3. when release.json's commit is not main's head, runs `/opt/paraclete/install/upgrade.sh --ref <head>`,
   the bootstrap and validation gate a release upgrade uses, unless a bootstrap is running. Its output
   goes to `/var/log/paraclete-lab-follow-main-upgrade.log`. The installed commit survives a reboot;
4. on the driver, fast-forwards the harness checkout to `origin/main` as the `paraclete` user, and only
   when it is on main with no changes (untracked files count), no harness process runs (`pgrep -f` for
   `dev/harness2` and the role's `harness-cycle`, `harness-eval` and `harness-promote`), and the move is a
   fast-forward. It never resets, stashes or merges, so a dirty or diverged checkout stays as it is. This
   replaces syncing the checkout by hand;
5. logs one line, which `sudo journalctl -t paraclete-lab-follow-main` shows: the repository, the installed
   commit, main's head, the agent, and what happened to the install and to the checkout.

It never prints a remote URL or git's output, because the checkout's remote may hold a token, and it
stores no credential. A run is safe twice over: a second one finds everything current, or the lock held.
`sudo systemctl start paraclete-lab-follow-main.service` runs one now.

| Command | Does |
|---|---|
| `node dev/harness2/cli.mjs lab-follow-main --install [--interval <minutes>] [--project <id>] [--canary-project <id>] [--zone <zone>]` | Over IAP SSH (`dev-env.mjs` `sshArgs`, with sudo), on both VMs, each in its own project: writes the updater and the two units, and enables and starts the timer. A file whose content is already right is not written again, and systemd reloads only when one changed, so a second install changes nothing. `--interval` is whole minutes from 5 to 1440, default 30; a new interval takes effect at once. The units are in `/usr/local/lib/systemd/system`, because `install/bootstrap.sh` stops and removes any `paraclete-*.service` in `/etc/systemd/system` that a release does not ship |
| `node dev/harness2/cli.mjs lab-follow-main --uninstall [--project <id>] [--canary-project <id>] [--zone <zone>]` | Stops and disables the timer and removes the updater, the units, the busy-since file and the upgrade log. A run in progress, which may be an upgrade, is never stopped: it finishes on its own, and the result says so. Safe twice |
| `node dev/harness2/cli.mjs lab-follow-main [--status] [--project <id>] [--canary-project <id>] [--zone <zone>]` | For each VM: the timer's state, its last run and that run's line, the installed commit, main's head and whether they match, the agent's mission and busy-since, and on the driver the checkout's commit. Changes nothing |

`lab-provision` (`--interval` too) runs the same install step on both VMs after it creates or updates
them, and tries a new VM's SSH for about two minutes. A VM it cannot reach makes its result not ok,
with the `lab-follow-main --install` command to run later. `lab-status` lists the VMs of both projects,
each with its `project`, and adds each running lab VM's timer state (`followMain`). The timer goes on over SSH, not through the startup script, because the startup script
runs only at boot and cannot reach a running VM, the lab's startup script stays install.sh's own so the
lab boots the way an instance does, and an `--uninstall` must stick across a reboot.

To pin the lab to a branch, take the timer off first (`--uninstall`). Otherwise it moves the lab back to
main within one interval.
