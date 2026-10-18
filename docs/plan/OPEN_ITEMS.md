# Open items

What one phase of the [build plan](BUILD_PLAN.md) hands to a later one. Each item names the phase
that resolves it. Delete an item in the commit that resolves it.

## Still open from phase 4 (services and configuration)

- **Workspace file names.** The artifact sweep keeps, and the artifact excludes skip, a list of
  workspace file names (organ prompt files, memory files, progress files). Reconcile the list with
  the workspace layout phase 4 defines.
- **Strict reads.** `createClient` in `agent/storage/firestore.mjs` defaults to logging read
  failures and returning empty results; `readDoc` and `commit` always fail closed. Once every caller
  is ported, decide whether strict should be the default.
- **One Firestore client.** The git store's default store makes its own Firestore REST calls. Fold
  them into `createClient` when the services wire both.
- **An approval gate as a checkpoint's last task.** On resume the checkpoint is skipped and marked
  complete without judging the work done before the gate, which then reaches the next checkpoint as
  established evidence. Decide whether that checkpoint should be verified on resume.
- **Documented commands.** `project-manage canon-set`, `canon-remove` and `canon-authority` exist but no
  skill documents them. Decide whether the agent should use them.
- **Smaller duplicates left after phase 4.** The control service reads `responsibilities.json` its own
  way (`rolePackages()`, accepting a bare array) and rebuilds the skill-directory order in
  `introspection.mjs`; `instancePaths()` in `agent/cli/cli-runtime.mjs` repeats the paths
  `service-runtime.mjs` builds (a shared builder could live in `config/instance.mjs`); the Core Memory
  fetch limit of 300 is a constant in two places. Fold each into its single home when touched next.
- **A long-running mission versus the active timeout.** Archival cancels a mission active for more
  than `archival.active_timeout_hours`. A mission waiting for the runner that long (the brain runs one
  at a time) could be cancelled. Unlikely; revisit if missions queue for hours.
- **Retiring a playbook.** Retiring an agent-written override brings the installed playbook back, and an
  installed playbook cannot be retired. Decide whether that is the intent.
- **Structured gateway log lines.** `brain-telemetry-read` parses the gateway's log text; give those
  lines structured fields so a wording change can't break it.

## Phase 5's live check (first run: 2026-10-17)

A fresh project in an organization, `install/install.sh --yes` from Git Bash on Windows at `main`:
every step ran first time, and the agent reported ready about three minutes after its VM was created.
A dashboard-style chat message then ran a full research mission on `gemini-4-argon` (cortex,
prefrontal, cerebellum) and `gemini-3.8-flash` (memory, research): 15 model calls, no fallbacks, no
errors, the answer delivered with a Markdown file in `files/out/<mission>/`. Confirmed on the way:

- every gcloud call's real output (`get-ancestors`, `ttls list`, the lifecycle file, delete protection);
- the first boot: apt and NodeSource on Debian 12, `npm ci` as root, the `paraclete` user and its
  journal group, the validation gate, the swap, the 30-second gateway wait, the readiness write;
- the fences: the `paraclete` user cannot write `/opt/paraclete` or `/etc/paraclete`; it can read the
  gateway token and write only its data root;
- the indexes build, and the queries that need them run;
- real Firestore answers an `updateTime` precondition on a deleted document with FAILED_PRECONDITION
  (`StoreConflict`), and reads timestamps back normalized (`...:00Z`), so comparing them as instants is
  required, as the code does;
- `dev/status`, `dev/logs`, `dev/query` and `dev/say` over IAP SSH and Firestore from Windows.

Upgrades, checked live on 2026-10-18: `dev/deploy.mjs` over an IAP SSH session from Windows; the signed
`upgrade` command through control's transient unit; and a reboot after an upgrade, which kept the
upgraded release ("chosen by the installed release") while the VM's metadata still named the older
one.

Still to check on a dev instance:

- **Index builds after install.** The installer starts the index builds and moves on; for the first
  minute or two after the first boot the brain logs `The query requires an index ... currently
  building` every three seconds, with the full error. Either wait for the indexes in step 4 or have the
  services log a building index once, quietly.
- **npm install scripts.** npm 11 on the VM skips install scripts that `allowScripts` does not cover
  and warns about two (`@google/genai`'s no-op, `protobufjs`'s version check). Harmless today; declare
  them in `agent/package.json` or silence the warning.

## Found while building the dashboard (phase 6)

The dashboard works around each of these today; each names where the fix belongs.

- **Answering a mission.** A person answers a mission's question or blocker only through chat: the
  brain's classifier attaches the message to the mission. The mission page links to the chat. A
  deterministic path (a message `reply_to` the brain honors before classifying, as approval replies
  are) would make answering exact.
