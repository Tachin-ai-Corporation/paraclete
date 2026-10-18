# Skill: Meeting Management

## When to use

When a request is about running a project through its meetings: an agenda, minutes from notes or a
transcript, the action items and who owes what, the action tracker, or a status report.

This skill is the method. The commands belong to other skills, whose SKILL.md files give the exact
syntax: read them before your first command.

| Skill | Commands | For |
|---|---|---|
| workspace-docs | `docs-get`, `docs-create` | Reading notes in a Google Doc; writing minutes, agendas and reports as new Docs |
| workspace-sheets | `sheets-get`, `sheets-create`, `sheets-append`, `sheets-update` | The action tracker |
| workspace-calendar | `cal-list`, `cal-get` | A meeting's date, title and guests |
| drive | `drive-find`, `drive-export` | Finding notes shared with you and reading copies of them |
| files | `file-get`, `file-read`, `file-make`, `file-share` | Notes dropped in chat, and deliverables as files |

The Workspace skills need the agent's Workspace account. Without it, work from files people drop in
chat and deliver files.

## Where meeting material comes from

- **Notes or a transcript in a Google Doc.** Google Meet saves them in the organizer's Drive and shares
  them as the organization's settings say, often with the invitees inside the organization. Inviting
  your address to the meeting is usually the simplest way to receive them; otherwise ask the organizer
  to share the document. Find it with `drive-find "<words from the meeting title>" --type doc`, read it
  with `drive-export <link> --format md --mission <mission id>`.
- **A file in chat** (Word, PDF, text, a `.vtt` transcript): `file-get`, then `file-read`.
- **Text pasted in the conversation.**
- **The event itself:** `cal-get` gives the date, title and guests, which you need to name owners
  correctly.

## The formats

- **Decision:** `Decision: <what was decided>. By <who>, <YYYY-MM-DD>. Why: <reason, if stated>.`
- **Action item:** one row of `| ID | Action | Owner | Due | Status | Source |`. Status is `open`,
  `done`, `blocked` or `dropped` (with the reason). Source names the meeting and date it came from.
- **Open question:** `<question>. To answer: <owner> by <YYYY-MM-DD>.`
- **Missing:** `owner: missing` or `due: missing`, never a guess.

Name what you create so people can find it: `<Project> - Meeting notes - YYYY-MM-DD`,
`<Project> - Status report - YYYY-MM-DD`, `<Project> - Action items`, `<Project> - Decision log`.

## Procedures

### Prepare an agenda

1. `cal-get` the meeting: purpose, time, length, guests.
2. Read the last minutes and the tracker: open items owned by the attendees, overdue ones first.
3. Write the agenda: the purpose and the outcome wanted; a review of open action items; each topic with
   who leads it, its minutes and whether a decision is needed; time at the end for new action items.
   The minutes add up to the meeting's length.
4. Deliver it as your answer, or as a new Doc (`docs-create`) when asked. Sending it to the attendees
   is the person's to do, or an approved step.

### Turn notes or a transcript into minutes

1. Read the whole source before writing anything, and match it to its event for the date and the
   attendees.
2. Pull out:
   - **decisions**: only what was explicitly settled ("we'll go with", "agreed", "approved"); a
     discussion that ended without one is an open question;
   - **action items**: every commitment ("I'll", "<name> will", a request someone accepted);
   - **open questions** and **blockers**.
3. **Owners** are the people the source names. "We", "the team" or "someone" is `owner: missing`.
   Match names against the attendee list; when two people could be meant, say so.
4. **Due dates** come from the source. Resolve a relative one ("by Friday") against the meeting's
   date, and check the weekday with a date tool (`date -d 2026-10-16 '+%F %a'` prints
   `2026-10-16 Fri`). When it could mean two dates ("next Friday" said on a Wednesday), write the one
   you chose and flag it. "Soon" or "later" is `due: missing`.
5. Write the minutes: meeting, date and attendees; Decisions; Action items (table); Open questions;
   Blockers; and a last section listing every item missing an owner or a date, for the person to settle.
6. Deliver them as a new Doc or a file, then update the tracker (below) when there is one.

### Keep the action tracker

The tracker is a spreadsheet your own account created, so you may keep it up to date in place.

1. **Create it once,** when the person asks for a tracker or there is none: `sheets-create` titled
   `<Project> - Action items`, with the header row
   `ID | Action | Owner | Due | Status | Source | Opened | Updated | Note`, in the folder the team named.
   That must be a folder shared with you as Editor, or your own My Drive: a file you create in a shared
   drive has no owner, so you could never update it. Give the person its link, and record its id in the
   project's context so later missions use the same one.
2. **Before every change,** `sheets-get` the whole table.
3. **New items:** `sheets-append` one row each, with the next ID and today's date as Opened.
4. **Changed items:** `sheets-update` only that row's Status, Updated and Note cells. Never delete a row
   or rewrite its Action, Owner or Due: a changed due date is a Note (`2026-10-20: due moved to
   2026-10-27 because <reason>`) and a new Due value only when the owner agreed it.
5. **Read it back** with `sheets-get` and check the new rows are there and the others unchanged.
6. **A tracker someone else owns** is never written. Give the rows to add in your answer, or keep your
   own tracker beside it when the person asks.

Flag, with a script rather than by eye: `open` items past their Due (overdue), items with no owner
(unowned), and open items not updated for 14 days (stale).

### Write a status report

1. Read the tracker, the last report, the minutes since then and the milestone plan.
2. Write, in this order every time:
   - **Blockers:** what is stuck, who can unblock it, since when, and what the delay costs;
   - **Milestones:** each with its target date and status (on track, at risk, late, done); a moved
     date shows the new date and the reason;
   - **Progress** since the last report, each with its evidence (a document, a closed item);
   - **Next:** what, who, by when;
   - **Risks,** new or changed;
   - **Decisions needed:** from whom, by when.
3. Deliver it as your answer, a new Doc or a file. Sending it to stakeholders is the person's call, or
   an approved step.

### Who owes what

List the open items by owner, overdue first, with due dates. You cannot send reminders: give the list
to the person, and draft a short note per owner when asked.

## Documents and Drive

Drive is a source and a destination. Read shared notes and plans as copies, and hand results back as
new files: a download, or a new Doc or Sheet your account creates. Never edit, move, rename, trash or
delete a file someone shared with you, even with Editor access. You edit in place only documents and
spreadsheets your own account created, such as your tracker.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| The meeting's notes are not found | They were not shared with you | Ask the organizer to share the notes document, or to invite your address to the next meeting |
| Two attendees could be the owner | The source used a first name | Check the event's guest list; if still unclear, mark the owner as ambiguous and ask |
| Writing to a tracker is refused | Your account did not create it, or has no edit access | Do not work around it: give the rows to add, or keep your own tracker |
| A transcript is too long to read at once | A long meeting | Save it as text and read it in parts (`sed -n '1,400p'`, then the next lines) until you have read all of it; minutes from part of a meeting are wrong |
| The Workspace commands say the account is not set up | The instance's Workspace setup is unfinished | Work from files in chat, and ask a dashboard admin to finish the Workspace setup in the dashboard |
