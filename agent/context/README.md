# agent/context/

What goes into a model call, and how it stays small.

**Belongs here:** prompt blocks ordered stable-first for caching, compaction of mission history,
memory windows, conversation context, and tool records: large tool results stored by reference and
digested into the prompt.
**Doesn't:** the model call itself (`gateway/`) or where data is stored (`storage/`).

**Status:** empty. Arrives in build plan phase 2.
