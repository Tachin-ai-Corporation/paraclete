# Writing a process playbook

A process is a playbook: a named narrative of how one kind of work goes well, which the agent recalls
when its work resembles it ([the glossary](../GLOSSARY.md)). This guide is for developers who add a
playbook to a role package's `processes/`, and for anyone reviewing the playbooks the agent writes
for itself. A playbook's fields are the ones `tests/content/packages.test.mjs` checks; the agent's
own authoring, with the `process-ops` command, is in
[skills/processes/SKILL.md](../../skills/processes/SKILL.md). This guide says what the brain does
with a playbook, how to write its order of work and its approval points without turning it into a
program, and what makes one good.

## A narrative, never a program

The brain never runs a playbook as steps. The process registry serves it as remembered guidance
(`agent/work/process-registry.mjs`), and the planner folds it into its own checkpoint plan, adapted
to the request. That is why a playbook has no step, organ, gate or parameter fields: the plan is the
cortex's (decides each step) and the prefrontal's (plans checkpoints), made fresh for each mission.

A playbook is one JSON file, `roles/<id>/processes/<playbook>.json`, with:

| Field | Required | What the code does with it |
|---|---|---|
| `id` | Yes | The file's name; lowercase letters, digits and dashes; `p-` by convention. The key the registry, a responsibility's `processRef` and a project's playbook list use |
| `name` | Yes | The short handle shown with it everywhere |
| `description` | Yes | One line. Shown in every listing; cut to 200 characters in the cortex's decision payload and the prefrontal's analysis |
| `narrative` | Yes | The guidance itself. Shown whole in the library; its first 200 characters in the planner's hint |
| `intent_keywords` | No | Phrases matched against the mission's goal to put the playbook in front of the planner |
| `status` | Yes | `active` for an installed playbook (the tests insist). The registry skips a `deprecated` one, so the agent no longer sees it |
| `version` | No | A counter for people reading the repo. Nothing in the agent reads it, and the dashboard's Library lists only the playbooks stored in Firestore ([open items](../plan/OPEN_ITEMS.md), phase 6) |

## Where playbooks come from

| Source | Lives in | Written by | Notes |
|---|---|---|---|
| Installed | `roles/generic/processes/` and the role's `processes/` | A release | Read at brain start, generic first; the first playbook with an id wins (`agent/work/role-packages.mjs`), so a role's playbook with one of generic's ids would be dropped, and the tests refuse one |
| The agent's own | The root `processes` collection in Firestore | `process-ops write` | Replaces an installed playbook with the same id, whole (`agent/work/process-registry.mjs`). Retiring it marks it deprecated, which brings the installed one back. An installed playbook cannot be retired |

Two consequences:

- **An instance whose agent rewrote an installed playbook keeps its own version.** A release that
  improves that playbook does not reach it.
- **A playbook the agent writes takes no `intent_keywords` of its own.** `process-ops` takes none
  (`agent/cli/process-ops.mjs`). Its first write over an installed playbook carries the installed
  one's over, so the planner's keyword hint still finds it; a playbook the agent creates from nothing
  has none, and reaches the cortex through the library only.

## What the agent sees, and when

| When | What reaches the organ | Code |
|---|---|---|
| Every classification and decision of the cortex | The whole library: every active playbook's id, name, description and narrative | `cortexSystem` and `decidePayload` in `agent/services/brain/prompt-assembly.mjs` |
| The prefrontal's first analysis of a mission, the brief | The whole library. A playbook that covers the work is named in the brief's `process_match`, which the cortex reads with the brief | `analyzeRequest` in `agent/services/brain/prompt-assembly.mjs`; `prompts/prefrontal.md`; `agent/services/brain/envelope-runner.mjs` |
| Planning | Playbooks whose `intent_keywords` occur in the goal, matched as lowercase substrings. They are recorded on the mission as `recalled_processes`, and when the prefrontal structures the plan it gets them with the first 200 characters of each narrative | `agent/services/brain/actions/checkpoint-plan.mjs` |
| A responsibility fires with a `processRef` | That playbook's whole narrative, in the mission's context | `fireResponsibility` in `agent/work/scheduler.mjs` |
| A mission in a project that lists playbooks | A reminder to plan with those playbooks | `agent/services/brain/prompt-assembly.mjs` |
| After a mission completes | For up to three playbooks it recalled, the memory organ may write one lesson line to working memory. It never edits the playbook | `agent/organs/temporal-memory/context-maintenance.mjs`, `recordLessons` in `agent/organs/temporal-memory/memory.mjs` |

What follows for a writer:

- **Every word is read on every cortex decision.** The library rides in the cortex's stable context,
  so a long narrative, or a near-duplicate playbook, costs every mission whether it applies or not.
- **The first 200 characters are the hint.** Lead with the stance and the shape of the work.
- **A lesson about a playbook becomes memory, not an edit.** The nightly consolidation may promote
  it into Core Memory, tagged with the playbook's id. Changing the playbook is an authoring decision:
  a commit, or the agent's own `process-ops write`.

## The order of work: write it as prose

