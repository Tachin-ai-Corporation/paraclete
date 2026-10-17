# skills/

Skill packages every agent gets, whatever its role. A skill is codified procedure: the instructions
for doing one kind of work, plus the commands that do it.

**Installed:** yes, on every instance.

## Package shape

```
skills/<id>/
  SKILL.md         agent-facing: when to use the skill and how, with exact command syntax
  skill.json       { id, name, version, when_to_use, organs, commands }
  <command>.mjs    a command only this skill governs: Node, `#!/usr/bin/env node`, exporting
                   main(argv, deps) like the commands in agent/cli/
```

`SKILL.md` is agent-facing product text, written to the paraclete agent. Never follow it yourself.

In `skill.json`, `organs` names the organs that use the skill (`cortex`, `prefrontal`, `motor`,
`cerebellum`, `temporal-memory`, `temporal-research`) and `commands` names every command the skill
documents and governs: either a file here, or a shared command in `agent/cli/<command>.mjs`. The
gateway's skill index (`agent/gateway/skill-catalog.mjs`) reads `id`, `name`, `when_to_use` and
`organs`, and shows each tool-using organ the path of every SKILL.md. Keep the first sentence of
`when_to_use` short: it is the skill's one-line capability. `tests/content/` checks every package.

## What belongs here

Skills the generic agent needs: files, Drive, web search and fetch, shell and scripting, git
artifacts, memory, verification, planning, work and project management, processes, secrets,
telemetry and careful operations.

## What doesn't

A skill only one role needs goes in `roles/<id>/skills/`.

## Skills

| Skill | Organs | Commands | For |
|---|---|---|---|
| `memory-recall` | temporal-memory | `core-memory-read` | Building the recall packet from pre-loaded memory |
| `memory-consolidate` | temporal-memory | `core-memory-read`, `core-memory-write`, `core-memory-retire`, `update-deep-truths`, `session-summary` | The nightly consolidation of the three memory layers |
| `plan-structuring` | prefrontal | none | The checkpoint plan schema and its rules; the brain hands it to the prefrontal |
| `verification` | cerebellum | none (the verdict tools are the gateway's) | The graded verdict and its evidence standard |
| `work-management` | motor | `responsibility-manage`, `project-manage`, `work-log-read`, `work-output-read`, `task-log-read` | Responsibilities, projects, and reading past work |
| `git-artifacts` | motor | `work-status`, `work-diff`, `work-log`, `work-commit`, `work-sync`, `work-clone` (here); `git-store` | Mission working trees and the git artifact store |
| `git-repos` | motor | none (plain `git`) | Outside git repositories |
| `web-search` | temporal-research | `web-search`, `web-fetch` (here) | Grounded web search and reading pages |
| `secrets` | motor | `secret-read` (here) | Using a Secret Manager secret without revealing it |
| `processes` | motor | `process-ops` | Process playbooks |
| `telemetry` | motor | `brain-telemetry-read`, `agent-status` | Organ-turn telemetry and the instance's status |
| `system-shell` | motor | none | General command-line work and safe file edits |
| `scripting` | motor | none | Bash and Python scripts |
| `careful-operations` | motor | none | The method for unfamiliar or irreversible operations |

The `files` and `drive` skills arrive in build plan phase 7.
