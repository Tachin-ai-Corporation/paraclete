# Skill: Memory Recall

## When to use

When the cortex asks temporal-memory to recall what is relevant to a request. The brain gathers the
raw material from every memory layer and from past work, and temporal-memory turns it into one focused
context packet.

## How recall works

On the recall path temporal-memory has no tools and makes one model call: it is a pure synthesizer.
The brain does all the retrieval first, deterministically, and puts the results in the prompt between
`--- PRE-LOADED MEMORY DATA ---` markers. Recording and consolidating memory is the other mode of the
same organ, with tools; see the memory-consolidate skill.

### What is pre-loaded

| Source | What it holds |
|---|---|
| Working memory | `MEMORY.md`: the most current operational state |
| Core Memory | Entries matching the request plus a recent scan, deduplicated, ranked by value |
| Recent work | The last 7 days of missions in every outcome (complete, failed, blocked, needs input, cancelled), grouped by day, each with its outcome, a short reason and its mission id. Failures are included on purpose: they carry the most learning |
| Matching work | Missions matching cues taken from the request: 30 days back, or 180 on escalation. Failed and blocked ones rank below completed ones |
| Known resources | Names already resolved to identifiers (Drive folders, documents, Chat spaces): this mission's own captures plus the `resources` category of Core Memory, one line each, matches first |

Recall works at the level of missions and outcomes. A per-task post-mortem of one failed mission (its
attempts, tool errors and timings) is an investigation task for the motor through the work-management
skill (`work-log-read --mission <id>`), not something recall pre-loads.

### Scope

| Scope | Window | When |
|---|---|---|
| targeted (default) | 30 days of matching work | Most requests |
| deep | 180 days of matching work | After an escalation, or when the caller asks |

## Building the packet

### First pass: assess and construct

1. Understand what facts the request needs.
2. Judge each candidate: genuinely relevant, or only a keyword match?
3. Merge the relevant items into one focused packet, citing work by envelope id and date.
4. Or escalate: if answering needs work history older or broader than the candidates, return exactly
   this and nothing else:

   ```json
   {"recall_escalate": true, "cues": ["refined", "search", "terms"], "reason": "Need older deployment history"}
   ```

   Never guess or fabricate instead; the brain fetches deeper history and asks again.

### Second pass, after an escalation: construct only

You get the expanded candidates, deep history included. Build the final packet. There is no second
escalation.

## Principles

- **Identifiers travel verbatim, always.** When the candidates hold a known resource, carry it into the
  packet character for character, with the name it maps to, binned `verified`. An id is never
  paraphrased, shortened or dropped for brevity: a half-remembered id is worse than none, and a missing
  one costs a search the agent already did. If an identifier is even plausibly relevant, include it.
  This is the one place completeness beats concision.
- **Surface what is relevant, not everything.** Recall makes context smaller, not larger. The
  identifier rule is the deliberate exception.
- **Rank by value, then recency.** Core Memory entries carry an importance weight and come back
  value-ranked. Lead with the highest-value, most relevant facts and lessons, and drop low-signal
  noise. The packet is the pruned good part, not a transcript; every organ decides on what you rank.
- **Never fabricate.** If nothing matches, say so.
- **Frame failures forward.** A failed mission is an episode bound to its time and conditions,
  carrying a lesson (the obstacle that recurred, what to try differently), never a verdict on
  feasibility. Surface the lesson and state that the capability is not foreclosed. Never carry
  "consistently fails", "infeasible", "impossible" or "the tool can't" into the packet.
- **Cite work** by envelope id and date.
- **Stay in your lane.** No web search (temporal-research's job), no outside systems (the motor's).
- **One escalation per recall.** The brain enforces it.
- **Order:** recent context, then targeted matches, then filler.
- **Structure the packet** in clear sections: Working memory, Core Memory, Work history, Known
  resources.

## Reading Core Memory directly

With the memory tools (during consolidation), read Core Memory with:

- `core-memory-read [--query "<terms>"] [--category <category>] [--status active] [--since <Nd>] [--limit <n>]`
  - `--query` matches terms against each entry's fact and tags, and matching entries rank higher;
    `--category` narrows to one category (`all` means every category); `--status` is `active` (the
    default), `superseded` or `retired`; `--since 30d` keeps entries created in the last 30 days;
    `--limit` defaults to 10.
  - Output: the entries ranked by value (importance × confidence × (1 + matched terms)), newest first
    on a tie, each with its id, category, fact, tags and weights.
  - Categories in use: `architecture`, `operations`, `iam`, `decisions`, `patterns`, `errors`,
    `resources`. `resources` is the name-to-id lookup table.
  - An empty result is usually a filter that matched nothing, not an empty memory. Read again without
    `--category` before concluding memory has nothing.
