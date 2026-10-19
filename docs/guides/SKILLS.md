# Writing a skill

A skill is codified procedure: the instructions for one kind of work, plus the commands that do it
([the glossary](../GLOSSARY.md)). This guide is for developers who add a skill to `skills/` or to a
role's `skills/`, or change one. The package's files and `skill.json` fields are defined in
[skills/README.md](../../skills/README.md), and the conventions every command shares in
[agent/cli/README.md](../../agent/cli/README.md); this guide says how the agent finds and uses a
skill, when to write one, when a skill needs a command of its own, how to shape that command and the
`SKILL.md` procedure, and which tests every skill gets.

## How the agent finds a skill

What you write lands in three places, each read by different organs:

| Who | Sees | Built by | When |
|---|---|---|---|
| The cortex (decides each step) and the prefrontal (plans checkpoints) | A capability map: for each organ, every skill's name and the first sentence of its `when_to_use`, cut at 120 characters. Never a path or a command | `capabilityMap` in `agent/services/brain/prompt-assembly.mjs` | Re-read at every mission boundary (`agent/services/brain/main.mjs`) |
| Every organ with tools: the motor (executes), the cerebellum (verifies), temporal-research, and temporal-memory when it consolidates | A skill index: name, id, the whole `when_to_use`, and the path of the `SKILL.md` to read | `buildSkillCatalog` in `agent/gateway/skill-catalog.mjs` | Once, when the gateway starts |
| The organ doing the work | The `SKILL.md` itself, read with its `readFile` tool | The organ | Before it runs a command |

So `when_to_use` routes the work, `SKILL.md` carries the method, and a command does what code must
do. Three consequences:

- **The planners never see your procedure.** They plan the outcome and name the organ; the organ
  doing the work reads the skill and picks the method. Write `SKILL.md` for that organ.
- **Reading the skill first is an instruction, not a check.** The shell tool's description tells the
  organ to read the relevant `SKILL.md` before its first use of any command, and never to guess syntax
  (`runCommand` in `agent/gateway/tools.mjs`). Nothing stops a command run before its skill was read,
  which is why a procedure must give exact syntax.
- **`organs` is not an access list.** Every tool-using organ gets the same index, whatever a skill's
  `organs` says; the index leaves out only skills used by nothing but the planning organs, and skills
  whose `requires` the instance does not meet (`agent/gateway/skill-catalog.mjs`). `organs` decides
  where the skill appears in the capability map, which applies `requires` the same way
  (`readSkills()` in `agent/services/brain/prompt-assembly.mjs`): the planners never plan with a
  skill the motor cannot see.

## When a skill, and when something else

A skill is the right home for a procedure the agent repeats, with the commands it runs. Most other
content has another home; the [module charter](../concepts/MODULE_CHARTER.md) draws the lines.

| You have | It belongs in | Why |
|---|---|---|
| The method and exact commands for one kind of work | A skill | The organ doing the work reads it when it needs it, and only then |
| A rule about what passes, or what needs approval, in a domain | A role's organ prompt ([ROLES.md](ROLES.md)) | It must shape every plan and verdict in the domain, not only the step that uses a tool |
| How a kind of work goes well, without tool syntax | A process playbook ([PROCESSES.md](PROCESSES.md)) | The planner recalls it when the work resembles it |
| Identifiers and conventions of one body of work | A project's context, which the agent keeps in Firestore | Template-clean; the work-management skill tells the agent to keep identifiers there |
| A value more than one file uses | `config/contracts.json` | The single source for shared values ([DEVELOPING.md](../../DEVELOPING.md), section 9) |
| Behaviour every organ needs | The organ's base prompt in `prompts/` | Organ prompts hold no tool syntax ([prompts/README.md](../../prompts/README.md)) |

Base or role: a skill every agent needs, whatever its role, goes in `skills/`; a skill only one role
needs goes in that role's `skills/` ([skills/README.md](../../skills/README.md)). Skill ids are unique
across both (`tests/content/packages.test.mjs`).

## A procedure alone, or a command too

Most skills need no command of their own. Eighteen of the twenty shipped role skills are procedures,
many of them over real command-line tools (`gcloud`, `bq`, `gh`, `firebase`), and so are base skills
such as `careful-operations` and `git-repos`. A procedure over a tool that already exists is less code
to keep, and the agent can read the tool's own `--help`.

Write a command when code must do what a procedure cannot promise:

| The command must | Example |
|---|---|
| Enforce a limit or a refusal | `billing-query` refuses anything but one `SELECT`, dry-runs it, and caps the bytes BigQuery may bill (`roles/finance-analyst/skills/billing-analysis/billing-query.mjs`) |
| Compute what a model would estimate | `contrast-check` computes WCAG contrast ratios (`roles/designer/skills/accessibility-checks/contrast-check.mjs`) |
| Call an API as the right identity, with the right scopes | The Workspace commands act as the agent's account with only the scopes of the API they call ([skills/README.md](../../skills/README.md)) |
| Keep a secret out of the model's context | `secret-read` prints only the value, for use inside command substitution (`skills/secrets/secret-read.mjs`) |
| Give a step a stable, checkable result | `file-get` prints a record of each file it fetches: its path, name, type, size, checksum and source (`skills/files/file-get.mjs`) |

