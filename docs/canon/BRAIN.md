# Brain qualities

These are the qualities the agent's [brain](../GLOSSARY.md) has, and every change to it must keep.
The brain is the brain service's mission loop plus the [organs](../GLOSSARY.md) it consults through
the [gateway](../GLOSSARY.md). Read this before you change how the agent thinks, plans, verifies,
remembers or speaks: anything in `agent/services/brain/`, `agent/work/`, `agent/context/`,
`agent/gateway/`, `prompts/` or `skills/`. The product's walls are in [PRODUCT.md](PRODUCT.md); how
the canon is written and changed is in [README.md](README.md).

Each quality gives what it is, why it matters, and how the code gives it. Where only a prompt gives
it, or a part of it is missing, it says so.

## The machine

### B-1. A deterministic machine that consults models

Code owns the loop. The brain service reads what comes in, picks the mission to run, chooses which
organ to call, moves every status, retries, and ends every run. Organs are called for judgment and
language: to classify a message, analyze the work, choose a move, plan, execute a task, judge a
checkpoint, write the answer. Where a fixed rule can decide, code decides without a model: an
"approve" or "reject" in chat is recognized before any classification, a timed wait resumes on the
clock, and a mission's end is a transition in a table.

- **Why.** A model that holds the loop can skip a step, forget a check or loop forever. A loop in code
  takes the same path from the same state, and its history reads like a flowchart.
- **How the code gives it.** `agent/services/brain/main.mjs` runs the loops;
  `agent/services/brain/envelope-runner.mjs` runs one mission, decision by decision;
  `agent/services/brain/approval-replies.mjs` reads approvals without a model; statuses move only
  through `agent/work/work-transitions.mjs` ([PRODUCT.md](PRODUCT.md), P-26). The dashboard's
  [effort](../GLOSSARY.md) setting only scales the organs' sampling temperature; it never changes which
  checks run (`agent/work/effort.mjs`).

### B-2. Each organ has one job

| Organ | Its one job | Tools | Model tier |
|---|---|---|---|
| cortex | Decides the next step of a mission: classifies what comes in, chooses each move, writes the answer | None | cortex |
| prefrontal | Plans: analyzes the work into a [brief](../GLOSSARY.md), and structures checkpoints | None | strong |
| motor | Executes tasks with tools | Shell, files, directories, images | strong |
| cerebellum | Verifies each checkpoint and owns the verdict | Reads files, views images, reports a verdict | strong |
| temporal-memory | Maintains the agent's memory: builds the recall packet, consolidates | None when recalling; the memory commands and its own two files when consolidating | fast |
| temporal-research | Researches outside sources | The motor's | fast |

The organ decides its model, tools and step budget. A caller names the organ, and may ask only one
thing more: that the memory organ consolidate, with its memory tools. Only the motor,
temporal-research and temporal-memory run checkpoint tasks; the organs that plan and verify never do.

- **Why.** One job per organ keeps each prompt short and pointed, and keeps verification independent
  of the work it checks. A call with two jobs does both badly and checks neither.
