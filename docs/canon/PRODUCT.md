# Product rules

These are the rules every change to paraclete keeps. They cover what an instance is, where
configuration lives, how code reaches a VM, what fences the agent in, where the dashboard stops, and
how work moves. Read them before you design a change and when you review one. The qualities the
agent's brain must have are in [BRAIN.md](BRAIN.md); how the canon is written and changed is in
[README.md](README.md).

Each rule gives the rule, why it exists, and where it is kept. "Kept by" names the code, test or
script that holds the rule; when nothing enforces a rule, or only a prompt does, the rule says so.

## What an instance is

### P-1. One Google Cloud project holds one paraclete

An [instance](../GLOSSARY.md) is the whole project: one VM named `paraclete`, one Cloud Run service
named `paraclete`, one Firestore database, one bucket named `<project>-paraclete`, and three service
accounts, `paraclete-agent@`, `paraclete-dashboard@` and `paraclete-dwd@` (the last only on a
[workspace role](../GLOSSARY.md)). Firestore collections sit at the root, with no agent id in any path.

- **Why.** One agent per project means nothing needs an agent id: not a collection path, a resource
  name or an IAM binding. The project's boundary is the instance's boundary for billing, access and
  deletion.
- **Kept by.** Every resource name is defined once, in `install/lib/names.sh`, which `install/install.sh`
  and `install/uninstall.sh` both read. Collection names are defined once, in
  `agent/storage/collections.mjs`. Re-running `install/install.sh` on a project that has an instance
  repairs it: the role, the agent's name and the region default to the existing VM's, so a re-run never
  makes a second agent or a second dashboard.

### P-2. An instance lives inside its project

The agent's work and data stay in the project: Firestore, the bucket, Secret Manager, and models on
Vertex AI called as the project. Beyond Google's own APIs, the only service the product depends on is
GitHub: the VM downloads its release from it, and the dashboard reads its list of releases. Installing
also downloads packages from Debian, NodeSource, npm and, for roles that pin Python packages, PyPI.

- **Why.** An owner installs paraclete into their own project and owns what it holds. Nothing an
  instance needs runs on someone else's servers, nothing reports to a vendor, and deleting the project
  deletes the instance.
- **Kept by.** Nothing tests this; reviews do. The outside addresses the product calls are GitHub's in
  `agent/release/versions.mjs`, `install/bootstrap.sh` and `install/upgrade.sh`, and the package
  sources in `install/bootstrap.sh`. A change that adds another outside dependency changes this rule.
  The agent reaching the web for a mission (a link a person shared, a web search) is work, not a
  dependency.

### P-3. Each instance has one role, and `generic` is the base of every role

A [role](../GLOSSARY.md) is chosen at install. An instance gets the `generic` role package plus its
own. A role adds a focus and a few tools to the generic agent; its prompts hold domain rules only. The
package format is [roles/README.md](../../roles/README.md).

- **Why.** One agent with one focus is easier to trust, test and support than an agent that changes
  shape. Building every role on `generic` means every agent has the same base skills, playbooks and
  upkeep.
- **Kept by.** `install/manifest.txt` installs `generic` and the instance's role, nothing else.
  `agent/work/role-packages.mjs` reads `generic` first. `tests/content/packages.test.mjs` keeps
  `generic` the plain base (no Workspace account, no skills of its own) and every role's package
  valid. Changing an instance's role is not a product feature
  ([build plan](../plan/BUILD_PLAN.md), section 14); the developer's role move is in
  [install/README.md](../../install/README.md).

### P-4. The agent runs on Gemini; Claude runs only when an admin turns it on

The cortex (the organ that decides each step) and the [strong tier](../GLOSSARY.md) run on Gemini
until a [dashboard admin](../GLOSSARY.md) turns Claude on with a model that passed the Models tab's
Test. The [fallback model](../GLOSSARY.md) is always Gemini.

- **Why.** Claude needs the owner to accept Anthropic's terms in Model Garden, and is billed
  separately. An instance must work out of the box without either.
- **Kept by.** Only a stored `true` turns Claude on (`agent/services/gateway/settings.mjs`).
  `agent/services/control/models.mjs` stores a Claude model only when the contracts list it, and the
  Models tab offers the switch only for a model that answered a test in the last hour
  (`dashboard/components/settings/models-settings.js`). `config/contracts.mjs` refuses contracts whose
  fallback models are not Gemini.

