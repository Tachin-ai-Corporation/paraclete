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

**Checked live on 2026-10-18:** IAP sign-in in Chrome (the header's audience is
`/projects/<number>/locations/<region>/services/<service>`, as derived); `roles/iap.admin` granted on
the Cloud Run IAP resource, which lets the dashboard read and write its grants; an unknown address
refused by IAP with Google's reason shown and no record written; Secret Manager's
`labels.paraclete=agent` list filter; signed commands run, and an unsigned one refused; chat, presence,
the work and mission pages, approvals and the badge, the agent's brain view, System and Setup.

**Still to confirm on a dev instance:** adding and then removing a real colleague; whether a service's
IAP grants outlive deleting it (uninstall does not remove them); an organization's domain restriction
refusing an outside email at `setIamPolicy`; creating, rotating and deleting a secret.

## Found while building files and Drive (phase 7)

- **CORS on an upgraded instance.** install.sh sets the bucket's CORS for the dashboard's origins; an
  instance moved by `dev/deploy.mjs` or the upgrade button gets none until install.sh runs again. Have
  the deploy path apply the same rule (`install/lib/dashboard.mjs corsConfig`).
- **The upload size is checked when the upload completes.** The signed PUT does not cap the size; a
  larger object is deleted at completion. Signing `x-goog-content-length-range` (and allowing it in
  CORS) would refuse it at the bucket.
- **Files from before phase 7.** Missions finished before the `files` records existed have objects in
  the bucket but no records, so their Files section is empty.
- **One mission-inbox path.** `agent/files/mission-paths.mjs` and `skills/drive/drive-get.mjs` each
  build `missions/<id>/missions/<id>/inbox/`; drive-get and drive-export should use the files package's.
  `drive-put` keeps its own copy of the credential-path check that `agent/storage/file-store.mjs` has.