- **How the code gives it.** `agent/gateway/organs.mjs` (each organ's job, toolset, tier and prompt),
  `agent/gateway/tools.mjs` (the toolsets), `agent/gateway/server.mjs` (the caller names only the
  organ), `VALID_TASK_ORGANS` in `agent/work/checkpoint-executor.mjs`. Each organ's prompt is
  `prompts/<organ>.md`, plus the role's addition. **Not structural:** temporal-research holds the
  motor's open toolset; that it only searches and reads is its prompt's rule
  (`prompts/temporal-research.md`).

### B-3. Models answer in structured JSON, and code checks it before acting

The cortex and the prefrontal answer in JSON held to a schema for each mode: classify, analyze,
decide, plan. A deterministic parse and check runs first; only when it fails does the
[utility model](../GLOSSARY.md) restructure the answer into the schema, told to keep its content as it
is. A decision that still cannot be read is asked for again, as JSON only, and each attempt counts
against the mission's decision budget. The cerebellum's verdict is the name of the tool it called,
`report_pass` or `report_fail`; its prose is never parsed for control flow.

- **Why.** Free text that drives execution is a guess about what the model meant. A schema makes the
  model's choice a value code can check, and an unreadable answer a known case.
- **How the code gives it.** `CORTEX_SCHEMAS` and `enforceSchema()` in
  `agent/providers/vertex-text.mjs`, `agent/providers/json-repair.mjs`, the decide loop in
  `agent/services/brain/envelope-runner.mjs`, and `extractVerdict()` in `agent/organs/cerebellum/verdict.mjs`.

### B-4. The cortex chooses among moves that code defines

The cortex picks one move per decision from a closed set: `checkpoint_plan`, `synthesize`,
`synthesize_with_failure`, `needs_input`, `blocked`, `status_update`, `wait` and
`trigger_responsibility`. Each move has one handler. A move outside the set is refused, and the cortex
is told the legal ones. Some moves are refused in some states: a plain `synthesize` over an
unresolved failure, or a new plan once every checkpoint has passed.

- **Why.** A model that can invent a move can invent a state. With a closed set, every path a mission
  can take is in the code.
- **How the code gives it.** `agent/services/brain/actions/index.mjs` (the moves and their handlers).
  `tests/agent/services/brain/actions/index.test.mjs` keeps the moves, the decide schema and the
  moves `prompts/cortex.md` teaches equal. The refusals are in
  `agent/services/brain/actions/synthesize.mjs` and `agent/services/brain/actions/checkpoint-plan.mjs`.

### B-5. Every model call goes through a named path

Organ turns go through the gateway, a service on the VM's loopback port; the acknowledgment of a new
request is one too, on the cortex. The services' small jobs (schema repair, mission titles, digests,
the rewrite of a delivery or an approval request, the mouth's voicing and status notes, the ears'
repair of a mangled Chat message) go to the utility model through `agent/providers/vertex-text.mjs`,
with no tools, sessions or fallback. Three other calls exist, each for one narrow purpose: the
`web-search` command's grounded search (`skills/web-search/web-search.mjs`), control's Claude test
(`agent/services/control/claude-check.mjs`) and the installer's model check (`install/install.sh`).

- **Why.** Knowing every place a model is called is how you know what the agent can say and do, and
  what it costs. A quick call beside the paths escapes the checks they apply.
- **How the code gives it.** `agent/gateway/server.mjs` and `agent/gateway/turn-loop.mjs` for organ
  turns; `agent/providers/vertex-text.mjs` for the rest. Only `agent/gateway/` imports the model SDKs
  (`tests/repo/boundaries.test.mjs`).

### B-6. A fallback continues the turn; it never repeats a tool

When an organ's model fails mid-turn, the turn continues on the fallback model from the same
[transcript](../GLOSSARY.md): the tool calls that already ran stay in it with their results, and none
runs again. A gateway that cannot answer at all is not a verdict on the mission: the runner tries the
mission again later.

- **Why.** Rerunning a turn reruns its tools, and a mutating command run twice (a deploy, a file
  written, a resource created) is a second effect nobody asked for.
- **How the code gives it.** `runTurnWithFallback()` in `agent/gateway/turn-loop.mjs`; the retry in
  `agent/services/brain/envelope-runner.mjs`.

### B-7. One mission at a time, its checkpoints in order

The brain runs one mission at a time and runs it to the end of its run before taking the next. A
mission is claimed durably, with a compare-and-swap, so two processes can never run it. Checkpoints
run in order, and the tasks within a checkpoint run in order; a failed task or a failed milestone
halts the plan, and nothing proceeds past it.

- **Why.** Attention on one mission means its context is whole and its decisions see every result. A
  mission loop without concurrency has no races of its own to reason about.
