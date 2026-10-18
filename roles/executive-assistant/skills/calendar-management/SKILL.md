# Skill: Calendar Management

## When to use

When someone asks you to find time, schedule or move a meeting, prepare them for a meeting, or brief
them on their day, or asks about invitations they received.

This skill is the method. The commands belong to base skills, and their SKILL.md files give the exact
syntax: read them before your first command.

| Skill | Commands | For |
|---|---|---|
| workspace-calendar | `cal-list`, `cal-get`, `cal-freebusy`, `cal-create`, `cal-update` | Reading events and availability; creating and changing events on your own calendar |
| workspace-gmail | `gmail-search`, `gmail-get` | Reading the mail that reaches your own account. Read-only: there is no way to send |
| workspace-docs | `docs-get`, `docs-create` | Reading a meeting's documents; writing a brief as a new Doc |
| drive | `drive-find`, `drive-export` | Finding documents shared with you, and reading copies of them |

## What you can do on a calendar

- **Your own calendar** belongs to your Workspace account. Every event you create goes there, and the
  people you invite get the invitation from your address. That is how a meeting reaches the person you
  work for: you invite them.
- **A person's calendar** you can read (`cal-list --calendar <their address>`) once they share it with
  your address with "See all event details". You cannot create or change events on it.
- **Free/busy** (`cal-freebusy`): busy times, without details, for anyone in the organization whose
  calendar shows availability.
- **Changing an event:** only one you organize, which means one you created. Someone else's meeting
  changes through its organizer.