A playbook still says what comes first and what comes last. Write that order in sentences: settle
the question or the criteria, gather the evidence, do the work, prove the result from the live
system, then report. The planner turns it into checkpoints sized to the request.

`p-release` is the model: pre-flight, then a person's approval, then tag, deploy, verify from the live
system, and say what shipped (`roles/generic/processes/p-release.json`).

Where real steps belong instead:

| Steps that | Go in | Because |
|---|---|---|
| A scheduled firing must follow, with exact commands | A responsibility's `context.process` ([RESPONSIBILITIES.md](RESPONSIBILITIES.md)) | The scheduler hands them to the mission numbered |
| Use a tool, with its syntax | A skill's procedure ([SKILLS.md](SKILLS.md)) | The organ doing the work reads it before it runs a command |

A command written into a narrative goes stale when the command changes. For a skill's own commands,
`tests/content/command-flags.test.mjs` checks the flags written in installed playbooks, but a
narrative should name the kind of work ("gather the logs"), not the command.

## Approval points: say where a person approves, and why

A playbook has no gate field. The planner places approval gates: a plan step of type `approval_gate`,
for a destructive or public action a person approves first (the step types are listed in
`agent/services/brain/prompt-assembly.mjs`). The checkpoint executor raises the gate and waits for the
decision (`agent/work/checkpoint-executor.mjs`). How approvals work is in the
[culture of work](../concepts/CULTURE_OF_WORK.md#who-approves-what).

So the playbook's sentence is what tells the planner where the gate goes. Name the point and the
reason:

- `p-release`: the approval between pre-flight and deploy is the part never to skip, because a
  release is hard to take back.
- `p-rollback` (`roles/devops-engineer/processes/p-rollback.json`): show exactly what will move, and get
  it approved unless the person already asked for that exact rollback.
- `p-plan`: when the work is consequential, show the design and get it approved before building.

The code's own backstop is narrow. When the brief marks a part of the work destructive or public and
the plan has no approval gate, the brain warns the cortex once, then accepts the plan as it is
(`agent/services/brain/actions/checkpoint-plan.mjs`). Beyond that warning the code adds no gate. The
rest is text: playbooks, role prompts, and the motor's own prompt and the careful-operations skill,
which have the motor stop and fail an irreversible step that no approval preceded (`prompts/motor.md`,
`skills/careful-operations/SKILL.md`).

Two more lines a playbook draws:

- **Read-only work says so, in the description too.** `p-audit`, `p-investigate`, `p-review` and
  `p-deploy-verify` each say they examine and never fix, and put "Read-only" in the one line every
  listing shows.
- **Memory work has no gates.** A mission fired by a memory-scoped responsibility may not open an
  approval gate (`agent/work/memory-scope.mjs`): nothing it does leaves memory.

## What makes a good playbook

- **One kind of work,** named by the work: Investigation, Release, Rollback.
- **A description that stands alone:** what the work is, when it applies, and its line ("Read-only:
  it measures and recommends, never fixes"), in under 200 characters.
- **A narrative of pattern and stance:** the order that works, what to watch for, what not to do,
  where the person approves. Honest about what has worked, not what might.
- **Nothing that belongs elsewhere:** no command syntax (skills), no identifiers or people
  (projects and memory), no secrets.
- **Keywords people would use,** as phrases. Matching is a plain substring test, so a short word
  matches inside longer ones: `add` matches "address", `plan` matches "explanation". Several playbooks
  can match one request; the hint informs the planner and decides nothing.
- **Lean.** Refine an existing playbook before adding a near-duplicate: the whole library rides on
  every cortex decision.
- **In the right package.** Generic's playbooks serve every instance; a role adds its own and never
  redefines generic's.

## Testing

1. **The tests.** `tests/content/packages.test.mjs` checks that each file parses, its `id` matches the
   file name and the id pattern, `name`, `description` and `narrative` are present, `status` is
   `active`, `intent_keywords` is a list of phrases, no role reuses a generic id, and every
   responsibility's `processRef` names a playbook in generic or the role.
   `tests/content/content-hygiene.test.mjs` and `tests/content/command-flags.test.mjs` read playbooks
   too.
2. **On a dev instance.** After `node dev/deploy.mjs <branch>`, send a request worded the way people
   ask for that work: `node dev/say.mjs "<request>"`. `node dev/logs.mjs brain` shows
   `[checkpoint_plan] playbook match:` with the ids that matched, and the mission's
   `recalled_processes` field (`node dev/query.mjs work --doc <mission>`) records them. Then judge the
   plan in the dashboard's mission page: did it keep the order and the approval point?

## Checklist

- [ ] One kind of work, not covered by an existing playbook
- [ ] `id` matches the file name, starts `p-`, and is not one of generic's
- [ ] The description says what, when, and the read-only line if there is one, in under 200 characters
- [ ] The narrative leads with the stance, gives the order in prose, and names where a person
      approves and why
- [ ] No command syntax, identifiers or secrets
- [ ] Keywords are phrases people use, checked against words they occur inside
- [ ] `status` is `active`
