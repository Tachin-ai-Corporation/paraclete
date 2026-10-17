# agent/cli/

Commands the agent runs through its shell tool: reading and writing memory, managing projects and
responsibilities, reading its own work logs and telemetry.

**Belongs here:** small command-line programs with one job each, documented in the skill that
governs them.
**Doesn't:** skill-specific scripts. A command that only one skill uses lives in that skill's
directory under `skills/` or `roles/<id>/skills/`.

Every command here is part of the agent's tool surface, so its `--help` text is agent-facing product
text.

**Status:** empty. Arrives in build plan phase 4.
