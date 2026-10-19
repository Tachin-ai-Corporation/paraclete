# docs/canon/

The canon is the set of rules paraclete keeps whatever else changes. Read it before you design a
change, and when you review one. A change that breaks a rule here is not an improvement, however much
it helps elsewhere: either the change gives way, or the rule changes on purpose, in the same commit,
with the code that keeps it.

| Doc | Holds | Read it before |
|---|---|---|
| [PRODUCT.md](PRODUCT.md) | The product rules, P-1 to P-30: what an instance is, configuration, install and upgrade, the fences around the agent, the dashboard boundary, and the work model | Any change to the product |
| [BRAIN.md](BRAIN.md) | The qualities of the agent's brain, B-1 to B-25: the deterministic machine, its organs, verification, durable work, context and memory, and how the agent speaks | Any change to `agent/`, `prompts/` or `skills/` that alters how the agent thinks or works |

**Installed:** no.

## How the canon is written

- **Each rule says three things:** the rule, why it exists, and where the code keeps it, as repo paths
  you can open. A rule nothing enforces says so, and so does a fence that rests on a prompt alone.
- **Only what the code does.** A rule describes the product as it is. Something planned, or known to be
  missing, is not a rule: it lives in [plan/OPEN_ITEMS.md](../plan/OPEN_ITEMS.md) until the code has it.
- **Its own numbers.** P-*n* and B-*n* are this repo's numbers. Reviews and commit messages may cite
  them; the agent-facing text in `prompts/`, `skills/` and `roles/` never does, and states its rules in
  plain words instead (`tests/content/content-hygiene.test.mjs` checks).
- **Product words mean what [GLOSSARY.md](../GLOSSARY.md) says.** An organ's name comes with its plain
  job the first time it appears.

## Changing a rule

A rule changes the way code changes: in a commit, reviewed, with the code that keeps the new rule.
The commit says which rule it adds, changes or retires, and why the product is still what
[the build plan](../plan/BUILD_PLAN.md) says it is. When code changes what a rule describes, the rule
changes in the same commit ([docs/README.md](../README.md), "Rules").

A number names one rule for good. A retired rule keeps its number and heading, marked retired, with the
reason; a new rule takes the next free number in its document.

## What the canon is not

- **Not the how.** How work moves through requests, missions, checkpoints and tasks is
  [concepts/CULTURE_OF_WORK.md](../concepts/CULTURE_OF_WORK.md); what belongs in a prompt, a skill, a
  process or a project is [concepts/MODULE_CHARTER.md](../concepts/MODULE_CHARTER.md); writing roles,
  skills, processes and responsibilities is in [guides/](../guides/README.md).
- **Not the development workflow.** Branches, commits, dev instances and the verification ladder are in
  [DEVELOPING.md](../../DEVELOPING.md).
- **Not a format reference.** Each package's README defines its own format; the canon links to it.
