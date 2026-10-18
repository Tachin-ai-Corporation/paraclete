# roles/designer/

A Workspace role: an agent that gives the organization's materials a clear, consistent and accessible
look. It builds and documents design systems, designs presentations and documents from them, audits
several deliverables for consistency, and checks the accessibility of everything it delivers.

| Part | Designer |
|---|---|
| Purpose | Design systems and brand guides, presentations and documents, consistency audits, accessibility reviews |
| Channel | Dashboard chat, and Google Chat once the Workspace account is set up |
| Skills | The base skills, the Workspace skills, `design-system`, and `accessibility-checks` with its `contrast-check` command (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): accessibility is part of done; use the organization's system, and never invent brand values silently; hierarchy before decoration and structure before polish; others' files are sources |
| Responsibilities | None at install (below) |
| GCP roles | None beyond the generic base set: every Workspace API is reached as the agent's own account |
| Workspace | Yes. The agent needs its own Google Workspace account, set up by a dashboard admin in the dashboard after install: create the user, grant domain-wide delegation in the Admin console, then test it |

## The Workspace account

Slides, Docs and Drive run as the agent's own Google account, through domain-wide delegation to
`paraclete-dwd@<project>.iam.gserviceaccount.com`, which a dashboard admin sets up after install with
the dashboard's setup wizard. With it the agent reads brand assets shared with its address and creates
Google Slides decks and Docs in its own Drive. Until then it works with files dropped into chat and
delivers .pptx, .docx, .pdf and .html files.

## Accessibility checks

"Accessibility is part of done" is enforced three ways: the cortex puts the checks into every design
checkpoint's acceptance criteria, the motor runs them before it reports a deliverable done, and the
cerebellum fails a design delivered without their evidence. The floor is based on WCAG 2.2 level AA
(contrast, text size, alternative text, structure, reading order, links, PDFs tagged, color never the
only signal). The checks run on the generic toolchain: renders through LibreOffice and Chromium,
pixel sampling with ImageMagick, `pdfinfo` and `pdffonts` for PDFs, and the slide and document XML.

`skills/accessibility-checks/contrast-check.mjs` computes the WCAG contrast ratio of color pairs
deterministically, so no ratio is judged by eye. It prints each pair's ratio, truncated rather than
rounded up, with its verdict for normal text, large text, AAA and non-text elements; `--require <level>`
exits 1 when a pair falls short, and `--pairs` checks a whole palette from a JSON list. Its tests are in
`tests/roles/designer/skills/accessibility-checks/contrast-check.test.mjs`.

An automated rule engine such as axe-core is not included: it would add npm packages and a browser
driver to every designer instance, while these checks need only the generic toolchain. Keyboard use and
screen-reader output cannot be tried from the VM, and the skill reports them as not checked.

## Workspace skills it relies on

Base skills in `skills/` that every Workspace role gets. The role's skills name their commands and
leave their syntax to them.

| Skill | Commands used |
|---|---|
| `workspace-slides` | `slides-get`, `slides-create` |
| `workspace-docs` | `docs-get`, `docs-create` |
| `drive` | `drive-find`, `drive-export`, `drive-put` (the generic base) |

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: `workspace: true`, the `design-system` and `accessibility-checks` skills, no extra GCP roles, no extra packages |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/design-system/` | Finding the organization's system, a minimal system, tokens, the guide, designing presentations and documents, and consistency audits. No commands of its own |
| `skills/accessibility-checks/` | The accessibility floor, checks by medium (slides, documents, PDFs, web pages, charts), reporting and fixing; the `contrast-check` command |
| `responsibilities.json` | Empty, with the reason |
| `processes/` | `p-design-system`, `p-accessibility-review`, `p-presentation-design` |
| `memory.md` | The agent's first working memory |

## Why no responsibility ships

Design work comes from requests. A recurring check, such as an accessibility pass over a team's
templates, needs the templates named, which happens only after install; people who want one ask the
agent, which creates it as its own responsibility.

## Rules the role adds

- Every deliverable passes the accessibility checks before it is delivered, asked or not.
- Every visual value traces to a token of the organization's system or a stated reason; a new system is
  a proposal until a person approves it.
- Drive is a source and a destination: brand assets, templates and decks people shared are read as
  copies and never edited, moved, renamed, trashed or deleted. A revision is a new file the agent's
  account creates; it edits in place only files it created.
