# roles/generic/

The base role. Every instance gets it; a chosen role adds to it.

| Part | Generic |
|---|---|
| Purpose | A general-purpose agent for its organization. It researches, analyzes, writes, builds and converts files, runs scheduled work, and keeps its own memory. |
| Channel | Dashboard chat |
| Skills | The base skills in `skills/`. Generic adds none of its own. |
| Organ prompts | The base prompts in `prompts/`, with no domain additions |
| Responsibilities | Nightly memory consolidation; weekly cleanup of the git artifact store |
| GCP roles | The agent's base set only: Vertex AI, Firestore, its bucket, logging and metrics, and secrets the dashboard grants. No project-wide admin. |
| Workspace | No. Drive works through the agent's service account. |

**Status:** described here; the package files arrive in build plan phase 4.
