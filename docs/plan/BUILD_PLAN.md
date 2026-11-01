# Paraclete Build Plan

**Status:** in progress · **Started:** 2026-10-17

This is what paraclete is, the decisions behind it, and the order of the work. It is the overall
mission for anyone developing this repo. When a decision changes, change this plan in the same commit.

---

## 1. What paraclete is

| | Rule |
|---|---|
| P1 | One Google Cloud project holds exactly one paraclete. |
| P2 | The repo is public. A project owner installs it with one command from Cloud Shell. |
| P3 | Every paraclete has its own dashboard behind Google sign-in. The person who installed it is the first user, and dashboard admins add more. |
| P4 | Each paraclete has one role, chosen at install. `generic` is the default and the base every other role builds on. |
| P5 | A Google Workspace account for the agent is optional. Only roles flagged `workspace` get one. |
| P6 | Every paraclete works with files and Google Drive. It takes files in, works on them, and hands back standard file types as dashboard downloads. |
| P7 | It runs on Gemini by default. Claude is an upgrade the owner turns on after accepting Anthropic's terms. |
| P8 | Upgrades come from this repo's releases. One button moves the dashboard and the agent to the same release, and by default the dashboard presses it by itself when a new release is out. |

The agent is a deterministic machine that consults models: code moves the data and enforces the
rules, and models think in structured JSON. Work runs Request → Mission → Checkpoint → Task. An
independent verifier judges every checkpoint, and every outbound message leaves through one service.

---

## 2. Decisions

| Area | Decision |
|---|---|
| Topology | One VM for the agent, one dashboard on Cloud Run, Firestore, one Cloud Storage bucket. The VM runs host-native systemd services, no containers. |
| Roles | One per instance, chosen at install. `generic` is the default and the base of every role. |
| Workspace | A flag on roles. A flagged role gets a Google account through domain-wide delegation (DWD), Google Chat as a channel, and the Workspace skills. |
| Drive | Every agent, `generic` included. It acts as its service account by default, and as its own Google account on Workspace roles. |
| Files | Every agent takes files in from the dashboard, links, Cloud Storage, git and Drive, and returns standard files as dashboard downloads. |
| Dashboard sign-in | Identity-Aware Proxy (IAP) directly on Cloud Run with Google's managed sign-in. No OAuth client to create. |
| Models | `gemini-4-argon` for the cortex and the strong tier, `gemini-3.8-flash` everywhere else. Claude is opt-in. |
| Upgrades | The dashboard detects releases of this repo. An admin installs one with a button; by default a scheduled job of the dashboard's installs each new release by itself, the same way (an admin turns that off on the System tab, or `install.sh --no-auto-update`). |
| Continual improvement | A harness (`dev/harness2/`) proposes changes to prompts, skills, role packages and contracts tunables, and opens them as pull requests. They reach `main` with a version in the title, green CI and a squash merge, and reach instances only in a release. Phase 11. |
| Runtime | Node 24 on the VM and the dashboard. |
| Email | Not in this plan. |

---

## 3. Architecture

```mermaid
flowchart LR
  user([Workspace users]) -->|Google sign-in| iap[IAP]
  iap --> dash[Dashboard<br/>Cloud Run]
  dash <--> fs[(Firestore)]
  dash <--> gcs[(Bucket<br/>files + git artifacts)]
  subgraph vm [Agent VM]
    ears[Ears] --> brain[Brain]
    brain --> gw[Gateway]
    brain --> mouth[Mouth]
    ctl[Control]
  end
  fs <--> ears
  fs <--> brain
  mouth --> fs
  dash -. commands .-> fs -.-> ctl
  gw --> vertex[Vertex AI<br/>Gemini / Claude]
  brain <--> gcs
  brain <--> drive[Google Drive]
  mouth -. workspace roles .-> chat[Google Chat]
  ctl -. upgrades .-> gh[Releases]
```

### Services on the VM

| Service | Job |
|---|---|
| Gateway | Runs organ turns against Vertex AI: the tool loop, caching, sessions and fallbacks |
| Brain | The mission loop: intake, planning, checkpoints, verification, finalization and the scheduler |
| Ears | Inbound messages and file drops. Serves several channels at once: the dashboard always, Google Chat on Workspace roles |
| Mouth | The only way out: replies, deliveries and attachments |
| Control | The dashboard's bridge to the VM: status, skills, config, responsibilities, model switch, upgrades and restarts |