- **Not possible with these commands:** answering an invitation (yours or anyone's) and deleting an
  event.

When a calendar you need is not visible, tell the person how to share it: in Google Calendar, the
calendar's "Settings and sharing", then "Share with specific people", add your address, and choose
"See all event details".

## The rules

1. **Read before you write.** Look at the event as it stands and at free/busy for the window before you
   create or move anything.
2. **Every time has a zone,** the person's own, named, and right for the event's date (below).
3. **Nothing reaches anyone unconfirmed.** Inviting people or removing them emails them; changing an
   event that has guests changes it on their calendars, and emails them when notified. Each such step
   waits for an approval of exactly what will go out (the event, the time with its zone, every guest),
   and then you do exactly that. One exception: an event whose only guest is the person who asked, at a
   time they gave or chose, reaches no one else and needs no separate approval.
4. **Mail is read-only.** Search and read; a reply the person needs goes in your answer as text.
5. **Bring in only what is needed.** A brief needs a meeting's purpose and its asks, not every guest's
   address or a message's full text.

## Timezones

- Use IANA zone names (`America/New_York`, `Europe/Berlin`), never abbreviations: "CST" names three
  different zones.
- The person's zone comes from working memory or the conversation. When neither has it and the time
  matters, ask.
- The calendar commands take a zone (`--tz`) and read and print times in it: pass the person's zone
  rather than converting times yourself.
- For any other arithmetic, let a tool do it, for the event's own date: around a daylight-saving change,
  a date a few weeks away has a different offset from today's.
  - A wall-clock time in a zone, with its offset:
    `TZ=America/New_York date -d '2026-11-03 10:00' --iso-8601=seconds` prints
    `2026-11-03T10:00:00-05:00`.
  - An event's time as someone elsewhere reads it:
    `TZ=Europe/Berlin date -d '2026-11-03T15:00:00Z' '+%a %d %b %H:%M %Z'`.
- Write times in answers the way the person reads them: "Tue 3 Nov, 10:00-10:30 (New York time)", with
  the other side's local time when attendees are elsewhere.

## Procedures

### Find a time

1. Settle the constraints: who must attend, how long, the window (earliest and latest day), each
   person's zone and working hours (memory, or ask), and whether it needs a video link or a room.
2. `cal-freebusy` for every attendee over the window, with `--slots <minutes>` for the free time they
   share and `--hours` set to the working hours they have in common, in the person's zone (`--tz`).
   Someone whose availability you cannot see is unknown, not free: say so.
3. Prefer times that leave a break after a run of back-to-back meetings.
4. Offer two or three options in the person's zone, and in each attendee's when it differs. Don't
   choose one silently.

### Schedule a meeting

1. Find a time, or take the time the person gave and check it with `cal-freebusy` for every attendee.
2. A conflict: stop and report it with free options. Book over it only when the person says so.
3. Write the event out in full: title, start and end with zone, guests (the person you work for among
   them), video link or place, and the description or agenda. Every guest address comes from something
   you read or were given; never compose one from a name.
4. When anyone besides the person who asked is invited, the event waits for an approval that shows
   step 3's text. Then create exactly what was approved with `cal-create`: the invitations go out as it
   is created.
5. Read it back (`cal-get`): time, zone, guests and their answers. Report its link.

### Move or change a meeting

1. `cal-get` the event: organizer, guests, recurrence. If you did not organize it, you cannot change it:
   tell the person what should change, for them or its organizer to do.
2. A recurring event: settle whether one occurrence or the whole series changes.
3. For a new time, check it as in "Schedule a meeting".
4. An event with guests besides the person who asked: the change waits for an approval that shows
   exactly what changes, who is added or removed, and whether guests are notified.
5. Make the change with `cal-update`, then confirm it with `cal-get`.

### Cancel a meeting, or answer an invitation

The calendar commands do neither. Say so plainly, and never report either as done.

- **Cancel:** for a meeting you organized, the person can ask you to mark it cancelled in its title and
  description (a change under rule 3, since guests see it), and they decline it on their side. For
  anyone else's meeting, its organizer cancels it.
- **Answer an invitation:** tell the person what the invitation is and when it is, and they answer it.

### Prepare a meeting brief

1. `cal-get` the event: purpose, organizer, guests, description, attached or linked documents, video
   link.
2. Read each document as a copy (`drive-export` or `docs-get`) and summarize it in a few lines.
3. `gmail-search` for recent mail about the meeting (words from its title, the organizer's address,
   the last two weeks), and `gmail-get` the messages that matter. Keep the asks and decisions.
4. Look for notes from the last meeting in the same series (`drive-find` with words from the title).
5. Write the brief: purpose and decisions expected; who attends and why, as far as you know; what each
   document says; open questions; two or three questions worth asking; every source by name. Deliver it
   as your answer, or as a new Doc with `docs-create` when one is wanted.

### Prepare the daily briefing

1. **Whose day.** Working memory says whom you brief, their zone, and which calendars are theirs. When
   it doesn't, report that as the missing input. Never brief from your own calendar as if it were
   theirs.
2. **The schedule.** `cal-list` the day in their zone on each calendar in scope (theirs, shared with
   you, and your own for meetings you set up for them). Note each event's time, title, organizer, video
   link or place, and their answer.
3. **What needs attention.** Overlaps; back-to-back runs with no break; invitations still awaiting
   their answer; meetings with nothing to prepare from; changes since the last briefing, when you know
   them.
4. **Mail.** `gmail-search` your inbox for mail since the last briefing (the last day; on a Monday,
   since Friday), and `gmail-get` the messages that ask something. Keep the sender, the ask and the
   deadline.
5. **Open items** from working memory that fall due today.
6. **Write it short:** a one-line day at a glance, then Schedule, Needs attention, Mail that asks
   something, and Open items. Every line traces to a read in this mission. A quiet day gets a short
   briefing that says so.
7. The briefing changes nothing: no event created or changed, and no mail.

## Documents and Drive

Drive is a source and a destination. Read a shared document by bringing a copy into the mission (the
drive skill), and hand results back as new files: a download, or a new Doc your account creates.
Never edit, move, rename, trash or delete a file someone shared with you, even with Editor access. You
edit in place only documents your own account created.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| A calendar or event is not found | It is not shared with you, or the id is wrong | Ask for the share (see "What you can do on a calendar") |
| Free/busy shows nothing, or an error, for someone | Their availability is hidden, or they are outside the organization | Say you cannot see their availability, and ask the person to confirm a time with them |
| A change is refused because someone else organizes the event | Only its organizer may change it | Tell the person what should change, for them or the organizer to do |
| The command says the Workspace account or a scope is not set up | The instance's Workspace setup is unfinished | Tell the person and ask a dashboard admin to finish and test the Workspace setup in the dashboard. Don't retry in a loop |
| A time comes out an hour off | The zone, or the offset for the wrong date | Pass `--tz` with the person's zone; recompute with `date` for the event's own date |
