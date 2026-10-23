# Writing a role

A role is the agent's focus, chosen when an instance is installed: `generic` is the default and the
base of every role, and another role adds a focus and a few heavier tools on top of it. This guide is
for developers who add a role package to `roles/` or change one. The package's files and fields are
defined in [roles/README.md](../../roles/README.md); this guide says what the code does with each
part, how to choose the agent's grants at least privilege, how a Workspace role differs, what belongs
in a role's organ prompts, and how to check a role on a dev instance with `dev/smoke.mjs`.

## When a role, and when something else

A role is worth adding when a kind of work needs what a skill alone cannot bring: its own Google Cloud
grants, its own command-line tools on the VM, or domain rules that change how the agent plans and
judges every mission in that area. "A deploy passes only on a live 2xx" is such a rule
([build plan](../plan/BUILD_PLAN.md), section 4).

| You need | Put it in | Why |
|---|---|---|
| A procedure every instance could use | A base skill in `skills/` ([SKILLS.md](SKILLS.md)) | Every instance installs the base skills whatever its role |
| A procedure only this focus uses | A skill in the role's own `skills/` | It installs only where the role does |
| One organization's folders, people or conventions | Nothing in the repo: the agent keeps them in a project or its memory | The repo is a template every organization installs |
| A different agent for each team | Nothing: one project holds one agent, with one role | An instance keeps the role it was installed with; changing it is not a product feature ([build plan](../plan/BUILD_PLAN.md), section 14) |

The installer offers every role whose `role.json` exists in the clone it runs from
(`install/install.sh` lists them), so a new package is installable as soon as it is in the repo. The
exception is a development role, one whose `role.json` sets `listed: false`: a package for working on
this repo, such as `paraclete-h2`, which the installer installs only when `--role` names it. A role
whose code needs the repo's `dev/` tooling must be one, because `dev/` is never installed.

## The parts, and what reads them