### Identities

| Identity | Used by | Gets |
|---|---|---|
| `paraclete-dashboard@` | Cloud Run | Firestore, the bucket, Secret Manager, Cloud Build and Cloud Run (self-upgrade), IAP policy on its own service (user management), signing its own upload URLs |
| `paraclete-agent@` | The VM | Vertex AI, Firestore, the bucket, logging and metrics, secrets the dashboard grants it, Drive through the VM's scopes, plus whatever the role declares |
| `paraclete-dwd@` | Workspace roles only | Nothing in GCP. Its client ID receives the DWD grant in the Admin console |
| The agent's Google account | Workspace roles only | Chat, Drive, Docs, Sheets, Slides, Calendar and Gmail read, through `paraclete-dwd@` |

The VM never runs as the default compute service account, and nothing relies on that account's
automatic Editor grant.

### Data

Firestore collections sit at the root, because one project holds one agent: `agent` (one document),
`users`, `threads`, `messages`, `intake`, `work`, `approvals`, `processes`, `projects`,
`responsibilities`, `core_memory`, `tool_results`, `files`, `commands` and `config`.

Configuration is one `config/contracts.json`, with no compile step. One `install/manifest.txt` lists
every file installed onto the VM.

---

## 4. Roles

A role is a focus plus a few heavier tools on top of the generic agent. Each paraclete has exactly
one, chosen at install. The package format is in [roles/README.md](../../roles/README.md); the
generic role is described in [roles/generic/README.md](../../roles/generic/README.md).

### Catalog

A role with a Workspace account gets the Workspace skills (Calendar, Gmail read, Docs, Sheets, Slides),
Google Chat as a channel, and Drive as its own account; the dashboard's setup wizard connects the
account after install.

| Role | Workspace | Adds to generic |
|---|---|---|
| Generic | no | Nothing; this is the base |
| Executive Assistant | yes | Calendar management (own calendar; invitations only when asked, behind an approval); a daily briefing, off until a person asks for it |
| Project Manager | yes | Meeting notes and status reports in Docs and Sheets |
| Finance Analyst | yes | Billing analysis over the Cloud Billing export in BigQuery (a capped, read-only query command); BigQuery Job User, and Data Viewer on the export granted by a billing admin |
| Legal Advisor | yes | Contract review and obligation tracking; redlines as Docs comments or a new copy, never edits to the reviewed document |
| Designer | yes | Design-system procedures, presentation design, accessibility checks (a contrast checker) |
| DevOps Engineer | no | gcloud, Cloud Build images (no Docker on the VM), Cloud Storage, Firebase Hosting; Cloud Run and Cloud Build roles, and Artifact Registry and act-as only on its own repository and account |
| Software Engineer | no | Coding, code review, pull requests through the `gh` CLI with a token from Secrets |
| QA Engineer | no | Test runs, regression runs and defect reports |
| Data Engineer | no | BigQuery loads, queries and schema changes; BigQuery User and Data Editor |
| Security Engineer | no | Read-only IAM and exposure audits; Security Reviewer, Cloud Asset Viewer, Org Policy Viewer |
| Web Master | no | Site audit (Lighthouse), custom domains, Firebase Hosting, read-only gcloud |

Role prompts hold domain rules only: devops "a deploy passes only on a live 2xx", legal "assist and
escalate, never give legal advice", engineering "done means tested". The base prompt plus one role
file is the whole composition.

`roles/paraclete-h2` is not in the catalog. It is a development role (`listed: false` in its
`role.json`): the agent that runs the continual-improvement harness (phase 11) against this repo. The
installer does not offer it, and installs it only when `--role` names it.

---

## 5. Files and Drive

Every paraclete gets a `files` skill and a `drive` skill. Together they take a file from wherever it
was shared, let the agent work on it locally, and hand back a standard file.

| | |
|---|---|
| **In** | Files dropped into dashboard chat; any http(s) link; objects in the project's Cloud Storage; git repos (public, or private with a token in Secrets); Drive files and folders shared with the agent |
| **Work** | Read anything to text or Markdown (PDF, Word, Excel, PowerPoint, CSV, HTML); images go to the model as pixels; edit, convert, merge, split |
| **Out** | Markdown, PDF, Word (.docx), Excel (.xlsx), CSV, PowerPoint (.pptx), HTML, PNG, SVG, JSON, ZIP. Shown as downloads on the mission in the dashboard, and optionally saved to Drive |

