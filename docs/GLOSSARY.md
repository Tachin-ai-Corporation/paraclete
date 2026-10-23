# Glossary

Every product term, defined once. When a doc, README or comment uses one of these words, it means
this.

## The product

| Term | Meaning |
|---|---|
| paraclete | The product: one AI agent for one Google Cloud project. Also the agent itself, inside an instance. |
| instance | One installed paraclete, in one Google Cloud project |
| dev instance | An instance in a project used only for developing this repo |
| role | The agent's focus, chosen at install. One per instance. `generic` is the default and the base of every role |
| role package | A role's directory under `roles/`: its `role.json`, organ prompt appends, skills, playbooks, responsibilities and first working memory (`roles/README.md`) |
| development role | A role package for working on this repo, not for an organization's work: its `role.json` sets `listed: false`, so the installer does not offer it and installs it only when `--role` names it. `paraclete-h2` is one |
| Paraclete-H2 | The continual-improvement harness (`dev/harness2/`, build plan phase 11) and its development role `paraclete-h2`. It runs missions against benchmark tasks, proposes changes to the mutable surface, and opens the winners as promotion pull requests |
| mutable surface | What the harness may change, seven components `c1` to `c7` (`dev/harness2/surface.mjs`): contracts tunables, base and role organ prompts, skill playbooks (each skill's `SKILL.md` and `skill.json`), and role playbooks (a role's README, processes and responsibilities). No code and no grants: a skill's commands and a role's `role.json` are outside it, as is the rest of the code |
| promotion | A harness change opened as a pull request to `main`: its title starts with its version (`dev/harness2/promote.mjs`), and it is merged with squash. It reaches instances in the next release |
| setup wizard | The dashboard's Settings, Workspace tab on a workspace role: the steps that connect the agent's Workspace account |
| setup checklist | The dashboard's Settings, Setup tab: what is done and what is left, for an admin |
| version card | The top of the dashboard's Settings, System tab: the release the instance runs, newer releases with their notes, and Install |
| workspace role | A role flagged `workspace: true`. Its agent gets its own Google Workspace account through domain-wide delegation |
| Workspace account | The agent's own Google account on a workspace role: a user an admin creates, connected in the dashboard's setup wizard, and recorded on the VM in `/etc/paraclete/workspace.json`. The agent acts as it for Chat, Drive, Docs, Sheets, Slides, Calendar and Gmail |
| domain-wide delegation | The Admin console grant that lets `paraclete-dwd@` sign tokens as the agent's Workspace account, for the scopes listed. Google has no API for it, so an admin pastes the client ID and scopes the wizard shows |
| Chat app record | The Chat API's configuration in the project: an app name and a description, interactive features off. Google requires it of the project that calls the Chat API, also for calls made as a user. Nobody sees it; the agent is a person in Chat, not an app. An admin saves it once in the Cloud console, from the wizard's link |
| first message | The first mention of the agent's new Workspace account in a Google Chat space it was added to. Until someone has written to a user, Chat refuses to list its conversations, so the agent can see none; the workspace check reports Chat as waiting for it, and the agent reads messages from up to an hour before Chat first answered, so this one is answered too. People reach the agent in spaces: Chat refuses its replies in direct messages while its account has never signed in |
| agent-images | The Artifact Registry repository a role with `resource_roles` on `agent-repository` pushes its images to; the agent may write there and nowhere else in Artifact Registry |
| role move | A developer re-running `install.sh --role <other>` on an existing instance. Not a product feature: the old role's own grants are revoked, its packages stay, memory stays |
| release | A version tag on main (`vYYYY.MM.DD.N.N`) published as a GitHub release with notes by `.github/workflows/release.yml`; instances install it or upgrade to it. `dev/release.mjs` cuts one |
| upgrade | Moving an instance, VM first and then the dashboard, to a release or commit. From the dashboard: the System tab's Install, only forward |
| automatic update | An upgrade the dashboard starts by itself: its scheduled job (a Cloud Run job, started by Cloud Scheduler every 30 minutes) installs the newest release the way Install does, while the agent is idle (`dashboard/lib/server/auto-update.mjs`). On by default (`config/settings.auto_update`); never moves an instance installed from a branch or commit |
| migration | A release's idempotent data change (`migrations/<version>-<slug>.mjs`), run once per instance by the upgrade after the services stop and before the new release is swapped in; recorded in `config/migrations` |
| Claude candidates | The Claude Opus models the contracts list (`vertex.models.claude_candidates`), newest first: the Models tab's Test tries each, and Claude is turned on with the newest that answered (`config/settings.claude_model`) |
| dashboard | The web app where people use and manage an instance |
| dashboard admin | A dashboard user who manages users, settings, secrets, models and upgrades |
| dashboard member | A dashboard user who chats with the agent, follows and approves its work, and downloads its files |
| dashboard user | Someone with both the IAP grant on the dashboard's service and a record in `users`. Either alone grants nothing |
| IAP | Identity-Aware Proxy: Google's sign-in in front of the dashboard. It admits only people granted access and signs a header saying who they are |

