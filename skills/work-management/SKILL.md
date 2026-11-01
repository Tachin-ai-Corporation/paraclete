# Skill: Work Management

## When to use

When you create, change or list responsibilities (your recurring duties) or projects (bodies of work
with their own artifact repository and context), and when you read past work: missions, their step
ledgers, their full outputs and task records.

## Commands

### Read

- `work-log-read [--hours <n>] [--recent <n>] [--status <status>] [--type <type>] [--min-steps <n>] [--mission <id>] [--limit <n>] [--json] [--verbose]`
  lists recent work envelopes (missions, checkpoints, tasks) with their outcomes and timing.
  - `--recent <n>` is "my last n missions": missions only, 30 days back.
  - `--status failed` (or `blocked`) narrows to what went wrong. `--type` is `R` (request), `M`
    (mission), `C` (checkpoint) or `T` (task).
  - `--mission <id>` prints one mission's tree of checkpoints and tasks **plus its step ledger**: each
    task attempt with its status, error and timing, the richest record of why a mission failed. It
    reads only that mission. Do not widen `--hours` to hunt for one mission's children.
  - `--verbose` adds instruction and result text; `--json` prints a JSON array.
- `work-output-read <envelope-id> [--json]` prints the full output of one envelope: a header (status,
  type, title, times) and then the complete output. Use it when a result reached you truncated.
  `--json` prints the raw document.
- `task-log-read [--last <n>] [--task <taskId>]` prints the most recent task envelopes (default 5) as a
  JSON array, each with `taskId`, `type`, `parentId`, `status`, `intent`, `text`, `startedAt`,
  `completedAt`, `durationMs`, `outputChars` and `error`. `--task <id>` prints that one envelope with
  its history.

### Write

- `responsibility-manage [--note "<why>"] [--json] <verb> ...` manages your responsibilities (below).
- `project-manage <subcommand> ...` manages projects (below).

## Responsibilities

You run three kinds of responsibility:

- **Installed upkeep**, marked `locked`: nightly memory consolidation and weekly git artifact cleanup.
  You cannot change these; they change only with a release.
- **Your role's defaults:** you can override fields, pause them, drop your changes (`reset`), or take
  one over completely (`adopt`; it then stops receiving product updates).
- **Your own:** ones you created. You can do anything with these.

Your changes go to your responsibility store in Firestore. The scheduler re-reads it every minute and
lays it over the installed defaults, so a change is live within a minute, needs no release, survives
upgrades, and is a revision you can undo. Nothing edits an installed file.

```
responsibility-manage list                      # everything you run, and where each definition comes from
responsibility-manage show <id>                 # one responsibility as it runs, plus its store record
responsibility-manage create --stdin            # JSON on stdin (shell-safe); or '<json>', or --file <path>
responsibility-manage update <id> '<json>'      # only the fields that change; context merges key by key (also --stdin or --file)
responsibility-manage toggle <id> [on|off]      # without on or off, flips it
responsibility-manage remove <id>               # one you created (for a default: toggle it off, or reset)
responsibility-manage reset <id>                # back to the installed default
responsibility-manage adopt <id> ['<json>']     # make an installed default fully yours
responsibility-manage history <id>              # every revision: who, when, what
responsibility-manage revert <id> --to <n>      # restore revision n, as a new revision
```

`--note "<why>"` records the reason on the revision; `--json` prints machine-readable output. On
`create` and `update`, `--process-ref <playbook-id>` links a process playbook (`""` clears it) and
`--process-params '<json>'` stores parameters beside it; a firing does not pass them to its mission, so
put anything the mission needs in the instruction or the project.

A new responsibility needs `id`, `name`, either `schedule` (a five-field cron expression) or `event`
(`on_complete` or `on_failure`), `instruction`, `success_criteria`, `context.purpose` and
`context.process` (an array of steps, each one a string). `timezone` is an IANA zone (default `UTC`); it defaults to
`enabled: true` and `min_spacing_minutes: 30`. Put any identifiers it depends on (folders, documents)
in a project and set `project_id`; never bury them in the text.

Refused, with the reason printed:

- a cron form the scheduler cannot read: use `*`, `*/N`, numbers, `a-b` and `a,b`. Names such as `MON`,
  and `7` for Sunday, are refused;
- an unknown timezone;
- a schedule that fires more often than every 15 minutes;
- any change to a `locked` responsibility;
- owning more than 25 responsibilities;
- creating an id an installed default already uses: `update` or `adopt` it instead.

If someone else edits the same responsibility at the same moment, one of you is told it changed at the
same moment; run the command again.

### Take on a recurring duty

Use this when someone asks for something on a schedule ("every Monday, send the summary") or on an
event ("when a mission fails, write a review").

1. Write the definition as JSON: `id` (`r-<name>`, lowercase with dashes), `name`, `schedule` with
   `timezone`, or `event`, `instruction`, `success_criteria`, `context.purpose`, and `context.process`.
   Write the process steps so that a future you, with no memory of this conversation, can follow them.
2. Create it, passing the JSON on the runCommand tool's stdin:
   `responsibility-manage create --note "<who asked, and why>" --stdin`.
