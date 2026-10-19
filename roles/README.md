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
                          skills: [...]       the role's own skills, in skills/ (every one there is installed)
                          gcp_roles: [...]    granted to the agent's service account at install, on the project
                          apis: [...]         Google APIs the installer turns on, by short name (optional)
                          resource_roles: [{ role, on }]
                                              grants on one resource each, never the project (optional)
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

## What a role is granted

`install/install.sh` reads three fields of `generic`'s and the role's `role.json` (step 1 checks them with
`install/lib/role-access.mjs`, which `tests/content/packages.test.mjs` runs on every role too):

| Field | What the installer does | Rules |
|---|---|---|
| `gcp_roles` | Grants each to `paraclete-agent@` on the project (step 3) | Least privilege: only what the role's work needs. Never a basic role or one that hands out access. Never a role that acts as any service account or writes to any image repository (`roles/iam.serviceAccountUser`, `serviceAccountTokenCreator`, `serviceAccountOpenIdTokenCreator`, `workloadIdentityUser`; `roles/artifactregistry.writer`, `repoAdmin`, `admin`, `createOnPushWriter`, `createOnPushRepoAdmin`): project-wide, those reach the dashboard's account, whose signature the VM obeys, and its images. The installer refuses a role that asks for one, and takes back one it finds the agent holding |
| `apis` | Turns each on (step 2), with every instance's own; never turns one off, also after a move | Short names: `bigquery` is `bigquery.googleapis.com` |
| `resource_roles` | Grants each on one resource that is the agent's own (step 3) | `on` is `agent-account`: the agent's service account itself, so it may act as itself and no other (`roles/iam.serviceAccountUser` or `serviceAccountTokenCreator`); or `agent-repository`: the Docker repository `agent-images` in the instance's region, which the installer creates the first time a role asks for it (`roles/artifactregistry.reader`, `writer` or `repoAdmin`; not `admin`, which would change who may read it) |

A move to another role (a developer path, `install/README.md`) takes back the previous role's
`gcp_roles` and `resource_roles` that neither `generic` nor the new role declares; `agent-images` and its
images stay, and `install/uninstall.sh` deletes them only with `--purge`.

## Roles

| Role | Workspace | Adds to generic |
|---|---|---|
| [`generic`](generic/) | no | Nothing; this is the base |
| [`executive-assistant`](executive-assistant/) | yes | Calendar procedures, meeting briefs, a daily briefing (shipped turned off) |
| [`project-manager`](project-manager/) | yes | Agendas, minutes, an action tracker, status reports |
| [`finance-analyst`](finance-analyst/) | yes | Billing analysis from the Cloud Billing export, with the `billing-query` command; BigQuery Job User |
| [`legal-advisor`](legal-advisor/) | yes | Legal review and redlining as comments or a copy, obligations and deadlines |
| [`designer`](designer/) | yes | Design-system procedures, accessibility checks with the `contrast-check` command |
| [`devops-engineer`](devops-engineer/) | no | gcloud, Cloud Build images (no Docker on the VM), Cloud Storage, Firebase Hosting; Cloud Run and Cloud Build roles, and act-as and image push only on its own account and its own `agent-images` repository; a weekly read-only Cloud Run review |
| [`software-engineer`](software-engineer/) | no | Coding with tests, code review, GitHub pull requests through `gh` |
| [`qa-engineer`](qa-engineer/) | no | Test runs reported as evidence, baselines, flaky tests, defect reports |
| [`data-engineer`](data-engineer/) | no | BigQuery with dry runs and byte caps, loads through staging; BigQuery User and Data Editor |
| [`security-engineer`](security-engineer/) | no | A read-only IAM and exposure audit; Security Reviewer, Cloud Asset Viewer, Org Policy Viewer and Storage Bucket Viewer; a weekly security review |
| [`web-master`](web-master/) | no | Firebase Hosting changes through preview channels, custom domains, site audits with Lighthouse, read-only gcloud |
| [`paraclete-h2`](paraclete-h2/) | no | Dual-loop harness evolution (`harness-cycle`), Stage 1/2 benchmark evaluation and failure harvesting (`harness-eval`), and Pareto promotion gate verification (`harness-promote`) |

## Status

`generic/` is complete. Build plan phase 8 adds the other roles. Done: the Workspace roles
(`executive-assistant`, `project-manager`, `finance-analyst`, `legal-advisor`, `designer`), and the roles
without a Workspace account (`devops-engineer`, `software-engineer`, `qa-engineer`, `data-engineer`,
`security-engineer`, `web-master`, `paraclete-h2`). A role's `setup.npm` and `setup.pip` packages are pinned to exact
versions and installed by `install/bootstrap.sh` (npm globally as root, pip for the `paraclete` user;
`install/README.md` says why).
