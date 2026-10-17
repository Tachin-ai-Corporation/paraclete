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
| workspace role | A role flagged `workspace: true`. Its agent gets its own Google Workspace account through domain-wide delegation |
| release | A tag of this repo that instances can install or upgrade to |
| upgrade | Moving an instance, dashboard and VM together, to a release or commit |
| dashboard | The web app where people use and manage an instance |
| dashboard admin | A dashboard user who manages users, settings, secrets, models and upgrades |
| dashboard member | A dashboard user who chats with the agent, follows and approves its work, and downloads its files |

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
| session | The cortex's running conversation for one mission, kept by the gateway so each step sends only what is new |
| fallback model | The model a turn continues on when its organ's model fails |
| strong tier | The more capable model used for planning, executing and verifying |
| effort | The dashboard setting that trades thoroughness against cost |

## Work

| Term | Meaning |
|---|---|
| request | Something a person asked the agent for |
| envelope | The Firestore document, in the `work` collection, for one request, mission, checkpoint or task. Its `status` moves only along the legal transitions in `agent/work/work-transitions.mjs` |
| intake | An inbound message waiting for the brain to classify it as a new request, an answer to a waiting mission, or chat |
| mission | The unit of work created from a request. Missions never nest |
| checkpoint | One verified milestone within a mission |
| task | One step of a checkpoint, done by one organ |
| acceptance criteria | What a checkpoint must achieve; the verifier judges against them |
| checkpoint spine | The mission's list of checkpoints and their verified status, kept by code. The mission cannot finish while the spine shows an unverified checkpoint |
| milestone verdict | The verifier's judgment of one checkpoint |
| verdict | The verifier's judgment: met, met with a caveat, or not met |
| probe | A follow-up check the verifier asks for when the evidence in hand can't settle a claim |
| stakes | How much harm a mistake would do: `routine`, `consequential` or `irreversible`. Higher stakes earn more verification and an approval gate |
| effect scope | What a mission is allowed to change. A memory-scoped mission may change only the agent's memory |
| result packet | The structured hand-off from one task to the next: outputs, evidence and the tool records behind them |
| resource ledger | The record of everything a mission created or changed outside its own files, so it can be reported and cleaned up |
| blackboard | The mission's shared notes, visible to every organ working on it |
| step ledger | The record of which steps of a checkpoint already ran, so a resumed mission never repeats one |
| approval gate | A checkpoint step that waits for a person to approve before the work continues |
| responsibility | Scheduled or triggered work the agent owns, such as nightly memory consolidation |
| process | A playbook the agent follows for a kind of work |
| project | A body of work with its own artifact repository and context |
| artifact | A file the agent produced, stored in its git artifact store |
| artifact manifest | The record of which artifacts a mission or project holds, with their content hashes |
| deliverable | What a mission hands back to the person who asked |
| mission tree | The mission's working directory on the VM, a git checkout of its project's artifact repository |
| merge policy | How a mission's branch reaches its project's main branch: `auto` merges when the mission passes, `gated` waits for a person's approval |
| outgoing file | A file the agent hands back, stored under `files/out/<mission>/` in the bucket and shown as a download on the mission |
| incoming file | A file a person shared with the agent, stored under `files/in/<upload>/` in the bucket |

## Knowledge

| Term | Meaning |
|---|---|
| working memory | `MEMORY.md`: short, current context the agent carries into every turn |
| Core Memory | Durable facts the agent has learned, stored in Firestore |
| Deep Truths | The few principles the agent has confirmed across many sessions |
| skill | Codified procedure: instructions plus the commands that do one kind of work |
| tool record | The log of a tool call, written by code, that the model cannot fabricate |
| tool log | The block of tool records the gateway appends to a turn's output, between `[TOOL EXECUTION LOG]` markers |
| epistemic bin | How a claim is known: `verified` (re-derived from evidence), `inferred` (reasoned from evidence) or `assumed` (not checked). Every claim the agent reports carries one |
| brief | The cortex's analysis of a mission before it decides: what is being asked, what is known, and what is missing |
| bundle | A git bundle file in the bucket. A repository's history is a chain of bundles; `gc` consolidates them |
| ref | The pointer from a branch of an artifact repository to its latest commit and the bundles that hold it, stored in Firestore |

## Conversation

| Term | Meaning |
|---|---|
| channel | Where a conversation happens: the dashboard (every instance) or Google Chat (Workspace roles) |
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
| contracts | `config/contracts.json`, the single source for shared values |
| manifest | `install/manifest.txt`, the list of files installed onto the VM |
