# agent/context/

What goes into a model call, and how it stays small.

**Belongs here:** prompt blocks ordered stable-first for caching, compaction of mission history,
memory windows, conversation context, and tool records: large tool results stored by reference and
digested into the prompt.
**Doesn't:** the model call itself (`gateway/`) or where data is stored (`storage/`).

## Files

| File | Does |
|---|---|
| `prompt-blocks.mjs` | Assembles prompts from blocks, most stable first, so providers cache the prefix |
| `compaction.mjs` | Keeps a mission's context bounded: checkpoint digests, mission digests, prior-work context |
| `tool-record.mjs` | The tool log every organ turn ends with, and large results stored by reference |
| `conversation-context.mjs` | The recent conversation a request came from |
| `thread-ledger.mjs` | The agent's record of each conversation thread and its turns |
| `work-recall.mjs` | Recalls relevant past work for a new request |
| `core-memory-rank.mjs` | Ranks Core Memory entries by value and matched search terms, for recall and `core-memory-read` |
| `context-maintenance.mjs` | The lesson step after a mission that worked in a project or followed a process |
| `history.mjs` | Appends status changes to an envelope's timeline |
| `skill-requirements.mjs` | What a skill may require of its instance (`requires: ["workspace"]`) and whether this instance has it: the gateway's skill index leaves out a skill that cannot work here, and control's `skills` view says why |
