# Skill: Checkpoint Plan Structuring

## When to use

When the brain asks the prefrontal to structure a checkpoint plan from a goal and its Brief, or to plan
new tasks for one checkpoint that failed. The brain puts this skill in the request; there are no
commands.

## Output schema

Return one JSON object with a `checkpoints` array:

```json
{
  "checkpoints": [
    {
      "instruction": "The milestone: the meaningful state the mission reaches at this checkpoint",
      "accept_criteria": "The observable outcome that is true once the milestone is reached. The cerebellum verifies this. An end state, never 'the tasks ran'.",
      "tasks": [
        {
          "agent": "motor | temporal-research | temporal-memory",
          "task": "One outcome a single organ owns end to end. What to achieve, never the tool or API.",
          "accept_criteria": "A light self-check the organ uses on its own task. The cerebellum judges the checkpoint, not each task.",
          "step_type": "standard | approval_gate",
          "brief_part": "The Brief part this task serves"
        }
      ]
    }
  ]
}
```

`step_type` defaults to `standard`. An `approval_gate` task pauses the checkpoint until a person
approves; its `task` says what they are approving, which is the work that runs after the gate (the rest
of the checkpoint, or else the next checkpoint). Put the gate directly before the step that needs it.

## Procedure: structure a plan

1. Read the goal, the Brief's parts and the map of what each organ can do.
2. Define checkpoints as **verifiable milestones**: meaningful states the mission reaches that deserve
   an independent check (a phase gate, an approval, a deliverable produced). A checkpoint is not a
   grouping of tasks or a tool step; it is the milestone the cerebellum judges.
3. For each checkpoint write its `instruction` (the milestone) and its `accept_criteria`: the
   observable outcome that is true when the milestone is reached. That is the contract the cerebellum
   verifies, so it must be a real, checkable end state.
4. Break each checkpoint into outcome tasks, each a result one organ owns end to end (it may take many
   tool calls): the `agent`, a `task` describing the outcome, and a light `accept_criteria`.
5. Check the result: it fits the schema, no field is missing, and it holds no commands.

## Procedure: re-plan one checkpoint

A request marked `[PLAN STRUCTURING — SINGLE CHECKPOINT]` asks for **tasks only**, for the one
checkpoint it names. A mission's checkpoints are fixed after the first plan: a checkpoint that fails is
given new tasks; the mission is not re-shaped.

1. **The outcome and the acceptance criteria are fixed.** They are marked "do not reword" because
   checkpoints that already passed keep their verdicts against these exact criteria. Plan tasks that
   meet the criteria as written.
2. **Read why the last attempt did not meet them,** and change the approach, not the goal. If the
   earlier tasks failed on mechanics (a wrong command, a document not read), make the new tasks more
   specific about the outcome to reach, not longer.
3. **Cover every unmet clause.** Split the criteria into their separate clauses and check your tasks
   against each one. The verifier judges all clauses at once, so a plan that meets some of them still
   fails, and because the criteria are fixed it fails the same way every round. For criteria reading
   "the draft ids are identified **and** the details are extracted", a plan with only extraction tasks
   can never pass: nothing identifies the drafts. If earlier evidence already meets a clause, say so in
   your reasoning instead of dropping it silently.
4. **Return exactly one checkpoint** in `checkpoints`. Anything beyond the one asked for is discarded.
5. Propose different `accept_criteria` only if the fixed wording is genuinely unachievable (it asks for
   something that cannot exist), not merely awkward. One refinement per checkpoint is accepted; after
   that the wording stands, so spend it carefully.
6. **Never plan a "clone the repository" or "check out main" task.** The brain has already cloned the
   project's repository into the mission's working tree, on the mission's own branch. Such a task is
   wasted motion, and checking out another branch takes the work off the mission branch.

If you conclude the mission itself is mis-shaped (a whole phase is missing, or the goal was misread),
say so plainly in your reasoning rather than adding checkpoints. Re-shaping a mission is the cortex's
decision.

## Rules

### Checkpoints are milestones; tasks are steps

A checkpoint is a verifiable milestone, and its `accept_criteria` is the outcome the cerebellum judges.
Tasks are the steps the owning organ takes to get there, and the organ checks its own tasks. Keep
tool-step language ("apply each change individually", "generate a structured list of instructions")
out of a checkpoint's criteria: it makes the milestone unverifiable against how the organ actually
chose to work. State the end state and let the organ choose the way.

**The outcome names a state, never the method that reaches it.** A checkpoint's `instruction` is fixed
for the whole mission: a failure gets new tasks, but the outcome wording stands. A method written into
the outcome becomes a permanent constraint on every later attempt, even after the method was carried
out, or proved wrong. Write "three draft agreements exist in the In Progress folder, one per client",
not "prepare the drafts by duplicating the master template": the second reads like an outcome and
behaves like an instruction, and keeps asking for duplication after the drafts exist.