3. Verify: `responsibility-manage list` shows it with its schedule, as your own at revision 1.

### Change one

1. `responsibility-manage list` shows every responsibility and where its definition comes from: an
   installed default, a default you overrode, or your own.
2. Change only the fields that should change:
   `responsibility-manage update r-<id> '{"schedule":"20 10 * * 4","timezone":"America/Chicago"}'`. On
   an installed default this stores an override of just those fields, so later product fixes to the
   rest still reach you.
3. Pause or resume: `responsibility-manage toggle r-<id> off` (or `on`).
4. Verify: `responsibility-manage show r-<id>` shows the new values and revision.
5. Undo: `responsibility-manage history r-<id>`, then `responsibility-manage revert r-<id> --to <n>`.
   To drop every change you made to an installed default, `reset` it.

## Projects

Projects live in Firestore. They support a parent and children (at most 4 levels), dependencies on
other projects, linked process playbooks, and a context of durable resources.

```
project-manage list                                       # every project: id, name, status, goal, parent, dependencies, processes
project-manage get <id>                                   # one project as JSON
project-manage create '<json>' [--processes <ids>]        # a new project
project-manage update <id> '<json>' [--processes <ids>]   # partial update; context merges deeply
project-manage complete <id>                              # status: complete
project-manage pause <id>                                 # status: paused
project-manage archive <id>                               # status: archived
project-manage add-context <id> <key> '<json-packet>'     # add or replace one context entry (or --stdin for the value)
project-manage add-process <id> <process-id>              # link a process playbook to the project
```

- `create` needs `id` (lowercase letters, digits and dashes), `name`, `description`, `goal` and
  `context` (an object); `parent_id` and `depends_on` (an array of project ids) are optional. A new
  project starts `active`. `create` refuses an id that already exists: use `update` to change it.
- A `'<json>'` argument may also be the path of a file holding the JSON.
- `update` merges `context` deeply and every other field shallowly. Changing `parent_id` checks the
  parent exists and the depth stays within 4. Statuses: `active`, `complete`, `paused`, `archived`.
- `--processes <comma-separated-ids>` sets the project's process list; `--processes ""` clears it.

### Project context

A project's context is the high-level view of its working area: durable resource references and
lasting conventions. Each entry is a resource packet:

```json
{ "kind": "drive_folder", "ref": "<id>", "url": "https://...", "name": "Display name", "summary": "What it is for" }
```

`kind` is one of `drive_folder`, `doc`, `sheet`, `slides`, `url`, `repo`, `git`, `resource` or
`convention`, and a packet needs at least a `ref`, a `url` or a `summary`. Keys are short semantic slugs.

Record a discovery as soon as a future mission on the same project would need it:

| Discovery | Example |
|---|---|
| A resource id | `project-manage add-context <id> assets_folder '{"kind":"drive_folder","ref":"<folder-id>","summary":"shared images for the site"}'` |
| A verified command or endpoint | `project-manage add-context <id> deploy_command '{"kind":"convention","summary":"Deploy with: npm run build, then the hosting deploy of dist/"}'` |
| A permission requirement | `project-manage add-context <id> upload_access '{"kind":"convention","summary":"Uploading to the shared folder needs editor access"}'` |
| A known pitfall | `project-manage add-context <id> build_first '{"kind":"convention","summary":"Never deploy raw source; build first"}'` |

Context holds only durable references and lasting conventions. It is not for a mission's particulars
(one document's id, this run's result: those belong in the mission record), history or failures,
transient state ("the repository is at commit X"), or step sequences (those belong in a process).
Keys that name state, history, logs, attempts, tasks, steps or processes are refused, as is a bare
value that is not a packet. To point a project at the processes it follows, use `add-process` or
`--processes`, not context.

When text contains apostrophes, quotes or newlines, pass the value with `--stdin` through the
runCommand tool's stdin instead of quoting it on the command line.

### Create a project

1. Write the JSON: `id` (lowercase with dashes), `name`, `description`, `goal`, `context`.
2. `project-manage create '<json>'`.
3. Verify: `project-manage get <id>` shows it, `active`.

### Project files

A project's artifacts live in its git artifact repository. When a mission runs for a project, the
brain clones that repository into the mission's working tree and commits at checkpoint boundaries;
see the git-artifacts skill.

## Analyze past work, or diagnose a failed mission

Use this when a task asks you to review, learn from or report on past work, especially failures.
Recall gives outcome-level context; these commands give per-task depth.

1. List recent missions: `work-log-read --recent 10`. Note the failed or blocked ones and copy the id.
2. Drill into one: `work-log-read --mission <id>` prints its tree and its step ledger. The step-ledger
   errors are the concrete reason (a tool error, a verification failure, missing input).
3. If an envelope's output is truncated, read it whole: `work-output-read <envelope-id>`.
4. Classify each failure by its cause, and report it with the mission id and the exact error as
   evidence. Cite what you observed, not what you infer.

## Inspect completed work

1. `work-log-read --hours 48 --status complete` lists completed missions and their outcomes.
2. Verify that the list shows the missions with their completion status.