### P-5. The repo holds nothing of any one organization

No organization's names, project ids, email addresses, domains, Drive ids or instance URLs appear in
the repo. Examples use placeholders: `your-gcp-project`, `agent@example.com`, `example.com`.

- **Why.** The repo is public, and any organization installs it. A value from one organization is a
  leak for that organization and a bug for every other.
- **Kept by.** `tests/repo/hygiene.test.mjs` fails on any email address outside the placeholder
  domains, and on any name in each developer's private denylist
  ([DEVELOPING.md](../../DEVELOPING.md), section 6).

## Configuration

### P-6. A value used in more than one place lives in `config/contracts.json`

Model tiers, budgets, timeouts, limits and intervals come from `config/contracts.json`, and every
place that uses one reads it from there. Library packages in `agent/` read no configuration: the
services and the commands load it and pass values down. Three kinds of setting each have one home:
product defaults in `config/contracts.json` (changed by a release), the instance's identity in
`/etc/paraclete/instance.json` (written at install, read through `config/instance.mjs`), and what an
admin changes in the `settings` document of the Firestore `config` collection.
[config/README.md](../../config/README.md) has the details.

- **Why.** Two copies of a value drift apart, and the one that wins is whichever the code happens to
  read. One source makes a change one edit.
- **Kept by.** `tests/repo/boundaries.test.mjs` lets only `services/` and `cli/` read `config/`. The
  dashboard imports the JSON itself, never `config/*.mjs` (`tests/repo/dashboard-boundaries.test.mjs`).
  Nothing detects a second, hardcoded copy of a contracts value; reviews do.

### P-7. A bad configuration stops a service before it works

The contracts are checked when every service and command starts, and again when a release is staged,
before anything is stopped. The checks include the storage ceilings (the mission context budget is at
most 125,000 tokens, because it is stored on a Firestore document of at most 1 MiB), that the gateway
binds to loopback only, and that the archival sweep can never cancel a timed wait. The instance record
is checked the same way.

- **Why.** A service that starts on bad configuration fails later, inside someone's mission. A
  failure at start costs seconds and names its cause.
- **Kept by.** `validateContracts()` in `config/contracts.mjs`, run by `loadContracts()` from
  `agent/services/service-runtime.mjs` and `agent/cli/cli-runtime.mjs`, and by the validation gate,
  `install/vm/check-release.mjs`. `validateInstance()` in `config/instance.mjs`. A new setting that
  protects a limit gets its check in `validateContracts()`, not a comment.

### P-8. No secret in the repo, and no service-account key anywhere

No service-account key is ever created, stored or read. The VM gets tokens from its metadata server;
on a workspace role, the agent's Google account gets tokens through IAM signing as `paraclete-dwd@`
([domain-wide delegation](../GLOSSARY.md)). Secrets an admin adds live in Secret Manager only, and the
agent reads one at the moment it needs it. The one secret an instance makes for itself is the
gateway's token, created on the VM and readable only by root and the services' user.

- **Why.** A key in a file outlives the reason it was made and leaks with the file. Tokens minted at
  runtime expire on their own.
- **Kept by.** `agent/auth/metadata-token.mjs` and `agent/auth/dwd-token.mjs` (no keys).
  `dashboard/lib/server/secrets.mjs` stores a value and never reads it back; it grants the agent's
  account access to each secret alone. `skills/secrets/secret-read.mjs` prints a value to stdout and
  nowhere else. `agent/storage/file-store.mjs` refuses to hand a credential back as a file.
  `agent/context/compaction.mjs` redacts tokens and private keys from mission digests.
  `tests/repo/hygiene.test.mjs` fails on key files and `.env` files in the repo. `install/bootstrap.sh`
  creates the gateway's token once, with mode 0640.

## Install and upgrade

### P-9. A repo path is the same path on the VM, and the manifest says what is installed

Each line of `install/manifest.txt` is a repo path; it is installed at the same path under
`/opt/paraclete`. A line ending in `/` installs the whole directory. Nothing developer-only is
installed: `dev/`, `docs/`, `tests/`, `dashboard/`, `.github/` and the root guidance files never are.
A new installed file and its manifest line land in the same commit; most lines are directories, so a
new file in an installed directory needs no line of its own.

