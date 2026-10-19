# Skill: Memory Consolidation

## When to use

When the nightly memory consolidation responsibility fires. Never start it for other work. It is
memory's own housekeeping: prune working memory, reconcile Core Memory, and review the Deep Truths.

## The memory boundary

Memory is exactly three layers, and they are the only things this cycle writes:

| Layer | Where | Loaded | Lifespan | Your job |
|---|---|---|---|---|
| Working memory | `/var/lib/paraclete/memory/MEMORY.md` | Into every cortex prompt | Hours to days | Prune what is done or stale; keep it under 2,000 characters |
| Core Memory | Firestore, read and written by the commands below | On demand, through recall | Weeks to months | Retire stale entries, promote stable new facts |
| Core Memory `resources` | The same store, one category | Into every mission's known resources | Until the target moves | Promote captured identifiers, record aliases, supersede on change |
| Deep Truths | `/var/lib/paraclete/memory/DEEP_TRUTHS.md`, changed only through `update-deep-truths` | Into every cortex prompt | Months or longer | Change only on strong evidence across many sessions |

Processes, projects, skills and responsibilities are definitions. Read them to reconcile against;
never write them. A lesson about one is recorded as memory, tagged with its id. The tools enforce
this: the consolidation toolset has no shell and no general file writer.

## Commands

Run each command through the **`memoryCommand`** tool, passing the command line exactly as shown. It
runs without a shell, so pipes, `;`, `&&`, redirects and `$(...)` are refused. Put long free text in
its `stdin` field for a command that reads stdin.

- `core-memory-read [--query "<terms>"] [--category <category>] [--status active] [--since <Nd>] [--limit <n>]`
  reads Core Memory, value- and relevance-ranked. The default limit is small: pass `--limit 50` when
  surveying.
- `core-memory-write --fact "<fact>" --category <category> [--tags "t1,t2"] [--importance <0..1>] [--supersedes <old-id>]`
  promotes a durable fact, or replaces an entry when `--supersedes` names it (the old entry is marked
  superseded). `--importance` (default 0.5) and `--confidence` (default 0.9) take values from 0 to 1.
- `core-memory-retire --id <id> --reason "<why>"` retires a stale, contradicted or duplicated entry.
- `update-deep-truths --list | --add "<truth>" | --remove "<truth>"` lists or changes the Deep Truths in
  `DEEP_TRUTHS.md`. A truth is one line; `--remove` matches the whole line, exactly as `--list` prints
  it. At most 10 are kept.
- `session-summary --hours 24 [--limit <n>] [--exclude-intent memory_consolidation]` summarizes recent
  completed missions, with their compaction digests.
- Read-only views of the definitions you reconcile against: `process-ops list`, `process-ops get <id>`,
  `project-manage list`, `project-manage get <id>`, `project-manage canon-list <id>`. Their write
  subcommands are refused.

Categories in use: `architecture`, `operations`, `iam`, `decisions`, `patterns`, `errors`,
`resources`.

Files: read with `readFile` (absolute paths, as in the table). Write `MEMORY.md` and
`consolidation_report.md` with **`writeMemoryFile`**; they are the only files memory writes.

**One pass.** The consolidation is a single task: you run every step below yourself, in one session,
and keep your triage in your own working context. There is no later task to hand a plan to and no file
to pass it through; a plan file is refused.

## Procedure

You process the day's experience across all three layers, running the tools yourself, and you weight
what you keep by value so that recall later surfaces the best of it first.

1. **Read working memory.** `readFile /var/lib/paraclete/memory/MEMORY.md` to see the recent focus and
   open items.
2. **Read recent sessions.** `session-summary --hours 24 --limit 20`. A long mission includes a
   `Digest:` section: its `learning:` lines are claims already binned while the mission ran, and are
   first-class candidates for promotion.
3. **Read recent work.** When your instruction carries the last week's missions, use them: completed
   missions carry verified outcomes worth promoting, and failed ones carry lessons.
4. **Read recent Core Memory.** `core-memory-read --since 30d --limit 20`.
5. **Read the whole archive.** `core-memory-read --category <category> --limit 50` for each category,
   then `core-memory-read --limit 100` with no category, to catch entries filed under any other name.
   An empty read is almost always a filter that matched nothing; never conclude memory is empty until
   an unfiltered read says so.
6. **Promote and reconcile resources** (the name-to-id table). Missions record outside identifiers
   (Drive folders, documents, Chat spaces) as they resolve them. Promote the durable ones so the next
   mission never searches for them again:
   - `core-memory-write --fact '<kind>: "<name>" = <id>' --category resources --tags "<kind>,<project>" --importance 0.8`
   - One entry per identifier, in exactly that form, so recall can parse it back. This is a lookup
     table, not narrative: no prose, no commentary.
   - **Record aliases as their own entries.** When a mission searched for one name and the real object
     has another, write both names pointing at the same id. The alias is the expensive knowledge: a
     plan that uses a name the object does not have will search for it again and again.
   - **Reconcile, don't accumulate.** When an id changed, `--supersedes` the old entry. When a target no
     longer resolves, retire it in step 10: a confidently wrong id is worse than none, because it will
     be trusted.
   - Resource entries do not count against the promotion limit in step 11: they are cheap, high-value,
     and limited by the number of real objects.