- **How the code gives it.** `agent/services/brain/envelope-runner.mjs` (one active mission, the
  claim, startup recovery), `agent/services/brain/envelope-store.mjs` (the claim's compare-and-swap),
  `agent/work/checkpoint-executor.mjs` (checkpoints and tasks in sequence).

## Verification

### B-8. Every checkpoint is judged by an organ that did not do the work

The cerebellum judges each checkpoint once its tasks ran: did the combined work meet the milestone's
[acceptance criteria](../GLOSSARY.md)? A checkpoint planned without criteria is judged on its stated
outcome. The cerebellum never runs a task, cannot change anything, and never joins the cortex's
running [session](../GLOSSARY.md); on Gemini, every step it takes must be a tool call. A milestone
never passes unverified: a verifier that returns no verdict after a retry and a shorter prompt, or a
verification that cannot run, fails the milestone as inconclusive.

- **Why.** The organ that did the work is the worst judge of it. A pass that nobody rendered is a
  pass nobody checked.
- **How the code gives it.** `verifyMilestone()` in `agent/organs/cerebellum/verify.mjs`, called by
  `agent/work/checkpoint-executor.mjs`. `CEREBELLUM_TOOLSET` in `agent/gateway/tools.mjs`;
  `forceToolCall` in `agent/gateway/organs.mjs`, applied by `agent/gateway/google-step.mjs`;
  `session.excluded_organs` in `config/contracts.json`, applied by `agent/gateway/server.mjs`.

### B-9. Verification is re-derivation from evidence

The verifier judges from the evidence, not from the executor's account of it. The
[tool log](../GLOSSARY.md) is written by the gateway from what the tools actually returned. A large
result is stored whole and replaced in the log by a labelled digest and a reference, never cut
silently. A verdict reached on a partial view (a row cut, the evidence clipped, a digest in place of a
result) is judged again on the complete evidence, with stored results put back. Work earlier
checkpoints established is handed to the verifier as established. A failure that only says "I could
not see it" is not a judgment of the work: it triggers the complete re-check, and if the evidence is
still out of view the milestone is inconclusive, not failed work.

- **Why.** "Sounds right" is how confident wrong answers pass, and a verifier shown a cut record fails
  work that was fine. Judging the stored evidence, whole, makes both rarer.
- **How the code gives it.** `agent/gateway/turn-loop.mjs` appends the tool log;
  `agent/context/tool-record.mjs` stores and digests large results; `agent/organs/cerebellum/verify.mjs`
  runs the re-check; `isMissingEvidenceFail()` in `agent/organs/cerebellum/verdict.mjs` tells "not visible" from
  "wrong". The log is the gateway's alone: a tool-log marker a model writes into its own text is made
  inert (`quoteToolLogMarkers()` in `agent/context/tool-record.mjs`), and the verdict and the task's
  outcome read the last block, the gateway's (`lastToolLog()`). **Missing:** the verifier cannot ask
  for a [probe](../GLOSSARY.md); nothing services one (`agent/organs/cerebellum/verify.mjs` says so).

### B-10. The verdict is graded, and the verifier owns it

A milestone is met, met with a caveat, or not met. Met with a caveat means the intent is achieved but
a criterion is partly met in a way that does not defeat the deliverable; the caveat is a field of the
pass, shown to the person with the answer, never swallowed. Not met splits in two: work judged wrong,
and work the verifier could not judge. A pass the brain could not fully confirm (the complete-evidence
re-check returned nothing, or the adversarial pass did not complete) stands only with a caveat that
says so.

- **Why.** A two-way switch either blocks working deliverables over small gaps or passes them
  silently. A graded verdict passes what works and tells the person what is missing.
- **How the code gives it.** The `caveat` argument of `report_pass` in `agent/gateway/tools.mjs`;
  `extractPassCaveat()` in `agent/organs/cerebellum/verdict.mjs`; the grades and the module's own caveats in
  `agent/organs/cerebellum/verify.mjs`; `renderCaveatSection()` and `isRealTaskFailure()` in
  `agent/work/finalization.mjs`, which never count an inconclusive or timed-out row as failed work.

### B-11. Scrutiny rises with the stakes

Every mission has [stakes](../GLOSSARY.md): routine, consequential or irreversible. The
classification sets them for a person's request, routine when it names none; scheduled work runs as
routine. At consequential stakes or above, and for work the brief marks load-bearing, a pass
faces an [adversarial pass](../GLOSSARY.md): a separate call tries to overturn it with an expert's
objection, a flip test and a boundary case. An attack that lands fails the milestone; one that cannot
be judged leaves at most a caveat. The final answer gets the same [attack duty](../GLOSSARY.md). A
plan whose brief has a destructive or public part and no approval gate is sent back once with a
warning.

- **Why.** Verification costs model calls. Spending them where a mistake would do harm buys the most
  safety for the least time and money.
- **How the code gives it.** `agent/organs/cerebellum/verify.mjs` and
  `agent/services/brain/actions/synthesize.mjs`, from `brain.attack_duty_stakes_min` in
  `config/contracts.json`; `stakesAtLeast()` in `agent/organs/cerebellum/verdict.mjs`; the warning in
  `agent/services/brain/actions/checkpoint-plan.mjs`. **Not structural:** after that one warning the
  plan runs as written; an approval gate before a destructive step is the cortex's and the motor's
  prompt rule (`prompts/cortex.md`, `prompts/motor.md`), not a check.

### B-12. Nothing is reported done that the work did not reach

The cortex proposes that a mission is done with the `synthesize` move. That move is refused while a
real task failure stands unresolved, and while the last checkpoint of the mission's
[checkpoint spine](../GLOSSARY.md), the one that holds the deliverable, is not complete. The answer is
then checked by the cerebellum against the mission's criteria: a fail there sends the cortex to
`synthesize_with_failure`, saying plainly what was and was not achieved. Only a short answer to a
request without real criteria skips that check. Work that did not fully succeed ends with
`synthesize_with_failure`: the cortex gets one chance to resolve the failure another way, and then the
mission ends blocked, with its account of what happened. A conversational answer, a
[classification](../GLOSSARY.md) of `respond`, is recorded as a mission complete when written: it runs
nothing and changes nothing. A delivered body is never empty: when no synthesis was written, one is
composed from the mission's state and labelled as such.

- **Why.** The worst failure is a false success: a person acts on a result that does not exist. Code
  proves that real work happened; the verifier judges whether it is enough.
- **How the code gives it.** `agent/services/brain/actions/synthesize.mjs`, `finalizeBlockedBySpine()`
  in `agent/work/checkpoint-spine.mjs`, `agent/services/brain/actions/synthesize-with-failure.mjs`,
  `agent/work/deliverable.mjs`. **Known gaps:** a synthesis the verifier returned no verdict on still
  completes, flagged for review. And a checkpoint whose last task is an approval gate is marked
  complete on resume without being
  judged ([plan/OPEN_ITEMS.md](../plan/OPEN_ITEMS.md), phase 4).

## Durable work

### B-13. Verified work is kept, not redone

The mission's first plan pins its checkpoint spine: each checkpoint's outcome and criteria. A failure
re-plans only the first checkpoint that has not passed, against its pinned outcome; checkpoints that
passed keep their verdicts. Criteria may be refined at most `brain.max_criteria_revisions` times. A
new plan for a mission whose checkpoints all passed is refused. The [step ledger](../GLOSSARY.md)
replays a task that already completed, with its recorded output, instead of running it again. After
an approval, the plan continues at the task after the gate rather than being decided again.

- **Why.** Re-deriving a whole plan after one failure reruns work that passed, and can loop for hours
  without converging. Keeping what is verified makes every retry smaller than the last.
- **How the code gives it.** `agent/work/checkpoint-spine.mjs`,
  `agent/services/brain/actions/checkpoint-plan.mjs`, `agent/work/step-ledger.mjs`, and
  `resumeAfterApproval()` in `agent/services/brain/envelope-runner.mjs`.

### B-14. What is stored is enough to resume

When the brain stops, at a restart or a crash, it starts again from what is stored: finished tasks are
replayed, not run again, and only a task cut off in the middle of its turn runs again. A mission's
progress is saved on its envelope after every task, pointing back at the last task until its milestone
is judged, so a crash before the verdict re-verifies instead of skipping. At start, the brain releases
the claims a dead process left and continues those missions. Writes that a replay might repeat are
keyed: the brain's own messages under a mission, and the mouth's Chat posts, whose message id comes
from what the message is, so a retried post returns the message Chat already has.

- **Why.** VMs reboot and services restart during upgrades. Work that lives only in memory, or a
  handler that double-fires on replay, turns a restart into lost or duplicated work.
- **How the code gives it.** `_cp_progress` and the step ledger in
  `agent/work/checkpoint-executor.mjs`; `recover()` in `agent/services/brain/envelope-runner.mjs`;
  `createCT()` in `agent/services/brain/envelope-store.mjs`; `agentMessageId()` in
  `agent/providers/channel.mjs`.

### B-15. Failure is honest and bounded

Every loop has a limit, and every limit says what it stopped. A mission gets at most
`brain.max_iterations` decisions over its whole life, a resumed one included; an organ turn at most
`organs.max_steps` model calls; a stuck tool loop is warned, then stopped. A required task is retried
once, told why it failed. After three failed plans the cortex is told to escalate instead of planning
again. A mission whose run errors three times in a row, a storage outage aside, is failed with the
error. A timed-out task's outcome is unknown, not failed, and its retry is told to check what already
landed. A blocked mission says what is in the way: when the cortex states nothing, the failing task's
own report is recovered; when nothing failed, it says the stop came while planning. A mission whose
tasks all succeeded is not marked blocked over a checkpoint's verdict: it is sent once to a verified
synthesis instead.

- **Why.** An agent that retries forever spends money and hides the problem; one that fails without a
  cause leaves the person nothing to act on.
- **How the code gives it.** The limits in `config/contracts.json`; `agent/gateway/loop-guard.mjs`;
  `agent/services/brain/envelope-runner.mjs` (the decision cap and repeated errors);
  `MAX_REPLANS` in `agent/services/brain/actions/checkpoint-plan.mjs`; the retry in
  `agent/work/checkpoint-executor.mjs`; `agent/work/task-outcome.mjs` (timeouts and truncation);
  `agent/services/brain/actions/blocked.mjs`, with `articulateBlocker()` in
  `agent/work/finalization.mjs`. The escalation after three failed plans is an instruction to the
  cortex, not a refusal: only the decision cap stops a cortex that keeps planning.

### B-16. Code owns the clock; the model never waits

When progress depends on time, the cortex chooses the `wait` move with a number of minutes and the
next step, and the mission pauses as `waiting`. The brain resumes it when the time comes. A wait is
bounded by `brain.wait_min_minutes` and `brain.wait_max_minutes` (one minute to one day as shipped);
anything longer or recurring is a [responsibility](../GLOSSARY.md), fired by the scheduler in its own
time zone. The archival sweep never cancels a timed wait before its time.

- **Why.** A model told to wait loops tool calls or sleeps inside a command, burning tokens, and a
  timer in a process dies with the process. A resume time on the envelope survives both.
- **How the code gives it.** `agent/services/brain/actions/wait.mjs`, `agent/services/brain/waits.mjs`
  (resumes with a compare-and-swap, so a cancel at the same moment is never undone),
  `agent/work/archival.mjs`, `agent/work/scheduler.mjs`; `config/contracts.mjs` refuses an archival
  timeout shorter than the longest wait.

## Context and knowledge

### B-17. Every token in a prompt earns its place

Each model call gets the least context that is enough. Prompts are assembled most stable first, so
providers cache the prefix. A mission's accumulated context has a budget, and past it the oldest
iterations fold into a digest, with the instruction and criteria kept word for word. Finished
checkpoints reach later tasks as digests; the checkpoint in flight stays word for word. Results reach
the cortex as [result packets](../GLOSSARY.md): a summary and a reference, and the cortex asks for the
full content by reference only when the summary is not enough. Tool results are capped, and a cut is
always announced. Working memory has a hard cap. Organs see an index of skills, not every skill's
text, and a turn keeps only its most recent images.

- **Why.** Tokens cost money and time, and a long prompt dilutes the model's attention. Memory and
  digests exist to make context smaller, not larger.
- **How the code gives it.** `agent/context/prompt-blocks.mjs`, `agent/context/compaction.mjs`,
  `agent/services/brain/mission-context.mjs`, `agent/work/result-packet.mjs`, `capResult()` in
  `agent/gateway/tools.mjs`, `agent/gateway/skill-catalog.mjs`, `agent/gateway/images.mjs`; the
  budgets in `config/contracts.json`, whose ceilings `config/contracts.mjs` checks.

### B-18. Memory is a closed set of three layers

The agent's memory is [working memory](../GLOSSARY.md), [Core Memory](../GLOSSARY.md) and the
[Deep Truths](../GLOSSARY.md), and nothing else. Processes, projects, skills and responsibilities are
what memory reads, never what it writes. The memory organ consolidates with a toolset that can do
nothing else: the memory commands, run without a shell, read-only views of playbooks and projects, and
its own two files, working memory and the [consolidation report](../GLOSSARY.md). A mission whose
[effect scope](../GLOSSARY.md) is memory runs every task on the memory organ, may not open an approval
gate, and gets a one-pass plan written by code. A lesson a finished mission taught about its project
or playbook goes to working memory, where the nightly consolidation decides whether it earns a place
in Core Memory.

- **Why.** Memory that edits definitions drifts the agent's playbooks and projects with every pass,
  and a binding kept only in memory can be pruned away. One memory organ, writing only memory, keeps
  both stable.
- **How the code gives it.** `MEMORY_TOOLSET` in `agent/gateway/tools.mjs`; `MEMORY_COMMANDS` and
  `MEMORY_READ_VIEWS` in `agent/services/gateway/settings.mjs`; `agent/work/memory-scope.mjs`;
  `agent/context/context-maintenance.mjs`. **Gap:** a memory-scoped mission still lets a task run on
  temporal-research, whose toolset is open (B-2).

### B-19. Recall is gathered by code before the work starts

Before a mission runs, the brain gathers what the agent already knows, deterministically: working
memory, Core Memory ranked by value, the last week's work, past work that matches the request, and the
[known resources](../GLOSSARY.md). The memory organ turns the candidates into one recall packet that
every other organ sees. An identifier found once is kept in the mission's
[resource ledger](../GLOSSARY.md) and shown to every later task; when a plan mistypes one by a single
character, and only one known id is that close, code repairs it before the plan runs.

- **Why.** What the agent knows is the cheapest and most trusted source, and an id resolved once
  should never be searched for again or retyped from memory.
- **How the code gives it.** `recall()` in `agent/services/brain/memory.mjs`,
  `agent/context/work-recall.mjs`, `agent/context/core-memory-rank.mjs`,
  `agent/work/resource-ledger.mjs`, and `repairPlan()` in
  `agent/services/brain/actions/checkpoint-plan.mjs`.

### B-20. The conversation is context, not memory

The recent conversation is assembled by code, from the channel or from the
[thread ledger](../GLOSSARY.md), trimmed to a budget, and given to the cortex when it classifies and
decides, and to the mouth when it voices a reply. Tasks get their instruction, not the chatter. No
organ reads or writes the ledger: the brain, the ears and the mouth write it as a rebuildable cache,
and losing it costs coverage, never correctness.

- **Why.** A conversation is what was said, not what is known. Kept apart, it informs the next reply
  without becoming a fact the agent carries forever.
- **How the code gives it.** `agent/context/thread-ledger.mjs`, `agent/context/conversation-context.mjs`,
  `agent/services/brain/intake.mjs`, `agent/services/mouth/voicing-context.mjs`; the budgets in
  `config/contracts.json`'s `conversation` section. The task payload in
  `agent/work/checkpoint-executor.mjs` carries no conversation.

### B-21. Skills are codified procedure

A [skill](../GLOSSARY.md) is the written procedure for one kind of work plus the commands that do it.
Command syntax lives in a skill's SKILL.md, not in organ prompts. Each tool-using organ sees an index:
what each skill is for and where its SKILL.md is, so it reads the procedure before running a command.
A skill whose requirement the instance lacks (a Workspace skill without a Workspace account) is left
out. The planner is handed the plan-structuring skill itself. The package format is
[skills/README.md](../../skills/README.md); writing one is [guides/SKILLS.md](../guides/SKILLS.md).

- **Why.** A solved problem written down is solved the same way every time, and improves in one
  commit for every instance. Procedure improvised in a prompt is re-derived, differently, each time.
- **How the code gives it.** `agent/gateway/skill-catalog.mjs` and
  `agent/context/skill-requirements.mjs`; `install/vm/launchers.mjs` installs a command for each one a
  skill lists; `tests/content/packages.test.mjs` checks every SKILL.md names every command its skill
  governs; `tests/content/command-flags.test.mjs` checks agent-facing text uses only flags the commands
  take. **Not checked:** that organ prompts hold no tool syntax, and that an organ reads a skill before
  using its commands; both are prompt rules (`prompts/README.md`, `prompts/motor.md`).

## Speaking

### B-22. Every claim carries its epistemic bin

A claim is `verified` (re-derived from evidence), `inferred` (reasoned from evidence) or `assumed`
(not checked); these are the [epistemic bins](../GLOSSARY.md). The answer's listed assumptions are
shown each with its bin, least certain first, and a claim with no bin is shown as assumed. A mission
digest whose claims lack bins is rejected before it enters the mission's context.

- **Why.** A reader can discount exactly what was not checked only if each claim says how it is known.
  An unlabelled guess reads as a fact.
- **How the code gives it.** `epistemicBin()` and `composeAnswerFirst()` in
  `agent/services/brain/actions/synthesize.mjs`; the decide schema's `assumptions` in
  `agent/providers/vertex-text.mjs`; `validateMissionDigest()` in `agent/context/compaction.mjs`.
  **Prompt only:** bins on claims inside an organ's prose (`prompts/motor.md`, `prompts/cerebellum.md`,
  `prompts/temporal-research.md`).

