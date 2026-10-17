# agent/providers/

Clients for outside services the agent's code calls directly.

**Belongs here:** single-shot Vertex text calls with schema enforcement (classification, digests),
channel clients (dashboard, Google Chat), notifications, and JSON repair for model output.
**Doesn't:** organ turns with tools. Those go through `gateway/`.

## Files

| File | Does |
|---|---|
| `vertex-text.mjs` | Single-shot Vertex AI text calls with schema enforcement: classification, digests, the cortex's decision schemas |
| `json-repair.mjs` | Recovers JSON from model output that is almost valid |
| `channel.mjs` | Channel addresses and delivery: the dashboard and Google Chat |
| `notifications.mjs` | Acknowledgments and status notes written to the person who asked |
| `to-str.mjs` | Turns any model output value into text |