- **A structured verdict.** The checkpoint executor stores no verdict field; the dashboard reads it
  back from the checkpoint's status and output, `needs_review`, the mission's `_milestone_caveats` and
  the `Step n.verify` line of `_cp_digest`. Store `verification: { verdict, summary, caveats,
  inconclusive, checks }` on the checkpoint envelope, and the mission page can show the verifier's
  per-criterion checks.
- **Stale approval gates.** A gate whose mission was cancelled or ended stays `pending` forever. The
  dashboard shows it as no longer needed and refuses to decide it; the agent should close such gates.
- **Copied constants.** The dashboard copies `AGENT_SENDER` (`agent/providers/channel.mjs`), the
  `archived_reason` strings (`agent/work/archival.mjs`) and the organs' jobs and tiers
  (`dashboard/components/agent/organs.js`, from `agent/gateway/organs.mjs`), because it may import
  only `agent/auth`, `agent/storage` and `agent/work`. Tests pin the first; move each to an importable
  home when touched.
- **The whole playbook library.** The `processes` collection holds only playbooks the agent wrote or
  changed; installed ones live in `roles/` on the VM. A read-only `processes` command in control that
  merges the two (as `process-ops list` does) would show the whole library. Nothing writes
  `processes/{id}/revisions` yet; the dashboard reads `{ revision|version, name, description,
  narrative, status, who, when }`.
- **Responsibility steps.** Control's `responsibilities` result carries only a step count and a
  200-character instruction; return the steps to show them.
- **Notices.** Messages the agent sends to no thread have no `thread_id` field, so the dashboard reads
  the agent's newest 100 messages to find them (the `sender` + `timestamp` index). Writing
  `thread_id: null` and supporting `IS_NULL` in `query()` would make it an exact query.
- **Presence.** The chat's "working on it" reads every unfinished mission, whole, to find this
  thread's. An index on the address's thread, or a field mask in `query()`, would narrow it.
- **Who sees what.** Every dashboard user sees every mission and every approval, whoever asked:
  members "follow and approve missions". Revisit if users need privacy from each other.
- **Secret versions.** Replacing a secret's value adds a version and leaves the older ones enabled.
  Decide whether to disable them.
- **An approval in the conversation.** A gate approved from the dashboard leaves no trace in the chat
  that asked for it: the agent's "approve or reject" request is the last word there until the mission
  ends. A short note from the mouth ("Approved by ...; continuing") would close the loop.
- **The gate on the mission page.** A gate is a step of the plan with no task envelope, so the plan
  shows "Task 1, Task 3". Show the gate as its own row, with who decided it.

**Checked live on 2026-10-18:** IAP sign-in in Chrome (the header's audience is
`/projects/<number>/locations/<region>/services/<service>`, as derived); `roles/iap.admin` granted on
the Cloud Run IAP resource, which lets the dashboard read and write its grants; an unknown address
refused by IAP with Google's reason shown and no record written; Secret Manager's
`labels.paraclete=agent` list filter; signed commands run, and an unsigned one refused; chat, presence,
the work and mission pages, approvals and the badge, the agent's brain view, System and Setup.

**Still to confirm on a dev instance:** adding and then removing a real colleague; whether a service's
IAP grants outlive deleting it (uninstall does not remove them); an organization's domain restriction
refusing an outside email at `setIamPolicy`; creating, rotating and deleting a secret.

## For phase 7 (files and Drive)

- **Download list.** `agent/storage/file-store.mjs` writes objects under `files/out/<mission>/` but no
  Firestore records. The chat shows a message's attachments with a download link
  (`/api/files/download`, streamed through the dashboard); the mission page needs either a bucket
  listing or records in `files`. A re-export overwrites objects of the same name, so the latest
  version wins. Phase 7 replaces the streamed download with signed URLs, and adds uploads.
- **Drive wording.** Project and deploy-target context tells the agent to use "the drive skill"
  rather than naming commands. Confirm the wording once the skill exists.

## For phase 9 (models and upgrades)

- **One way to build and deploy the dashboard.** `install/lib/dashboard.mjs` holds the build and deploy
  arguments (Cloud Build in the region, as the dashboard's account; Cloud Run with 1 CPU, 1 GiB, at most
  3 instances, IAP on). The upgrade button must do the same; move those settings into
  `config/contracts.json`, which the dashboard may read.
- **Platform version on envelopes.** `platform_version` is declared on envelopes but nothing stamps it.
  Stamp it from `<install root>/release.json` once releases exist.

## For phase 8 (roles)

- **The Workspace account on the VM.** `install.sh` never writes the Workspace metadata keys: the agent's
  Google account exists only after the setup wizard. The wizard records it through a signed control
  command that writes it where `bootstrap.sh` keeps it across upgrades (a file under `/etc/paraclete`
  the bootstrap merges into `instance.json`), then restarts ears and mouth.
- **Role setup packages.** `bootstrap.sh` refuses a role whose `setup` lists `pip` or `npm` packages;
  add support when a role first needs them.