### B-23. Answer first, then reasoning, then risk

When the cortex gives an answer, the delivered text leads with it, then the reasoning, then the risk
and the assumptions. A body composed from mission state leads with a headline that says how the
mission ended.

- **Why.** A reader should be able to act on the first lines. Hedges belong where they can be acted
  on, not spread over the answer.
- **How the code gives it.** `composeAnswerFirst()` in `agent/services/brain/actions/synthesize.mjs`
  and `composeFallbackSummary()` in `agent/work/deliverable.mjs`. Without an `answer` field, the
  cortex's synthesis is used as written, and the order is its prompt's rule (`prompts/cortex.md`).

### B-24. The agent answers like a colleague

A person who asks for work gets an [acknowledgment](../GLOSSARY.md) at once, and
[status notes](../GLOSSARY.md) on a fixed schedule while it runs, skipped when the agent has just
spoken to them. A conversational message is answered at once, with no plan to run. Every reply is
[voiced](../GLOSSARY.md) in the agent's own words with the recent conversation in view, and internal
noise is held back. When the agent is stuck it asks one question with the `needs_input` move. A file
it made reaches the person as a download: the documents a mission makes are committed and exported
with its artifacts, and the prompts forbid pointing a person at a path on the VM.

- **Why.** People trust a colleague who says "on it", keeps them posted and asks precisely. Silence
  followed by a wall of text, or internal mechanics in a reply, do the opposite.
