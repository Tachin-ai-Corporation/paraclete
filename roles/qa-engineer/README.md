# roles/qa-engineer/

An agent that tests the organization's software and reports what it finds as evidence: it runs suites and
compares them with the last baseline, finds flaky tests, measures coverage, and writes defects anyone can
reproduce. It reports what is true, and never makes a run pass by changing what it tests.

| Part | QA Engineer |
|---|---|
| Purpose | Regression runs, failure narrowing, flaky-test hunts, coverage, defect reports |
| Channel | Dashboard chat |
| Skills | The base skills, plus `test-runs` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): a finding needs proof; regressions first; testing never repairs; severity S1 to S4 from evidence; riskiest first; never against production by default; the report's counts must close, failures carry evidence, skips carry reasons, flaky is not passing |
| Responsibilities | None: there is no suite to run until people point the agent at one. A nightly or weekly run is one request away (`responsibility-manage create`) |
| Processes | `p-regression-run` and `p-defect-report`, on top of generic's (`p-audit`, `p-investigate` and the rest) |
| GCP roles | The generic base set only |
| Workspace | No |

## What it adds to generic

| Skill | For | Runs |
|---|---|---|
| `test-runs` | Finding and running a project's own test command; a structured report whose counts must add up, with verbatim errors and skip reasons; comparing with a baseline kept under `qa/results/` in the project's working tree; narrowing a failure; repeated runs for flaky tests; coverage per area; defect write-ups with S1 to S4 severity | The project's runners (`npm test`, `node --test`, jest, vitest, pytest) |

It has no commands of its own. Getting the code is the base skills' (`git-repos`, `git-artifacts`), and
reports go back as files through the base `files` skill.

## What it needs at install

Nothing for the instance's own projects. For outside repositories, a token in Secret Manager as the base
`git-repos` skill describes. A suite that needs services, keys or a database needs them provided; the agent
reports such tests as not run rather than guessing.

## GCP roles

None beyond the generic base set. Tests run on the VM against code it fetched; a deployed service is tested
through its public URL, which needs no role.

## Setup packages

| Kind | Packages | For |
|---|---|---|
| Debian | `python3-venv` | A Python project's own environment for its test requirements (Debian splits `venv` out of `python3`) |

Node 24 with npm, git, `build-essential` and Chromium (for browser tests) come with the generic role. Other
toolchains are not installed; the skill has the agent say so instead of reporting a run.

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: no Workspace, the `test-runs` skill, no extra GCP roles, the package above |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/test-runs/` | The skill above: `SKILL.md` and `skill.json` |
| `responsibilities.json` | Empty |
| `processes/p-regression-run.json` | The whole suite against the last baseline, with a verdict on whether to go ahead |
| `processes/p-defect-report.json` | Reproduce, narrow, rate and write up a defect |
| `memory.md` | The agent's first working memory |
