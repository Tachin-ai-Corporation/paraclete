# Writing a responsibility

A responsibility is work the agent owns on a schedule or after an event, such as the nightly memory
consolidation ([the glossary](../GLOSSARY.md)). This guide is for developers who ship a
responsibility with a role package, and for anyone reviewing the ones the agent schedules for itself.
The fields are defined by the schema in
[agent/work/responsibility-schema.mjs](../../agent/work/responsibility-schema.mjs); a role's file holds
`{ "version": 1, "responsibilities": [...] }`; the agent's own authoring, with the
`responsibility-manage` command, is in [skills/work-management/SKILL.md](../../skills/work-management/SKILL.md).
This guide says what a firing does, how to write each field, the cron forms the scheduler reads and
where they differ from common cron, how timezones behave, and what the scheduler guarantees and what
it does not.

## Two layers

| Layer | Lives in | Written by | Changes with |
|---|---|---|---|
| Installed defaults | `roles/generic/responsibilities.json` and the role's `responsibilities.json` | This repo | A release |
| The agent's own | The root `responsibilities` collection in Firestore, one document per id, each change kept as a numbered revision | `responsibility-manage`, and the dashboard's on and off switch (`agent/services/control/responsibilities.mjs`) | Live within `responsibility_store.refresh_ms` (60 seconds), no release |

`agent/work/responsibility-store.mjs` merges the two, and the scheduler, the control service and the
command all go through it, so they agree on what runs. What follows from the merge:

- **Generic first, first id wins.** A role responsibility with one of generic's ids would be dropped
  without a word; `tests/content/packages.test.mjs` refuses one.
- **An override changes only the fields it names.** The rest keeps coming from the installed default,
  so a later release's fix to the instruction still reaches an agent that only moved the schedule. An
  adopted responsibility becomes wholly the agent's and stops receiving fixes.
- **A bad store record never removes a default.** An override that fails validation is skipped with a
  warning, and the installed default runs.
- **`locked` is generic's upkeep.** No store record changes a locked responsibility, and
  `responsibility-manage` refuses to write `locked` at all. A role's defaults stay unlocked, so a
  person or the agent can retime or pause them.
- **A role move leaves overrides behind.** An override of the previous role's default is ignored once
  that default is gone ([install/README.md](../../install/README.md)).

## What a firing does

Each firing writes two work envelopes: a request envelope (intent `responsibility`), complete at
once, and a mission under it. The brain queues the mission and runs it like any other, one mission at
a time (`agent/services/brain/responsibilities.mjs`). How missions are planned, verified and approved
is in the [culture of work](../concepts/CULTURE_OF_WORK.md).

The mission is built from the fields (`fireResponsibility` in `agent/work/scheduler.mjs`):

| The mission's | Comes from |
|---|---|
| Instruction | `instruction` |
| Acceptance criteria, which the verifier judges against | `success_criteria` |
| Context, in this order | `PURPOSE` (`context.purpose`), `PROCESS` (`context.process`, numbered), `PLAYBOOK` (the narrative of the `processRef` playbook), `REFERENCE FILES` (`context.reference_files`), `SUCCESS CRITERIA`, `PRIOR LEARNINGS` (`context.prior_learnings`, then the learnings earlier runs left), and `EFFECT SCOPE` for a memory-scoped one |
| Project | `project_id`, or the agent's default project |

After a firing's mission completes, the brain keeps up to two of the durable learnings its compaction
digest recorded, dated, in `responsibility_state/<id>`, newest
`compaction.learnings_max_entries` (5) kept; the next firing reads them as prior learnings
(`agent/services/brain/completion.mjs`). Never the installed file: a release would overwrite it.

A scheduled mission has no address, so its answer reaches the dashboard as a notice: a message in no
one's thread, which every dashboard user sees (`parseAddress` in `agent/providers/channel.mjs`; the
[open items](../plan/OPEN_ITEMS.md), phase 8, track giving it an addressee).

`processParameters` is accepted, validated and stored, but the scheduler does not put it into the
mission. Write what the work needs into `instruction` or `context`.

## Writing the fields

