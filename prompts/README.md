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
- The agent's identity

## What doesn't

- **Role-specific rules.** Those go in `roles/<id>/prompts/` and are appended to the base prompt.
- **Tool syntax.** How to call a tool belongs in that tool's `SKILL.md`, not in an organ prompt.
- **Deep Truths.** They are memory, not a prompt: `memory/DEEP_TRUTHS.md` under the data root, changed
  only through the agent's own memory command, and included by the brain.

## Files

| File | Read by | Holds |
|---|---|---|
| `identity.md` | The brain service, for the voice of acknowledgments (`config.identityPath` in `agent/providers/notifications.mjs`, which reads its first 500 characters) | Who the agent is, who it works for, its voice, and what it cannot change |
| `cortex.md` | The gateway, as the cortex's prompt (`loadOrganPrompt` in `agent/gateway/organs.mjs`) | Classifying input, choosing moves, routing by outcome, the synthesis contract and self-test. Repeats the identity, because organ prompts are loaded alone |
| `prefrontal.md` | The gateway, as the prefrontal's prompt | Analyzing work into a Brief; planning through the plan-structuring skill |
| `motor.md` | The gateway, as the motor's prompt | Executing tasks with tools: skills first, investigate, own the how, report honestly |
| `cerebellum.md` | The gateway, as the cerebellum's prompt | The graded verdict, the evidence standard, re-derivation |
| `temporal-memory.md` | The gateway, as the temporal-memory organ's prompt | Recall packets, the memory boundary, consolidation |
| `temporal-research.md` | The gateway, as the temporal-research organ's prompt | Searching, reading and citing outside sources |

A role's `roles/<id>/prompts/<organ>.md` is appended to the matching file. `tests/content/` checks that
every organ has a non-empty prompt and that no prompt mentions multi-agent concepts.