- **How the code gives it.** `agent/services/brain/intake.mjs` and `agent/providers/notifications.mjs`
  (acknowledgments and conversational answers), `agent/services/mouth/status-updates.mjs` (the
  schedule in `mouth.status_updates` of `config/contracts.json`), `agent/services/mouth/voice.mjs`,
  `agent/services/brain/actions/needs-input.mjs`, `agent/work/artifacts.mjs` and
  `agent/files/outgoing.mjs` (a mission's downloads and a reply's attachments), `prompts/cortex.md` and
  `prompts/motor.md` (no VM paths).

## The brain as code

### B-25. Thin services over pure libraries

The services read configuration, wire the libraries together and run their loops. The libraries take
every value as a parameter, and the logic that can be a pure function is one: most of
`agent/work/` takes plain data and returns plain data, with no Firestore, network or clock. Effects sit
at the edges, behind small named modules. So the brain runs end to end in tests on a laptop, against
in-memory fakes of Firestore and Cloud Storage.

- **Why.** Logic tested without a cloud is logic you can change safely. A bug reproduced as a failing
  test is fixed once.
- **How the code gives it.** `tests/repo/boundaries.test.mjs` (only services and commands read
  configuration), [agent/README.md](../../agent/README.md) (one concern per package), the fakes in
  `tests/fakes/README.md`, and the end-to-end tests in
  `tests/integration/dashboard-round-trip.test.mjs`.