| Field | Write it so | Why |
|---|---|---|
| `id` | `r-<name>`, never one of generic's | The store, the triggers and the history find it by id |
| `name` | A short name people recognize | It titles the request envelope, and the mission as `Execute: <name>`; a review that compares with last week's run finds that run by its title |
| `instruction` | The whole goal, as a person would ask it | A firing has no one to ask: a mission that stops for input waits, and is archived when nobody answers within `archival.needs_input_timeout_hours` (72) |
| `success_criteria` | What the result must contain, checkably; for read-only work, that nothing was changed | It is the mission's acceptance criteria |
| `context.purpose` | Why the work exists and what it prevents | It opens the mission's context, so the agent reads why before how |
| `context.process` | The steps a firing follows, one string each, `STEP n - ...` in the shipped files | Unlike a playbook, these are steps: the mission gets them numbered. Exact commands are fine here, and `tests/content/command-flags.test.mjs` checks a skill command's flags in them |
| `context.prior_learnings` | Lessons every run needs, such as what an empty result proves | It joins the learnings runs leave behind |
| `processRef` | The playbook whose pattern the work follows, when there is one | The narrative joins the context. It must name a playbook in generic or the role (the tests check); one missing at run time is skipped with a warning |
| `effect_scope` | `memory` only for memory upkeep | The brain plans the mission as one pass by temporal-memory, and the checkpoint executor moves any task planned for another organ but temporal-research to temporal-memory and refuses approval gates (`agent/work/memory-scope.mjs`) |
| `singleton` | `true` for anything that takes minutes | Two cycles at once must never run: a second consolidation over the same memory would corrupt it |
| `min_spacing_minutes` | A floor between firings, below the schedule's own interval | It stops a double firing, such as the one a daylight-saving change causes (below) |
| `triggerable` | `true` when a person may ask for a run in chat | Only these are offered to the cortex as cycles a person can start |
| `enabled` | Always written out, `true` or `false` | The scheduler arms only a responsibility whose `enabled` is `true`. The schema's default is not applied to installed files: one without the field never fires |
| `timezone` | An IANA zone; `UTC` for a role default | The shipped defaults use UTC, because no one's timezone is known at install; the agent moves one into a person's zone with an override when asked |
| `project_id` | None in a role default | The repo is template-clean; the agent puts identifiers in a project for its own responsibilities |
| `locked` | Only on generic's upkeep | See above |

Ship a default turned on only when it is safe and useful from the first week without anyone's input,
as the read-only weekly reviews of the DevOps Engineer and the Security Engineer are. One that needs
a person's answers first ships turned off: the executive assistant's daily briefing does
([roles/executive-assistant/README.md](../../roles/executive-assistant/README.md)).

## Cron: the forms the scheduler reads

`schedule` is five fields, minute hour day-of-month month day-of-week, read in `timezone`. Each field
takes `*`, `*/N`, a number, a range `a-b`, or a list `a,b`. Day of week runs 0 to 6, Sunday 0.
`checkCron` in `agent/work/responsibility-store.mjs` refuses every other form: a name such as `MON`, a
stepped range such as `1-5/2`, `7` for Sunday. Each would parse and never match, and the responsibility
would never fire. `tests/content/packages.test.mjs` runs `checkCron` on every installed schedule, and
`responsibility-manage` on every one the agent writes.

Two behaviours differ from common cron (`fieldMatches` and `cronMatch` in `agent/work/scheduler.mjs`):

| Behaviour | Here | Example |
|---|---|---|
| `*/N` | Matches values divisible by N, not every Nth value from the first | `0 0 */2 * *` fires on the 2nd, 4th, 6th...; `0 0 1 */3 *` in March, June, September and December; `*/7 * * * *` at :56 and then :00 |
| Day of month and day of week both set | Both must match | `0 9 1 * 1` fires only on a Monday that is the 1st, not on the 1st and on every Monday |

| Expression | Fires |
|---|---|
| `0 8 * * *` | Every day at 08:00 |
| `0 7 * * 1-5` | Weekdays at 07:00 |
| `0 6 * * 1` | Mondays at 06:00 |
| `0 */6 * * *` | At 00:00, 06:00, 12:00 and 18:00 |
| `0 0 1 * *` | The 1st of every month at midnight |

A schedule the agent writes may not fire more often than every
`responsibility_store.min_interval_minutes` (15 minutes; `checkFrequency` in
`agent/work/responsibility-store.mjs`). Installed schedules are exempt, as reviewed product content.

## Timezones

The scheduler matches the schedule against the wall clock in `timezone` (`wallClock` in
`agent/work/scheduler.mjs`), so a daylight-saving change moves the UTC instant and keeps the local
time. Two days a year that has consequences:

- **A local time that does not exist is skipped.** In `America/Chicago`, `30 2 * * *` does not fire on
  the day the clocks go forward.
- **A local time that happens twice fires twice,** unless `min_spacing_minutes` is more than the hour
  between them. In `America/Chicago`, `30 1 * * *` fires at 06:30 and 07:30 UTC on the day the clocks
  go back.

For daily work, avoid the hour in which the zone's clocks change, or set the spacing. An unknown zone
is refused by the tests and by `responsibility-manage`; one that reaches the scheduler anyway runs in
UTC, with a warning in the brain's log.

## What the scheduler guarantees

