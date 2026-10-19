# Module charter

What belongs where in the content the agent works from: an organ prompt, a skill, a process, a
project, a responsibility, a role package or the memory. Each reaches the agent by a different path,
at a different moment, and is changed by a different writer, so content in the wrong place either
never reaches the organ that needs it, goes stale where nobody looks, or is changed by someone who
should not. This charter is for anyone writing agent-facing text in [prompts](../../prompts/README.md),
[skills](../../skills/README.md) and [roles](../../roles/README.md), and for anyone changing the code
through which the agent writes its own processes, projects, responsibilities and memory. The formats
are defined in those READMEs and the guides say how to write each kind well; this page says which
kind a piece of content is, how to tell, and what goes wrong when it is misplaced. How the pieces are
used in a mission is in the [culture of work](CULTURE_OF_WORK.md).

## Three questions decide where content goes

- **Who reads it, and when?** An organ prompt is in every turn of its organ. A skill's procedure is
  read when the organ doing a task opens its SKILL.md. A playbook is in the cortex's view on every
  decision. A project's context reaches only the missions in that project. Memory reaches a mission
  through recall, and working memory sits in every cortex turn.
- **Who may change it?** Installed content (code, prompts, skills, role packages) changes only with a
  release: it lives under the install root, which is read-only to every service but control, the one
  that installs releases ([agent/services/README.md](../../agent/services/README.md)). The agent's
  own content (the playbooks it wrote, its projects, its responsibilities, its memory) changes at
  runtime, through its commands.
- **Must it hold whatever a model does?** Then it is code, and any text about it only explains it.

## The layers at a glance

| Layer | Answers | Lives in | Reaches the agent | Changed by |
|---|---|---|---|---|
| Code and contracts | What must hold whatever a model writes | The [agent package](../../agent/README.md); [config/contracts.json](../../config/contracts.json) | It runs the loop | A release |
| Organ prompt | Who the agent is, and how one organ thinks | `prompts/<organ>.md`, with the role's append | Every turn of that organ (`loadOrganPrompt` in `agent/gateway/organs.mjs`) | A release |
| Skill | How to do one kind of work, with the exact commands | A skill package | Tool-using organs see every SKILL.md path (`agent/gateway/skill-catalog.mjs`); the planning organs see one line per skill (`capabilityMap` in `agent/services/brain/prompt-assembly.mjs`) | A release |
| Process | How a recurring kind of work has gone well | A role package's playbooks; the `processes` collection | The cortex on every decision; the planner when its recall phrases match; a responsibility's mission (`agent/work/process-registry.mjs`) | A release; the agent, with `process-ops` |
| Project | Durable facts about a working area | The `projects` collection | Rendered into the prompts of each mission in that project (`buildContext` in `agent/work/projects.mjs`) | The agent, with `project-manage`; the brain, when a mission publishes or a project completes |
| Responsibility | Work the agent owns on a clock or an event | A role package's `responsibilities.json`; the `responsibilities` collection | As a mission's instruction and context when it fires (`agent/work/scheduler.mjs`) | A release; the agent, with `responsibility-manage`; a dashboard admin, on or off |
| Role package | One role's focus and heavier tools | `roles/<id>/` | Installed with the generic role; each part reaches the agent as its own layer | A release |
| Memory | What the agent learned and what it is working on | `MEMORY.md` and `DEEP_TRUTHS.md` under the data root; the `core_memory` collection | Working memory and Deep Truths in every cortex turn; Core Memory through recall (`agent/services/brain/memory.mjs`) | The agent only |
| The mission | One piece of work's particulars | Its envelope and its mission tree | That mission only | The brain, while it runs |

## Code, not text

A rule that must hold whatever a model writes lives in code. The text around it explains it, and may
repeat it to save an organ a wasted move, but is never its only home. The code keeps these, among
others:

| Rule | Where the code keeps it |
|---|---|
| Every status change is a legal move | `agent/work/work-transitions.mjs` |
| Missions never nest | `enforceMissionParentInvariant` in `agent/work/plan-utils.mjs` |
| A checkpoint passes only on the verifier's verdict tool call, never on prose | `agent/work/verdict.mjs` |
| A mission is not reported complete while its last checkpoint is unmet | `finalizeBlockedBySpine` in `agent/work/checkpoint-spine.mjs` |
| A memory-scoped mission runs only on the memory organs and opens no approval gate | `fenceMemoryTask` in `agent/work/memory-scope.mjs` |
| The memory organ, running a task, can write nothing but memory | `MEMORY_TOOLSET` in `agent/gateway/tools.mjs`; `MEMORY_COMMANDS` in `agent/services/gateway/settings.mjs` |

The reverse matters as much: a rule that only a prompt states is a request to a model, and the docs
must say so. That a destructive or public action needs an approval gate is such a rule: the prompts
ask for it, and the code warns once when it is missing
([culture of work](CULTURE_OF_WORK.md#who-approves-what)).

**How to tell:** if the rule failing once does harm, and a model could forget it, it belongs in code.

## Organ prompts

**What belongs.** The organ's one job and its boundaries; how it reasons and what it refuses; its
output contract (the cortex returns one JSON object, the cerebellum one verdict tool call); and, in
`prompts/identity.md`, who the agent is, who it works for, and what it cannot change. The base prompts
in `prompts/` are the same for every role. A role's append, `roles/<id>/prompts/<organ>.md`, adds only
the domain rules that role's work must meet: the DevOps verifier passes a deploy only on a fetch of
the live address with a 2xx (`roles/devops-engineer/prompts/cerebellum.md`); the legal advisor assists
and escalates and never gives legal advice (`roles/legal-advisor/prompts/cortex.md`).

**What does not.** Command syntax goes in a skill ([prompts/README.md](../../prompts/README.md)): a
prompt is in every turn, and a command's flags change without anyone rereading the prompts. A
playbook's narrative goes in a process; a working area's facts in a project; one organization's names
or values nowhere in the repo, since every install reads these files. Anything about other agents is
wrong by construction: there is one agent. A rule that must hold goes in code.

**How the repo keeps it there.** `tests/content/content-hygiene.test.mjs` refuses talk of handing
work to other agents, internal rule ids, template placeholders, and any line telling the agent to edit
its own prompts. `tests/content/packages.test.mjs` requires a non-empty prompt for every organ, an
append only for a known organ, and nothing in the prompts directory but the organ prompts, the identity
and the README. `tests/content/command-flags.test.mjs` checks that a skill command named in a prompt
is given only flags it takes. On the VM the prompts are read-only to the agent.

**Going wrong.** A prompt that states a fact about the platform goes stale when the platform changes,
and nothing checks it: describe what the organ can rely on in general terms, and leave the specifics
to a skill, which a test reads against its commands.

## Skills

**What belongs.** When to use the skill (the first sentence of `when_to_use` is its one-line
capability in the planners' map), the exact syntax of every command it governs, procedures, error
recovery and safety notes, and the commands' own code. A skill every agent needs is a base skill; one
only a role needs lives in that role's package ([skills/README.md](../../skills/README.md)). A skill
that needs the agent's own Workspace account says `requires: ["workspace"]`, and an instance without
one never shows it (`agent/context/skill-requirements.mjs`).

**What does not.** How an organ should judge goes in its prompt. A narrative of how a kind of work
tends to go well is a process. One organization's folders, ids or names belong in a project or in
memory. Steps that run on a schedule belong in a responsibility.

**How the repo keeps it there.** `tests/content/packages.test.mjs` checks every package: the manifest's
shape, a SKILL.md that documents every command, every command present in the skill or as a shared
command in the [cli package](../../agent/cli/README.md), nothing else in the package, ids unique across
the base skills and every role, and a Workspace-only skill only in a Workspace role.
`tests/content/skill-commands.test.mjs` runs the shared commands' `--help` and tests their behavior;
each skill's own commands have their tests beside the other skill tests.

**Going wrong.** A procedure that gives a command a flag it does not take sends the motor into a loop
of errors; the flags test exists to catch exactly that, across skills, prompts, playbooks and
responsibilities. A skill name in a plan's task text is fine; a command or flag there is not: planners
describe outcomes, and the organ doing the work picks the method from its skills
(`skills/plan-structuring/SKILL.md`).

The services also read skills the agent wrote for itself, from the data root's skills directory,
after every installed one, so an installed skill's id always wins (`skillDirectories` in
`agent/services/service-runtime.mjs`). The gateway builds its skill index when it starts
(`agent/services/gateway/main.mjs`), so such a skill reaches the motor only after a gateway restart. No
skill tells the agent how to write one.

## Processes

**What belongs.** A playbook: a name, a one-line description, a narrative in prose of the shape that
works (the order, what to watch for, what not to do), recall phrases (`intent_keywords`) that the plan
step matches against a goal, a status and a version. `roles/generic/processes/p-deploy-verify.json` is
a complete example. A playbook is never executed as steps (`agent/work/process-registry.mjs`); the
cortex and the planner fold it into their own plan.

**What does not.** Command syntax goes in a skill. A fixed list of steps, an organ for each step, or
where the approval gate sits belong to the mission's own plan, which the playbook only shapes. Work on
a schedule is a responsibility, which can name the playbook as its `processRef`. A working area's
facts go in its project.

**How the repo keeps it there.** For installed playbooks, `tests/content/packages.test.mjs` checks that
each parses, that its id matches its file name, that it has a name, a description and a narrative,
that it is active, and that its recall phrases are phrases. `tests/content/command-flags.test.mjs` reads
playbooks too. Nothing checks a narrative for command syntax, and a playbook the agent writes with
`process-ops` is checked only for its id (`agent/cli/process-ops.mjs`).

**Going wrong.** A playbook written as numbered commands is a skill or a responsibility in disguise:
the cortex reads it as guidance, never as steps, and nothing runs it on a schedule. A playbook that
reads as the plan itself takes control away from the planner, which then cannot adapt it to the
request. How to write one well: [guides/PROCESSES.md](../guides/PROCESSES.md).

## Projects

**What belongs.** The working area seen from above: a name, a goal, a one-line description, and
context entries that are durable resource references or working conventions, one per key, each
`{ kind, ref, url, name, summary }` with a kind of `drive_folder`, `doc`, `sheet`, `slides`, `url`,
`repo`, `git`, `resource` or `convention` (`agent/work/project-context.mjs`). Also: canon entries
(facts every mission in the project must not contradict, shown before the rest of its context), a
deploy target (`agent/work/deploy-target.mjs`), linked playbooks (`standardProcesses`), and its parent
and dependencies.

**What does not.** One mission's particulars, its history, its attempts and failures, a snapshot of
state, steps or a plan: those belong in the mission's envelope and tree, or in a process. The
mission's resource ledger stays on the mission (`NOT_PROJECT_CONTEXT` in `agent/work/projects.mjs`);
identifiers worth keeping beyond it go to Core Memory's `resources` category during consolidation.

**How the code keeps it there.** One validator, `validateContextEntry`, refuses a key that is not a
plain slug; a key that names state, history, failures, logs, a snapshot, attempts, debugging, to-dos,
tasks, steps, a plan file, a workflow, a procedure or a process; a bare value instead of a packet; an
unknown kind; and a packet with nothing in it. `project-manage` applies it to every context write
(`agent/cli/project-manage.mjs`), and so does the step that offers a finished mission's new context
to its project (`suggestContextPromotions` in `agent/work/projects.mjs`). The brain also writes one
key itself, `artifacts`, the latest artifact manifest, when a mission publishes
(`agent/work/artifacts.mjs`).

**Going wrong.** A key such as `deploy_steps` or `last_attempt` is refused: steps are a process and
attempts are a mission's history. A decision made for one deliverable, stored as project context,
becomes a standing fact every later mission in the project obeys.

## Responsibilities

**What belongs.** When it fires (a five-field cron and an IANA timezone, or an event), the instruction,
the success criteria, and a context with the purpose, the process steps, reference files and prior
learnings; optionally the playbook it follows (`processRef`), whether it may run twice at once
(`singleton`), the floor between firings, whether a person may run it now (`triggerable`), and whether
it may change only memory (`effect_scope`). The record's shape is
`agent/work/responsibility-schema.mjs`. A firing starts with no conversation, so its process steps are
written for a mission that knows nothing else (`prompts/cortex.md`), and they may name the exact
commands the firing runs: the installed ones do (`roles/generic/responsibilities.json`), and the flags
test checks those commands.

**What does not.** A one-off request is a mission. Know-how worth reusing outside the schedule is a
process, linked by `processRef`. What each run learned goes to the learnings overlay, which the brain
appends to after each completed run (`feedResponsibilityLearnings` in
`agent/services/brain/completion.mjs`), never into the installed file. A change to an installed
responsibility is an override in the agent's store, never an edit of the installed file, which the
next upgrade replaces (`agent/work/responsibility-store.mjs`).

**How the code keeps it there.** The store validates every record the agent or the dashboard writes:
the schema, cron forms the scheduler can read, a known timezone, at least 15 minutes between firings
of a schedule the agent writes, at most 25 responsibilities of its own, and no change to a `locked`
default (`responsibility_store` in the contracts). An invalid record is skipped and the installed
default keeps running. `tests/content/packages.test.mjs` validates every installed responsibility and
checks that its `processRef` names an installed playbook. How to write one, and what the scheduler
guarantees: [guides/RESPONSIBILITIES.md](../guides/RESPONSIBILITIES.md).

## Role packages

**What belongs.** What makes a role a focus with a few heavier tools: `role.json` (the Workspace flag,
the role's extra skills, its Google Cloud grants at least privilege, the APIs it needs, its setup
packages), domain-rule appends to the organ prompts, skills only this role uses, the playbooks and
responsibilities it starts with, and its first working memory (`memory.md`, copied into place once,
when there is none: `seed_memory` in `install/bootstrap.sh`). The format and the grant rules are in
[roles/README.md](../../roles/README.md); how to write one well is in
[guides/ROLES.md](../guides/ROLES.md).

**What does not.** Anything every role needs belongs in the generic role, the base skills or the base
prompts. A role is not a different agent and has no personality of its own. Organization-specific
values never ship in a role: an instance learns them at runtime as projects and memory. A role may not
reuse an id the generic role uses: the generic role's playbooks and responsibilities are read first
and the first id wins (`agent/work/role-packages.mjs`), so the role's copy would never load.

**How the repo keeps it there.** `tests/content/packages.test.mjs` checks every role: the shape of
`role.json`, setup packages the bootstrap can install with npm and pip versions pinned, appends only for
known organs, valid playbooks and responsibilities, a first working memory within the working-memory
target, no generic id reused, no basic role or role that hands out access, and the generic role's
upkeep `locked`. The installer refuses a role that asks for a grant outside the rules
(`install/lib/role-access.mjs`).

## Memory

Memory is a closed set of three layers, and the agent writes them:

| Layer | Holds | Where | Written by |
|---|---|---|---|
| Working memory | Short current context: the focus, active context, open items, one line per finished mission, and lessons | `MEMORY.md` under the data root | The brain appends lines; temporal-memory rewrites it during consolidation. A line that would pass the hard cap (`memory.working_memory_hard_cap_chars`) is not appended |
| Core Memory | Durable facts, each with a category, confidence and importance; identifiers in the `resources` category, one per entry | The `core_memory` collection | `core-memory-write` and `core-memory-retire`, run by temporal-memory |
| Deep Truths | The few principles confirmed across many sessions | `DEEP_TRUTHS.md` under the data root | `update-deep-truths`, run by temporal-memory |

**What does not belong.** Definitions: processes, projects, skills and responsibilities. Memory reads
them, to know what the agent already has, and records a lesson about one as memory tagged with its id;
it never edits one and never copies one in, where the copy would go stale (`prompts/temporal-memory.md`,
and step 5 of the consolidation in `roles/generic/responsibilities.json`). After a mission, the lessons
it taught about its project and its playbooks are appended to working memory, and the project and
playbooks are left as they are (`recordLessons` in `agent/services/brain/memory.mjs`).

**How the code keeps it there.** When temporal-memory runs a task (consolidation is its main one), its
tools are file reads, one memory command at a time with no shell (`MEMORY_COMMANDS`, plus read-only
views of playbooks and projects in `MEMORY_READ_VIEWS`, both in `agent/services/gateway/settings.mjs`),
and a writer for `MEMORY.md` and the consolidation report only (`MEMORY_TOOLSET` in
`agent/gateway/tools.mjs`). A memory-scoped mission's tasks run only on the memory organs: a task
planned for the motor is moved to temporal-memory (`agent/work/memory-scope.mjs`). What the code does
not fence: the motor's shell can run any installed command, memory commands included; that it leaves
memory to temporal-memory is its prompt's rule (`prompts/motor.md`).

**Going wrong.** With a full shell, a consolidation pass once rewrote project context; its tools were
narrowed to memory for that reason (`agent/gateway/tools.mjs`). A planner once split consolidation
into checkpoints that handed their triage forward in plan files memory may not write, and every later
checkpoint found nothing; consolidation is now one pass planned by code (`agent/work/memory-scope.mjs`).
A memory that work "was already done" is a claim to check, not evidence (`prompts/cortex.md`).

## The mission itself

The particulars of one piece of work stay with it: its envelope (instruction, criteria, resource
ledger, results) and the scratch in its mission tree (fetched inputs, step notes, the blackboard). What
it made leaves as its deliverable and its artifacts. Its particulars reach the project only through
the project-context validator, and memory only as its one working-memory line, its lessons, and what
consolidation later promotes into Core Memory.

## How to tell

Ask in order, and stop at the first yes:

1. Must it hold whatever a model does? Code.
2. Is it the exact syntax of a command, or how to drive a tool? A skill.
3. Is it how an organ thinks or what it returns, for every role? The organ's base prompt. Only for one
   role's domain? That role's append.
4. Does it happen on a clock or after an event? A responsibility.
5. Is it how a recurring kind of work goes well, to adapt rather than run? A process.
6. Is it a durable fact about a working area: a folder, a repository, a site, a convention? Project
   context.
7. Is it something the agent learned, or is working on now? Memory.
8. Is it true only of this one piece of work? The mission.
9. Is it one organization's value? It never enters the repo. An instance holds it in its projects,
   memory or settings.

## Content in the wrong place

| Content | Put in | Why it is wrong | Belongs in |
|---|---|---|---|
| A command and its flags | An organ prompt | It costs tokens in every turn of the organ, and it splits the command's documentation in two, so one half goes stale | The skill's SKILL.md |
| "When a deploy fails, roll back first, then report" | A skill | It is judgment about a kind of work, not how to drive a tool | A process, or the role's prompt if it is a rule the work must meet |
| Numbered commands to run every Monday | A process | Nothing runs a playbook on a schedule | A responsibility, whose steps may name commands |
| `last_attempt` or `deploy_steps` as a context key | A project | History and steps are not facts about the working area; the validator refuses them | The mission record, or a process |
| One deliverable's design choice | A project | Every later mission treats it as standing | The mission |
| An edit to an installed responsibility file | The installed file on the VM | The next upgrade replaces the file | An override in the agent's store |
| A copy of a playbook's narrative | Core Memory | It goes stale when the playbook changes, and recall already reads the playbook | Nowhere: memory records a lesson tagged with the playbook's id |
| An organization's folder id or person's name | A role package | Every install reads it | The instance's project context or memory |
| A rule that must hold every time, stated only as text | A prompt alone | A model can forget it | Code; or, if it stays a prompt rule, docs that say plainly it is a request |

## Where to read next

| Doc | For |
|---|---|
| [Culture of work](CULTURE_OF_WORK.md) | How missions use these layers |
| [Product rules](../canon/PRODUCT.md) | The rules every change keeps |
| [The guides](../guides/README.md) | Writing roles, skills, processes and responsibilities |
| [Glossary](../GLOSSARY.md) | What each word means |
