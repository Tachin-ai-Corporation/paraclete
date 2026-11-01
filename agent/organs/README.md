# agent/organs/

The brain's organs, one directory each, holding what is that organ's own: the code that decides
what it does and how its answers are read, so a change to one organ is a change to its directory.
Each directory is one module of the self-improvement loop (`dev/loop/modules.json`): a lane that
improves the organ changes only its files.

| Organ | Its job | Directory |
|---|---|---|
| cerebellum | Verifies each checkpoint and the final answer, and owns the verdict | [cerebellum/](cerebellum/README.md) |
| temporal-memory | Builds the recall packet a mission starts from, and writes the lessons a mission leaves | [temporal-memory/](temporal-memory/README.md) |

The other organs (cortex, prefrontal, motor, temporal-research) still live where the
brain's pipeline puts them; they move here one at a time (`docs/plan/MODULAR_LOOPS.md`, phase 2).

**What belongs here:** an organ's own decisions, with what they need passed in: how it is asked (its
instruction text), how its answer is read, and the rules it applies. **What does not:** the mission
loop, the executor, prompt assembly, the gateway's turns and tools, which move data between organs and
stay in `services/`, `work/` and `gateway/`; and the organ's base prompt, which is in `prompts/` until
every organ has a directory here.

**Rules** (`tests/repo/boundaries.test.mjs`):

- An organ imports `work`, `context`, `files`, `storage`, `providers`, `auth` and `release`, never
  another organ: what organs hand each other passes through the spine.
- Only `services/` imports an organ, and `cli/` for an organ's own commands (the memory organ's
  `core-memory-read` ranks with it). `work/` never does: the brain service hands the executor what it
  needs (the cerebellum's `verifyMilestone`, for one).

**Installed:** yes, with the rest of `agent/`.