| It guarantees | How | Code |
|---|---|---|
| A slot fires within about a minute of its time | It checks every minute | `TICK_INTERVAL_MS` in `agent/work/scheduler.mjs` |
| Two cycles of a singleton never run at once | Before firing, it looks in Firestore for a mission of the responsibility that is active, queued, pending or waiting; if one is found, the slot is skipped, not delayed. A mission stopped for an answer or an approval does not count | `inProgressCycle` in `agent/work/scheduler.mjs` |
| Firings are at least `min_spacing_minutes` apart | A slot that comes sooner is skipped. Unset or 0 counts as 15 minutes on the clock | `DEFAULT_MIN_SPACING_MINUTES` in `agent/work/scheduler.mjs` |
| A change in the store is live within a minute | The store is re-read every `refresh_ms` | `refreshStore` in `agent/work/scheduler.mjs` |
| A monthly schedule still fires | Slots are looked for eight days ahead; a schedule with none in range is looked at again every hour | `NEXT_FIRE_HORIZON_MS`, `REARM_INTERVAL_MS` in `agent/work/scheduler.mjs` |
| Event responsibilities never chain | A mission an event responsibility made fires no event responsibility, and none fires from its own mission | `fireEvent` in `agent/work/scheduler.mjs` |

What it does not guarantee:

- **No catch-up.** A slot that passes while the brain is down is not fired later: at start the
  scheduler arms each responsibility from the next minute on.
- **The firing time, not the running time.** A firing creates the mission; the brain runs it when the
  mission ahead of it is done.
- **Spacing across restarts.** The time of the last firing is kept in the brain's memory, so a restart
  forgets it. The singleton check reads Firestore and holds across restarts.
- **The singleton check when Firestore cannot answer.** A failed check lets the firing go ahead,
  rather than silently stopping scheduled work.
- **A person to deliver to.** The answer is a notice (above).

## Event responsibilities

Set `event` instead of `schedule`. A responsibility takes exactly one of the two: the schema refuses
a record with both, or with neither, which could never fire. The completion step fires two events
(`completionEvent` in `agent/services/brain/completion.mjs`):

| `event` | Fires when a mission |
|---|---|
| `on_complete` | Completes |
| `on_failure` | Fails or is blocked |

`on_deploy` is named in the scheduler's comments and in the work-management skill, but nothing fires
it. An event firing is spaced by `min_spacing_minutes` or the store's 15-minute floor, whichever is
longer; it does not check `singleton`. Its instruction gets the event and the mission that caused it
appended.

## Running one now

| Who | How | Which ones |
|---|---|---|
| A dashboard admin | The Library page's Responsibilities tab: Run now (`run_responsibility` in `agent/services/control/responsibilities.mjs`) | Any enabled one; the brain refuses a disabled one. It skips the spacing, never the singleton check |
| A person, in chat | Asks the agent; the cortex starts it (`agent/services/brain/actions/trigger-responsibility.mjs`) | Only `triggerable` and enabled ones |
| A developer, on a dev instance | `node dev/trigger.mjs <responsibility-id>`, which writes the same trigger the dashboard does and waits for the outcome | Any enabled one |

A run now counts as a firing for the spacing, so a weekly responsibility with a long
`min_spacing_minutes`, run by hand shortly before its slot, skips that slot.

## Testing

1. **The tests.** `tests/content/packages.test.mjs` validates every installed responsibility against
   the schema, runs `checkCron` on its schedule, checks its timezone is known, its `processRef` names a
   playbook in generic or the role, and its id is unique and not one of generic's.
   `tests/content/command-flags.test.mjs` and `tests/content/content-hygiene.test.mjs` read the file
   too. The scheduler's own behaviour is tested in `tests/agent/work/scheduler.test.mjs`.
2. **On a dev instance.** After `node dev/deploy.mjs <branch>`, `node dev/logs.mjs brain` shows a line
   per responsibility with its next firing, its schedule and zone, and where its definition comes from.
   The dashboard's Library page lists the same, with the next firing.
3. **Run it.** `node dev/trigger.mjs <responsibility-id>`, then follow the mission:
   `node dev/query.mjs work --where source_meta.responsibility_id=<responsibility-id> --where type=M`.
   Judge the result against `success_criteria`, as the verifier did.

## Checklist

- [ ] It is upkeep every instance needs (generic) or a role's recurring duty, with nothing of one
      organization in it
- [ ] `id` is `r-<name>` and not one of generic's
- [ ] `instruction` and `success_criteria` stand alone, and the criteria are checkable
- [ ] `context.purpose` says why; `context.process` gives the steps
- [ ] `enabled` is written out; on only if it is safe and useful without anyone's input
- [ ] The schedule uses the supported forms, and reads right under the two differences above
- [ ] `timezone` is set; daily work avoids the daylight-saving hours or has the spacing to cover them
- [ ] `singleton` is `true` and `min_spacing_minutes` set for anything that takes minutes
- [ ] `triggerable` is `true` if a person may ask for a run
- [ ] `processRef`, if set, names a playbook in generic or the role