## The agent's brain

| Term | Meaning |
|---|---|
| organ | One single-purpose part of the brain, with its own prompt and toolset |
| cortex | The organ that decides the next step of a mission |
| prefrontal | The organ that plans a mission's checkpoints |
| motor | The organ that executes tasks with tools |
| cerebellum | The organ that verifies each checkpoint and owns the verdict |
| temporal-memory | The organ that maintains the agent's memory |
| temporal-research | The organ that researches outside sources |
| gateway | The service that runs an organ's turn against a model |
| transcript | The gateway's provider-neutral record of a turn: messages, tool calls and their results. A fallback model continues it rather than starting over |
| thought signature | An opaque token Gemini attaches to its function calls; it must travel back with the call in the next request |
| viewImage | The gateway tool that shows an organ (motor, temporal-research or cerebellum) an image file as pixels: PNG, JPEG or WebP. A PDF page or slide is rendered to PNG with the files skill first. Only a turn's most recent images stay in its transcript |
| session | The cortex's running conversation for one mission, kept by the gateway so each step sends only what is new |
| fallback model | The model a turn continues on when its organ's model fails |
| strong tier | The more capable model used for planning, executing and verifying |
| effort | The dashboard setting that trades thoroughness against cost |

## Work

| Term | Meaning |
|---|---|
| request | Something a person asked the agent for. It arrives as an intake and becomes a mission directly; a request (`R`) envelope is written only when a responsibility fires, or for an approval reply that resolved nothing |
| envelope | The Firestore document, in the `work` collection, for one request, mission, checkpoint or task. Its `status` moves only along the legal transitions in `agent/work/work-transitions.mjs` |
| intake | An inbound message waiting for the brain to classify it as a new request, an answer to a waiting mission, or chat |
| classification | What the brain decides an intake is: `new_mission`, `attach` (more instruction for running work), `continue` (an answer to a mission that asked), `cancel`, or `respond` (a conversational turn answered at once) |
| follow-up mission | A new mission that carries a finished one as context, made when a person continues work that already completed |
| acknowledgment | The short reply the brain sends at once when it takes on a request |
| mission | The unit of work created from a request. Missions never nest |
| checkpoint | One verified milestone within a mission |
| task | One step of a checkpoint, done by one organ |
| acceptance criteria | What a checkpoint must achieve; the verifier judges against them |
| checkpoint spine | The mission's list of checkpoints and their verified status, kept by code. The finish gate refuses to complete a mission while the spine shows an unverified checkpoint |
| move | One of the cortex's legal decisions on a mission: `checkpoint_plan`, `synthesize`, `synthesize_with_failure`, `needs_input`, `blocked`, `status_update`, `wait` or `trigger_responsibility` (`agent/services/brain/actions/index.mjs`) |
| decide loop | The brain's cycle on one mission: ask the cortex for a move, run the move's handler, repeat until the mission finishes or waits |
| claim | The durable mark a brain puts on a mission it runs, so a restarted brain or a second runner never runs it twice |
| scoped re-plan | Planning again only the part of a mission that failed, keeping its verified checkpoints |
| milestone | A checkpoint the verifier judges on its own evidence, as opposed to a step inside one |
| inconclusive | A verdict the verifier could not reach on the evidence it had; the checkpoint fails closed |
| transition table | The legal status changes of an envelope, in `agent/work/work-transitions.mjs` |
| milestone verdict | The verifier's judgment of one checkpoint |
| verdict | The verifier's judgment: met, met with a caveat, or not met |
| adversarial pass | After a passing verdict on consequential work, the verifier attacks its own conclusion (an expert's objection, a flip test, a boundary case). An attack that lands overturns the pass; one that can't be judged leaves at most a caveat |
| attack duty | The part of the verifier's prompt that sets the adversarial pass |
| evidence floor | The check that a motor task claiming success shows the tool records behind it. A thin record adds a warning for the verifier; it never fails the task on its own (`agent/work/task-outcome.mjs`) |
| known resources | The block of identifiers the mission already resolved (from its resource ledger), given to organs so they never search for them again |
| probe | A follow-up check a verifier would ask for when the evidence in hand can't settle a claim. Not built: the verifier has no way to ask for one, and reports a fail saying what is missing instead |
| stakes | How much harm a mistake would do: `routine`, `consequential` or `irreversible`. Higher stakes earn more verification and an approval gate |
| effect scope | What a mission is allowed to change. A memory-scoped mission may change only the agent's memory |
| result packet | The structured hand-off from one task to the next: outputs, evidence and the tool records behind them |
| resource ledger | The record of everything a mission created or changed outside its own files, so it can be reported and cleaned up |
| blackboard | The mission's shared notes, visible to every organ working on it |
| step ledger | The record of which steps of a checkpoint already ran, so a resumed mission never repeats one |
| approval gate | A checkpoint step that waits for a person to approve before the work continues |
| responsibility | Scheduled or triggered work the agent owns, such as nightly memory consolidation |
| installed default | A responsibility as its role package ships it. An override in the agent's store changes only the fields it names; a bad override is skipped and the default runs |
| locked | A `generic` upkeep responsibility no override may change |
| notice | A message from the agent that belongs to no one's thread, such as a scheduled briefing; every dashboard user sees it |
| process | A playbook the agent follows for a kind of work |
| project | A body of work with its own artifact repository and context |
| canon | A project's authoritative entries: facts and rules that hold for every mission in it. Only its canon authority may change them; today the check compares the authority with the agent's own account, so no path lets a person change a project's canon yet |
| artifact | A file the agent produced, stored in its git artifact store |
| artifact manifest | The record of which artifacts a mission or project holds, with their content hashes |
| deliverable | What a mission hands back to the person who asked |
| mission tree | The mission's working directory on the VM, a git checkout of its project's artifact repository |
| merge policy | How a mission's branch reaches its project's main branch: `auto` merges when the mission passes; `gated` parks the merge for a person's approval, which nothing resolves yet |
| mission record | The summary of a finished mission the brain writes into the mission tree |
| context promotion | A suggestion, written when a mission ends, that a fact it found should join its project's context; the Library lists them, and nothing accepts one yet |
| outgoing file | A file the agent hands back, stored under `files/out/<mission>/` in the bucket and shown as a download on the mission |
| incoming file | A file a person shared with the agent, stored under `files/in/<upload>/` in the bucket |
| file record | A document in the `files` collection for one outgoing or incoming file: its mission, name, size, type, where it is stored, and the Drive copy if any. A mission's downloads and its final reply's attachments are its outgoing records |
| mission inbox | `missions/<id>/inbox/` inside a mission's working tree: where `file-get`, `drive-get` and `drive-export` put what they fetch. Never committed |
| output folder | An optional Drive folder, set in the dashboard, where the agent saves finished files as new Drive files. For the agent's service account it must be in a shared drive the account belongs to |

## Knowledge

| Term | Meaning |
|---|---|
| working memory | `MEMORY.md`: short, current context the agent carries into every turn |
| Core Memory | Durable facts the agent has learned, stored in Firestore |
| consolidation report | `consolidation_report.md`, the memory organ's account of what a consolidation pass changed and why |
| Deep Truths | The few principles the agent has confirmed across many sessions |
| skill | Codified procedure: instructions plus the commands that do one kind of work |
| tool record | The log of a tool call, written by code, that the model cannot fabricate |
| step note | A short record of what one task did, written to the mission tree so a resumed mission can see it |
| tool log | The block of tool records the gateway appends to a turn's output, between `[TOOL EXECUTION LOG]` markers |
| epistemic bin | How a claim is known: `verified` (re-derived from evidence), `inferred` (reasoned from evidence) or `assumed` (not checked). Every claim the agent reports carries one |
| brief | The prefrontal's analysis of a mission before the cortex decides: what is being asked, what is known, and what is missing |
| capability map | What the planners (the cortex and the prefrontal) see of the skills: each skill's name and the first sentence of its `when_to_use` |
| skill index | What an organ with tools sees of the skills: name, id, the whole `when_to_use`, and where its `SKILL.md` is. Built once when the gateway starts |
| intent keywords | A playbook's recall phrases: words that, found in a request, suggest the playbook to the planner |
| bundle | A git bundle file in the bucket. A repository's history is a chain of bundles; `gc` consolidates them |
| ref | The pointer from a branch of an artifact repository to its latest commit and the bundles that hold it, stored in Firestore |

## Conversation

| Term | Meaning |
|---|---|
| channel | Where a conversation happens: the dashboard (every instance) or Google Chat (Workspace roles) |
| voicing | The mouth's rewrite of the brain's output into a reply for the person, using the recent conversation |
| status note | A short progress message the mouth sends while a mission runs, on a fixed schedule |
| thread ledger | The agent's own record of each conversation thread's turns and running summary |
| address | The fixed destination of a reply, recorded when a message arrives. The mouth delivers to exactly that address |
| thread | One user's conversation with the agent in the dashboard |
| utility model | The fast model the services call directly for small jobs: classifying intake, writing acknowledgments, digesting results |

## Running on the VM

| Term | Meaning |
|---|---|
| brain | The service that runs the mission loop |
| ears | The service that takes in messages and files |
| mouth | The service that sends everything out. The only way out |
| control | The service that carries out the dashboard's commands on the VM |
| command | A request from the dashboard to the VM, written to the `commands` collection: a view (`status`, `skills`...) or a change (`restart_service`, `upgrade`...) |
| signed command | A command carrying the dashboard service account's signature over its id, type, params and requester. Control runs nothing else |
| heartbeat | A service's `services/<service>/health.json` under the data root, rewritten after each poll; control reports one older than a minute as stale |
| contracts | `config/contracts.json`, the single source for shared values |
| manifest | `install/manifest.txt`, the list of files installed onto the VM |
| install root | `/opt/paraclete`: the installed release, read-only to the agent |
| data root | `/var/lib/paraclete`: what the agent keeps across releases (memory, missions, files, its own skills, the services' health) |
| validation gate | The checks a staged release must pass before anything stops or is swapped (`install/vm/check-release.mjs`, and the migrations' dry run) |
| service accounts | `paraclete-agent@` (the VM, as the agent), `paraclete-dashboard@` (the dashboard; it signs the commands the VM obeys) and, on a workspace role, `paraclete-dwd@` (signs the agent's Workspace tokens; holds nothing in Google Cloud) |
| smoke test | `dev/smoke.mjs`: one read-only request in the installed role's area, followed until it passes or fails |