7. **Read the definitions, read-only.** `process-ops list` and `project-manage list`, then `get` for
   anything relevant. A Core Memory entry that only restates what a project or playbook already
   declares (a resource id the project carries, a playbook's own advice) is redundant: retire the
   memory copy in step 10, never the definition. Never copy a definition into memory either: recall
   already reads it from the definition, and a copy goes stale.
8. **Triage working memory.** Sort every entry of `MEMORY.md` into `ACTIVE`, `COMPLETED`, `STALE` or
   `PROMOTE`. A `lesson (project <id>)` or `lesson (playbook <id>)` line is the brain's record of what a
   mission taught about that project or playbook: promote it as a lesson tagged with that id, or let it
   go.
9. **Find what is out of date.** Compare recent work against the archive to find entries that are
   contradicted, redundant, duplicated or stale.
10. **Retire or supersede**, at most 5 per run: `core-memory-retire --id <id> --reason "<reason>"`, or
    `core-memory-write --fact "<fact>" --category <category> --supersedes <old-id>` for an update.
    Retire only on evidence that a fact is wrong, stale or duplicated, never to rename it: a fact whose
    value is still right keeps its name, because other work (a responsibility, a resource lookup)
    recalls it by that name. For duplicates, keep the oldest entry and retire the copies.
11. **Promote stable facts**, at most 5 per run:
    `core-memory-write --fact "<fact>" --category <category> --tags "<topic>" --importance <0..1>`.
    - Never write a fact that is already active (steps 4 and 5 show what exists): skip it, or supersede
      the existing entry to change it. A second copy is not reinforcement; it is noise the next pass
      has to clean up.
    - Never promote what a project or playbook already declares (step 7): that is a copy, not a lesson.
    - **Weight by value.** Set `--importance` high, toward 1.0, for a lesson that recurred across
      sessions, led to a success, or is load-bearing; leave routine facts at the default. Always set
      `--tags` with the topic, so recall can find high-value lessons by subject.
    - **Contrast clean passes against replans.** Before promoting a lesson about a project or playbook,
      compare missions where checkpoints passed on the first attempt against missions that needed a
      re-plan or failed: promote practices that clearly `helped` (associated with first-attempt pass) or
      forward warnings for patterns that `hurt` (triggered verifier rejection or repeated re-tasking).
      Leave `confounded` patterns (mixed outcomes across sessions) in working memory until further
      sessions disambiguate them.
    - **Never promote a failure as a verdict.** A failed mission promotes only as a forward lesson,
      "when <situation>, <do this>", never as "<task> is impossible". Feasibility is decided when the
      work runs, against the tools of that day; a stored "it can't be done" outlives the conditions
      that produced it. If such a belief exists and the tools have changed since, retire it in step 10.
12. **Rewrite working memory.** Write `MEMORY.md` with `writeMemoryFile`, keeping only active items,
    under 2,000 characters, in this form:

    ```markdown
    # Working memory

    ## Current Focus
    - What the agent is actively working on

    ## Active Context
    - Operational state, environment notes, pending items

    ## Open Items
    - Unresolved blockers or follow-ups
    ```

    If nothing in it needs to change, leave it as it is and say so in the report. A pass that changes
    nothing is a valid outcome; rewriting a file with its own content is not a consolidation.
13. **Review the Deep Truths.** `update-deep-truths --list`, then `--add` or `--remove` if warranted, at
    most 2 changes per run (criteria below).
14. **Write the report.** `writeMemoryFile consolidation_report.md` with the counts: working-memory
    entries triaged, retirements, promotions, Deep Truth changes with their justification and the Core
    Memory ids cited, and the final `MEMORY.md` character count. Repeat it in your answer. The report is
    the mission's verifiable outcome: the cerebellum checks it.

## Deep Truths criteria

- **Add** only when: the evidence spans 3 or more separate sessions; the fact has been stable in Core
  Memory for 7 or more days; you can cite at least 2 Core Memory ids as evidence; it is one sentence;
  it applies generally; and it shapes behavior. Never add a bare incapacity claim ("X can't be done"):
  that is a stale condition dressed as a truth. If you are unsure, it does not qualify yet.
- **Remove** when newer evidence contradicts it, the environment or tools changed, or another truth
  already says it.

## Error recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `core-memory-write` or `core-memory-retire` fails | Firestore timeout or rate limit | Retry once. If it fails again, note it in the report and leave the change for the next run |
| `writeMemoryFile` refuses `MEMORY.md` as too long | Over the hard cap | Prune further; working memory goes into every cortex prompt |
| Adding an eleventh Deep Truth | The limit is 10 | `--list`, remove a weaker or redundant truth first, then add |
| `REFUSED (memory boundary)` | A definition write, a shell operator, or a file that is not memory | Don't look for another route: memory writes only its three layers. Record what you wanted as a Core Memory lesson tagged with the project or playbook. For a shell operator, run each command as its own `memoryCommand` call |
