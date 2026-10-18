# roles/executive-assistant/

A Workspace role: an agent that looks after people's time. It schedules without conflicts, prepares
meeting briefs and a daily briefing, reads the mail sent to it, and drafts documents. It reads and
prepares; nothing goes out on anyone's behalf until they confirm it.

| Part | Executive Assistant |
|---|---|
| Purpose | Calendars, scheduling, meeting preparation, a daily briefing, and the documents around them |
| Channel | Dashboard chat, and Google Chat once the Workspace account is set up |
| Skills | The base skills, the Workspace skills, and `calendar-management` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): never accept, decline or send on someone's behalf without being asked, and confirm before anything leaves; mail is read-only; every time has a zone; check free/busy before booking |
| Responsibilities | `r-daily-briefing`, shipped turned off (below) |
| GCP roles | None beyond the generic base set: every Workspace API is reached as the agent's own account |
| Workspace | Yes. The agent needs its own Google Workspace account, set up by a dashboard admin in the dashboard after install: create the user, grant domain-wide delegation in the Admin console, then test it |

## The Workspace account

Calendar, Gmail, Docs, Sheets and Slides run as the agent's own Google account, through
domain-wide delegation to `paraclete-dwd@<project>.iam.gserviceaccount.com`. The installer cannot
create that account or the grant (Google has no API for the grant), so a dashboard admin does it after
install, following the dashboard's setup wizard. Until then the agent works like `generic`, and the
calendar-management skill is unavailable.

What the agent can reach through that account:

| What | How it works |
|---|---|
| A person's calendar | They share it with the agent's address with "See all event details", so the agent can read it. The agent cannot write to it |
| Scheduling | The agent creates events on its own calendar and invites people, the person it works for among them; invitations come from the agent's address. It changes only events it organized, and cannot answer invitations or delete events |
| Free/busy | Nothing to do, for people in the organization whose calendars show availability |
| Mail | Only mail sent or forwarded to the agent's own address. Gmail access is read-only: the agent never sends, replies or drafts |
| Documents | Shared with the agent's address, like with a colleague |

## Workspace skills it relies on

Base skills in `skills/` that every Workspace role gets. The calendar-management skill names their
commands and leaves their syntax to them.

| Skill | Commands used |
|---|---|
| `workspace-calendar` | `cal-list`, `cal-get`, `cal-freebusy`, `cal-create`, `cal-update` |
| `workspace-gmail` | `gmail-search`, `gmail-get` |
| `workspace-docs` | `docs-get`, `docs-create` |
| `drive` | `drive-find`, `drive-export` (both identities; the generic base) |

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: `workspace: true`, the `calendar-management` skill, no extra GCP roles, no extra packages |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/calendar-management/` | The method for finding time, scheduling and moving meetings, meeting briefs and the daily briefing, with timezone handling, and what the calendar commands cannot do. No commands of its own; marked `requires: ["workspace"]` |
| `responsibilities.json` | `r-daily-briefing`: weekdays at 07:00, turned off (below) |
| `processes/` | `p-daily-briefing`, `p-schedule-meeting`, `p-meeting-brief` |
| `memory.md` | The agent's first working memory: what it still has to learn (whom it assists, their timezone) |

## Why the daily briefing ships turned off

It is safe to run: it reads calendars, mail and memory and changes and sends nothing. It ships off
because at install it would brief nobody: the agent does not yet know whose day it is, their
timezone, or which calendars are theirs, and its Workspace account comes later. Its answer is also a
dashboard notice that every dashboard user sees, which suits an instance whose dashboard users are the
people being briefed. To turn it on, tell the agent whom to brief and in which timezone and ask for the
briefing; it sets the schedule and timezone (`responsibility-manage update` and `toggle`). An admin can
also turn it on in the dashboard; its default time is 07:00 UTC.

## Rules the role adds

- Nothing reaches another person without the person's request and an approval of exactly what goes:
  invitations, changes to events others are invited to, mentions in comments, shares. An event whose
  only guest is the person asking, at a time they gave or chose, reaches no one else and needs no
  separate approval.
- Gmail is read-only by scope (`gmail.readonly`): the agent never sends, replies, forwards or drafts.
- Drive is a source and a destination. The agent edits in place only documents its own account
  created; files people shared with it are read as copies and never edited, moved, renamed, trashed or
  deleted.
