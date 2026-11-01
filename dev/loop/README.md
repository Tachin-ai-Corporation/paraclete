# dev/loop/

The self-improvement loop: plain code that, one cycle at a time, has a coding agent change this
repository to resolve an issue, checks the change, and opens a pull request. Nothing here is product,
and nothing here is installed on an instance.

**No person in the loop.** A cycle opens a pull request only for a change its reviewer found resolves
the issue; CI's Loop guard checks it again; the loop's merger merges it once CI passed, or closes it
with the reasons, which the next attempt reads. The loop never edits its own rules (the referee) and
never changes an instance; it reaches instances only through a release (see "Releases").

| File | What it does |
|---|---|
| `cycle.mjs` | One cycle, and its command line: picks an issue, has the proposer change a checkout of main, checks the change, opens the pull request, records the cycle |
| `proposer.mjs` | The proposer interface, the brief it is given, and the command proposer that runs a headless coding-agent command named in your local settings |
| `reviewer.mjs` | Whether a change resolves its issue: the points to judge (the issue's "Done when"), the reviewer's brief, its verdict parsed and decided by code, and the command reviewer; from the command line, reviews a pull request against an issue |
| `command.mjs` | Runs a headless coding-agent command named in your local settings, in a checkout, within a time budget, for the proposer and the reviewer |
| `planner.mjs` | Where the work comes from when no person writes an issue: a training task main's head fails in the latest baseline, written up by code, or else one item of `docs/plan/OPEN_ITEMS.md`, chosen and written by a planner model and checked by code; either becomes a `loop` issue with testable "Done when" points |
| `baseline.mjs` | How the agent does on the model suite at main's head: a real-model run's summary per task, when the next is due, which training tasks fail a check, the target an issue planned from one names, and whether a measurement shows that target improved |
| `sentinel.mjs` | What undoes a loop merge that broke main: at a cycle's start, when CI failed on main's head and that head is a loop merge, opens its revert pull request, reopens its issue, and pauses the loop's cycles at the day's second revert; and the check a revert pull request must pass |
| `releaser.mjs` | Cuts a release of main at a cycle's start once the loop's merges since the last release ran healthy on the lab, so instances install them; off unless your local settings turn it on |
| `guard.mjs` | The check every loop pull request must pass before it merges, run by CI (`.github/workflows/loop-guard.yml`) and by the merger: the issue, the referee and test rules, the review re-judged and bound to the files it changes, and the evidence of a behaviour change, measured against a main that still stands |
| `merger.mjs` | Merges at most one passing loop pull request per run, within a daily cap, and closes those that cannot pass; run each hour by `.github/workflows/harness-merge.yml` |
| `config.mjs` | The loop's budget and caps, the paths a proposal may not touch (the referee), the paths that change the agent's behaviour |
| `modules.mjs`, `modules.json` | The modules the repo is split into, each a set of files one lane owns (`docs/plan/MODULAR_LOOPS.md`): which module owns a path, which model-suite tasks a change reaches, and whether a change for an issue that names its module keeps to that module's files |
| `test-report.mjs` | Reads which tests failed from the suite's output, with each one's error (for a test file that could not load, the error it printed), for the refusal comment and the cycle record |
| `timer.mjs` | Prints the systemd units that run a cycle on a schedule on the lab driver, and how to install them. Nothing installs them for you |

## One cycle

`node dev/loop/cycle.mjs [--lane <module>] [--issue <n> [--retry]] [--repo <owner/name>] [--dry-run] [--json]`

1. **Stops** while the harness is paused (`dev/harness2/PAUSED`, or `PARACLETE_H2_PAUSED`), or while the
   loop is (the repository variable `PARACLETE_LOOP_PAUSED`, set to anything but `0`; read through
   GitHub's REST API, so any gh works, and counted as set when it cannot be read). Set it to hold the
   next cycle, for example while a person merges changes to what the agent loads between two
   measurements; a cycle already running finishes. When CI failed on main's head, it changes
   nothing on it: a loop merge there is reverted first (see "When a loop merge breaks main"). On a
   healthy main it releases main when that is due (see "Releases"). Then it settles the loop's open
   pull requests (reverts among them): it brings each up to date with `main` and waits for the merger
   to merge or close it, looking every `merge.pollMinutes` (5) for at most `merge.waitMinutes` (150),
   and stops (`waiting`) when one is still open then. One loop change is in flight at a time: a change
   measured while an earlier one waits would be measured against a `main` that merge moves, and the
   guard would refuse it (see "Merging"). Then it stops once today's attempts
   (`maxCyclesPerDay`, 4, counted from the cycle log) are spent: the cap holds back new attempts, which
   spend model time, never a revert or a release, which keep limits of their own.
2. **Picks** the oldest open issue labelled `loop`. It skips an issue that already has an open pull
   request from a `loop/<issue>-` branch, and one it tried and failed within `retryAfterHours` (24).
   `--issue` names one; `--retry` tries it even within that wait. It reads the comments by the
   repository's maintainers (its owner, members and collaborators, never anyone else) on the issue,
   which include its own refusals of earlier attempts, and on its closed `loop/<issue>-` pull requests,
   which say why a reviewer closed one. An issue refused `maxAttempts` (6) times is given up: its `loop`
   label becomes `loop-stuck`, with a comment, and the loop no longer takes it. When no issue waits,
   the planner opens one (see "The planner") and this cycle takes it; when it plans none, the cycle
   finds no work, and its record says why the planner did not.
3. **Checks out** `origin/main` on the branch `loop/<issue>-<slug>`, in a temporary worktree, with the
   repo's installed packages linked in.
4. **Runs the proposer**, within its budget (`proposer.wallMinutes`, `maxTurns`, `maxTokens`). The
   proposer only edits files. Its brief carries the issue and the newest of those comments, as data,
   so an attempt learns what earlier ones changed and which tests they failed. When the suite fails
   (step 5), the proposer runs again on the same checkout with the failing tests, their errors and
   where they are, up to `repairRounds` (2) times, before the change is refused: the cycle runs the
   tests whether or not the proposer did.
5. **Checks the change.** It refuses the whole change when:
   - it touches the referee: `dev/loop/`; `dev/harness2/` (its runner seeds the tasks and marks runs
     measured, its lab scripts move the lab); `dev/release*.mjs` and the release check's helpers
     (`dev/smoke.mjs`, `dev/status.mjs`, `dev/deploy.mjs`, `dev/dev-env.mjs`); `.github/`; `install/`; `migrations/`;
     `roles/*/role.json`; `config/contracts.mjs`; `docs/canon/`; `DEVELOPING.md`; the package
     manifests;
   - it changes or removes an existing test (adding tests is welcome);
   - it adds or changes code (a `.mjs`, `.js`, `.jsx`, `.ts`, `.sh` or `.py` file outside `tests/`) and
     adds no new `.test.mjs` file under `tests/` (`untested`): the suite cannot fail on code nothing
     tests, so passing it is not enough. Removing code needs no test. It is checked before the suite runs;
   - the suite (`npm test`) fails.

   A change that passes is committed and reviewed. A reviewer model (`reviewer.mjs`, the command named
   by `reviewer` in your local settings) reads the issue, the change, its diff and the checkout, read-only,
   and answers each point of the issue's "Done when" list (or, without one, the issue as a whole) as met
   or not, as JSON. Code decides: the change is refused as `rejected` unless every point is met and the
   reviewer says it resolves the issue, and as `unreviewed` when no reviewer is set, it gives no verdict,
   or the review altered the checkout. The refusal lists the points it found unmet.

   A change to what the running agent reads on a mission (`prompts/`, `config/contracts.json`,
   `agent/` other than the control, ears and mouth services, which no measured run loads, `skills/`,
   `roles/*/` other than `role.json`) is committed and then measured. The model suite runs on main's
   head and on the change, each in a clone of its own (never a worktree of this repo: the measured agent
   runs model-chosen commands for hours), with real-model runs (`node dev/harness2/cli.mjs eval --real-model`,
   `measure.trials` runs of each task, within `measure.maxRollouts`). Each side runs its own code and
   reads its own files (`dev/harness2/model-runs.mjs` `loadSideProduct`). The sides take turns, task by
   task, so drift in the model's latency and quota over the hours falls on both. A rollout that fails on
   infrastructure (the network, a git command) runs again, and one that keeps failing is left out; more
   than a quarter of a side's runs left out, and that side could not be measured (`ROLLOUT_RETRY` in
   `dev/harness2/substrate.mjs`). Any other failure of a rollout is a failed run of its side. The change
   is refused when it could not be measured, when its evidence does not cover every task it reaches on
   both sides on the current version of the suite (the Loop guard checks this again), or when any task,
   the held-out tasks or the whole suite got worse. What a change reaches follows the product's loading
   rules (`modules.mjs` `impactedTasks`): a file in `roles/<r>/` other than generic's is read only by role
   r, so it is measured on r's tasks alone, and only a change on main that reaches those tasks makes its
   measurement stale; anything else the agent reads reaches every task.
   An issue that names its module (`<!-- loop-module: <id> -->`) allows a change to that module's files
   only, its tests among them (a test is its mirror's module's; a new one is named
   `<stem>-<what>.test.mjs` after a file of the module); the cycle refuses anything else as
   `out-of-module`, and the Loop guard checks it again. It does not have to improve the suite: a fix may not show there.
6. **Opens the pull request.** It commits under the next free version (newer than main, the tags and the
   open pull requests' titles), pushes the branch and opens the pull request, which resolves the issue
   and carries the proposer's summary, the tests' result, the review (each point and a
   `paraclete-loop-review` block a merger can read) and any evidence. When the change is refused, it says
   why in a comment on the issue instead, with the files it changed, the tests that failed and the points
   the reviewer found unmet.
   A measured change takes hours (three real-model runs of each of the model suite's 15 tasks on each
   side, about 8 minutes a run), so the timer's unit allows a cycle 20 hours; a long cycle only delays the
   next. A cycle starts by removing the checkouts a killed one left registered.
7. **Records** the cycle in `.local/harness2/cycles.jsonl`, with the failing tests of a refused one. The health check
   (`node dev/harness2/cli.mjs health`) counts loop cycles apart from the harness's own, and raises
   `loop-idle` when the loop's last 3 cycles, the newest within a day, all found no work.

A `--dry-run` cycle does everything up to the pull request, pushes and comments nothing, and does not
count toward the day's cycles. Exit codes: 0 for any outcome (opened, refused, nothing to do, paused),
1 when the cycle broke, 2 for a usage mistake.

## Lanes

`node dev/loop/cycle.mjs --lane <module>` runs a cycle for one module of `modules.json` with a lane
(`organ:cerebellum`, `role:designer`, `skill:drive`): a loop that changes only that module's files
(`docs/plan/MODULAR_LOOPS.md`). Without `--lane` a cycle is the global loop's, as before.

- **Its issues** are the open `loop` issues that name its module (`<!-- loop-module: <id> -->`); the
  global loop takes only the ones that name none. A change for one may touch only the module's
  files (`out-of-module` otherwise, and the Loop guard checks it again).
- **Its branches** are `loop/m/<lane>/<issue>-<slug>` (`organ:cerebellum` is `organ-cerebellum` there),
  so its pull requests are told apart from another lane's and from the global loop's.
- **It waits** only for its own open pull requests, and for reverts: another lane's change reaches
  other files, and a measurement main's merges made stale is refused by the guard. The global loop,
  whose changes are not scoped, waits for every loop pull request.
- **It counts** its own cycles against `maxCyclesPerDay`, and records its lane in each cycle record.
- **It leaves** the revert, the release and the baseline of the model suite to the global cycle: on a
  broken main it stops (`main-broken`) and opens nothing, so two cycles never revert one merge.
- **It plans nothing yet:** its issues are written by a person until each lane has a planner of its
  own (phase 4 of the plan).

Each lane runs in a checkout of its own: `clearStaleCheckouts` clears every loop checkout of the
repo it runs in, and two cycles in one repo would clear each other's.

## The proposer

Name the coding-agent command in `.local/loop.json` (gitignored), not in the repo:

```json
{
  "proposer": {
    "command": "your-coding-agent",
    "args": ["--headless", "--max-turns", "{maxTurns}", "--prompt-file", "{briefFile}"],
    "briefVia": "file",
    "env": {}
  }
}
```

- In `args`, `{briefFile}`, `{brief}`, `{worktree}`, `{maxTurns}` and `{maxTokens}` are filled in.
  With `"briefVia": "stdin"` the brief is written to the command's input.
- The command runs in the cycle's checkout, and is stopped after `proposer.wallMinutes`.
- It should end its output with a summary under a `SUMMARY:` line, which goes in the pull request.
  Without one, the pull request says it gave none (the end of its output is its tool's log).
- The same file can tune `maxCyclesPerDay`, `retryAfterHours`, `repairRounds`, `maxAttempts`, `maxRevertsPerDay`,
  `proposer`, `reviewer`, `planner`, `measure`, `merge` and `release`.
  The referee is not a setting.

## The reviewer

Name it in the same file, under `reviewer`, the same way: `command`, `args` (with the same
placeholders), `briefVia` and `env`, and optionally `wallMinutes` (15), `maxTurns`, `maxTokens` and
`maxDiffChars` (80,000: how much of the diff its brief carries). Run it read-only: it may read the
checkout to check a point, and a review that changes it is refused. It must end its output with the JSON
verdict the brief asks for. A reviewer from a different model family than the proposer misses
different things.

`node dev/loop/reviewer.mjs --issue <n> --pr <n> [--repo <owner/name>] [--json]` reviews a pull
request, open or closed, against an issue in a temporary checkout of its head, and changes nothing on
GitHub. It exits 0 when the change resolves the issue, 1 when it does not or could not be reviewed.

## Measured work: the agent's own weak spots

With `baseline.enabled` in your local settings (on the lab driver), a cycle measures main's head on the
model suite (`dev/harness2/model-suite.mjs`: requests a person could send, each checked by code
afterwards) with real-model runs, as a change is measured, `baseline.trials` (2) runs of every task
within `baseline.maxRollouts` (40). A training task that failed a check then runs again until it has
`baseline.confirmTrials` (6) runs (`runBaselineEval` in `cycle.mjs`): one failure in two runs is half
of them, and two of the first three tasks the loop targeted were such chance failures, each costing a
measurement of hours. It does so at most once in `baseline.everyHours` (24), only when main
moved since the last, and the cycle stops there, since a baseline takes hours. `baseline.mjs` keeps the
summary in `.local/loop/baseline.json`: per task its capability, and for a training task each check with
how many runs failed it. A held-out task stays a score, so none of its checks reaches an issue or the
proposer, and the measurement's held-out check means what it says.

The planner plans from it first. A training task with a check failing in half its runs or more (a
request that comes back wrong half the time is a weakness to fix) becomes a
`loop` issue written by code: the failing checks with what they saw, what the task asks, where the fix
belongs (what the agent reads or runs, never `dev/harness2/`), and two "Done when" points the reviewer
judges: the change is to the agent, and it gives the agent what it lacked in general terms, naming
nothing of the task. A hidden `<!-- loop-target: <task> -->` marker names the task. The change is
measured like any behaviour change (a task that looks worse is run `measure.confirmTrials` (6) times on
each side, and it counts as worse only when its drop, or the held-out tasks', is beyond twice the
standard error of the difference, so one unlucky run does not refuse a change), with the target task
run `measure.targetTrials` (6) times on each
side, and the cycle refuses it (`unimproved`) unless that task's gain on the change is beyond run-to-run
noise: more than twice the standard error of the difference of the two means, as promotion evidence
demands of a gain. The Loop guard checks the same in the pull request's evidence. The same failure (the
task, the suite's version and the failing checks) is planned once, and only from a baseline that still
describes main: one of main's head, or of a commit since which nothing the agent reads changed. Otherwise
the failure may be fixed already, and the planner plans from the open items until the next baseline.
An open issue planned from a failing task is closed, not attempted, once such a baseline shows its task
passing on main: a change merged meanwhile resolved it.

The benchmark's own setup is the referee's, never the agent's: a rollout's brain is built with no
mission tree (`deps.missionDir: null`, in `dev/harness2/live-runner.mjs`), since nothing creates one
there, so its task messages name none and the motor works where its task is seeded and checked.

## The planner

When no `loop` issue waits, fewer than `planner.maxOpen` (2) are open, and the baseline has no failing
training task left to plan (see above), a cycle runs the planner
(`planner.mjs`, the command named by `planner` in your local settings, set like the reviewer's and
read-only the same way). It is offered every item of `docs/plan/OPEN_ITEMS.md` not yet planned, picks
one a change in this repository can finish and tests can show done (never one that needs a person's
decision, live infrastructure, or a change to the referee), and answers with the item's key, an issue
title, a short context and 1 to 5 "Done when" points, as JSON, within the limits its brief states
(`PLAN_LIMITS`: a title of 10 to 120 characters, points of one line up to 400). An answer that fails a
check is refused, and the planner is asked again `planner.retries` (1) times with its answer and the
problems named; one still refused opens nothing. Code checks the answer, adds the point
every planned issue shares (the item leaves `OPEN_ITEMS.md`, or says what remains) and a hidden
`<!-- loop-plan: <key> -->` marker, so the item is never planned twice (a `loop-stuck` issue counts),
and opens the issue labelled `loop`. `node dev/loop/planner.mjs [--repo <owner/name>] [--dry-run]
[--json]` plans one now; `--dry-run` prints the issue it would open.

## Merging

`.github/workflows/loop-guard.yml` runs `guard.mjs` on every pull request, with the base branch's code.
A loop pull request (a `loop/` branch of this repository) passes only when:

- its body says which issue it resolves (`Resolves #<n>.`), and that issue is open and labelled `loop`;
- none of its files is the referee's, no existing test is changed or removed, and a change to code adds
  a test;
- its review block's points are the issue's "Done when" as it reads now, and the verdict passes
  `judgeReview` judged afresh (the verdict written into the block counts for nothing);
- its files are exactly the reviewed ones, with the reviewed contents (each file's blob), so a push
  after the review voids it;
- a change to what the agent reads carries measured evidence that no task got worse, naming every file,
  and names the commit of main it was measured against (`<!-- loop-measured-base: <sha> -->`): once what
  the agent reads changed on main since (GitHub's compare of that commit with main), the measurement is
  of a main that is gone, so the change is refused and its next attempt is measured again.

`node dev/loop/merger.mjs [--dry-run] [--json]` runs each hour in `.github/workflows/harness-merge.yml`,
after the harness's own merger, in the same job (so its run on `main` is not counted as CI, and the two
never merge at once). It merges, at most once per run and at most `merge.maxPerDay` (3) a day, a loop
pull request whose CI passed (the Loop guard among it), that passes the guard again, that GitHub can
merge cleanly and whose head contains `main`'s head. It squash-merges with the pull request's title
(moved to the next free version when stale), pinned to the head it checked, then dispatches CI on
`main`. One `main` has moved past waits: each cycle starts by merging `main` into the loop's open pull
requests (as the user it runs as, so CI and the Loop guard run again on what would land), and it waits for them
before it measures anything (see "One cycle", step 1). One that
cannot pass (CI failed, a conflict with `main`, the guard) is closed with the reasons: closing it frees
the issue for the next cycle, whose proposer reads that comment. Nothing merges while `dev/harness2/PAUSED` exists or CI on `main` failed.

## When a loop merge breaks main

The merger merges only what CI passed on the main it lands on, so this is rare; when it happens, the
merger holds every other merge while CI on main's head fails. A cycle starts by reading that CI
(`sentinel.mjs`). When it finished with a failure and main's head is a loop merge (the merger's squash
message), the cycle opens a revert pull request instead of new work: `git revert` of that commit on
`loop/revert-<sha>`, labelled `loop`, its body naming the commit and the pull request it reverts, as the
user the cycle runs as (so its CI and the Loop guard run). It reopens the issue that merge resolved,
saying why. The Loop guard passes a revert only when it sets every file the reverted commit touched back
to exactly what it was before that commit (by blob) and changes nothing else; the merger takes it first,
whatever main's CI says and past the day's cap. When it is the day's `maxRevertsPerDay` (2)-th revert,
the cycle also sets the repository variable `PARACLETE_LOOP_PAUSED`: cycles stop, the merger still
lands the revert. Delete the variable to resume. When main is broken by anything but a loop merge, or a
revert cannot be made, the cycle reverts nothing and builds nothing on it.

## Releases

Instances install new releases by themselves, so a release is how the loop's changes reach them. When
`release.enabled` is set in your local settings (on the lab driver), a cycle on a healthy main starts by
releasing main's head (`releaser.mjs`) when all of these hold: `dev/release.mjs`'s own checks pass (a
clean main equal to origin, a version newer than every tag, CI passed on the head); a loop merge landed
since the previous release; that release is `release.minHoursBetween` (20) hours old or more; and the
lab ran the head healthy: the machine the cycle runs on (the driver, itself an instance kept on main)
has that commit installed for `release.soakHours` (2) hours or more, with every agent service active
and every heartbeat it writes fresh (gateway and control write none, as `dev/status.mjs` knows). It tags as `dev/release.mjs` does, as the user the cycle runs as, so
`.github/workflows/release.yml` tests and publishes it; the tag's message names the commit, the soak
and the loop merges. With `release.smoke` as well (once the lab has its canary, a project of its own
whose coordinates `lab-provision` writes to the driver's `.local/instance.env`), the release is handed
to `node dev/release-check.mjs --vm-only` instead: it deploys the head to the canary, checks its status
and runs the role's smoke mission there, and tags only when all pass, within `release.checkMinutes` (90).

## On the lab driver

`node dev/loop/timer.mjs [--interval-hours <h>] [--repo <owner/name>]` prints a service and timer that
run one cycle every few hours (6 by default) as the harness checkout's owner, from that checkout. The
follow-main timer keeps that checkout on main's head, so each cycle runs the loop as it stands on main.
Install them by hand. Nothing in the lab provisioning does. The driver needs the proposer's command and
its credentials, `gh` logged in, and `.local/loop.json`.

Tests: `tests/dev/loop/`.
