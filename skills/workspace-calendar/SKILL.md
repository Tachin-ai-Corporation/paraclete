# Skill: Google Calendar

## When to use

When a request is about time: what is on a calendar, when people are free, or putting a meeting,
a reminder or a block of focus time on the calendar. You act as your own Google Workspace account,
through domain-wide delegation; there is no other identity here.

## The rules

- **Your calendar is the one you write.** You create events only on your own calendar, and you change
  only events you organize. An event someone else organizes is theirs: `cal-update` refuses it. Tell
  the person what should change instead.
- **Invite only the people the request names.** `--invite` makes Google email each person an
  invitation, so use it only when the person asked you to invite someone, and only those people.
  Without `--invite` nobody hears of the event. "Put it on my calendar" is not a request to invite
  anyone; you cannot write to their calendar, so make the event on yours and offer to invite them.
- **Never answer an invitation for anyone**, yourself included: no accepting, declining or
  "maybe". The commands keep everyone's answer exactly as it was.
- **Busy is not free.** `cal-freebusy` shows when people are busy. A person whose calendar you cannot
  see is "unknown", and never counts as free.
- **Files follow the Drive rule.** A document attached to an event is read with `drive-get` or
  `docs-get`; you never edit, move, rename, trash or delete a file someone shared with you, and you
  change in place only files your own account created.

## Times and time zones

Every command takes the same forms: a date `2026-10-20` (an all-day event, or the start of that day),
a date and time `2026-10-20T15:00` (in the time zone), or a time with its offset
`2026-10-20T15:00:00-05:00` (the zone does not matter then). The time zone is `--tz <name>` (an IANA
name: `America/Chicago`, `Europe/Paris`, `UTC`), else your own calendar's, which every command prints.

When a person says "3pm" or "tomorrow", work out the date and time in *their* time zone: from what
they said, from your memory of them, or ask. Pass it with `--tz` and say which zone you used. Daylight
saving is handled for you; never convert by hand.

## Commands

Every command prints plain lines, or JSON with `--json`. Exit code 0 is success, 1 a refusal from
Google or a rule (the message says why and what to do), 2 a mistake in the command (fix the arguments;
do not repeat it unchanged).

- `cal-list [--from <date or time>] [--to <date or time> | --days <n>] [--calendar <calendar id or email>] [--search <words>] [--limit <n>] [--tz <time zone>] [--json]`
  lists the events in a window, in start order, recurring ones one by one: when, title, id, then the
  organizer, how the attendees answered, your own answer when you are invited, the Meet link and the
  place. The window runs from `--from` (default now) to `--to` (a date there means the start of that
  day, so `--to` is not included) or for `--days` (default 7). `--calendar` reads another calendar you
  can see (a person's address, or a calendar id); without it, your own. `--search` finds words in the
  events. At most 50 events by default (`--limit` up to 250); it says when more fall in the window.
- `cal-get <event id> [--calendar <calendar id or email>] [--tz <time zone>] [--json]`
  prints one event whole: every attendee and their answer, the Meet link, whether it repeats, and its
  description. The id comes from `cal-list`.
- `cal-freebusy <email|me> [<email> ...] [--from <date or time>] [--to <date or time> | --days <n>] [--tz <time zone>] [--slots <minutes> [--hours <HH:MM-HH:MM>] [--weekends]] [--json]`
  prints each person's busy blocks in the window (`me` is you), and with `--slots <minutes>` the free
  time everyone shares: gaps of at least that long within working hours (`--hours`, default
  09:00-17:00 in the time zone) on weekdays (`--weekends` adds Saturday and Sunday). Up to 50 people.
- `cal-create --title <title> --start <date or time> [--end <date or time> | --minutes <n>] [--tz <time zone>] [--description <text>] [--location <text>] [--invite <email>[,<email>...]] [--meet] [--json]`
  adds an event to your calendar and prints its id and link. A start time runs for `--minutes`
  (default 30) or to `--end`. A start date makes an all-day event; `--end <date>` is its last day,
  included. `--invite` (repeatable, or comma-separated) invites people and Google emails them.
  `--meet` adds a Google Meet link. It also lists any of your events that overlap; it creates the
  event anyway, so check that list and tell the person.
- `cal-update <event id> [--title <title>] [--start <date or time>] [--end <date or time> | --minutes <n>] [--tz <time zone>] [--description <text>] [--location <text>] [--invite <email>[,...]] [--uninvite <email>[,...]] [--notify] [--json]`
  changes an event you organize. A new `--start` keeps the event's length unless you give `--end` or
  `--minutes`. `--invite` adds people and `--uninvite` removes them; Google emails those people, and
  everyone on the event about the change. Without them, nobody is told unless you add `--notify`
  (use it when people are already invited and the time or place changed).

## Procedures

### Someone's agenda for a day

1. `cal-list --from 2026-10-20 --days 1 --tz <their zone>` for your calendar, or add
   `--calendar <their address>` for theirs (only if they shared it with you).
2. Report each event's time, title and who it is with. Say which time zone the times are in.

### Find a time for several people

1. `cal-freebusy me pat@example.com lee@example.com --from <first day> --days 5 --slots 30 --tz <zone>`.
2. Offer two or three of the free times. Name anyone whose calendar was "unknown": their availability
   is not known.
3. Schedule only once the person picks a time.

### Schedule a meeting

1. Settle the title, start, length or end, and time zone. Use a specific title ("Budget review: Q3
   numbers", not "Meeting").
2. `cal-create --title "<title>" --start <start> --minutes <n> --tz <zone>`, adding
   `--invite <emails>` only for the people the request named, `--meet` when it is a video call, and
   `--description` for the agenda.
3. Read the output: if it lists overlaps, tell the person. Confirm with the event's time, link and who
   was invited.

### Move or change a meeting you organize

1. Find it: `cal-list --from <day> --days 1 --search "<words>"` and take its id.
2. `cal-update <id> --start <new start> --tz <zone>`, with `--notify` when people are invited and
   should hear of the change.
3. Confirm with the new time it prints.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `is organized by ... only its organizer may change it` | Someone else's event | Tell the person what should change; do not make a copy of their event |
| `cannot see calendar ...` | Their calendar is not shared with you | Use `cal-freebusy <their address>` for busy times, or ask them to share their calendar with you |
| `unknown: ... cannot see this calendar's free/busy` | Their organization or settings hide it | Say their availability is unknown; ask the person |
| `is not a date or time` | A time in another form | Write `2026-10-20`, `2026-10-20T15:00`, or with an offset |
| `--tz ... is not a time zone` | Not an IANA name | Use a name like `America/New_York`, `Europe/London`, `Asia/Tokyo`, `UTC` |
| `the domain-wide delegation grant does not include ...` | The Workspace setup lacks the Calendar scope | Report it to the person: a Workspace admin adds the scope named in the message. Do not retry |
| `has no Workspace account` | This instance has no Workspace account | Tell the person you cannot reach their calendar from here |
| `is limiting requests` | A rate limit | Wait a minute, then retry once |
