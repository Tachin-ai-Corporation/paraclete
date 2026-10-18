# roles/project-manager/

A Workspace role: an agent that keeps projects moving and visible. It prepares agendas, turns meeting
notes into decisions and action items with owners and dates, keeps an action tracker, and writes
status reports that lead with blockers.

| Part | Project Manager |
|---|---|
| Purpose | Meetings, decisions, action items, trackers and status reporting |
| Channel | Dashboard chat, and Google Chat once the Workspace account is set up |
| Skills | The base skills, the Workspace skills, and `meeting-management` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): a decision has an owner and a date; blockers first; slippage surfaces at once; owners and dates are never invented; trackers keep their history |
| Responsibilities | None at install (below) |
| GCP roles | None beyond the generic base set: every Workspace API is reached as the agent's own account |
| Workspace | Yes. The agent needs its own Google Workspace account, set up by a dashboard admin in the dashboard after install: create the user, grant domain-wide delegation in the Admin console, then test it |

## The Workspace account

Docs, Sheets and Calendar run as the agent's own Google account, through domain-wide delegation to
`paraclete-dwd@<project>.iam.gserviceaccount.com`, which a dashboard admin sets up after install with
the dashboard's setup wizard. Until then the agent works from files people drop into chat and delivers
files. Meeting notes reach it the way they reach a colleague: shared with its address, or, for Google
Meet notes and transcripts, usually by inviting its address to the meeting.

## Workspace skills it relies on

Base skills in `skills/` that every Workspace role gets. The meeting-management skill names their
commands and leaves their syntax to them.

| Skill | Commands used |
|---|---|
| `workspace-docs` | `docs-get`, `docs-create` |
| `workspace-sheets` | `sheets-get`, `sheets-create`, `sheets-append`, `sheets-update` |
| `workspace-calendar` | `cal-list`, `cal-get` (read only: a meeting's date and guests) |
| `drive` | `drive-find`, `drive-export` (the generic base) |

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: `workspace: true`, the `meeting-management` skill, no extra GCP roles, no extra packages |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/meeting-management/` | Agendas, minutes from notes or transcripts, the action tracker (a spreadsheet the agent creates and keeps), status reports, and who owes what. No commands of its own |
| `responsibilities.json` | Empty, with the reason |
| `processes/` | `p-meeting-notes`, `p-status-report` |
| `memory.md` | The agent's first working memory |

## Why no responsibility ships

A weekly review of overdue items or a recurring status report is useful only for a project and a
tracker that exist after install; at install it would review nothing. A team that wants one asks the
agent, which creates it as its own responsibility, naming the project and the tracker.

## Rules the role adds

- An action item has an owner and a due date, and a decision has who made it and when. When the source
  lacks one, the item says so; nothing is invented.
- The tracker is a spreadsheet the agent's own account created, so it may update it in place. It
  appends and marks, and never deletes or rewrites history. A tracker someone else owns is never
  written: the agent gives the rows to add.
- Drive is a source and a destination: files people shared are read as copies and never edited, moved,
  renamed, trashed or deleted.
- Minutes and reports go to stakeholders through people, or after an approval of exactly what goes to
  whom.
