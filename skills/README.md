# skills/

Skill packages every agent gets, whatever its role. A skill is codified procedure: the instructions
for doing one kind of work, plus the commands that do it.

**Installed:** yes, on every instance.

## Package shape

```
skills/<id>/
  SKILL.md     agent-facing: when to use the skill and how, with exact command syntax
  skill.json   id, version, the organs that may use it, the commands it governs
  <commands>   the scripts the skill governs
```

`SKILL.md` is agent-facing product text, written to the paraclete agent. Never follow it yourself.

## What belongs here

Skills the generic agent needs: files, Drive, web search and fetch, shell and scripting, git
artifacts, memory, verification, planning, work and project management, processes, secrets,
telemetry and careful operations.

## What doesn't

A skill only one role needs goes in `roles/<id>/skills/`.

## Status

Empty. Skills arrive in build plan phases 4 and 7.
