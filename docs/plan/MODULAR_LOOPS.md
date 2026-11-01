# Modular self-improvement: one loop per module

The self-improvement loop (`dev/loop/`) improves the agent one change at a time, and judges every
change on the whole model suite. This plan changes that. The product is split into **modules**: a
brain organ, a role, a skill, a tool. Each module gets its own **lane**: a loop that may change only
that module's files, and is judged on the tasks that module affects. Several lanes then run in
parallel. Canaries run long, realistic jobs aimed at one capability, such as memory recall or
verification.

It has three parts:

- **Assessment:** where the repo and the lab stand today, on 2026-11-01 at 51ea1d9.
- **Design:** modules, lanes and the measurement they need.
- **Phases:** the order of the work, each with a test that says it is done.

Paths in `code font` exist today. Paths in *italics* are proposed.

---

## 1. Assessment

### 1.1 The measurement cannot see most module changes

Three defects in how changes are measured matter more than the file layout. A cleaner layout gains
nothing until they are fixed.

1. **A measured run does not run the candidate's code.**
   - `dev/harness2/live-runner.mjs` and `dev/harness2/model-runs.mjs` import `buildBrain` and
     `buildGateway` statically, from the harness's own checkout.
   - So both sides of a measurement run main's brain, gateway, context and work code. Only the
     prompts, skills, roles, contracts and the commands the motor launches come from the side.
   - A change to organ code (recall ranking in `agent/context/work-recall.mjs`, verification in
     `agent/organs/cerebellum/verify.mjs`) is measured as no change. The code changes the loop
     measured so far (#71, #87) were measured this way.
2. **What a change affects is a yes or no.**
   - `isBehaviourPath` in `dev/loop/config.mjs` decides whether a change is measured, and a yes runs
     every task: 15 tasks, 45 runs a side, about 12 hours.
   - Nothing maps a path to the tasks it affects. The product's loading rules imply one:
     `roles/<r>/` reaches only role r's tasks.
   - The guard (`dev/loop/guard.mjs`) refuses a pull request as stale once main changes *any*
     behaviour path. A cycle waits for every open loop pull request before it measures. So one
     change is in flight, by rule.
3. **The suite cannot test what organs do.**
   - Every rollout starts with an empty Firestore and seeds workspace files only. Recall across
     missions cannot be measured at all.
   - Tasks run twice in a baseline, so a check that fails once looks like a target. Two of the
     three tasks the loop targeted were noise.
   - One network error aborts a whole run: the first version 4 baseline was lost after 3.4 hours
     this way.
   - Checks timed by the wall clock (`se-perf-latest-per-id`) are biased by load, which parallel
     lanes would add.

### 1.2 The brain is organized by stage, not by organ

The brain has six organs: cortex (decides each next step), prefrontal (analyzes the work and plans
checkpoints), motor (runs tasks with tools), cerebellum (verifies checkpoints and the answer),
temporal-memory (recall and consolidation) and temporal-research (outside research).

No organ has a module of its own. An organ is made of four kinds of pieces:

- **Its definition:** one entry in `agent/gateway/organs.mjs` (tier, toolset, sampling).
- **Its prompt:** `prompts/<organ>.md`, with appends in `roles/<id>/prompts/<organ>.md`.
- **Its toolset:** a constant in `agent/gateway/tools.mjs`.
- **Its logic:** spread across the brain service, `agent/work/`, `agent/context/` and
  `agent/providers/`, wherever code calls the organ.

| Organ | Closest thing to its own code | What it shares with other organs |
|---|---|---|
| cerebellum | `agent/organs/cerebellum/verify.mjs` (379 lines) and `agent/organs/cerebellum/verdict.mjs` | the verdict tools in `tools.mjs`; the answer check in `actions/synthesize.mjs` |
| temporal-memory | `agent/services/brain/memory.mjs` (353), `agent/context/work-recall.mjs`, `agent/context/core-memory-rank.mjs`, `agent/context/context-maintenance.mjs` | the memory tools in `tools.mjs`; the memory fence in `checkpoint-executor.mjs`; `agent/work/memory-scope.mjs` |
| prefrontal | none | `prompt-assembly.mjs`, `envelope-runner.mjs`, `actions/checkpoint-plan.mjs`, `agent/work/checkpoint-spine.mjs` |
| motor | none | `agent/work/checkpoint-executor.mjs` (960), `agent/work/task-outcome.mjs`, `tools.mjs` |
| cortex | the move handlers in `agent/services/brain/actions/` | `prompt-assembly.mjs` (584), `envelope-runner.mjs` (600), `agent/providers/vertex-text.mjs` (548) |
| temporal-research | none: it appears only as a name in lists | the motor's executor path |

What keeps organs from separating:

- **Shared files mix several organs.** Six of the largest files each hold the logic of two to four
  organs. Examples: `actions/checkpoint-plan.mjs` (cortex, prefrontal and memory) and
  `actions/synthesize.mjs` (cortex and cerebellum).
- **Instruction text lives in code.** About 15 code files carry text an organ reads. Examples: the
  four verifier prompts in the cerebellum's `verify.mjs`, the recall and escalation instructions in
  `memory.mjs`, the lesson prompts, and the descriptions of the verdict tools. A loop that edits only
  `prompts/<organ>.md` cannot reach any of it.
- **The shapes organs hand each other have no single home.**
  - The list of organs is written in about 11 places, the dashboard among them.
  - The plan, checkpoint and task shape is written in at least 7, with fields renamed between them.
  - The cerebellum's attack duty is written in 4: `prompts/cerebellum.md`,
    `skills/verification/SKILL.md`, the cerebellum's `verify.mjs` and `synthesize.mjs`.
- **Tunables, skills and tests are single shared files.**
  - `config/contracts.json` (306 lines) holds every organ's tunables.
  - One skill index is shared by every organ with tools.
  - Fixtures script all six organs at once (`tests/agent/services/brain/harness.mjs`), and
    `checkpoint-executor.test.mjs` (842 lines) tests three organs.
- **Paths are fixed in many places.** The package table in `agent/README.md` (enforced by
  `tests/repo/boundaries.test.mjs`) and the brain-to-gateway HTTP boundary decide where code may
  live. The prompts directory is named in the gateway, control, the manifest and
  `tests/content/packages.test.mjs`.

### 1.3 Roles and skills are already nearly modules

- **Roles and skills are found by scanning directories,** with no registry at run time: 13 roles, 44
  skill packages, 56 commands.
- **Procedure-only skills and most role content need no new layout,** only rules.
- **What ties them to other modules:**
  - **Central tests a loop may not edit:** `tests/content/packages.test.mjs` (about 320 generated
    cases), `tests/content/skill-commands.test.mjs`, and the role lists written into
    `tests/install/install.test.mjs`.
  - **Skills import each other.** Examples: the drive commands' helpers, and the docs helpers that
    the sheets and slides commands use. No boundary test checks these imports.
  - **Skill text names commands other modules own,** in 292 places. `drive-export` alone is named in
    14 other modules.
  - **`role.json` is a referee file,** so a role's lane cannot change its own grants or packages.
  - **`roles/generic/` is the implicit base of every role.**
- **Gateway tools** (9, in three toolsets) all live in `agent/gateway/tools.mjs` (717 lines), which
  the older harness treats as untouchable.

### 1.4 The loop and the lab run one change at a time

- **Measurement and planning:**
  - The planner, the baseline (`.local/loop/baseline.json`), the daily cap and the issue queue are
    global.
  - The planner refuses a baseline once any behaviour path changed after it.
- **Merging:**
  - The merger (`dev/loop/merger.mjs`) merges one pull request a run and three a day.
  - It waits on main's CI after each merge.
  - One pause switch and one revert count cover every loop.
- **On the driver:**
  - `clearStaleCheckouts` in `dev/loop/cycle.mjs` removes every cycle's temporary checkouts, so a
    second cycle running at once would delete the first one's.
  - Every cycle runs git in one shared checkout.
  - `dev/harness2/lab-follow-main.sh` does not recognize a running loop cycle, and can move that
    checkout under it.
- **Canary:** there is one canary, and it runs one read-only smoke request (`dev/smoke.mjs`).
- **The referee has gaps.** The loop may never change the files that judge it, but several judging
  files are missing from that list: `dev/harness2/live-runner.mjs`, `dev/harness2/substrate.mjs`,
  `dev/harness2/cli.mjs`, `dev/smoke.mjs` and the release-check helpers.

### 1.5 The shared files where parallel changes would collide

Since 2026-10-17, 68 commits changed product code. Of those:

- 41 also edited at least one shared file: `docs/plan/BUILD_PLAN.md`, `docs/plan/OPEN_ITEMS.md`,
  `docs/GLOSSARY.md`, `config/contracts.json`.
- 30 touched two or more modules, as this plan would draw them, and 11 touched five or more.
- The planner makes every loop change edit `docs/plan/OPEN_ITEMS.md`, so two lanes would conflict
  on it every time.

### 1.6 What already exists to build on

- **The older harness's mutable surface** (`dev/harness2/surface.mjs`) already partitions prompt,
  skill and role text into seven components.
- **Its curriculum** (`dev/harness2/curriculum.mjs`) already describes units as an organ, role or
  skill with a target path.
- **Harvesting** (`dev/harness2/harvest.mjs`) already turns production missions into tasks.
- **The loop's spine** works well and carries over unchanged in kind: the guard, sentinel reverts,
  the pause, releases gated on the canary, and refusals the next attempt reads.

---

## 2. Design

### 2.1 A module, and the rule that makes lanes safe

A module is a set of files that one lane owns. The registry, `dev/loop/modules.json`, names each
module's:

- **id and kind:** organ, skill, role, tool or platform;
- **owned paths:** globs covering its code, its instruction text, its schemas, its config fragment,
  its tests and its backlog;
- **capabilities:** what it affects, such as `verification`, `memory.recall`, `planning` or
  `role:designer`;
- **lane settings:** trials, budget, and the daily cap.

The registry is a referee file: a lane can never redraw its own boundaries.

Three rules follow from it:

1. **Every product file belongs to exactly one module.** A repo test checks this.
2. **A lane's change may touch only its module's files.** It may add new files under its globs,
   including new tests in its test directory. The guard checks this from the issue's module marker.
3. **What modules hand each other are interfaces, owned by a person.** Changing an interface is a
   change across modules. It goes through review, not a lane.

**Platform modules** are the deterministic spine: the mission loop, the executor, the gateway's turn
runner, storage, auth, release, install, the dashboard and the services. They have owners and tests,
but no lane at first. The product rule "code moves data and enforces the rules; models think" maps
onto this split: organs think, and the platform moves data.

### 2.2 Organs as modules

Each organ gets a directory of its own, *agent/organs/<organ>/*, holding:

| File | What it holds | Where it comes from today |
|---|---|---|
| *organ.json* | job, tier, toolset, sampling, token limit, the schemas it answers with | the `ORGANS` entry in `agent/gateway/organs.mjs` |
| *prompt.md* | the base prompt | `prompts/<organ>.md` |
| *texts/* | every other instruction the organ reads, one file each (the verifier's four passes, the recall escalation, the lesson prompts, the verdict tool descriptions) | strings inside about 15 code files |
| *config.json* | its tunables, merged into the contracts under its own key | its keys in `config/contracts.json` |
| *.mjs files | the organ's own decisions, with input and output passed in: recall ranking, verdict reading, plan linting, the motor's retry policy | the shared files in 1.2 |

Its tests live in *tests/agent/organs/<organ>/*. Role appends stay where they are, in
`roles/<id>/prompts/<organ>.md`, and belong to the role's module.

Two homes come with it:

- **Interfaces** get one home, *agent/interfaces/*: JSON Schemas for the organ list, the Brief, the
  plan, checkpoint and task shape, the verdict, the recall packet, the escalation, the resource fact,
  the step types and the stakes. Every other copy is generated from it or tested against it. That
  includes the skill text, the dashboard's organ list and the harness's lists.
- **The spine** keeps the wiring. It loads each *organ.json* through one registry, calls an organ
  through the gateway, and hands organ code what it needs. An organ module never imports another
  organ: it imports interfaces only.

The package table in `agent/README.md` gains this rule:

- *agent/organs/* may import *agent/interfaces/*, and the helpers `agent/context/` and
  `agent/providers/` already offer.
- It is imported by the brain service, `agent/work/` and the gateway. The gateway stays reachable
  from the brain over HTTP only.

**Splitting the shared files, organ by organ:**

| File | Splits into |
|---|---|
| `prompt-assembly.mjs` | cortex blocks; prefrontal blocks; a spine part that orders them |
| `actions/checkpoint-plan.mjs` | the cortex's move; the prefrontal's planner; the memory-mission plan |
| `actions/synthesize.mjs` | the cortex's answer; the cerebellum's answer check |
| `checkpoint-executor.mjs` | the dispatch spine; the motor's policy (resource precedence, retry guidance, outcome checks); the memory fence |
| `tools.mjs` | one file per tool, in *agent/gateway/tools/*; toolsets named in *organ.json* |
| `memory.mjs` | gathering (spine); ranking and the recall instructions (temporal-memory) |

### 2.3 Roles, skills and tools as modules

- **A role module** owns `roles/<id>/**` except `role.json`, which stays person-owned because it
  holds grants. It also owns *tests/roles/<id>/* and its own smoke requests, split out of
  `dev/smoke.mjs`. Its capability is `role:<id>`, so its lane runs only that role's tasks.
  - `roles/generic/` is a shared module, measured on every role, like an organ.
- **A skill module** owns `skills/<id>/**`, or `roles/<r>/skills/<id>/**`, with *tests/skills/<id>/*
  and any provider file only it uses.
  - Helpers that skills share move into a skill library module.
  - Skills then import only that library and the command runtime, and a boundary test checks it.
  - The central skill tests split into one generated test per package.
- **Tool modules** become possible once `tools.mjs` is split into one file per tool.

### 2.4 Measurement per module

A lane is judged at four tiers, cheapest first.

| Tier | What runs | Cost | Who uses it |
|---|---|---|---|
| 1. **Bench** | an organ called directly through the real gateway, on recorded inputs, scored by code | seconds per item; hundreds of trials an hour | organ lanes: the target and the gain |
| 2. **Capability missions** | whole missions tagged with a capability, with seeded state | about 8 minutes a run | each lane's own tasks |
| 3. **Integration guard** | a sample of the whole suite, and the daily baseline on main | hours | regressions across modules |
| 4. **Canary scenarios** | scripted jobs over hours or days on a live instance | days | long-horizon capability, the release gate, harvesting new tasks |

**Benches** answer the question the suite cannot: did this organ get better at its job? Examples:

- **cerebellum:** checkpoints with a planted defect (must fail) and clean ones (must pass). Score the
  catch rate and the false-fail rate.
- **temporal-memory recall:** a store of memories and a request. The packet must hold the facts that
  matter and leave out the ones that don't, and must escalate only when the history is needed.
- **prefrontal:** requests whose plans are scored on shape, order, dependencies and whether their
  criteria can be checked.

Bench items come from recorded contexts of real missions, scrubbed of identifiers, and from failures
the canaries harvest.

**Each module names its tasks through capability tags.**

- Each model-suite task and bench item carries its capabilities.
- Each module names the capabilities it affects.
- The tasks a change affects are its module's own tasks, plus a guard sample for the shared modules
  that every mission passes through (organs, `roles/generic`, platform).

The evidence records what was measured: the module, the task set, and the registry's version. The
guard then checks that the evidence covers every task the change's files affect, on the current
suite version. Neither is checked today.

**Statistics:**

- A target is confirmed before it becomes an issue, by running it again on main.
- A run that fails for infrastructure reasons is retried, or counted as not evaluated. It never
  aborts the measurement.
- The two sides run interleaved, task by task, so load and quota drift fall on both equally.

### 2.5 Lanes in parallel

- **One lane per module.** Each lane has:
  - its own issue label (*loop:<module>*);
  - a planner scoped to its failing tasks and its backlog (*docs/plan/modules/<module>.md*, in place
    of the shared open-items file);
  - its own baseline rows;
  - its own branches (*loop/<module>/<issue>-<slug>*), cycle records, daily cap and pause.
  - The global pause still stops every lane.
- **Optimistic merging, checked again before it lands:**
  - Two organ changes both affect every mission, so serializing on "stale" would serialize
    everything again.
  - Instead, a pull request whose base moved is checked again on the new main, at its cheapest
    sufficient tier: its bench, or its capability tasks. It merges if it still wins and still passes
    the guard sample.
  - The daily baseline on main runs the integration guard. When it finds a regression, the sentinel
    walks back through the day's merges and reverts the one that caused it.
- **The merger becomes a merge queue:**
  - several merges a run, each guarded again against the main before it;
  - pull requests brought up to date with main by the merger itself;
  - caps for each lane.
- **The driver:**
  - one clone and one lock for each lane;
  - `clearStaleCheckouts` removes only a dead cycle's checkouts;
  - a systemd template unit, *paraclete-loop@<module>*;
  - follow-main recognizes a running loop cycle;
  - one semaphore across the machine for rollouts and model quota.
  - Start with two lanes on the existing driver, and add a driver VM only when quota or CPU binds.

### 2.6 Canaries for capabilities

- **A scenario runner drives an instance through a script,** in the way `dev/say.mjs` does, and
  checks the outcomes. Examples:
  - Tell it three facts on Monday, then ask for them on Wednesday.
  - Ask for work whose obvious answer is wrong, and check that verification catches it.
- **Each module has a battery of scenarios.** One canary instance can run several modules'
  batteries. Each canary needs a project of its own (one project, one paraclete).
- **Canaries run main's head, not a branch.** They gate releases, and their failures are harvested
  into bench items and tasks. That grows the benchmark from real use instead of by hand, which is the
  fix for saturation: four suite versions in nine days, all written by hand.

---

## 3. Phases

The restructuring is done by people (or a coding agent under review), not by lanes. It moves
existing tests and referee files, which a lane may never change. The lab stays stopped until
phase 2's first two organs are done.

| Phase | Work | Done when |
|---|---|---|
| **0. Fix the instrument** | Each side runs its own product code, in a rollout process that imports the brain and gateway from the side. Retry transient errors; a failed rollout counts as not evaluated. Interleave the sides. Confirm a target before planning it. The guard checks the evidence's coverage and suite version. Close the referee gaps in 1.4. | A deliberately broken brain function on the candidate side is refused as a regression. A baseline survives an injected network fault. |
| **1. Registry and ownership** (no files move) | Write `dev/loop/modules.json`, starting from `dev/harness2/surface.mjs`'s components: six organ modules (globs over today's files), the role and skill modules, and platform modules. Add the ownership test, and the lane rule to the cycle and the guard. Tag the model suite's tasks with capabilities. Add module, lane and bench to `docs/GLOSSARY.md`. | Every product file is owned exactly once. A lane change outside its globs is refused. |
| **2. Organ modules** | Build *agent/interfaces/*, then *agent/organs/<organ>/*, one organ at a time: cerebellum and temporal-memory first, then prefrontal, motor, cortex and temporal-research. Move the prompts, the text held in code, the definitions and the config fragments, then split the shared files (2.2). Split the shared fixtures and tests per organ. Give each organ its own backlog. | A repo test finds no instruction text for an organ outside its directory. Any one organ's behaviour can change through its own directory alone. |
| **3. Benches and capability tasks** | The bench runner, and benches for the cerebellum, recall and the prefrontal. Tasks that seed stored state, and tasks that span several missions. Training tasks for the four roles that have only held-out tasks. | Each pilot organ's bench can tell a 5-point change from noise in under an hour. |
| **4. Two lanes in parallel** | The lane runner (2.5), the merge queue, and the sentinel's walk back through merges. Pilot: cerebellum (verification) and temporal-memory (recall). | Both lanes run at once for a week, each merges a measured gain, and no regression stays on main past the next daily baseline. |
| **5. Capability canaries** | The scenario runner, memory and verification batteries, and harvesting their failures into the pilot lanes' backlogs. | The memory battery runs daily on a canary, and its failures arrive as bench items. |
| **6. More lanes** | Roles (each measured on its own tasks), procedure-only skills, then skills with commands once the skill library and the per-package tests exist, then tools once `tools.mjs` is split. Prefrontal, motor and cortex lanes once their benches exist. | Lanes are added by registry entry, without changes to the loop. |

**Progress:**

- **Phase 0, code:** done.
  - #96: each side runs its own product code.
  - #97: runs survive infrastructure errors, and the sides take turns task by task.
  - #98: a failing task is confirmed before it is targeted, evidence must cover what it measures, and all of `dev/harness2/` is the referee.
  - Its exit test on the lab driver is still to run.
- **Phase 1:** the registry, the ownership test (`tests/dev/loop/modules.test.mjs`), the lane rule in the cycle and the guard, and measurement scoped to the tasks a change reaches (a role's files reach only that role's tasks). The capability tags on tasks wait for phase 3, where benches and organ tasks give them something to select: until then every organ's change reaches every task.

**Throughput, roughly:**

- Today: one change in about 12 hours, at best about 1.5 a day.
- After phase 4: a bench-tier attempt takes under an hour. Two lanes could make 6 to 10 attempts a
  day between them, with the expensive tiers run once a day on main rather than once for each change.

## 4. Risks

- **The move breaks running instances.** Prompts and code change paths between releases. Instances
  install whole commits, so a moved file arrives with its new readers. A release that moves files is
  still deployed to the canary and checked before it is tagged, as any release is.
- **Benches drift from real use.** A lane can overfit a bench, as #71 overfit a task. Benches are
  referee files, refreshed from harvested missions, and an organ's gain must also hold on its
  capability missions (tier 2) before it merges.
- **Optimistic merging lets an interaction through for up to a day.** The daily integration guard
  and the sentinel's walk back bound it. Releases still wait for a healthy main and a passing canary.
- **Quota.** Parallel lanes share one project's model quota. The semaphore in 2.5 meters it, and
  sides that run interleaved keep the quota fair to both.

## 5. Decisions for the developer

1. **Where organs live:** *agent/organs/<organ>/*, moving the prompts out of `prompts/`
   (recommended: one directory per lane), or keeping `prompts/` and adding code beside it.
2. **The pilot organs:** cerebellum and temporal-memory (recommended: they are the closest to modules
   already, and they are the two capabilities named in the request).
3. **Canaries:** how many, since each needs a project of its own.
4. **Order:** phase 0 can start at once. It changes only the harness, and is worth having whatever
   layout is chosen.