### Commands

| Command | Does |
|---|---|
| `file-get <source>` | Fetches from an upload id, URL, `gs://` path, git URL or Drive link into the mission's inbox, recording name, type, size, checksum and source |
| `file-read <path>` | Extracts text or Markdown, with page, sheet and slide selection |
| `file-convert <path> <format>` | Converts between the supported types |
| `file-make <format> --from <md\|html\|csv\|json>` | Builds an output file from source the agent wrote |
| `file-share <path> [--drive <folder>]` | Places the file in the mission outbox for download, and optionally uploads it to Drive |
| `drive-find`, `drive-get`, `drive-export`, `drive-put` | Search; download a file, or export a Google Doc, Sheet or Slides to an Office format, PDF or Markdown, into the mission's inbox; save a finished output as a new file |

The VM bootstrap installs the toolchain, as the generic role's apt packages without recommended ones:
pandoc, poppler-utils and qpdf for PDF, LibreOffice's headless Writer, Calc, Impress and Math, headless
Chromium, ImageMagick, `file`, two font families, and the Python libraries for Word, Excel and PDF
(python3-docx, python3-openpyxl, python3-pypdf; Debian has no python3-pptx, so a .pptx is read from its
XML and written with pandoc). Dashboard uploads go from the browser straight
to the bucket through a signed URL, so Cloud Run's 32 MB request limit doesn't apply. Inbox files
expire through a bucket lifecycle rule.

### Two Drive identities

