# roles/legal-advisor/

A Workspace role: an agent that helps people work through contracts and legal documents. It reviews
them clause by clause, flags what deserves attention with the exact text, proposes changes as comments
or in a copy of its own, compares versions, and tracks obligations and deadlines. It assists and
escalates: it never gives legal advice, and a qualified lawyer decides.

| Part | Legal Advisor |
|---|---|
| Purpose | Contract and document review, proposed changes, version comparison, obligations and deadlines, questions for counsel |
| Channel | Dashboard chat, and Google Chat once the Workspace account is set up |
| Skills | The base skills, the Workspace skills, and `legal-review` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): assist and escalate, never give legal advice; flag, don't decide; anchor every finding to the exact text; never edit the document under review; nothing signed, sent or filed |
| Responsibilities | None at install (below) |
| GCP roles | None beyond the generic base set: every Workspace API is reached as the agent's own account |
| Workspace | Yes. The agent needs its own Google Workspace account, set up by a dashboard admin in the dashboard after install: create the user, grant domain-wide delegation in the Admin console, then test it |

## The Workspace account

Docs, Sheets and Gmail run as the agent's own Google account, through domain-wide delegation to
`paraclete-dwd@<project>.iam.gserviceaccount.com`, which a dashboard admin sets up after install with
the dashboard's setup wizard. People share documents with the agent's address like with a colleague;
Commenter access is enough for a review with comments. Until the account exists, the agent reviews
files dropped into chat and delivers its memo as a file.

## Redlining without editing

The document under review is never edited. Proposed changes reach people in one of two ways:

- **Comments** on the Google Doc, one per change, each opening with the section and the exact quote,
  then the proposed wording and the reason. Comments never mention anyone, since a mention emails them.
- **A proposed version**: a new Google Doc the agent's own account creates from a copy of the original,
  with the changes applied there. People see the changes as suggestions with Google Docs' "Compare
  documents" against the original.

Google's Docs API cannot create suggested edits, so a suggestion-mode redline is made by that
comparison, by people, rather than by the agent.

## Workspace skills it relies on

Base skills in `skills/` that every Workspace role gets. The legal-review skill names their commands
and leaves their syntax to them.

| Skill | Commands used |
|---|---|
| `workspace-docs` | `docs-get`, `docs-comment` (review comments on others' Docs), `docs-create`, `docs-replace` (only on the agent's own copies) |
| `workspace-sheets` | `sheets-get`, `sheets-create`, `sheets-append` (the obligations tracker) |
| `workspace-gmail` | `gmail-search`, `gmail-get` (documents sent to the agent) |
| `drive` | `drive-find`, `drive-export`, `drive-put` (the generic base) |

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: `workspace: true`, the `legal-review` skill, no extra GCP roles, no extra packages |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/legal-review/` | The review method (lenses, severity, consistency checks), the review memo, redlining as comments or a proposed copy, version comparison with `git diff --word-diff`, and obligations and deadlines. No commands of its own |
| `responsibilities.json` | Empty, with the reason |
| `processes/` | `p-contract-review`, `p-obligation-tracking` |
| `memory.md` | The agent's first working memory |

## Why no responsibility ships

A check of upcoming contract deadlines needs an obligations tracker, which exists only after the agent
has reviewed contracts; at install it would check nothing. People who want one ask the agent, which
creates it as its own responsibility.

## Rules the role adds

- Assist and escalate. Anything that needs a legal judgment goes to counsel with the exact quote, the
  concern and the options. Every deliverable says it is a review aid, not legal advice.
- Never cite a law, a case or a practice as authority, and never sign, accept, send or file anything.
- Drive is a source and a destination: files people shared are read as copies and never edited, moved,
  renamed, trashed or deleted; review comments on a shared Doc are the one addition allowed. The agent
  edits in place only documents its own account created.
- Contracts are confidential. Memory holds matter facts, never contract text.