A command only one skill uses lives in that skill's directory; one that several skills or the services
share lives in `agent/cli/` ([agent/cli/README.md](../../agent/cli/README.md)). A command has one home:
the tests fail one found in both places.

## The command's shape

A skill's command is `<command>.mjs` in the skill's directory, listed in `commands` in `skill.json`.
The VM gets a launcher for it, `/opt/paraclete/bin/<command>`, so the agent runs it by its bare name
(`install/vm/launchers.mjs`).

| Rule | Why | Checked by |
|---|---|---|
| Starts `#!/usr/bin/env node`, then a header comment naming its own path and saying what it does | The launcher runs it with Node; a reader with no context learns its job | `tests/content/packages.test.mjs` |
| Exports `main(argv, deps = {})`, which returns the exit code, and runs `main` only when Node was started with this file | Before a release is installed, the validation gate loads every launcher's module (`install/vm/check-release.mjs`): a command that ran on import would run then. Tests call `main` with fakes | `tests/content/packages.test.mjs` |
| Takes its outside world through `deps`: stdout, stderr, fetch, the token source, the clock | Its tests run without a VM ([agent/cli/README.md](../../agent/cli/README.md)) | Its own tests |
| Exports its `USAGE` text, and prints it for `--help` | `tests/content/command-flags.test.mjs` reads the exported `USAGE` and fails any flag that agent-facing text writes after the command's name and the command does not take. Without an exported `USAGE` that check cannot run | `tests/content/command-flags.test.mjs` |
| Writes no install or data path (`/opt/`, `/var/lib/`) | Paths come from the instance record (`config/instance.mjs`); shared values from the contracts (`config/contracts.mjs`) | `tests/content/packages.test.mjs` |
| Authenticates through the VM: its metadata server's token (`agent/auth/metadata-token.mjs`), or for the Workspace account a domain-wide delegation token with only the scopes its API needs (`agent/auth/dwd-token.mjs`, `agent/auth/workspace-scopes.mjs`) | No key file ever exists ([DEVELOPING.md](../../DEVELOPING.md), section 6) | Review |
| Uses Node's built-ins only | Only `agent/gateway/` imports npm packages ([agent/README.md](../../agent/README.md)); a role's npm packages are installed as global command-line tools ([install/README.md](../../install/README.md#packages)) | Review |
| Results on stdout, problems on stderr; an outage is an error, never an empty result | The organ reads both streams and the exit code; an empty answer reads as "there is nothing" | Review |
| Checks every id and argument before it becomes a path or a request | A name from a model must not reshape a request path; `secret-read` checks the secret name against Secret Manager's own pattern | Its own tests |
| Has a name no other command uses | Two files claiming one command name stop the install (`install/vm/launchers.mjs`) | `tests/install/bootstrap.test.mjs`, over the base skills |

Fit the shell tool the organ runs it with (`agent/gateway/tools.mjs`, limits in the contracts'
`tools` section):

- **Time.** A command is stopped after `tools.timeout_ms` (120 seconds). A long job starts in the
  background and the procedure polls it; the DevOps Engineer's skills start builds and deploys with
  `--async` for this reason.
- **Output.** A result longer than `tools.output_chars` is cut, saying so. Print what the next step
  needs, offer `--limit`, or write large output to a file and say where.
- **Free text.** An argument with quotes, apostrophes or newlines breaks shell quoting. Give the
  command a `--stdin` flag; the shell tool has a `stdin` field for it.
- **Where it writes.** Installed code and `/etc/paraclete` are read-only to the services, which run as
  the `paraclete` user and own the data root ([install/README.md](../../install/README.md)). A command
  writes its files under the data root, such as the mission's working tree, where the next step and
  the verifier can find them.

Each command gets its own tests, at `tests/skills/<skill>/<command>.test.mjs`, or
`tests/roles/<role>/skills/<skill>/<command>.test.mjs` for a role skill ([tests/README.md](../../tests/README.md)).
They are hermetic: a fake fetch, a fake program runner, a scratch directory. Nothing checks that the
file exists, so the review does.

## `SKILL.md`: the procedure

`SKILL.md` is agent-facing product text, written to the agent ([skills/README.md](../../skills/README.md)).
Two things are checked: it starts with a `# ` title, and it names every command in `skill.json`
(`tests/content/packages.test.mjs`). The rest is convention, and the shipped skills share it:

| Section | What it holds |
|---|---|
| `# Skill: <Name>`, then `## When to use` | The work it serves, specifically enough to choose it over a neighbouring skill |
| The rule or the stance, when there is one | The one line the work must never cross. `skills/drive/SKILL.md` states its rule right after when to use it: Drive is where files come from and go to, never where the agent works |
| `## Commands` | Each command with its exact syntax and what it prints, read commands before write commands |
| What the account can and cannot do | And exactly what a person must do or grant, so the agent asks for that (`roles/devops-engineer/skills/gcloud/SKILL.md`) |
| `## Procedures` | Numbered steps under a name that says the goal, ending with a check that reads the live result back, never the command's own success message |
| `## Error recovery` | A table of symptom, cause and what to do, from failures seen |
| `## Safety` | What the skill never does, and what needs an approval first |

How to write it well:

- **Exact syntax, every time.** A flag written wrong in a procedure sends the agent into an error
  loop. `tests/content/command-flags.test.mjs` catches a flag a skill's own command does not take;
  nothing checks the flags of `gcloud`, `git` or any other outside tool, so run each line you write.
- **Verify by re-reading.** End a procedure with a read of the live state that proves the result,
  as step 4 of `skills/careful-operations/SKILL.md` asks.
- **Say what happens when it fails.** An error recovery row names the message the agent will see
  and the action to take, not "report the error".
- **Keep it to one kind of work.** The organ reads the whole file into its turn; a procedure for
  something else costs every task that only needed this one.
- **Keep identifiers out.** Use placeholders (`<project>`, `your-gcp-project`); the instance's real
  names come from tool output, the person, or a project.
- **Use the product's words.** `tests/content/content-hygiene.test.mjs` fails text that speaks of
  other agents, cites a rule by canon id, carries a `{{placeholder}}`, or tells the agent to edit its
  prompts.

## What `skill.json` does at runtime

The fields are defined in [skills/README.md](../../skills/README.md). What each one changes:

| Field | Read by | Write it so |
|---|---|---|
| `when_to_use` | The capability map (its first sentence, cut at 120 characters) and the skill index (whole) | The first sentence is the skill's one-line capability; the rest says when to reach for it. The tests want at least 20 characters |
| `organs` | The capability map's grouping; the index leaves out a skill whose organs are all planning organs | Name the organs that use it. Name the cerebellum when `SKILL.md` says what a pass must show in its domain: the verifier can read files, view images and report a verdict, but runs no commands (`CEREBELLUM_TOOLSET` in `agent/gateway/tools.mjs`) |
| `commands` | The launchers and the tests | Every command the skill documents, its own or shared |
| `requires` | The skill index and control's `skills` view | `["workspace"]` for a skill whose commands act as the Workspace account; the only requirement is defined in `agent/context/skill-requirements.mjs` |
| `version` | Control's `skills` view (`agent/services/control/introspection.mjs`) | Raise it when the procedure changes. Nothing enforces that |

## The tests every skill gets

| Test | Checks |
|---|---|
| `tests/content/packages.test.mjs` | `skill.json` has the documented fields and nothing else, its id is the directory's name, its organs are real organs, its requirements known; `SKILL.md` has a title and names every command; every command exists in the skill or in `agent/cli/`, never both; the directory holds only `skill.json`, `SKILL.md` and the listed commands' files, since a script it does not list never becomes a command; each own command has the shape above; ids are unique; a skill that requires a Workspace account sits in a Workspace role |
| `tests/repo/structure.test.mjs` | Every skill directory has a `SKILL.md` |
| `tests/content/content-hygiene.test.mjs` | The banned words, in `SKILL.md` as in every agent-facing file |
| `tests/content/command-flags.test.mjs` | Flags in agent-facing text are flags the command takes |
| `tests/install/bootstrap.test.mjs` | Every base skill's command file gets a launcher, and no two files claim one name |
| Your command's own tests | Its behaviour, with fakes |

On the VM, the validation gate loads every launcher's module before a release is swapped in, and a
release with one that does not load is not installed (`install/vm/check-release.mjs`).

## Trying a skill on a dev instance

1. Deploy your branch: `node dev/deploy.mjs <branch>` ([DEVELOPING.md](../../DEVELOPING.md),
   section 7). The upgrade restarts the services, so the gateway's index includes the new skill.
2. Check the dashboard's Agent page, Skills tab: it shows each skill with where it came from, and
   marks one the instance cannot use as unavailable, with the reason.
3. Send a request the skill serves: `node dev/say.mjs "<request>"`.
4. Read what the organ ran: `node dev/logs.mjs gateway` prints a `runCommand →` line for each
   command, and `node dev/query.mjs work --doc <mission>` shows the mission and its outcome.

## Checklist

- [ ] The content is a procedure for one kind of work, not a rule, a playbook, an identifier or a
      shared value
- [ ] Base skill only if every role needs it
- [ ] A command only where code must enforce, compute, authenticate, protect or record something
- [ ] The first sentence of `when_to_use` says the capability on its own
- [ ] `SKILL.md` gives exact syntax for every command, procedures that end by reading the result
      back, and an error recovery table
- [ ] Each command has the shape above, exports `USAGE`, and has its own tests
- [ ] `requires` set for a skill that acts as the Workspace account
- [ ] `version` raised for a changed procedure