| Part | Read by | When | What goes wrong when it is wrong |
|---|---|---|---|
| `README.md` | People | Reading the repo | Required: `tests/repo/structure.test.mjs` fails a role without one |
| `role.json`: `gcp_roles`, `apis`, `resource_roles` | `install/install.sh`, through `install/lib/role-access.mjs` | Install steps 1 to 3 | A refused grant stops the install in step 1 |
| `role.json`: `setup` | `install/bootstrap.sh`, through `install/vm/role-packages.mjs` | Every full install on the VM | A package that cannot be read or installed fails the install before anything is stopped |
| `role.json`: `listed` (optional) | `install/install.sh`, through `install/lib/role-access.mjs` `listed` | Install, step 1 and the role question | `false` leaves the role out of the role question and the list an unknown role prints; `--role` still installs it, with a note that it is a development role |
| `role.json`: `workspace` | The installer, the VM's instance record (`install/vm/instance-record.mjs`), the dashboard and the control service | Install, every boot, the Workspace setup | See [Workspace roles](#workspace-roles) |
| `role.json`: `skills` | Only `tests/content/packages.test.mjs`, which checks each listed skill exists | `npm test` | Nothing at runtime: every directory under the role's `skills/` is installed and shown to the agent, listed or not (`install/vm/launchers.mjs`, `agent/services/service-runtime.mjs`). Keep the list in step by hand |
| `prompts/<organ>.md` | The gateway, appended to that organ's base prompt (`agent/gateway/organs.mjs`) | Every turn of that organ | See [Organ prompts](#organ-prompts) |
| `skills/<id>/` | The VM's command launchers, the gateway's skill index and the brain's capability map | Install; gateway start; every mission boundary | See [SKILLS.md](SKILLS.md) |
| `processes/` | The brain's process registry (`agent/work/role-packages.mjs`, `agent/work/process-registry.mjs`) and the `process-ops` command | Brain start | See [PROCESSES.md](PROCESSES.md) |
| `responsibilities.json` | The brain's scheduler, the control service and the `responsibility-manage` command (`agent/work/responsibility-store.mjs`) | Brain start; each dashboard view | See [RESPONSIBILITIES.md](RESPONSIBILITIES.md) |
| `memory.md` | `install/bootstrap.sh` (`seed_memory`) | Only when the agent has no working memory yet | See [First working memory](#first-working-memory) |

Installed defaults are layered generic first, and the first id wins (`agent/work/role-packages.mjs`
for playbooks, `collectDefaults` in `agent/work/responsibility-store.mjs` for responsibilities). A role
playbook or responsibility that reuses one of generic's ids is therefore dropped without a word, and
`tests/content/packages.test.mjs` refuses one. Skill ids must also be unique across the base skills
and every role.

## Grants: least privilege

The agent acts as its service account, `paraclete-agent@`. A role's grants are what that account may
do beyond the base every instance has, so they are the role's blast radius. Every identity holds the
least access its job needs: that is a product rule ([product rules](../canon/PRODUCT.md)), and this
section is how a role keeps it.

### The base every instance has

Generic's `gcp_roles` (Vertex AI user, Firestore user, log writer and metric writer) go to every
instance's agent, with object admin on the instance's bucket only and access to each secret a
dashboard admin grants ([roles/generic/README.md](../../roles/generic/README.md)). Drive comes from
the VM's access scopes, not IAM. A role's `role.json` lists only what it adds to this.

### Choosing `gcp_roles`

The installer grants each one on the whole project. So:

1. **Start from the commands.** List what the role's skills run against Google Cloud, command by
   command, and the permissions each needs. A grant no procedure uses is only risk.
2. **Take the narrowest predefined role that holds those permissions,** and say why when a narrower
   one falls short. The shipped roles show the pattern (Google Cloud role names below drop their
   `roles/` prefix):

   | Role | Takes | Instead of | Because |
   |---|---|---|---|
   | `devops-engineer` | `run.admin` | `run.developer` | Making a service public needs `run.services.setIamPolicy`, which the developer role lacks |
   | `devops-engineer` | `storage.objectUser` | `storage.objectAdmin` | It reads and writes objects without changing their ACLs |
   | `security-engineer` | `orgpolicy.policyViewer` and `storage.bucketViewer` beside `iam.securityReviewer` | A broader role | The security reviewer role lacks `orgpolicy.policy.get` and `storage.buckets.get` |
   | `web-master` | `run.viewer` | `run.admin` | It only reads the Cloud Run services a site's rewrites send traffic to |

3. **Read-only work gets read-only roles.** The security engineer's four roles are all read-only: a
   remediation is for a person to run with their own access.
4. **What the account cannot do is a person's step.** Creating service accounts, granting project
   roles or creating buckets is left to a person, and the role's skills say exactly what to ask for,
   with the command ([roles/devops-engineer/README.md](../../roles/devops-engineer/README.md)).
5. **Say why, in the package.** Keys starting with `_` are documentation that
   `tests/content/packages.test.mjs` allows in `role.json`: the shipped roles explain every grant in
   `_gcp_roles_comment`, and their README has a GCP roles table with a "Why" column.

| Never in `gcp_roles` | Why | Where it is enforced |
|---|---|---|
| A basic role (`owner`, `editor`, `viewer`), or one that grants roles, administers service accounts or their keys, or turns services on and off | The agent could widen its own access | `tests/content/packages.test.mjs` only; the installer does not check this list |
| Acting as a service account, or writing to Artifact Registry (`PROJECT_WIDE_REFUSED`) | Project-wide, act-as reaches `paraclete-dashboard@`, whose signature the VM's control service obeys, and write reaches the dashboard's image repository | `install/lib/role-access.mjs`: the installer refuses the role in step 1, takes back such a grant it finds in step 3, and the test runs the same check |

A project-wide grant reaches the instance's own resources too. The DevOps Engineer's `run.admin` lets
IAM delete or replace the dashboard's own Cloud Run service; only its prompts and skills forbid
touching anything named `paraclete` or starting with `paraclete-`. When a grant reaches the instance,
say so in the README and keep the instance off limits in the prompts and skills, as that role does.
Nothing in IAM enforces it ([open items](../plan/OPEN_ITEMS.md), phase 8).

### `resource_roles`: grants on one resource

When the work needs to act as an account or push images, ask for it on a resource that is the agent's
own, never the project. `install/lib/role-access.mjs` accepts two kinds and a short list of roles for
each (`RESOURCE_KINDS`): `agent-account`, the agent's own service account, so builds and deploys run
as itself and as no other account; and `agent-repository`, the `agent-images` Docker repository the
installer creates the first time a role asks for it. Anything else is refused at install and in the
tests.

### `apis`

List the Google APIs the role's skills call that the installer does not already turn on for every
instance (`install/README.md` lists those). The installer turns each on in step 2 and never turns one
off, also when the instance moves to another role. Turning an API on grants no access.

### Grants a person makes

Some access cannot come from the installer: read access to a dataset in another project, a runtime
account the agent may act as, a GitHub token in Secret Manager. The finance analyst needs a billing
admin to grant Data Viewer on the billing export. Name each in the README under what the role needs at
install, with the command a person runs, and have the skill say what the agent asks for when the
grant is missing.

Declare in `role.json` every project grant the role's work relies on. The installer makes and takes
back only what role packages declare: when an instance moves to another role, it takes back what only
the previous role declared, and it cannot tell its own grant from the same role granted by hand
(`install/README.md`, "Moving an instance to another role").

## Workspace roles

`workspace: true` gives the agent its own Google Workspace account (see
[the glossary](../GLOSSARY.md): workspace role, Workspace account, domain-wide delegation). What the
flag changes:

| Where | What happens |
|---|---|
| The installer | Turns on the Workspace APIs and creates `paraclete-dwd@`, the account that signs tokens as the agent's Workspace account |
| The dashboard | Shows the Workspace setup wizard (`PARACLETE_WORKSPACE_ROLE`, set from the flag by `install/lib/dashboard.mjs`), where an admin connects the account |
| The VM | The control service records the account only for a flagged role (`agent/services/control/workspace-account.mjs`), writes it into the instance record and restarts the services; the bootstrap keeps it there across upgrades and reboots ([install/README.md](../../install/README.md)) |
| The agent | Once the account is recorded, Google Chat becomes a channel, and skills that carry `"requires": ["workspace"]` join the gateway's skill index (`agent/context/skill-requirements.mjs`) |

What a Workspace role package must get right:

- **The scopes are not the role's.** Every Workspace role's account gets the same list,
  `WORKSPACE_SCOPES` in `agent/auth/workspace-scopes.mjs`, which the wizard shows the admin. A role
  that needs another Workspace API is a product change there, not a role field.
- **A role skill that acts as the account says so.** Give it `"requires": ["workspace"]` so the agent
  is not shown commands that cannot work before the account exists. `tests/content/packages.test.mjs`
  refuses such a skill in a role without the flag.
- **The account arrives after install.** The first working memory says what the agent does not know
  yet (whom it assists, their timezone), and scheduled work that needs those answers ships turned off:
  the executive assistant's daily briefing does
  ([roles/executive-assistant/README.md](../../roles/executive-assistant/README.md)).
- **The Drive rule holds.** A file someone shared is read, commented on or copied, never edited, moved,
  renamed, trashed or deleted ([skills/README.md](../../skills/README.md), "Workspace skills"). Keep
  the role's prompts consistent with it.
- **Usually no project roles.** Four of the five shipped Workspace roles add no `gcp_roles` at all;
  their work happens as the Workspace account.

## Organ prompts

A role's organ prompts hold domain rules only. `roles/<id>/prompts/<organ>.md` is appended to
`prompts/<organ>.md` for that organ, after a blank line (`loadOrganPrompt` in
`agent/gateway/organs.mjs`). The file name must be an organ id (`tests/content/packages.test.mjs`).
Every shipped role appends to the same three organs:

| Organ | Its job | What the role's append says | In `roles/devops-engineer/prompts/` |
|---|---|---|---|
| cortex | Decides each step of a mission | What done means in the domain, what needs an approval gate, the stakes of its kinds of work, what is off limits, what is a person's step | A deploy passes only on a live 2xx |
| motor | Executes tasks with tools | How to act safely: as which identity, what to record before a change, what never to run | Before changing a service, record what serves now, as the way back |
| cerebellum | Verifies each checkpoint | What the tool log must show before work in the domain passes | A build passes on a final `SUCCESS` status and the image's digest read back from the registry |

What does not belong in an organ prompt:

| Not this | It belongs in | Why |
|---|---|---|
| Command syntax and flags | The skill's `SKILL.md` | Organ prompts hold no tool syntax ([prompts/README.md](../../prompts/README.md)); a flag written twice drifts |
| How a kind of work goes well, start to finish | A process playbook ([PROCESSES.md](PROCESSES.md)) | A prompt holds rules the organ must meet on every turn; how a kind of work usually goes is guidance the planner adapts to each request |
| Identifiers, people, regions | The agent's projects and memory | Template-clean |
| A rule every role needs | `prompts/<organ>.md` | It applies to every instance |

How to write the rules:

- **Give each rule its reason,** in one sentence. The legal advisor's "Assist and escalate; never give
  legal advice" says which questions are a lawyer's and what the agent does instead.
- **Make a pass checkable.** A cerebellum rule names the evidence ("the tool log holds a fetch of the
  URL people use"), so the verifier can re-derive it rather than take a claim on trust.
- **Keep it short.** The append rides on every turn of that organ. The shipped appends run from about
  700 to 2,300 characters each.
- **Start the way the shipped ones do,** with a `## Your role: <title>` heading, so the append reads
  as its own section after the base prompt.
- **Never in the generic role's package.** The gateway appends only the instance's own role's
  `prompts/` directory (`agent/services/gateway/main.mjs`), so an append in generic's package would
  reach only instances whose role is generic. Rules for every role go in the base prompts.

"Domain rules only" is a review rule: no test can tell a domain rule from tool syntax. The tests check
the file names, that no append is empty, the banned multi-agent words
(`tests/content/content-hygiene.test.mjs`), and that any flag written after a skill command's name is
one the command takes (`tests/content/command-flags.test.mjs`).

## Skills, playbooks and responsibilities

Each has its own guide: [SKILLS.md](SKILLS.md), [PROCESSES.md](PROCESSES.md) and
[RESPONSIBILITIES.md](RESPONSIBILITIES.md). What is particular to a role:

- A role's skills are its heavier tools. Eighteen of the twenty shipped role skills have no commands
  of their own: they are procedures, many of them over real command-line tools such as `gcloud`,
  `bq`, `gh` and `firebase`.
- A role's playbooks add to generic's (`p-investigate`, `p-release` and the others) and never redefine
  them. A responsibility's `processRef` may name a playbook in generic or in the role.
- A role's responsibilities stay unlocked, so a person or the agent can retime or pause them; `locked`
  is for generic's upkeep. Ship one turned on only when it is safe and useful from the first week
  without anyone's input, as the DevOps Engineer's read-only weekly review is. A role that starts with
  none ships `{ "version": 1, "responsibilities": [] }`.

## Setup packages

How `setup` is installed, and why pip installs for one user, is in
[install/README.md](../../install/README.md#packages). What a role author has to get right:

- **Name every Debian package the tools need.** `apt-get` runs without recommended packages, so a
  tool's recommendations never arrive on their own.
- **Pin npm and pip packages to one exact version.** `install/vm/role-packages.mjs` refuses a range, a
  tag or an unpinned name, and a package that generic and the role pin at two versions; the content
  tests run the same check. Move a pin in its own commit and check the tool with it; the DevOps
  Engineer's README asks for a release at least two weeks old.
- **A pip package's commands are not on the services' `PATH`;** a skill runs one as
  `python3 -m <module>`.
- **Do not list what the image has.** `gcloud`, `gsutil` and `bq` come with Debian 12's Compute Engine
  image ([roles/devops-engineer/README.md](../../roles/devops-engineer/README.md)).
- **There is no Docker.** Membership of the `docker` group is root on the VM, and rootless Docker
  needs setuid helpers the services' `NoNewPrivileges` blocks; Cloud Build builds images instead
  (same README).
- **Packages stay.** A move to another role leaves the previous role's packages installed.

## First working memory

`memory.md` becomes the agent's `MEMORY.md` only when it has none (`seed_memory` in
`install/bootstrap.sh`, which falls back to generic's when the role has no file). So a change to it
reaches new instances only, never a running one, and not one that moves to the role.

- **Fit the budget.** `tests/content/packages.test.mjs` holds it to the contracts'
  `memory.working_memory_target_chars` (2,000 characters).
- **Use the sections the nightly consolidation writes:** `## Current Focus`, `## Active Context` and
  `## Open Items` (step 10 of `r-memory-consolidation` in `roles/generic/responsibilities.json`).
- **Say what the agent has yet to learn,** and when to ask: the shipped seeds name the facts each role
  needs from its people (regions to use, whom it assists) and say to ask on first need.

## Testing a role

1. **Run the tests.** `npm test`, or `node --test tests/repo/*.test.mjs tests/content/*.test.mjs` for
   the package checks alone. For a role, `tests/content/packages.test.mjs` checks the shape of
   `role.json`, that its grants and APIs pass `install/lib/role-access.mjs`, that its packages are
   installable and pinned, its prompt files, every playbook and responsibility, its first memory's size,
   and the id clashes above.
2. **Give the role a smoke request.** Add an entry to `SMOKE_REQUESTS` in `dev/smoke.mjs`: a request in
   the role's area that changes nothing, answerable on any instance, with `expect` patterns a correct
   answer must match. A role without an entry gets the generic request, or for a Workspace role a read
   of its own calendar. `tests/dev/smoke.test.mjs` checks that every request's wording is read-only
   ("change nothing", or a "Find out" research question) and that every pattern compiles.
3. **Put the role on your dev instance.** Install a fresh project with
   `install/install.sh --role <id> --ref <branch>`, or move your dev instance to the role and reinstall
   its VM ([DEVELOPING.md](../../DEVELOPING.md), section 7, "Checking another role on the same dev
   instance"). Read the installer's output for the grants and APIs it made.
4. **For a Workspace role, connect the account first,** through the dashboard's setup wizard. When it
   reads the role from the VM, the smoke test refuses to send anything while the instance record has
   no Workspace account.
5. **Run `node dev/smoke.mjs`.** It reads the role from the VM, sends the request as a dashboard message
   in a thread of its own, and follows it for up to 900 seconds. PASS means the mission completed, its
   result was delivered, and the answer matches every pattern. A question back, an approval gate, a
   failure or no answer in time is a FAIL with the reason: a smoke request must need no one. Add checks
   with `--request "<text>" --expect <regex>`; for a Workspace role, `--doc <link>` asks for a summary
   of a Google Doc instead ([dev/README.md](../../dev/README.md)).
6. **Read the evidence.** The command prints the mission's id; `node dev/query.mjs work --doc <id>`
   shows it, and `node dev/logs.mjs brain` the brain's account of it.

## Checklist

- [ ] The role is a focus with its own grants, tools or domain rules, not one organization's setup
- [ ] `README.md` follows the shipped roles: a parts table, what it adds to generic, its grants with
      why, what a person sets up, its packages, its files
- [ ] Every `gcp_roles` entry is used by a procedure, is the narrowest that works, and is explained
- [ ] Act-as and image push, if needed, are `resource_roles` on the agent's own account or repository
- [ ] What a project-wide grant reaches of the instance itself is written down, and the prompts and
      skills keep the instance off limits
- [ ] Prompts hold domain rules with their reasons; no command syntax, no identifiers
- [ ] No playbook, responsibility or skill id reuses one that exists
- [ ] Packages are named in full; npm and pip pinned
- [ ] `memory.md` fits 2,000 characters and says what the agent must still learn
- [ ] A row in the roles table of [roles/README.md](../../roles/README.md)
- [ ] An entry in `SMOKE_REQUESTS`, and a PASS on a dev instance