- **Why.** Imports resolve the same in a checkout and on the VM, so code that runs in the tests runs
  on the VM. A file that ships without its manifest line breaks every fresh install.
- **Kept by.** `install/vm/manifest.mjs` reads the manifest for `install/bootstrap.sh`.
  `tests/repo/structure.test.mjs` checks that every manifest path exists and that nothing
  developer-only is listed. The validation gate (`install/vm/check-release.mjs`) loads every service
  with everything it imports from the staged release, so a missing file stops the install before
  anything changes.

### P-10. The VM runs host-native services, with no containers

The agent's five services (gateway, brain, ears, mouth, control) are Node.js programs run by systemd,
each with its own unit, such as `agent/services/brain/paraclete-brain.service`. No container runtime is
installed on the VM. The dashboard is a container, on Cloud Run, outside the VM.

- **Why.** Membership of the `docker` group is root on the machine, which would let the agent rewrite
  its own installed code, and rootless containers need setuid helpers that the services'
  `NoNewPrivileges` blocks. A role that builds images builds them with Cloud Build
  (`roles/devops-engineer/role.json`).
- **Kept by.** `install/bootstrap.sh` installs the units and no container runtime. No test checks
  this.

### P-11. Every install, upgrade and migration step is safe to run twice

Running `install/install.sh` again repairs an instance and creates nothing twice. A boot that finds
its commit already installed only re-checks and restarts what needs it. A data migration is recorded
once it succeeds and is written so that a second run changes nothing. A dashboard command runs once.

- **Why.** Reboots, retries, timeouts and two admins clicking at once all repeat steps. A step that
  breaks or duplicates on its second run turns an interruption into an incident.
- **Kept by.** `tests/install/install.test.mjs` (a real run, then re-runs that create nothing again).
  `install/bootstrap.sh` (the installed-commit path, and one run at a time under a lock).
  `install/vm/migrate.mjs` and the rules in [migrations/README.md](../../migrations/README.md).
  `agent/services/control/command-queue.mjs` claims each command with a compare-and-swap before it
  runs.

### P-12. An instance runs an exact commit, and only one that passed the validation gate

The installer resolves any ref to a full 40-character commit and records it on the VM. At every boot,
the VM's startup stub runs `install/bootstrap.sh` from that commit, which keeps a release an upgrade
installed since. An upgrade from the
dashboard names a release tag or a full commit; branch names and short ids are refused, and the
upgrade runs that release's own upgrader, never the installed copy. A release is staged beside the
running one and must pass the validation gate before anything is stopped; then the services stop, the
data migrations run, and the release is swapped in. If its gateway is not ready in time, the previous
release and instance record come back.

- **Why.** A branch moves, so "installed from a branch" says nothing about what runs. A release that
  fails its checks, or fails to start, must leave the running one as it was.
- **Kept by.** `install/install.sh` and `install/upgrade.sh` (ref resolution), `install/bootstrap.sh`
  (staging, the swap and rollback), `install/vm/check-release.mjs` (the gate),
  `agent/services/control/upgrade.mjs` (the ref check, against `versioning.canonical_regex` in
  `config/contracts.json`).

### P-13. Releases are version tags, and one release runs both halves

A [release](../GLOSSARY.md) is a tag on `main` in the commit version format, `vYYYY.MM.DD.N.N`,
published by the release workflow after its tests pass. The dashboard installs a release on the VM
first, then builds and deploys the dashboard at the same commit. From the dashboard an instance moves
only forward, or installs the same release again to finish an upgrade; going back is
`install/install.sh --ref <older tag>`. An automatic update is that same upgrade, started by the
dashboard's own scheduled job instead of an admin, to the newest release only. It is on by default,
waits for an idle agent, and never moves an instance installed from a branch or commit. On a
dashboard that checks for withdrawn releases, no new install starts to a release its maintainers
withdrew (a prerelease on GitHub, after `dev/release.mjs yank`), by hand or automatically; an upgrade
to it already running finishes, and a dashboard on an older release may still install it within the
hour it keeps GitHub's list. An instance on a withdrawn release moves on to the next newer release.

- **Why.** The dashboard imports the agent's own libraries, so the two halves must run the same code.
  Moving the VM first means a failed VM upgrade leaves the dashboard as it was. Instances update
  themselves, forward only, so a bad release would reach every one of them: it is checked on a dev
  instance before it is tagged, and can be withdrawn after.
