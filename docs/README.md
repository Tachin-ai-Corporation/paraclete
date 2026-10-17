# docs/

Product documentation. Find the row that matches your question.

| Question | Doc |
|---|---|
| What are we building, and in what order? | [plan/BUILD_PLAN.md](plan/BUILD_PLAN.md) |
| What did an earlier phase leave for a later one? | [plan/OPEN_ITEMS.md](plan/OPEN_ITEMS.md) |
| What does a product word mean? | [GLOSSARY.md](GLOSSARY.md) |
| How do I work on this repo? | [../DEVELOPING.md](../DEVELOPING.md) |

**Installed:** no.

## Arriving as the build reaches them

| Doc | Holds |
|---|---|
| `canon/PRODUCT.md` | The product rules every change keeps |
| `canon/BRAIN.md` | The qualities the agent's brain must have |
| `concepts/CULTURE_OF_WORK.md` | Requests, missions, checkpoints and tasks, and the primitives around them |
| `concepts/MODULE_CHARTER.md` | What belongs in an organ prompt, a skill, a process or a project |
| `guides/` | How to write roles, skills, processes and responsibilities |
| `INSTALL.md` | Installing paraclete, for project owners |

## Rules

- Docs describe the product as it is. When code changes behavior, the doc changes in the same commit.
- Each fact lives in one doc. Others link to it.
- Docs are written for readers with no context: define terms through the glossary, and say where
  things live.
