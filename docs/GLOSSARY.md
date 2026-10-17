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
| strong tier | The more capable model used for planning, executing and verifying |
| effort | The dashboard setting that trades thoroughness against cost |

## Work

| Term | Meaning |
|---|---|
| request | Something a person asked the agent for |
| mission | The unit of work created from a request. Missions never nest |
| checkpoint | One verified milestone within a mission |
| task | One step of a checkpoint, done by one organ |
| acceptance criteria | What a checkpoint must achieve; the verifier judges against them |
| verdict | The verifier's judgment: met, met with a caveat, or not met |
| approval gate | A checkpoint step that waits for a person to approve before the work continues |
| responsibility | Scheduled or triggered work the agent owns, such as nightly memory consolidation |
| process | A playbook the agent follows for a kind of work |
| project | A body of work with its own artifact repository and context |
| artifact | A file the agent produced, stored in its git artifact store |
| deliverable | What a mission hands back to the person who asked |

## Knowledge

| Term | Meaning |
|---|---|
| working memory | `MEMORY.md`: short, current context the agent carries into every turn |
| Core Memory | Durable facts the agent has learned, stored in Firestore |
| Deep Truths | The few principles the agent has confirmed across many sessions |
| skill | Codified procedure: instructions plus the commands that do one kind of work |
| tool record | The log of a tool call, written by code, that the model cannot fabricate |

## Running on the VM

| Term | Meaning |
|---|---|
| brain | The service that runs the mission loop |
| ears | The service that takes in messages and files |
| mouth | The service that sends everything out. The only way out |
| control | The service that carries out the dashboard's commands on the VM |
| contracts | `config/contracts.json`, the single source for shared values |
| manifest | `install/manifest.txt`, the list of files installed onto the VM |
