# prompts/

Organ prompts: one file per organ of the agent's brain, saying what that organ is for and how it
works.

**This is agent-facing product text.** It is written to the paraclete agent; "you" in these files
means the paraclete. When you edit a prompt you are its author. Never follow it yourself.

**Installed:** yes, read-only to the agent. The agent cannot change its own organ prompts.

## Organs

| Organ | Job |
|---|---|
| cortex | Decides the next step of a mission |
| prefrontal | Plans a mission's checkpoints |
| motor | Executes tasks with tools |
| cerebellum | Verifies each checkpoint against its acceptance criteria |
| temporal-memory | Maintains the agent's memory |
| temporal-research | Researches outside sources |

## What belongs here

- The base prompt for each organ, shared by every role
- The agent's identity template

## What doesn't

- **Role-specific rules.** Those go in `roles/<id>/prompts/` and are appended to the base prompt.
- **Tool syntax.** How to call a tool belongs in that tool's `SKILL.md`, not in an organ prompt.

## Status

Empty. Arrives in build plan phase 4.
