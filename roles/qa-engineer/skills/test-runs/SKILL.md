# Skill: Test Runs and Reports

## When to use

When the work is to run tests and say, with evidence, what passed and what did not: a suite before a
release, a regression run after a change, a failure narrowed down, flaky tests found, coverage measured,
a defect written up. There are no commands of its own: you run the project's test tools. Getting the
code is the git-repos skill's (an outside repository) or already done (a mission's working tree).

A test run reads and reports. You never edit a test or the code under test to make a run pass; a fix is
separate work someone asks for.

## Find how the project tests itself

Read before you run: the manifest's scripts (`package.json` `scripts`, `pyproject.toml`, `tox.ini`,
`Makefile`), the CI configuration (`.github/workflows/`), and the README. Use the project's own command,
with its own configuration. Only when there is none, fall back on the runner's default.

| Stack | Install | Run everything | One test, verbose |
|---|---|---|---|
| Node | `npm ci` | `npm test` (read what it runs) | `npx jest <file> -t '<name>'`, `npx vitest run <file> -t '<name>'`, `node --test <file>` |
| Python | `python3 -m venv <workspace>/venvs/<repo>`, then its `bin/pip install -r requirements.txt` (or `-e '.[test]'`) | `<venv>/bin/python -m pytest` | `<venv>/bin/python -m pytest <file>::<test> -vv` |

Node 24 and Python 3.11 run here. Another toolchain (Go, Java, .NET, a different Node or Python) does
not: say so in the report and run nothing in its place. End-to-end tests that drive a browser can use
the installed Chromium; a test runner that downloads its own browser stores it under your home, never
with system dependencies (no `--with-deps`, which needs the machine's root).

Always capture everything and keep it: `<command> > <workspace>/runs/<name>.log 2>&1; echo "exit=$?"`.
A suite longer than about two minutes runs in the background with that log, and you check the log until
it ends (the scripting skill). Most runners also write machine-readable results: ask for them
(`--reporter=json` or `--json --outputFile=<file>` for Node runners, `--junitxml=<file>` for pytest), and
count from those, never from scrolling text.

## The report

Every run is reported in this shape, never as prose alone:

```json
{
  "suite": "<what ran>",
  "command": "<exact command>",
  "commit": "<sha of the code under test>",
  "environment": "<where: this machine, Node or Python version, and any service URL tested>",
  "ran_at": "<ISO 8601 UTC>",
  "summary": { "total": 0, "passed": 0, "failed": 0, "skipped": 0, "errors": 0 },
  "duration_seconds": 0,
  "failures": [{ "test": "<id>", "expected": "...", "actual": "...", "error": "<verbatim message, first lines>", "evidence": "<log path and line, or file>" }],
  "skipped": [{ "test": "<id>", "reason": "<the reason the code gives>" }],
  "flaky": [{ "test": "<id>", "passed": 0, "failed": 0 }]
}
```

- `total` equals `passed + failed + skipped + errors`, or the report is wrong: recount.
- Every failure carries the verbatim error and where its evidence is. "See the logs" is not evidence.
- Every skip carries the reason written in the code (`skip("...")`, a marker's reason). A skip with no
  reason is a finding. When more than a tenth of the suite is skipped, the run is not clean, whatever
  passed.
- Write the report to a file and hand it back with `file-share` when the person wants it; put its summary
  and the failures in your answer.

## Procedures

### Compare with the last baseline

1. Keep every run's report. In a project's mission tree, save it as
   `qa/results/<suite>/<UTC date and time>.json` so it is committed with the checkpoint and the next run
   finds it; outside a project, the previous run's report is in that mission's output (the
   work-management skill: `work-log-read`, then `work-output-read <id>`).
2. Compare test by test and report four lists: regressions (passed then, fail now), fixes (failed then,
   pass now), still failing, and new tests.
3. Flag, even when everything passed: a total that fell by more than 5% with no tests deleted on purpose
   (tests stopped being collected), and a duration under half or over twice the baseline.
4. With no baseline, say so: this run becomes the baseline.

### Narrow down a failure

1. Run the one failing test alone, verbose, and keep its full output.
2. Run it again. A test that fails alone and in the suite is real; one that passes alone and fails in
   the suite depends on order or shared state: say which other test it runs after.
3. Read the test and the code it calls, enough to state expected against actual in one sentence each.

### Find flaky tests

Run the suite, or the suspect tests, five times with the same command, each to its own log
(`for i in 1 2 3 4 5; do <command> > <workspace>/runs/repeat-$i.log 2>&1; done`, in the background for a
long suite). A test with both outcomes is flaky: report it separately with its pass and fail counts, and
never count it as passing.

### Measure coverage

Use the project's coverage setup when it has one (`npm run coverage`, `pytest --cov=<package> --cov-report=term-missing`
when `pytest-cov` is among its test requirements). Report coverage per area or module, not only the total:
a critical module under its threshold is a finding even when the total looks healthy. Do not install a
coverage tool into a project that has none without asking.

### Write up a defect

A defect report is a recipe a stranger can follow:

- **Title:** what fails, specifically ("Login rejects passwords with a space", not "login bug").
- **Severity:** S1 blocker (down, data loss, security hole, no workaround), S2 critical (a main feature
  broken, a painful workaround), S3 major (partly broken, a fair workaround), S4 minor (cosmetic, a rare
  edge). Rate what you can show, never higher to get attention or lower to avoid it.
- **Where:** the commit, the environment, the data it needs.
- **Steps:** numbered, from a clean start, with exact inputs.
- **Expected and actual,** each in a sentence, and how often (always, intermittently: how many in how
  many runs).
- **Evidence:** the failing test or command, the verbatim error, the log path, a screenshot for anything
  visual.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `0 tests` or `no tests ran` | The runner did not find them: wrong directory, pattern or config | Run from the project root with its own command; read its test configuration |
| Import or module errors in every test | Dependencies not installed in this environment | Install with the project's lockfile into its environment, then run again |
| The run is stopped after about two minutes | The command limit | Run it in the background with a log and poll the log |
| Results differ from CI | Different versions, environment variables or services | Name the difference in the report; never pick the more convenient result |
| A test needs a service, a key or a database you do not have | Integration tests need setup | Report them as not run, with what they need; never mark them passed |

## Safety

- Never point tests at production data or a production service unless the person asked for exactly
  that; tests that write anything run against something disposable.
- Never edit tests or code during a run, and never report a failing test as passing.
- Keep secrets a suite needs in Secret Manager (the secrets skill), out of logs and reports.
