# roles/software-engineer/

An agent that works in the organization's code: it understands a codebase, makes the smallest change that
does the job, proves it with the project's own tests, and hands it back as a commit or a pull request. It
also reviews other people's changes. Done means tested.

| Part | Software Engineer |
|---|---|
| Purpose | Features, fixes and wiring in existing repositories, pull requests on GitHub, and code review |
| Channel | Dashboard chat |
| Skills | The base skills (among them `git-repos` and `git-artifacts`), plus `coding`, `code-review` and `pull-requests` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): done means tested; understand before modifying; reproduce a bug with a test first; minimal changes; branches and pull requests, never a push to a default branch; merges only when asked; reviews are read-only; deploying is out of scope |
| Responsibilities | None: there is no code to watch until people point the agent at it |
| Processes | `p-bug-fix` and `p-pull-request`, on top of generic's (`p-plan`, `p-review` and the rest) |
| GCP roles | The generic base set only |
| Workspace | No |

## What it adds to generic

| Skill | For | Runs |
|---|---|---|
| `coding` | The method for a change: understand the codebase, take a test baseline, reproduce a bug as a failing test, change the real file in place, prove it with the project's build, linters and tests, read the diff, commit. Which toolchains run here, and how a web page edit is checked by rendering it | The project's own tools, `git`, `work-*`, `file-convert`, `chromium` |
| `code-review` | Getting a change, running its tests, judging it (correct, safe, tested, consistent), and a verdict with findings by weight | `git`, `gh`, the project's tools |
| `pull-requests` | Opening a pull request with its evidence, following checks, answering review comments, posting a requested review, merging only when asked | `gh`, `secret-read` |

None has commands of its own. The base `git-repos` skill already clones, branches and pushes with a token
from Secret Manager; `p-review` in the generic role is the shape of a review.

### Pull requests: the `gh` CLI, with a token from Secret Manager

Pull requests go through `gh`, the GitHub CLI, rather than hand-written REST calls: it builds the
requests, handles pagination and reads back the result, and `gh api` reaches the rest of the REST API with
the same authentication. Debian 12 ships it (2.23), so it installs like any other package; the skill uses
only flags that version has. `gh` never logs in: each command gets the token in `GH_TOKEN`, read from
Secret Manager by `secret-read` inside that one command, so the token never lands in a file, a git remote
or the agent's output. GitHub Enterprise Server works with `GH_HOST` and `GH_ENTERPRISE_TOKEN`. Other
hosts get the branch pushed and a link for the person, or their REST API through `curl`.

## What it needs at install

Nothing to work in the instance's own projects. For outside repositories:

- **A token** for the repositories it should work on, created on GitHub by a person: a fine-grained
  token with read and write for contents and pull requests, and read for checks, commit statuses and
  actions (or a classic token with `repo`). A dashboard admin stores it in Secret Manager from the
  dashboard and grants the agent access to that secret, then tells the agent its id.
- Write access for the token's owner on those repositories, or a fork the agent can push to.

## GCP roles

None beyond the generic base set. Code lives in git: the instance's artifact store (its bucket and
Firestore, already in the base set) and outside hosts reached with a token. Nothing here runs or deploys on
Google Cloud; that is the DevOps Engineer role's work.

## Setup packages

| Kind | Packages | For |
|---|---|---|
| Debian | `gh` | Pull requests, checks and reviews on GitHub |
| Debian | `python3-venv` | A Python project's own environment, so its requirements never touch the system's Python (Debian splits `venv` out of `python3`) |

Node 24 with npm, git, `build-essential`, `python3-pip` and `python3-dev` come with the generic role. Other
toolchains (Go, Java, Rust) are not installed: the `coding` skill tells the agent to say so and never claim
tests ran.

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: no Workspace, the three skills, no extra GCP roles, the packages above |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/coding/`, `skills/code-review/`, `skills/pull-requests/` | The skills above: `SKILL.md` and `skill.json` each |
| `responsibilities.json` | Empty |
| `processes/p-bug-fix.json` | Reproduce with a failing test, find the root cause, the smallest fix, the whole suite |
| `processes/p-pull-request.json` | Clone, branch, change and test, push, open the request with its evidence, follow it |
| `memory.md` | The agent's first working memory |
