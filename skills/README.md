# skills/

Skill packages every agent gets, whatever its role. A skill is codified procedure: the instructions
for doing one kind of work, plus the commands that do it.

**Installed:** yes, on every instance.

## Package shape

```
skills/<id>/
  SKILL.md         agent-facing: when to use the skill and how, with exact command syntax
  skill.json       { id, name, version, when_to_use, organs, commands, requires? }
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

`requires` (optional) names what the instance must have for the skill's commands to work. The one
requirement is `workspace`: the agent's own Google Workspace account. On an instance without it the
gateway leaves the skill out of the organs' index, and control's `skills` view marks it
`unavailable`. The requirements are defined in `agent/context/skill-requirements.mjs`.

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
| `files` | motor | `file-get`, `file-read`, `file-convert`, `file-make`, `file-share` (here) | Taking files in from wherever they were shared, reading them as text, converting and making office files, PDFs and images, and handing results back as mission downloads |
| `drive` | motor, temporal-research | `drive-find`, `drive-get`, `drive-export`, `drive-put` (here) | Google Drive as the agent's own identity: finding shared files, downloading or exporting them into the mission, and handing results back as new Drive files |
| `secrets` | motor | `secret-read` (here) | Using a Secret Manager secret without revealing it |
| `processes` | motor | `process-ops` | Process playbooks |
| `telemetry` | motor | `brain-telemetry-read`, `agent-status` | Organ-turn telemetry and the instance's status |
| `system-shell` | motor | none | General command-line work and safe file edits |
| `scripting` | motor | none | Bash and Python scripts |
| `careful-operations` | motor | none | The method for unfamiliar or irreversible operations |

## Workspace skills

Every Workspace role gets these: they carry `"requires": ["workspace"]`, so they are installed on
every instance but shown to the agent only when it has its own Workspace account. Each command acts
as that account through domain-wide delegation, with only the scopes of the API it calls
(`agent/auth/workspace-scopes.mjs`); the API clients are `agent/providers/workspace*.mjs`. The Drive
rule holds in all of them: a file someone shared is read, commented on or copied into a new file,
never edited, moved, renamed, trashed or deleted; the agent changes in place only files its own
account owns, and the commands that do check ownership first.

| Skill | Organs | Commands | For |
|---|---|---|---|
| `workspace-calendar` | motor, temporal-research | `cal-list`, `cal-get`, `cal-freebusy`, `cal-create`, `cal-update` (here) | Calendars, people's free and busy times, and events on the agent's own calendar; invitations only for the people a request names, and never an answer to one |
| `workspace-gmail` | motor, temporal-research | `gmail-search`, `gmail-get` (here) | Searching and reading the agent's own mailbox, and attachments into the mission; read only |
| `workspace-docs` | motor, temporal-research | `docs-get`, `docs-create`, `docs-comment`, `docs-replace` (here) | Docs as Markdown or text, comments, new Docs from Markdown, and in-place edits of the agent's own Docs |
| `workspace-sheets` | motor, temporal-research | `sheets-get`, `sheets-create`, `sheets-append`, `sheets-update` (here) | Sheets read cell by cell, new Sheets from CSV, and value writes into the agent's own Sheets |
| `workspace-slides` | motor, temporal-research | `slides-get`, `slides-create` (here) | Decks read slide by slide with their notes, and new decks from an outline |