- **Reply attachments** are capped at 20 by a constant (`MAX_ATTACHMENTS` in the brain's completion).
- **Images, live.** `gemini-4-argon` accepts images inside a function response and reads them (it
  compared a rendered .docx with its source PDF and fixed a duplicated title). Still to check: that
  Claude on Vertex takes a tool_result image, and that three images at the size cap fit the request
  limits.
- **The output folder's name.** Set to a shared drive's root, the Drive check calls the folder
  "Drive" (the root folder's own name); show the shared drive's name instead.
- **A restricted organization.** The Drive check's advice for an organization that blocks sharing
  outside its domain is untested live: the dev organization allows sharing with the service account.
- **Renders for the verifier.** The motor rendered its check images to `/tmp` and deleted them; the
  verifier then asked for the same paths and found nothing. The files skill now says to keep renders
  in the mission's own `missions/<id>/renders/`; confirm the next live run does.

## Found while building roles, Workspace and Chat (phase 8)

- **Who a scheduled briefing is for.** A responsibility has no addressee, so the executive assistant's
  daily briefing reaches the dashboard as a notice every user sees, never one person's thread or Chat
  space. Give a responsibility an optional delivery address, set when a person asks for it.
- **Stopping work from Chat.** Anyone in the organization who reaches the agent in Chat can add to or
  stop a mission, as a dashboard member can. Decide whether a stop from Chat is limited to the person
  who asked or to dashboard users.
- **Dashboard users in group spaces.** A dashboard user is recognised in a group space only after they
  have written to the agent in a direct message once. The `chat.memberships.readonly` scope would let
  the ears match them without that step.
- **Cloud Run admin is still project-wide for the devops role.** Act-as and image pushes are on its
  own account and `agent-images` only, so it cannot run anything as the dashboard's account or sign
  commands; but IAM still lets it delete, reconfigure, re-route or replace the dashboard's `paraclete`
  service with a revision of its own image running as `paraclete-agent@`. Only the skills forbid it.
  Make IAM enforce it, after checking on a dev project: (a) a conditional grant excluding
  `.../services/paraclete` (confirm the resource types and name forms Cloud Run evaluates, and that
  list, deploy and traffic still work), or (b) an IAM deny policy on a tag the installer binds to the
  dashboard's service. Either way, install.sh and uninstall.sh must learn conditional bindings (they
  read policies without conditions and remove with `--condition=None`).
- **A default runtime account for deployed services.** A service the agent deploys runs as
  `paraclete-agent@` by default and carries all its access; only the gcloud skill keeps public ones off
  it. A third resource kind (`runtime-account`: an empty account with act-as for the agent) would let
  IAM enforce least privilege for deployed code.
- **Workspace files in a shared drive.** The Workspace skills edit in place only files the agent's
  account owns; a file it created in a shared drive has no owner, so it cannot be edited later. A mark
  set at creation (`appProperties`) could prove it made the file. There is no share command for files
  in the agent's My Drive yet.
- **Shared helpers across skills.** Some skills import helpers from another skill's command
  (`drive-get`, `drive-put`, `docs-create`); move them into `agent/files/`.
- **A role move leaves things behind.** The old role's apt, npm and pip packages stay installed, and the
  working memory is not reseeded for the new role.
- **To check live:** the Chat behaviors Google documents loosely (a mention posted as a user,
  `lastActiveTime` on thread replies); Drive's Markdown import for docs-create; Meet links; npm
  installs of the pinned firebase-tools and lighthouse under Node 24; Lighthouse with Debian's Chromium
  inside the services' sandbox; `gcloud builds submit` as the agent with source staged in the bucket.

## Phase 8's live check (2026-10-18)

Checked on the dev instance: the generic, devops-engineer and executive-assistant smoke missions pass
(the HTTP/2 RFCs; Cloud Run listed read-only; the agent's own calendar read as its Workspace account),
each after a role move with install.sh --role, which took back the previous role's grants. On the
Workspace role, two @mentions in Chat spaces were taken in and answered in their threads. The wizard's Test
passes Drive, Docs, Sheets, Slides, Calendar and Gmail (the Docs, Sheets and Slides 404 probes hold).
A Chat message posted by the mouth with its client-assigned id and `requestId` goes through under user
authentication. Google Chat needed four things the code did not know, each found by swapping signers
and accounts between this instance and an older deployment that works:

- **A Chat app record in the project** (name, description, interactive features off). The wizard's
  step 3 links to it; Google has no API for it. Messages the agent posts carry its name as a label.
- **A first message.** Chat refuses `spaces.list` ("permission denied ... or the resource doesn't
  exist") for a user nobody has written to, with any signer. The check now reports Chat as waiting
  (`pending`), the ears back off and say why, and the first listing reads the hour before it, so the
  message that brought the account into Chat is answered.
- **Spaces, not direct messages.** An account that has never signed in reads a direct message but
  every reply it posts there is refused; in a space the same post goes through. The wizard sends
  admins to a space. The owner decided people reach the agent in spaces; direct messages are not
  pursued further.
- **Spaces that admit outsiders.** The owner decided the agent reads them like any other space, as
  the older deployment did: outside members can ask and see answers there; approvals still come only
  from dashboard users. Their count shows on the System tab.

Also seen: the generic smoke answer says it verified both RFCs at the IETF, yet tags both claims
`[assumed]`. A claim the mission checked against a source should carry the bin for that.


## Found while building models and upgrades (phase 9)

Phase 9's own handoff items are done: the dashboard's build and deploy settings live in the contracts'
`dashboard` block, which the installer and the upgrade button both read, and the brain stamps
`platform_version` on every envelope it creates from `release.json`.

Checked live (2026-10-19): the first two releases published through `dev/release.mjs` and the release
workflow (`v2026.10.19.1.1`, `v2026.10.19.1.2`); the dev instance moved from the first to the second
with the System tab's Install: the VM first (its migration step ran, with nothing to migrate), then
Cloud Build, then the Cloud Run v2 update, which kept IAP, the service's size, its account and every
environment value but the release and commit. The card reloaded onto the new dashboard by itself.
The Claude Test ran from the VM: every candidate answered 404 in `us-east5`, the project having no
Claude model enabled.

- **Claude, deferred.** The owner chose to stay on Gemini for now and revisit Claude later, so turning
  Claude on and off is not yet checked live. When it is: enable a Claude Opus model in Model Garden,
  run the Test, turn Claude on, and check a tool turn on the newer Opus models (the gateway sends them
  no temperature and sends their thinking back with the tool call, both untested against the real
  API); Vertex AI's wording when Anthropic's terms are not accepted (the Test's fixes follow the
  expected wording); whether the newer models are served in `vertex.anthropic_location` (`us-east5`)
  or need `global`.
- **GitHub's rate limit.** Unauthenticated GitHub allows 60 requests an hour per address, and Cloud Run
  shares its outbound addresses with other tenants. The release check fails gracefully and keeps the
  last answer; an optional GitHub token secret would lift the limit.
- **A tag whose release never published.** A bare `install/install.sh` installs the newest version tag
  (`install/lib/ref.sh`), not the newest published release, so a tag whose release workflow failed
  would still be installed. `dev/release.mjs` tags only a commit CI passed, which makes this rare.
  A tag ruleset that lets only maintainers push `v*` tags would close the other way in.
- **A hung migration.** The services are stopped while migrations run, and only control's upgrade time
  limit bounds that; a migration run at boot has none. A contracts key and a `timeout` around the run
  would bound it.
- **Instances installed from a branch** are offered no updates: the card cannot order a branch against
  a release.
- **The Claude Test's result is not kept.** It lives in the open tab, and the switch offers only the
  newest model that answered; members see the setting, not the last test.

## Found while writing the product docs (phase 10)

Writing the canon, the concepts and the guides against the code found these. The docs describe the
code as it is, gaps included; stale READMEs, comments and agent-facing lines were fixed as they were
found. Worst first.

**Fixed in the hardening pass that followed** (each with its tests):
- A mission no longer completes without verification after the cortex gives up a second time: only
  work done after the self-unblock check counts, and work that succeeded goes on as a `synthesize`
  move, through the finish gate and the verifier
  (`agent/services/brain/actions/synthesize-with-failure.mjs`).
- The tool log can no longer be imitated: a marker a model writes into its own text is made inert at
  the gateway, and the verdict and the task's outcome read the last block, the gateway's
  (`agent/context/tool-record.mjs`, `agent/gateway/turn-loop.mjs`).
- A reply in a dashboard thread decides only gates raised in that thread, even when one is all that
  is pending; an approval in chat is written only if the gate is unchanged since it was read, as the
  dashboard's is (`agent/services/brain/approval-replies.mjs`).
- A responsibility that leaves out `enabled` fires, as its schema says; the planners' capability map
  leaves out skills the instance cannot use; the first `process-ops write` over an installed playbook
  keeps its `intent_keywords`.

**Verification and honesty, still open.**
- **Advice where a rule was meant.** The escalation after three failed plans is an instruction to the
  cortex; a plan with a destructive or public part and no approval gate is warned once, then runs.

**Fences that rest on prompts.** The agent's shell runs as the VM's account, which may write Firestore
message documents and sign as `paraclete-dwd@` (so mint a Chat token); the VM's `drive` scope would let
the shell change a shared file; temporal-research has the motor's open toolset; Calendar invitations
and Doc comments reach people without passing the mouth. The canon's P-16 lists them.

**Work model.**
- The mission record is written under the mission tree's `missions/`, which the publish excludes, so
  it stays on the VM (`agent/work/mission-record.mjs` now says so). Committing it needs a path per
  mission: every mission writes the same two paths, which would collide when mission branches merge.
- `processParameters` is stored but never reaches the mission a firing creates.
- `on_deploy` is accepted as an event, but nothing raises it.
- A `gated` merge is parked in `context.pending_merge`, and nothing resolves it; context promotions are
  listed in the Library, and nothing accepts one; the canon authority check compares against the
  agent's own account, so no person can change a project's canon.
- Rejected missions are never archived, and their checkpoint stays `awaiting_approval`. The archival
  sweep writes statuses directly, outside the transition table. `planned`, `needs_review` and
  `timed_out` are declared and never entered. Nothing writes `depends_on`. The plan schema allows a
  step type `ask`, which runs as an ordinary task.
- Skills the agent writes under its data root reach the motor only after a gateway restart.
- `projects.context_max_tokens` and `projects.archive_completed_after_days` are never read.
- `uninstall.sh` keeps the agent's Secret Manager secrets even with `--purge`.
- The Setup tab's Drive advice now matches the Drive rule (Editor only on a folder the agent writes new
  files into).
