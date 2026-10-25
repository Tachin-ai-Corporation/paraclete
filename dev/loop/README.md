# dev/loop/

The self-improvement loop: plain code that, one cycle at a time, has a coding agent change this
repository to resolve an issue, checks the change, and opens a pull request. Nothing here is product,
and nothing here is installed on an instance.

**Stage 1, supervised.** The loop opens pull requests; a person reviews and merges them. It never
merges, releases or changes an instance.

| File | What it does |
|---|---|
| `cycle.mjs` | One cycle, and its command line: picks an issue, has the proposer change a checkout of main, checks the change, opens the pull request, records the cycle |
| `proposer.mjs` | The proposer interface, the brief it is given, and the command proposer that runs a headless coding-agent command named in your local settings |
| `config.mjs` | The loop's budget and caps, the paths a proposal may not touch (the referee), the paths that change the agent's behaviour |
| `test-report.mjs` | Reads which tests failed from the suite's output, with each one's error (for a test file that could not load, the error it printed), for the refusal comment and the cycle record |
| `timer.mjs` | Prints the systemd units that run a cycle on a schedule on the lab driver, and how to install them. Nothing installs them for you |

## One cycle

`node dev/loop/cycle.mjs [--issue <n> [--retry]] [--repo <owner/name>] [--dry-run] [--json]`

1. **Stops** while the harness is paused (`dev/harness2/PAUSED`, or `PARACLETE_H2_PAUSED`), or once
   today's cycles (`maxCyclesPerDay`, 4) are spent. Cycles are counted from the cycle log.
2. **Picks** the oldest open issue labelled `loop`. It skips an issue that already has an open pull
   request from a `loop/<issue>-` branch, and one it tried and failed within `retryAfterHours` (24).
   `--issue` names one; `--retry` tries it even within that wait. It reads the issue's comments by
   its maintainers (the repository's owner, members and collaborators, never anyone else), which
   include its own refusals of earlier attempts.
3. **Checks out** `origin/main` on the branch `loop/<issue>-<slug>`, in a temporary worktree, with the
   repo's installed packages linked in.
4. **Runs the proposer**, within its budget (`proposer.wallMinutes`, `maxTurns`, `maxTokens`). The
   proposer only edits files. Its brief carries the issue and the newest of those comments, as data,
   so an attempt learns what earlier ones changed and which tests they failed.
5. **Checks the change.** It refuses the whole change when:
   - it touches the referee: `dev/loop/`; the evaluation, benchmark, evidence, merge, pause and health
     code in `dev/harness2/`; `dev/release*.mjs`; `.github/`; `install/`; `migrations/`;
     `roles/*/role.json`; `config/contracts.mjs`; `docs/canon/`; `DEVELOPING.md`; the package
     manifests;
   - it changes or removes an existing test (adding tests is welcome);
   - it adds or changes code (a `.mjs`, `.js`, `.jsx`, `.ts`, `.sh` or `.py` file outside `tests/`) and
     adds no new `.test.mjs` file under `tests/` (`untested`): the suite cannot fail on code nothing
     tests, so passing it is not enough. Removing code needs no test. It is checked before the suite runs;
   - the suite (`npm test`) fails.

   A change to what the running agent reads (`prompts/`, `config/contracts.json`, `agent/`,
   `skills/`, `roles/*/` other than `role.json`) is committed and then measured. The model suite runs on
   main's head and on the change, with real-model runs (`node dev/harness2/cli.mjs eval --real-model`,
   `measure.trials` runs of each task, within `measure.maxRollouts`). The change is refused when it
   could not be measured, or when any task, the held-out tasks or the whole suite got worse. It does not
   have to improve the suite: a fix may not show there.
6. **Opens the pull request.** It commits under the next free version (newer than main, the tags and the
   open pull requests' titles), pushes the branch and opens the pull request, which resolves the issue
   and carries the proposer's summary, the tests' result and any evidence. When the change is refused,
   it says why in a comment on the issue instead, with the files it changed and the tests that failed.
7. **Records** the cycle in `.local/harness2/cycles.jsonl`, with the failing tests of a refused one. The health check
   (`node dev/harness2/cli.mjs health`) counts loop cycles apart from the harness's own.

A `--dry-run` cycle does everything up to the pull request, pushes and comments nothing, and does not
count toward the day's cycles. Exit codes: 0 for any outcome (opened, refused, nothing to do, paused),
1 when the cycle broke, 2 for a usage mistake.

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
- The same file can tune `maxCyclesPerDay`, `retryAfterHours`, `proposer` and `measure`. The referee
  is not a setting.

## On the lab driver

`node dev/loop/timer.mjs [--interval-hours <h>] [--repo <owner/name>]` prints a service and timer that
run one cycle every few hours (6 by default) as the harness checkout's owner, from that checkout. The
follow-main timer keeps that checkout on main's head, so each cycle runs the loop as it stands on main.
Install them by hand. Nothing in the lab provisioning does. The driver needs the proposer's command and
its credentials, `gh` logged in, and `.local/loop.json`.

Tests: `tests/dev/loop/`.
