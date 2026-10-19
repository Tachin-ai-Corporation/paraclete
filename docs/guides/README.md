# docs/guides/

How to write the packages the agent runs on: roles, skills, process playbooks and responsibilities.
These guides are for developers of this repo, human or AI, who add or change one of those packages.
Each builds on a format reference that already defines the package's fields, and adds what that
reference does not say: why the parts exist, what the code does with them, how to write them well,
and the mistakes to avoid.

**Installed:** no.

| Guide | Read it when you | Format reference it builds on |
|---|---|---|
| [ROLES.md](ROLES.md) | Add or change a role package: its grants, prompts, skills, playbooks, responsibilities and first memory, and its smoke test | [roles/README.md](../../roles/README.md) |
| [SKILLS.md](SKILLS.md) | Add or change a skill: its procedure, its commands and their tests | [skills/README.md](../../skills/README.md), [agent/cli/README.md](../../agent/cli/README.md) |
| [PROCESSES.md](PROCESSES.md) | Write a process playbook a role ships, or review one the agent wrote | The playbook fields `tests/content/packages.test.mjs` checks; the agent's own authoring in [skills/processes/SKILL.md](../../skills/processes/SKILL.md) |
| [RESPONSIBILITIES.md](RESPONSIBILITIES.md) | Ship scheduled work with a role, or review what the agent scheduled for itself | [agent/work/responsibility-schema.mjs](../../agent/work/responsibility-schema.mjs); the agent's own authoring in [skills/work-management/SKILL.md](../../skills/work-management/SKILL.md) |

Whether a piece of content belongs in a skill, a playbook, a role prompt, a project or memory is the
[module charter](../concepts/MODULE_CHARTER.md)'s question. Product words mean what
[the glossary](../GLOSSARY.md) says.

## What every package shares

- **It is agent-facing product text.** Prompts, `SKILL.md` files, playbooks and responsibilities
  are written to the paraclete agent: "you" in them means the agent. You are their author, and
  you never follow them yourself ([DEVELOPING.md](../../DEVELOPING.md), section 2).
- **It describes one agent.** `tests/content/content-hygiene.test.mjs` fails on agent-facing text
  in `prompts/`, `skills/` and `roles/` that speaks of other agents, teammates or a controlling
  agent, cites a rule by a canon id, or tells the agent to edit its own prompts.
- **It is template-clean.** No organization's names, people, project ids, addresses or Drive ids:
  every instance installs the same files, and the repo holds nothing of any one organization
  ([product rules](../canon/PRODUCT.md)). `tests/repo/hygiene.test.mjs` fails on an email address
  outside the placeholder domains and on anything in your private denylist
  ([DEVELOPING.md](../../DEVELOPING.md), section 6). What one organization needs belongs in that
  instance's projects, memory and own responsibilities, which the agent keeps at runtime, in
  Firestore and under its data root.
- **It needs no manifest entry.** `install/manifest.txt` installs `skills/`, `roles/generic/` and
  the instance's own role directory whole, so a new skill, playbook or responsibility file in those
  directories reaches the VM without a new line there.
- **It is tested in two places.** `npm test` runs the content tests on every package. What only a
  running agent shows is checked on a dev instance ([DEVELOPING.md](../../DEVELOPING.md),
  section 7), never on an instance someone relies on.
