# Paraclete

Paraclete is one capable AI agent for one Google Cloud project. A project owner installs it with a
single command. It gets its own dashboard, open to the people in the owner's Google Workspace, and it
does real work: research, analysis, writing, files and scheduled duties. Every step is planned,
executed and checked by an independent verifier.

> **Status: in development.** It installs from its releases. The build plan,
> [docs/plan/BUILD_PLAN.md](docs/plan/BUILD_PLAN.md), says what is done and what comes next.

## How it works

- **One project, one agent.** Everything paraclete needs lives in the project it is installed in: a
  VM for the agent, a dashboard on Cloud Run, Firestore and one storage bucket.
- **One role, chosen at install.** `generic` is the default. Other roles add a focus and a few tools.
  Roles flagged `workspace` also give the agent its own Google Workspace account.
- **Files in, files out.** Share files with it through the dashboard, a link, Cloud Storage, git or
  Google Drive. It hands back standard files as dashboard downloads.
- **Gemini by default.** Claude is an optional upgrade.
- **Upgrades from releases.** The dashboard shows new releases and installs one with a click.

## Install

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/Tachin-ai-Corporation/paraclete&cloudshell_git_branch=main&cloudshell_workspace=.&cloudshell_open_in_editor=docs/INSTALL.md)

You need a Google Cloud project inside your organization, with billing turned on, and owner rights on
it. The button opens Google Cloud Shell with this repository cloned and the install guide open. Then
run, with your project's id:

```
gcloud auth login
install/install.sh --project your-gcp-project
```

The first command logs Cloud Shell in as you: Google opens a repository it does not own without your
credentials. The installer asks for the agent's role and name, sets up the project, waits until the
agent is ready, and prints the dashboard's address. [docs/INSTALL.md](docs/INSTALL.md) is the full
guide: what each step does, signing in and adding people, updates, Claude, removing paraclete, and what
to do when a step fails.

## Repository map

| Path | What it holds |
|---|---|
| `dashboard/` | The web dashboard (Next.js on Cloud Run) |
| `agent/` | Code that runs on the agent's VM |
| `prompts/` | Organ prompts: how each part of the agent's brain thinks |
| `skills/` | Skill packages every agent gets |
| `roles/` | One package per role, starting with `generic` |
| `config/` | `contracts.json`, the single source for shared values |
| `install/` | Installer, uninstaller, VM bootstrap and install manifest |
| `migrations/` | Data migrations a release carries, run by the upgrade |
| `docs/` | Build plan, glossary, product rules and guides |
| `tests/` | Every test; `npm test` runs them all |
| `dev/` | Tools for developing this repo; never installed |

Every directory has a `README.md` that says what belongs in it and what doesn't.

## Working on this repo

Read [DEVELOPING.md](DEVELOPING.md) first. It applies to people and AI agents alike.

## License

[MIT](LICENSE)