- **Kept by.** `agent/release/versions.mjs` defines versions and their order, and leaves withdrawn
  releases out of the ones a dashboard may offer; `tests/agent/release/versions.test.mjs` keeps it
  equal to `versioning.canonical_regex` in `config/contracts.json`. `dev/release-check.mjs` tags a
  head only after it deployed it to a dev instance, found its status clean and its smoke mission
  passing. `dev/release.mjs` tags only a head whose CI passed and whose subject starts with a newer
  version; `.github/workflows/release.yml` refuses a tag that is not a version or not on `main`, and a
  rerun leaves a withdrawn release as it is. `dashboard/lib/server/upgrade.mjs` runs the VM, build and
  deploy steps in order, and starts only a release newer than the installed one, or the same one
  again, after asking GitHub, every time, whether it is still published.
  `dashboard/lib/server/auto-update.mjs` starts automatic updates only through that same `startUpgrade`,
  and `tests/dashboard/lib/server/auto-update.test.mjs` checks what it decides. Every commit's subject
  starts with its version ([DEVELOPING.md](../../DEVELOPING.md), section 10); nothing checks that before the
  release tool does.

### P-14. A data migration changes data only, and the release before can still read the result

A [migration](../GLOSSARY.md) runs once per instance, as the services' own user, after the services
stop and before the new release is swapped in. It may change Firestore and the data root, never
installed code or the machine. It adds and copies before it removes, because nothing undoes it.

- **Why.** A failed upgrade starts the previous release again on whatever the migration already
  changed. Data that release cannot read would turn a failed upgrade into a broken instance.
- **Kept by.** `install/vm/migrate.mjs` (the run, the record, the strict reads) and
  `install/bootstrap.sh` (when it runs, and as which user). The format and rules are
  [migrations/README.md](../../migrations/README.md). Readability by the release before is kept by
  review and the migration's own tests, not by a check.

### P-15. The agent's own state outlives every change to its code

What the agent learns and makes lives outside the install root: memory, missions and files under the
data root, `/var/lib/paraclete`, and its responsibilities, playbooks and Core Memory in Firestore.
Installed defaults are never edited in place: the agent's own responsibilities and playbooks are
records in Firestore that override an installed default with the same id. Uninstalling keeps
Firestore, the bucket and the agent's image repository unless the owner passes `--purge`.

- **Why.** An upgrade replaces the install root whole. A change the agent wrote into an installed file
  would be lost at the next upgrade.
