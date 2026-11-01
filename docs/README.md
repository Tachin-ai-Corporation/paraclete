# docs/

Paraclete's documentation: how to install it, the rules every change keeps, how the agent works, and
how to write the packages it runs on. Project owners read [INSTALL.md](INSTALL.md); the rest is for
developers of this repo, human or AI. Find the row that matches your question.

| Question | Doc |
|---|---|
| How do I install paraclete, add people, update it, turn on Claude or remove it? | [INSTALL.md](INSTALL.md) |
| What does a product word mean? | [GLOSSARY.md](GLOSSARY.md) |
| What rules does every change keep? | [canon/PRODUCT.md](canon/PRODUCT.md) |
| What qualities must the agent's brain have? | [canon/BRAIN.md](canon/BRAIN.md) |
| How does the agent turn a request into checked work: missions, checkpoints, tasks and approvals? | [concepts/CULTURE_OF_WORK.md](concepts/CULTURE_OF_WORK.md) |
| Does this belong in an organ prompt, a skill, a process, a project, a role package or the memory? | [concepts/MODULE_CHARTER.md](concepts/MODULE_CHARTER.md) |
| How do I write a role package? | [guides/ROLES.md](guides/ROLES.md) |
| How do I write a skill? | [guides/SKILLS.md](guides/SKILLS.md) |
| How do I write a process playbook? | [guides/PROCESSES.md](guides/PROCESSES.md) |
| How do I give the agent scheduled work? | [guides/RESPONSIBILITIES.md](guides/RESPONSIBILITIES.md) |
| What are we building, and in what order? | [plan/BUILD_PLAN.md](plan/BUILD_PLAN.md) |
| What did an earlier phase leave for a later one? | [plan/OPEN_ITEMS.md](plan/OPEN_ITEMS.md) |
| How will the self-improvement loop work on several modules at once? | [plan/MODULAR_LOOPS.md](plan/MODULAR_LOOPS.md) |
| How do I work on this repo? | [../DEVELOPING.md](../DEVELOPING.md) |

**Installed:** no.

## Layout

| Path | Holds | Read by |
|---|---|---|
| [INSTALL.md](INSTALL.md) | Installing and looking after an instance | Project owners |
| [GLOSSARY.md](GLOSSARY.md) | Every product term, defined once | Everyone |
| [canon/](canon/README.md) | The product rules and the brain's qualities, and how either changes | Anyone designing or reviewing a change |
| [concepts/](concepts/README.md) | How work is done, and what belongs where | Anyone changing the agent or the content it runs on |
| [guides/](guides/README.md) | How to write roles, skills, processes and responsibilities | Anyone adding or changing one of those packages |
| [plan/](plan/BUILD_PLAN.md) | The build plan, and what one phase leaves for a later one | Anyone deciding what to build next |

## Rules

- Docs describe the product as it is. When code changes behavior, the doc changes in the same commit.
- Each fact lives in one doc. Others link to it.
- Docs are written for readers with no context: define terms through the glossary, and say where
  things live.
- A doc names the code it describes by its repo path in backticks, and links to other docs with
  relative links. `tests/repo/docs.test.mjs` fails on a relative link in any Markdown file that leads
  nowhere in the repo or to a heading the file does not have, and on a backticked repo path in `docs/`
  or any `README.md` that the repo does not have.