**Criteria are format-agnostic unless the person asked for a format.** A criterion states what must be
true of the content, never the shape it arrives in. If the person asked to "list", "summarize" or "tell
me", do not require a JSON array or any other schema: a correct answer in prose would fail that check
and strand a finished mission. Demand a specific format only when the person asked for it ("give me a
CSV"). Otherwise state the content: "each shared document is listed with its name, id and who shared
it, newest first".

**Criteria test the deliverable, not the tooling that made it.** A criterion asserts the artifact's
observable outcome (it exists, it is reachable, its content is right), never an incidental detail of
the run that produced it: a deprecation warning, a log line, an exit-code cosmetic, which flag or
login method was used, "no warnings were printed". Pinning one fails work that succeeded, and often
cannot be met at all (a warning the tool always prints). A deploy checkpoint's criterion is "the
staging URL returns HTTP 200 and serves the updated page", not "the deploy used a non-deprecated login
method". Put a runtime detail in a criterion only when the person named it as a requirement.

**The subject of a criterion is the artifact, never an organ or a planning step.** A criterion that
names the cortex, the prefrontal, the motor, the cerebellum, "the plan", "the premise" or "the
approach is re-evaluated" describes the agent's own next move. The cerebellum can honestly pass it
while the deliverable does not exist: it answered the wrong question truthfully, and the mission then
reports results it never had. A criterion someone outside the agent could not check is a note to self,
not a criterion. Write what a reader could confirm: "the report lists every service with its installed
version and its expected version, and names each mismatch", not "the agent finds a way to get the
versions".

**A missing capability fails the checkpoint; it never becomes a planning goal.** If an organ reports
that no tool can do what the mission needs, that is a question for a person (the capability must be
built or granted), not a criterion about trying again. Turning "I cannot do this" into "the agent works
out how to do this" is how an impossible mission acquires a checkpoint it can pass.

**A criterion must not require a state that exists only when the mission completes,** above all a
commit "on main". The organs commit to the mission's own branch; the brain merges that branch into
`main` only when the mission completes, and a push to `main` from inside the mission is refused. A
criterion such as "the change is on the main branch" can never be met from inside the mission: the
organ makes the edit correctly and then fails its own criterion. Write the deliverable as its content,
committed: "index.html contains the new headline, committed to the mission branch". A later deploy
checkpoint reads the mission's working tree, which already holds the edit.

### Simplicity first

The best plan is the simplest one that gets the work done.

**Default: one checkpoint.** Most work needs one checkpoint with one to three tasks. Add a second only
when the work truly needs a phase gate:

- an approval: a person must approve before the work continues;
- the first phase must be complete and verified before the second can start.

Do not create a new checkpoint for:

- reading before writing within the same work: read then change is two tasks, not two checkpoints;
- verification steps: every checkpoint is verified automatically;
- "analyze, then implement": two tasks in one checkpoint;
- **a small content edit that exists only to be shipped** ("change the headline and give me a staging
  link", "fix this copy and redeploy"). The edit is a step toward the deployable, not a milestone of
  its own. Make it **one deploy checkpoint** whose milestone is the observable outcome ("the staging
  URL returns HTTP 200 and serves the new text"), with the edit and the deploy as tasks inside it: edit
  the file in the mission's working tree and deploy that tree. Split into two checkpoints only for
  substantial work where the change itself deserves its own verification;
- **reporting a result the mission already produced** ("report the staging URL", "send back the
  document link"). The checkpoint that produced the artifact is the deliverable, and its URL is its
  output. Reporting it is the mission's answer: a synthesize move by the cortex, delivered by the
  mouth, never a trailing "report the URL" checkpoint. Such a checkpoint re-verifies what the previous
  one already proved, fails whenever the wording does not echo the URL the way the verifier expects,
  and each failure re-plans the mission. Make the checkpoint that produced the artifact the last one.

**Count your tasks.** More than five tasks in total is probably over-decomposed. Could two adjacent
tasks be one? Usually yes.

**No placeholders.** Every task is concrete and actionable. Never write "PLACEHOLDER", "to be filled
later", "TBD" or any deferred content: the brain sends task text exactly as written. If you need
information before you can write a task, make gathering it a plan of its own; the cortex is called
again with the results.

### Valid task agents

The `agent` field is exactly one of:

| Agent | Can do | Cannot do |
|---|---|---|
| `motor` | Run commands, read and write files, use any skill, change state | Send anything to a person: the mouth is the only way out |
| `temporal-research` | Search the web, fetch and read pages | Write files, change state, run other commands |
| `temporal-memory` | Recall memory, read Core Memory | Write files, change state, search the web |

Common mistakes:

- "Search the web and save the results to a file": temporal-research cannot write files. Split it:
  temporal-research searches, then the motor saves the results.
- "Recall memory and create a report": temporal-memory cannot write files. Split it the same way.
- Giving temporal-research or temporal-memory any task that says create, write, upload, deploy or
  modify. Those verbs need the motor.
- A skill name, `exec` or `system` as an agent. They are not agents.
- `cortex`, `prefrontal` or `cerebellum` as a task agent. They are organs with their own roles, not
  task agents.

### Outbound is never a motor task

Anything aimed at a person is never a `motor` task: the motor cannot deliver anything, because the
mouth is the only way out. Shape it as the matching move or step instead:

- a reply or finished answer: a synthesize move by the cortex, not a task in this plan;
- a receipt that queued work was received: a status_update move;
- content that must be signed off before it leaves: an `approval_gate` task.

Never write a motor task such as "email the staging URL to the requester" or "send the report".

### Size tasks by outcome, not by tool step

A task is one outcome one organ owns end to end. The organ sequences the tool calls itself, so many
tool calls in one task is normal execution. But each task runs as its own turn, with a bounded budget
of tool calls and time, and a fresh task re-reads its context from scratch, so the budget reaches real
work only when the task is one coherent outcome. Avoid both failures:

- **Over-bundling:** several outcomes in one task ("write the HTML and the CSS and render the PDF and
  upload it"). The organ spends its budget on the first outcome and runs out before the rest. When a
  deliverable needs authoring, rendering and delivery, those are separate tasks, each with a fresh
  budget.
- **Fragmenting:** one outcome split across tasks ("write the HTML", then "write the CSS"). Each split
  re-reads the brief and the skill from scratch, wasting budget and risking drift between the halves.
  One artifact, its markup and its styles, is authored in one task.

Split only when the outcome genuinely changes (author, render, deliver), never merely because one
outcome takes several steps. "Read, analyze, apply" is one outcome.

### Task text describes outcomes, never tool syntax

Write what should happen, not how. The organs read their own skills. Say "read the project context",
not "read the project context using the drive skill". Name a skill at most; never a command, flag or
API operation. "Execute the generated batch of document API operations" names a tool that does not
exist; "incorporate the redline changes into the body and remove the redline notes section" is the
outcome.

### Name code targets by their role, not a guessed path

For work in a code repository, the brain has already put the project's repository in the mission's
working tree, and the motor finds where files actually live. Name the change by its role in the outcome
("the homepage", "the FAQ section of the landing page", "the navigation styles"), never a path you did
not read: a guessed path is usually wrong, and every attempt then edits a file that does not exist. The
tree's root is the project's root; there is no extra prefix to add. If the person named an exact file,
pass that name through verbatim; otherwise describe the target and let the motor locate it.

### Never split a task away from the identifier it needs

If task B needs an identifier that task A has to find, A and B are one task. Do not write "locate the
template" and then "duplicate the template identified in the previous task": that is one outcome, and
splitting it is how the wrong file gets used. Each task runs as its own turn, so a back-reference such
as "identified in the previous task", "found above" or "from step 1" is not something the organ can
resolve: it has to guess which id you meant from whatever context came along, and it can guess wrong
without anything failing loudly. Write one task that owns the whole outcome: "duplicate the fixed-fee
master template from the Templates folder once per client into the In Progress folder". The organ
resolves the id and uses it within one turn, where it cannot get lost.

### Identifiers are copied, never retyped

When the request carries a "Known Resources" block, every id in it was read back from a tool result. If
a task needs one, copy it from that block character for character. Never retype an id from memory,
never carry one over from an earlier task list, and never invent one to fill a gap.

An id cannot be almost right. One wrong character makes a task that fails instantly and identically on
every retry, and because the checkpoint is fixed, the new tasks are derived from your own earlier
wording each round, copying the same wrong id forward.

If a resource you need has no id in that block, do not guess one. Name the resource plainly ("the
master template in the Templates folder") and let the executing organ resolve it: resolving identifiers
is work it can do and you cannot.

### Acceptance criteria demand evidence

Write criteria a verifier can check against concrete evidence, at the level of the outcome. For a task
that reads or analyzes an artifact (a document, a file, a dataset), the criteria demand evidence of
coverage, for example "the whole document was read: the characters read equal the document's total,
shown in the output", not merely "the content was retrieved". A partial read that passes verification
is how a later edit destroys content.

### One-task plans are valid

A simple request yields one checkpoint with one task.

### Limits

- Do not execute anything.
- Do not decide whether the goal is feasible; the cortex decides.