- **Kept by.** `config/instance.mjs` (the data root's layout). `install/manifest.txt` installs only
  under the install root. `agent/work/responsibility-store.mjs` and `agent/work/process-registry.mjs`
  merge the agent's records over the installed defaults; upkeep marked `locked` cannot be overridden.
  `install/uninstall.sh` keeps the data without `--purge`.

## Fences

### P-16. What the agent cannot do is fenced by structure, not by its prompts

File permissions, systemd sandboxes, IAM, OAuth scopes and closed command sets decide what the agent
can reach. A prompt may repeat a fence; it is never the only one. Where a prompt is the only thing
that stands between the agent and an action, the rule that covers the action says so, and the gap is
listed here.

- **Why.** A model can be wrong, confused or misled by what it reads. A fence it cannot cross holds
  whatever it believes.
- **Kept by.** Rules P-17 to P-20, P-27 and P-28. The fences that rest on a prompt today:

| What | What the agent's shell could still do | Where it is noted |
|---|---|---|
| One way out (P-27) | Write a message document to Firestore, or mint a Chat token, since the VM's account may sign as `paraclete-dwd@` | P-27 |
| Drive as a source, not a workspace (P-28) | Edit a shared file through the Drive API, which the VM's `drive` scope allows | P-28 |
| The research organ only researches | Run commands and write files: temporal-research has the motor's toolset (`agent/gateway/organs.mjs`) | [BRAIN.md](BRAIN.md), B-2 |

### P-17. The agent cannot change its own foundation

Installed code, organ prompts, installed skills, the contracts and the instance record are read-only
to the agent. Every service but control runs as the `paraclete` user, which can write only the data
root.

- **Why.** An agent that can rewrite its own code, prompts or limits has no fixed limits. A fix to the
  foundation is a commit, reviewed, released, and installed the same way on every instance. That
  holds for the continual-improvement harness too ([build plan](../plan/BUILD_PLAN.md), phase 11): it
  changes prompts and limits only as pull requests to this repo, never on an instance, and an
  instance gets them only by installing a release.
- **Kept by.** `install/bootstrap.sh` makes `/opt/paraclete` and `/etc/paraclete` root's. Each unit
  runs as `paraclete` with `ProtectSystem=strict`, `ReadOnlyPaths=/opt/paraclete /etc/paraclete`,
  `ReadWritePaths=/var/lib/paraclete` and `NoNewPrivileges=yes`
  (`agent/services/brain/paraclete-brain.service`; each service's `main.test.mjs`, such as
  `tests/agent/services/brain/main.test.mjs`, checks its unit). The gateway's `writeFile` tool refuses
  any path outside the writable directories (`agent/gateway/tools.mjs`).

### P-18. Control runs only a closed set of commands, and only when the dashboard signed them

The control service is the one service that runs as root, because restarting services and installing
a release need it. It carries out [commands](../GLOSSARY.md) from the `commands` collection, and only
[signed commands](../GLOSSARY.md): the dashboard signs each as its own service account, and control
checks the signature against the keys Google publishes for that account. The command set is fixed; no
command names a program, a path or a shell string; programs run with argument lists, on allowlisted
units only. [agent/services/control/README.md](../../agent/services/control/README.md) has the
protocol.

- **Why.** The agent's own account can write to the `commands` collection, so a document there proves
  nothing. A signature only the dashboard's account can make does, and the agent's account cannot sign
  as it.
- **Kept by.** `agent/auth/command-signature.mjs` (signing and checking),
  `agent/services/control/command-queue.mjs` (refuses unsigned, altered or expired commands),
  `agent/services/control/commands.mjs` (the closed set), `agent/services/control/systemd.mjs`
  (allowlisted units, no shell). Which dashboard users may send a command that changes something is
  the dashboard's decision: admins only (`dashboard/lib/server/commands.mjs`). An automatic update
  is no exception: the dashboard's update job runs as the dashboard's account and signs its `upgrade`
  command the same way (`dashboard/lib/server/auto-update.mjs`), and control never starts one by itself.

### P-19. Every identity holds the least access its job needs

The VM runs as `paraclete-agent@`, never as the default compute account. The agent's account gets the
`generic` role's few project roles, object access on the instance's bucket only, access to each secret
an admin grants it, and what its role declares. No role may grant, project-wide, a role that acts as
another service account, writes to an image repository, or changes or runs Cloud Run services and
jobs. A role that needs one gets it on one resource of its own (the agent's own account, or its own
image repository, `agent-images`), or for Cloud Run, on the project minus paraclete's own.

- **Why.** Project-wide act-as would reach `paraclete-dashboard@`, whose signature control obeys;
  project-wide image push would reach the dashboard's own images; and project-wide Cloud Run change
  would reach the dashboard's service and its update job, which runs as the dashboard's account. Any
  of them would let the agent command itself as an admin.
- **Kept by.** `install/lib/role-access.mjs` (what a role may ask for, and the roles never granted
  project-wide), run by `install/install.sh`, which refuses such a role and takes back such a grant it
  finds. `tests/content/packages.test.mjs` runs the same checks on every role. Each role's grants are
  in its `role.json`, such as `roles/generic/role.json`. A role that changes Cloud Run gets it on
  every service and job but the dashboard's and its update job, which the installer tags
  `paraclete=managed` (`install/lib/tags.sh`).

### P-20. The VM takes no inbound traffic but SSH through IAP, and the gateway answers only its own machine

Two firewall rules cover the VM: SSH from IAP's range is allowed, and everything else inbound is
denied. The gateway listens on loopback only, and every endpoint that runs a model needs its bearer
token.

- **Why.** Nothing outside the VM has reason to call it: the dashboard reaches the agent through
  Firestore (P-21). A gateway without a token would serve any process on the machine.
- **Kept by.** `install/lib/names.sh` (the rules and their priorities), applied by
  `install/install.sh`. `config/contracts.mjs` refuses a gateway bind that is not loopback.
  `agent/gateway/server.mjs` refuses to start without a token and checks it on every request.

## The dashboard boundary

### P-21. The dashboard holds no agent logic and never calls the VM

The [dashboard](../GLOSSARY.md) never plans, decides or runs work. It reaches the agent through
Firestore, the bucket and signed commands. It imports only the agent libraries the two sides share:
`agent/auth`, `agent/storage`, `agent/work` and `agent/release`, and the contracts as JSON.

- **Why.** One definition of each shared thing (a collection name, an approval's resolution, a
  command's signature) keeps the two sides from drifting. A dashboard that called the VM would need an
  open port on it.
- **Kept by.** `tests/repo/dashboard-boundaries.test.mjs` (what the dashboard may import).
  `tests/repo/boundaries.test.mjs` refuses any import of the dashboard from `agent/`. The VM's
  firewall (P-20) leaves no way to call it.

### P-22. Two checks admit every dashboard request

IAP admits only people granted access to the dashboard's service, and signs a header saying who they
are. The dashboard verifies that signed header on every request, never the plain email header, and
then requires a record in `users` that says `admin` or `member`. Either alone grants nothing. Adding or
removing a user changes the IAP grant and the record together, and the last admin can be neither
removed nor made a member.

- **Why.** The IAP grant decides who reaches the dashboard; the record decides what they may do.
  Trusting an unsigned header would trust anything that reached the service another way.
- **Kept by.** `dashboard/lib/server/iap.mjs` (the signature check), `dashboard/lib/server/auth.mjs`
  and `route()` in `dashboard/lib/server/http.mjs`, which every API route goes through, with
  `{ admin: true }` for admin routes. `dashboard/lib/server/users.mjs` and
  `dashboard/lib/server/user-admin.mjs` (users, and the last admin).

### P-23. Only dashboard users decide approval gates

An [approval gate](../GLOSSARY.md) is decided in the dashboard by any dashboard user, or by a reply in
the conversation that raised it: a reply in a dashboard thread decides only gates raised in that
thread, even when one gate is all that is pending. A reply in Google Chat counts only from someone the
ears matched to a dashboard user, and only for gates raised in that space. Two people deciding one
gate at the same moment, wherever they decide it, cannot both win.

- **Why.** An approval lets consequential work go ahead. Anyone in the organization may reach the
  agent in Chat, and some spaces admit people outside it; neither makes someone an approver.
- **Kept by.** `agent/services/brain/approval-replies.mjs` (approvals in chat, checked against
  `agent/storage/dashboard-users.mjs`), `dashboard/lib/server/approvals.mjs` (the dashboard's decision,
  guarded by the gate's update time), `agent/work/approvals.mjs` (the gate's lifecycle). A reply in
  chat is guarded the same way: it re-reads the gate and writes only if it is unchanged.

## Code structure

### P-24. Packages depend in one direction

`agent/` is one package per concern, and a package imports only those its row in
[agent/README.md](../../agent/README.md) allows. Services never import each other; nothing imports
`services/` or `cli/`; only the gateway service imports `gateway/`, and everything else reaches the
gateway over its local port. Only `gateway/` imports npm packages.

- **Why.** An import against the direction means two concerns share a name, and a cycle makes neither
  testable alone.
- **Kept by.** `tests/repo/boundaries.test.mjs` reads the table in `agent/README.md` and refuses every
  import outside it.

## The work model

### P-25. Work runs Request, Mission, Checkpoint, Task, and missions never nest

Every piece of work is an [envelope](../GLOSSARY.md) of one of four types: a request, a
[mission](../GLOSSARY.md), a [checkpoint](../GLOSSARY.md) or a [task](../GLOSSARY.md). A mission holds
checkpoints, a checkpoint holds tasks, and a mission never holds another mission. A person's message
arrives as an [intake](../GLOSSARY.md), and new work in it becomes a mission; a
[responsibility](../GLOSSARY.md)'s firing writes a request envelope, and its mission is the one kind
of mission with a parent. Every mission has
a [project](../GLOSSARY.md): one that names none goes to the default project. How work moves through
these is [concepts/CULTURE_OF_WORK.md](../concepts/CULTURE_OF_WORK.md).

- **Why.** One shape for all work means one loop runs it, one view shows it, and one set of rules
  keeps it honest.
- **Kept by.** `agent/work/work-schema.mjs` (the four types). `enforceMissionParentInvariant()` in
  `agent/work/plan-utils.mjs` turns any other parented mission into a checkpoint, and
  `agent/services/brain/envelope-store.mjs` applies it, and the default project, to every envelope it
  saves.

### P-26. An envelope's status changes only through the transition table

Code, never a model, moves an envelope from one status to another, and only along the legal moves in
one table. A finished envelope is never reopened. Each move stamps the fields it requires, such as a
wait's resume time.

- **Why.** Without one table, which moves are legal is spread over every place that sets a status.
  With it, "can finished work become active again?" has one answer: no, because its recorded outcome
  would then describe work it did not produce.
- **Kept by.** `agent/work/work-transitions.mjs` (the table and the reducer). The brain's envelope
  store and the checkpoint executor (`agent/services/brain/envelope-store.mjs`,
  `agent/work/checkpoint-executor.mjs`) refuse an illegal move while `brain.transition_guard` in
  `config/contracts.json` is `enforce`, as it ships.

### P-27. Everything the agent says leaves through the mouth

The [mouth](../GLOSSARY.md) is the one service that sends the agent's messages: replies, questions,
acknowledgments, status notes and approval requests, on every channel. The brain asks for a send by
marking an envelope's delivery pending, with its [address](../GLOSSARY.md); the mouth delivers to
exactly that address. The ears only read. The Workspace grant holds no scope that sends or changes
mail.

Two Workspace actions reach people without the mouth, as work a request asked for rather than the
agent speaking: a calendar invitation, which Google emails to the attendees, and a comment on a Doc.
The calendar skill invites only the people a request names ([skills/README.md](../../skills/README.md)).

- **Why.** One way out is one place to voice, record, retry and audit what the agent says. A second
  path would skip all four.
- **Kept by.** Only `agent/services/mouth/outbound.mjs` calls `deliverToAddress()` in
  `agent/providers/channel.mjs`. `agent/auth/workspace-scopes.mjs` gives the ears read-only Chat scopes
  and Gmail a read-only scope, and `tests/agent/auth/workspace-scopes.test.mjs` checks both. No skill
  offers a command that sends. **Not structural:** the agent's shell runs as the VM's account, which
  may write Firestore and may sign as `paraclete-dwd@`, so it could write a dashboard message or mint
  a Chat token itself. Only the prompts (`prompts/motor.md`) stop it.

### P-28. Drive is a source and a destination, not a workspace

The agent downloads what it needs from Drive, works on it on the VM, and hands back new files. It
never edits, moves, renames, trashes or deletes a file someone shared with it. On a workspace role it
changes in place only files its own account owns.

- **Why.** A file someone shared is theirs. A copy the agent made can be checked, and the original is
  still there when the copy is wrong.
- **Kept by.** `agent/providers/drive.mjs` has no update or move; its one removal is for the Drive
  check's own test file. `agent/providers/workspace.mjs` checks ownership before every in-place change.
  **Not structural:** the VM's `drive` scope would let the agent's shell change a shared file through
  the API directly; the skills (`skills/drive/SKILL.md`) and prompts are what stop it.

### P-29. Git holds the agent's artifacts, objects before refs

A project's [artifacts](../GLOSSARY.md) live in a git repository stored as [bundles](../GLOSSARY.md)
in the bucket, with one [ref](../GLOSSARY.md) document per branch in Firestore. A bundle is uploaded
before the ref that names it is written, and a ref moves only by compare-and-swap.

- **Why.** A crash between the two leaves an unreferenced object, never a ref to a missing one, and
  two writers cannot overwrite each other's commits. No git server is needed.
- **Kept by.** `agent/storage/git-store.mjs`, with its tests in `tests/agent/storage/git-store.test.mjs`.

### P-30. Every step leaves a trace

Every status change writes a record to the envelope's history. Every envelope the brain creates names
the release that created it. Every service logs one JSON object per line, which journald keeps, and
writes a heartbeat after each poll.

- **Why.** A mission's story must be readable from what was stored, without reproducing it, and a
  behavior must be traceable to the code that produced it.
- **Kept by.** `agent/context/history.mjs`, `agent/services/brain/envelope-store.mjs` (one history
  record per move), `agent/work/platform-version.mjs` (the release stamp), `createLogger()` in
  `agent/services/service-runtime.mjs`, and each service's heartbeat, which control reports stale after
  a minute (`agent/services/control/introspection.mjs`).
