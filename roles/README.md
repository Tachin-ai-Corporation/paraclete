# roles/

One package per role. Each instance has exactly one role, chosen at install. `generic` is the
default and the base of every role: an instance always gets `generic` plus its chosen role.

**Installed:** `generic` and the chosen role.

## Package shape

```
roles/<id>/
  README.md               what the role is for, for people reading the repo
  role.json               id, title, summary, version,
                          workspace: true | false,
                          skills: [...]       added to the base skills
                          gcp_roles: [...]    granted to the agent's service account at install
                          setup: { apt, pip, npm }
  prompts/<organ>.md      domain rules appended to that organ's base prompt (optional)
  responsibilities.json   scheduled work the role starts with
  processes/              playbooks the role starts with
  memory.md               the agent's first working memory
  skills/<id>/            skills only this role uses
```

## Rules

- A role is a focus plus a few heavier tools. It is not a different agent.
- Role prompts hold domain rules only, for example "a deploy passes only on a live 2xx".
- `workspace: true` means the role needs its own Google Workspace account. The dashboard then walks
  an admin through domain-wide delegation, and the agent gets Google Chat and the Workspace skills.
- Prompts, processes, responsibilities and skills here are agent-facing product text.

## Status

`generic/` describes the base role. Its package files arrive in build plan phase 4; the other roles
arrive in phase 8.