| | Every agent (service account) | Workspace roles (agent's own account) |
|---|---|---|
| How people share | With `paraclete-agent@<project>.iam.gserviceaccount.com`, shown with a copy button in the dashboard | With the agent's Workspace address |
| Read and export | Yes | Yes |
| Create new files | Only inside a shared drive the service account belongs to. Service accounts have no Drive storage of their own. | Yes, in its own My Drive |

**Drive is a source and a destination, not a workspace.** An agent downloads what it needs into its
mission's inbox on the VM, works on it there, and hands results back as new files: dashboard
downloads, and optionally a new file in the output folder. It never edits, moves, renames, trashes or
deletes a file someone shared with it. Editing documents in place may come later, for Workspace roles.

The `drive` skill picks the identity itself: the agent's account when one is configured, the service
account otherwise. Settings has an optional output shared drive and a Test Drive button. Some
organizations block sharing with addresses outside their domain, which can include service accounts.
The install and the Test Drive button detect this and explain the options: a shared drive the service
account belongs to, an admin policy change, or a Workspace role.

---

## 6. Models

| Where | Default | With Claude turned on |
|---|---|---|
| Cortex (decides each step) | `gemini-4-argon` | Claude Opus |
| Strong tier: prefrontal (plans), motor (executes), cerebellum (verifies) | `gemini-4-argon` | Claude Opus |
| Temporal organs (memory, research) | `gemini-3.8-flash` | `gemini-3.8-flash` |
| Service calls (ears, mouth, digests) | `gemini-3.8-flash` | `gemini-3.8-flash` |
| Fallback | `gemini-3.8-flash` | `gemini-4-argon` |

`gemini-4-argon` answers only on Vertex AI's global endpoint. It returns tool calls with thought
signatures and a call `id`; the gateway must send both back.

The strong tier is on for every role. The effort setting stays as the dial.

**Turning on Claude.** Settings → Models links to Model Garden to accept Anthropic's terms. A Test
button probes the Claude Opus models the contracts list (`vertex.models.claude_candidates`, newest
first) and names the newest the project can reach; a switch then moves the cortex and the strong tier
to it (`config/settings.claude_model`). Gemini stays the fallback. Only the models listed in
`vertex.anthropic_temperature_models` get a temperature: the newer Opus models refuse any sampling
setting.

---

## 7. Access and users

- **Sign-in.** IAP sits directly on the Cloud Run service. Its Google-managed sign-in admits only
  accounts in the project's organization, which is the Workspace boundary. Nobody creates an OAuth
  client.
- **Prerequisite.** The project must belong to the Workspace's Cloud organization.
- **First user.** The installer grants itself `roles/iap.httpsResourceAccessor` on the service and
  becomes the first dashboard admin.
- **Two dashboard roles.** Admins manage users, settings, secrets, models and upgrades. Members chat,
  follow and approve missions, and download files. The IAP binding decides who reaches the dashboard;
  the `users` record decides what they can do.
- **Adding and removing users.** An admin enters an email; the dashboard adds or removes the IAP
  binding and the user record together.
- **Trust.** The dashboard verifies the signed IAP header (`x-goog-iap-jwt-assertion`) on every
  request, never just the email header.
- **Conversations.** Each user has their own thread with the agent. Messages carry the sender, missions
  record who asked, and approvals show who asked and who approved.

---

## 8. Install

An "Open in Cloud Shell" button on the README opens Cloud Shell with the repository cloned at `main`;
`install/install.sh` there installs the newest release tag (`--ref` picks another). It asks two
questions, the role (default `generic`) and the agent's name, then runs unattended. Re-running it
repairs an install. [docs/INSTALL.md](../INSTALL.md) is the owner's guide.

```
install/install.sh
  1  check      caller can act as owner, billing is on, project is in an organization, the ref resolves
  2  apis       compute, run, firestore, iam, iamcredentials, aiplatform, artifactregistry,
                cloudbuild, secretmanager, storage, iap, drive, cloudresourcemanager, cloudscheduler
                (+ Workspace APIs for flagged roles);
                then checks the cortex model answers
  3  accounts   paraclete-dashboard@, paraclete-agent@ (+ the role's gcp_roles), paraclete-dwd@ if flagged
  4  firestore  native database (delete-protected), indexes and the TTL policy
  5  bucket     <project>-paraclete: uniform access, public access prevention, lifecycle rules
  6  dashboard  Cloud Build at the tag → Artifact Registry → Cloud Run with IAP; grant the installer;
                the automatic-update job (Cloud Run job) and its schedule (Cloud Scheduler)
  7  network    the default network (or a paraclete one); SSH from IAP only, everything else denied
  8  agent VM   e2-standard-2, 50 GB, Debian 12, paraclete-agent@, cloud-platform + drive scopes;
                the startup script runs install/bootstrap.sh at the release's commit on every boot
  9  wait       until the agent reports ready, then print where to find it
```

For development, `--ref <branch>` installs a branch and `--repo <owner>/paraclete` installs from a
fork.

**What stays manual.** Nothing, for a role without Workspace. Turning on Claude needs the owner to
accept Anthropic's terms in Model Garden. A Workspace role needs the dashboard's setup wizard: create
the agent's user, paste one client ID and the scope list into the Admin console (copy buttons and a
direct link), save the project's Chat app record in the Cloud console (a name and a description,
interactive features off; a direct link), then click Test, save, and add the agent to a Chat space
and @mention it (Chat lists a new user's conversations only once someone has written to it).
Google has no API for the DWD grant or for the Chat app record.

**Uninstall.** `install/uninstall.sh` removes everything the installer created. It keeps the bucket
unless you pass `--purge`.

---

## 9. Upgrades

1. **Releases.** A maintainer cuts a release from main's head once CI is green for it, with
   `dev/release-check.mjs`: it first deploys the head to a dev instance and requires a clean status and
   a passing smoke mission there, then tags it the way `dev/release.mjs` does: a tag in the commit
   version format (`vYYYY.MM.DD.N.N`). The tag's workflow (`.github/workflows/release.yml`) runs the
   tests again and publishes the GitHub release with notes, one line per commit since the previous
   release.
2. **Detection.** The dashboard checks this repo's releases (cached hourly in `config/release_check`)
   and shows "Update available" with the notes.
3. **Install.** An admin clicks Install. The VM goes first: the control service downloads that tag's
   upgrader, never the copy already installed, then installs, runs the validation gate and the
   migrations, and restarts the services. Only then does Cloud Build build the dashboard at the tag,
   and Cloud Run roll the dashboard to it. A failed VM upgrade leaves the dashboard as it was; a
   failure after it leaves an upgrade the card offers to finish.
4. **Migrations.** A release can carry idempotent data migrations (`migrations/`), which the upgrader
   runs after the services stop and before the new release is swapped in. A failure keeps the
   installed release, which starts again.
5. **One version.** The dashboard and the agent report the same version. The button only moves
   forward; going back is `install/install.sh --ref <older tag>`.
6. **Automatic updates.** On by default. A Cloud Scheduler job starts a Cloud Run job every 30 minutes
   (`contracts.auto_update`): the dashboard's own image and account running
   `dashboard/jobs/auto-update.mjs`. Each run installs the newest published release exactly as Install
   does, with the same signed VM command, then the dashboard's build and rollout, and follows it to the
   end (`dashboard/lib/server/auto-update.mjs`).
   - It moves only forward, and finishes an upgrade left half-done first.
   - It never moves an instance installed from a branch or commit, such as a dev instance under test.
   - While a mission is active it waits, for at most 24 hours from the first run that found one, then
     installs anyway; missions resume after the restart.
   - An admin turns it off or on on the System tab, which also shows what the last run did.
   - `install/install.sh --no-auto-update` installs with it off.
   - An instance installed before automatic updates gets the job and the schedule the next time
     `install.sh` runs.
7. **Withdrawing.** A bad release is withdrawn with `dev/release.mjs yank <tag> --reason "<why>"`:
   GitHub lists it as a prerelease whose notes start with `Withdrawn: <why>`, and its tag stays. Each
   dashboard stops offering it at its next look at GitHub, and one that checks for withdrawn releases
   starts no new install to it, since every upgrade asks GitHub first. An upgrade to it already running
   finishes, and a dashboard on an older release may still install it within its cached hour. An
   instance already on it says so on its version card and moves on to the next newer release as usual.
   The next release's notes start after the last one not withdrawn. The release workflow of a tag older
   than v2026.10.23.12.1 is never rerun: it would publish a withdrawn release again.

---

## 10. How the code gets here

Code is ported from a predecessor project, one package at a time. A port is a deliberate rewrite into
this layout, not a copy:

- the package arrives with its tests, under the mirrored path in `tests/`;
- it uses this repo's names and vocabulary, and its header comments explain it to a reader with no
  context;
- nothing comes across that serves coordinating several agents or one organization's setup;
- every port passes the hygiene tests, including each developer's private denylist.

---

## 11. Build sequence

Each phase ends with `npm test` green in CI. Phases 6, 7 and 8 can run in parallel once phase 5 is
done.

1. **Foundation** (done). Layout, a README in every directory, developer guide, glossary, this plan, hygiene
   and structure tests, CI.
   *Exit:* CI green; the hygiene test passes with a private denylist in place.
2. **Core libraries** (done). `agent/auth`, `storage`, `providers`, `context` and `work`, with their tests.
   Fix the timed-wait defect in section 12 on the way in.
   *Exit:* the libraries' tests pass and the dependency-direction test enforces
   [agent/README.md](../../agent/README.md).
3. **Gateway** (done). `agent/gateway` with Gemini 4 call ids, a fallback that never reruns tools that
   already ran, and a shell tool that keeps a failed command's output.
   *Exit:* gateway tests pass, including a recorded Gemini 4 tool turn.
4. **Services and configuration** (done). Brain, ears, mouth and control; `config/contracts.json`; organ
   prompts in `prompts/`; the base skills; the `generic` role package.
   *Exit:* ears, brain and mouth run a mission end to end against the in-memory Firestore fake in
   `tests/fakes/` with a scripted gateway (`tests/integration/`).
5. **Install and dev loop** (done; checked live on 2026-10-17). `install.sh` (with `--ref` and `--repo`), `bootstrap.sh`, the manifest,
   `uninstall.sh`, and the `dev/` scripts.
   *Exit:* a dev instance installed from a branch runs a full mission on `gemini-4-argon` with no
   fallbacks, and the cortex runs on Gemini without errors.
6. **Dashboard** (done and checked live, but for adding and removing a real colleague). IAP trust, users and the two dashboard roles, the single-agent shell, per-user chat,
   approvals, work views, memory, settings, and the setup checklist.
   *Exit:* add and remove a user; chat with the agent; approve a gated mission.
7. **Files and Drive** (done and checked live, but for a restricted organization's sharing policy). The `files` skill and toolchain, signed-URL uploads, mission downloads, and the
   `drive` skill with both identities.
   *Exit:* drop a PDF into chat and get a .docx back; read a Doc shared with the service account; write
   into a shared drive; the sharing-policy check reports correctly in a restricted organization.
8. **Roles** (done and checked live; Chat answers in spaces, not yet in direct messages). The 11 roles in the catalog, the Workspace flag with its setup wizard, and the Google
   Chat channel.
   *Exit:* `generic`, one Workspace role and one other role each install and pass a smoke mission.
9. **Models and upgrades** (done; the upgrade checked live, Claude deferred: the agent runs on Gemini until it is revisited). The Claude switch, the release workflow, release detection, the upgrade
   button, and migrations.
   *Exit:* turn Claude on and off; upgrade a dev instance from one release to the next from the
   dashboard.
10. **Product docs** (done; the install button's first live press is next). `docs/canon/`,
    `docs/concepts/`, the guides, `docs/INSTALL.md`, and the README's install button.
    *Exit:* every doc matches the code, and the doc-path tests pass.
11. **Continual improvement** (in progress). The harness in `dev/harness2/`
    ([dev/README.md](../../dev/README.md)) and its agent, the development role `roles/paraclete-h2`.
    - It changes only the mutable surface (`c1`..`c7`, `dev/harness2/surface.mjs`): contracts
      tunables, base and role prompts, skill playbooks (`SKILL.md`, `skill.json`), and role playbooks
      (README, processes, responsibilities). Code and grants are outside it: a skill's commands, a
      role's `role.json`, and the rest of the code.
    - Its promotions are pull requests. Since `v2026.10.22.1.1` each title starts with its version and
      is merged with squash, so `main`'s head stays releasable. Since `v2026.10.22.1.2` the release notes
      also list changes merged with a merge commit. Instances get promotions only through a release.
    - Since `v2026.10.23.2.1` a promotion opens only with measured evidence: the candidate against the
      current version on the same tasks, over repeated trials, proposed by a model. Runs that the
      scripted in-process gateway answered are refused as evidence.
    - Since `v2026.10.23.10.1` a `--real-model` run measures a prompt change: each side's rollouts go
      through the product's own gateway, started from a checkout of that side, to the real model, on
      the model suite's tasks (`dev/harness2/model-suite.mjs`), each with deterministic checks and a
      training or held-out split. Only such runs are evidence; the evidence also needs a passing
      calibration (the baseline against itself shows no change, a known-bad change shows a loss) and
      no held-out regression. A run stops at its spend cap, and `dev/harness2/PAUSED` stops every cycle.
    - Since `v2026.10.23.14.1` every cycle is recorded, and a daily health check (`dev/harness2/health.mjs`)
      keeps one `harness-alarm` issue open for each way the loop has been seen to fail quietly. The
      development role can also release main after a check on the lab canary (`r-release-check`), off
      until a maintainer turns it on.
    - Since `v2026.10.24.4.1` the self-improvement loop (`dev/loop/`) runs as plain code: one cycle takes
      a `loop` issue, has a coding agent change a checkout of main, refuses a change to the referee, to
      an existing test, a failing suite, or a behaviour change that real-model runs do not show to be
      safe, and opens a pull request. Since `v2026.10.25.4.1` a reviewer model judges each change
      against its issue's "Done when" and code decides. Since `v2026.10.25.5.1` no person merges: CI's
      Loop guard (`dev/loop/guard.mjs`) re-checks every loop pull request, its review bound to the
      files it changes, and the loop's merger (`dev/loop/merger.mjs`) merges a passing one, at most 3
      a day, or closes it with the reasons for the next attempt. Since `v2026.10.26.3.1` the loop finds
      its own work: when no `loop` issue waits, its planner turns an item of `docs/plan/OPEN_ITEMS.md`
      into one, with testable "Done when" points, and an issue refused 6 times is given up as
      `loop-stuck`. Since `v2026.10.26.7.1` a loop merge that breaks CI on `main` is reverted by the
      next cycle, through a pull request the Loop guard checks sets exactly that commit's files back, its
      issue reopened; a second revert in a day pauses the loop (`PARACLETE_LOOP_PAUSED`). Since
      `v2026.10.26.10.1` the loop releases `main` once its merges since the last release ran healthy on the
      lab (the driver runs the head for 2 hours, every service active), at most once in 20 hours, so
      instances install them; since `v2026.10.26.12.2` the release goes through the lab canary's smoke
      mission first. Since `v2026.10.27.4.1` the loop measures the agent itself: once a day a cycle runs
      the model suite on `main`'s head with the real model (`dev/loop/baseline.mjs`), and the planner
      turns a training task that fails a check into an issue whose change must make that task score
      higher, no task or the held-out tasks worse. Since `v2026.10.27.7.1` the legacy harness's scheduled
      cycles (`r-harness-evolution-cycle`, `r-failure-harvest`, `r-harness-closed-loop`) are off: they ran
      without the real model and measured nothing. Since `v2026.10.30.1.1` the model suite's tasks are
      harder (version 3), and since `v2026.10.31.3.1` every role a person can install has tasks of its
      own (version 4). Next: tasks that exercise Workspace, Drive and Hosting through fakes of their
      commands, which no rollout can reach today.
    - Since `v2026.10.23.12.1` a release is checked on a dev instance before it is tagged:
      `dev/release-check.mjs` deploys `main`'s head there, requires its status to be clean on that commit
      and the role's smoke mission to pass, and only then cuts the release, with the check recorded in
      the tag's message. A bad release is withdrawn with `dev/release.mjs yank`: no new install to it
      starts on a dashboard that checks for withdrawn releases, and instances on it move on to the next
      newer release.
    - Since `v2026.10.23.11.1` the merge step is in the repo: the hourly harness-merge workflow
      (`.github/workflows/harness-merge.yml`, `dev/harness2/merge.mjs`) squash-merges at most one
      promotion per run, only while CI passed on `main`'s head, and only one whose head contains
      `main`'s head, whose CI passed, whose evidence block passes `judgeEvidence` and names every
      file it changes, and whose files stay on the mutable surface (contracts only in tunable keys).
      Then it dispatches CI on `main`. `dev/harness2/PAUSED` stops it.
    - Since `v2026.10.24.3.1` CI checks every promotion pull request's evidence
      (`.github/workflows/promotion-evidence.yml`): the block in its description must pass and name every
      changed file, checked again on each push and each edit of the description, so nothing that merges
      on CI alone can merge a promotion without it.

    *Exit:* a promotion merges only with measured evidence and green CI, `main`'s head is releasable
    after every merge, and a release with promotions passes the smoke missions on a dev instance.

**Acceptance.** In a clean project inside a Workspace organization: one command, a dashboard link in
about 15 minutes, the owner signs in, adds a colleague, drops a spreadsheet into chat, and gets a
formatted report back as a download. Then the same flow for a Workspace role, through the setup
wizard.

---

## 12. Known defects to fix while porting

| Defect | Effect | Status |
|---|---|---|
| The stale-work sweep cancels waits after 8 hours | Timed waits may legitimately run 24 hours | Fixed in phase 2 (`agent/work/archival.mjs`) |
| A model fallback reruns the whole turn | Tools that already ran in the failed turn run again | Fixed in phase 3: the fallback continues the transcript; checked live from Gemini 4 to Flash and to Claude |
| The shell tool drops a failed command's output | The reason a command refused is lost | Fixed in phase 3 (`agent/gateway/tools.mjs`) |
| A checkpoint can pass on compacted evidence, or with an inconclusive adversarial check | The verifier passes claims it could not fully check | Phase 4, with the checkpoint executor |
| A project listing can show a placeholder dash instead of a project id | The agent has to guess which project is meant | Registry fixed in phase 2; the listing command in phase 4 |

Phase 2 also fixed defects found while porting, each with a test: shell and option injection in the
git store, a project manifest that was never saved, a scheduler guard that stopped working after a
responsibility's history grew, approvals that stopped resuming after the hundredth, recall that went
blind after 300 envelopes, a mission stranded when its resume after approval failed, and a stored
`id` field that could override a document's real id.

---

## 13. Risks and checks

- **Organization required.** IAP's managed sign-in works only for projects inside an organization. The
  installer checks this first.
- **Drive sharing policy.** Restricted external sharing may block sharing with the service account.
  Phase 7 tests this in a locked-down organization.
- **Cortex on Gemini.** The cortex's session replay and caching were first built around Claude. Phase 5
  proves them on Gemini before anything else is built on top.
- **Gemini 4 is new.** It was released on 2026-10-13 and is served only from the global endpoint. The
  installer checks the project can call it.
- **VM size.** LibreOffice and Chromium need more memory than e2-medium has. Start at e2-standard-2
  (8 GB) with 50 GB of disk.
- **Release-check rate limit.** GitHub allows 60 unauthenticated requests per hour per IP address. The
  dashboard caches the result.
- **Organization policies.** No `allUsers` invoker (IAP removes the need) and no reliance on default
  service-account grants. A blocked step prints the command and Google's own error; only the model
  check names organization policies as a likely cause.

---

## 14. Not in this plan

- Email in or out
- Changing an instance's role after install, or more than one role
- Claude as the default model
- Projects outside an organization
- Moving agents in from other systems
