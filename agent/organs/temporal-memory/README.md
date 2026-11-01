# agent/organs/temporal-memory/

The memory organ (temporal-memory): it builds the recall packet a mission starts from, out of the
candidates code gathers, and writes the lessons a finished mission leaves. With its memory tools it
also consolidates memory, in the nightly upkeep.

| File | What it does |
|---|---|
| `memory.mjs` | The brain's half of memory: the working-memory and Deep Truths files, recall (gathering the candidates, asking the organ for the packet, one escalation for deeper history), the mission line, and the lessons after a mission |
| `work-recall.mjs` | Recall of the agent's past work: the cues a request carries, the last week's digest, and matching past missions |
| `core-memory-rank.mjs` | How Core Memory entries rank against a search, for recall and `core-memory-read` |
| `context-maintenance.mjs` | The lesson step after a mission that worked in a project or followed a process: what it asks the organ, and how its answer is checked |

**Called by:** the brain service (`agent/services/brain/main.mjs` builds memory; `intake.mjs` reads
the cues and the week's digest), and `agent/cli/core-memory-read.mjs`.

**Also the memory organ's, elsewhere for now:** its base prompt (`prompts/temporal-memory.md`), its
skills (`skills/memory-recall/`, `skills/memory-consolidate/`), its commands in `agent/cli/` (the
Core Memory and Deep Truths commands, `session-summary`), and the memory-only fence the executor
enforces (`agent/work/memory-scope.mjs`, which `agent/work/` keeps since the executor imports it). Its
module in `dev/loop/modules.json` names what a lane may change.

**Tests:** `tests/agent/organs/temporal-memory/`.
