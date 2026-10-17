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

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record. `gcp_roles` is the base set every instance's agent account gets on the project: `aiplatform.user`, `datastore.user`, `logging.logWriter`, `monitoring.metricWriter`. The bucket grant (object admin on the instance bucket only) and secret grants (one per secret) are not project roles, so the installer and the dashboard make them; its `_gcp_roles_comment` says so. `setup.apt` installs the command-line tools the base skills use |
| `responsibilities.json` | Two `locked` responsibilities: `r-memory-consolidation` (daily at 08:00 UTC, memory-scoped, following `p-memory-consolidate`) and `r-git-gc` (Sundays at 04:00 UTC, `git-store gc <projectId> main` for every project) |
| `processes/` | Playbooks every instance starts with: `p-audit`, `p-deploy-verify`, `p-investigate`, `p-memory-consolidate`, `p-plan`, `p-release`, `p-review` |
| `memory.md` | The agent's first working memory |

`tests/content/` checks that every responsibility validates against
`agent/work/responsibility-schema.mjs`, that every process parses, and that every `processRef` names a
playbook that exists.
