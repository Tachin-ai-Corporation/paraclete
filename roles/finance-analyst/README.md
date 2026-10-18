# roles/finance-analyst/

A Workspace role: an agent that analyzes what the organization spends on Google Cloud and keeps its
financial numbers honest. It reports costs, explains trends and spikes from the Cloud Billing export,
compares spending with budgets and invoices, and works through the spreadsheets and invoices people
share. It analyzes and recommends; it never moves money.

| Part | Finance Analyst |
|---|---|
| Purpose | Cloud cost reporting and investigation, budget and invoice comparisons, financial spreadsheets |
| Channel | Dashboard chat, and Google Chat once the Workspace account is set up |
| Skills | The base skills, the Workspace skills, and `billing-analysis` with its `billing-query` command (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): numbers trace to a source; never move money; recommend against a baseline; data has an as-of time; totals are re-added before anything passes |
| Responsibilities | None at install (below) |
| GCP roles | `roles/bigquery.jobUser` on the instance's project (below) |
| APIs | BigQuery, turned on by the installer |
| Workspace | Yes. The agent needs its own Google Workspace account, set up by a dashboard admin in the dashboard after install: create the user, grant domain-wide delegation in the Admin console, then test it |

## What the role can reach, and the grants behind it

Cost data comes from the **Cloud Billing export in BigQuery**, the one place Google Cloud publishes
billing data for queries. Reading it takes two grants, kept apart on purpose:

| Grant | On | Made by | Why |
|---|---|---|---|
| BigQuery Job User (`roles/bigquery.jobUser`) | The instance's project | The installer, from `gcp_roles` | Lets `billing-query` run query jobs in this project. It reads no data by itself |
| BigQuery Data Viewer | The export's dataset only | A billing admin, after install | Lets the agent read the export. The dataset usually lives in another project, which the installer cannot know |

Queries run in the instance's project, so its BigQuery API must be on: the installer turns it on (`apis`
in `role.json`). On an instance installed before it did, `billing-query` says when the API is off and
gives the command that turns it on.

Not granted: **Billing Account Viewer.** Google grants it only on a billing account, never on a
project, so the installer cannot give it, and the export already carries the cost data it would show.
Budgets come from people instead, as a number or a spreadsheet. The agent never changes billing
settings, budgets or resources, and holds no role that could.

For a billing admin, after install: in the Google Cloud console, Billing, "Billing export", "BigQuery
export", turn on "Standard usage cost" (and "Detailed usage cost" for per-resource costs) into a
dataset; then grant `paraclete-agent@<project>.iam.gserviceaccount.com` BigQuery Data Viewer on that
dataset, and tell the agent the dataset's name.

## The billing-query command

`skills/billing-analysis/billing-query.mjs` runs one read-only GoogleSQL query as the VM's service
account. It refuses anything but a single `SELECT` (or `WITH ... SELECT`) before calling BigQuery, dry
runs every query first, refuses one that would process more than the cap (10 GB by default, 200 GB at
most), and sends the same cap as `maximumBytesBilled`, so BigQuery itself stops a query from billing
more. Rows print as CSV or JSON. Its tests are in
`tests/roles/finance-analyst/skills/billing-analysis/billing-query.test.mjs`.

## Workspace skills it relies on

Base skills in `skills/` that every Workspace role gets. The billing-analysis skill names their
commands and leaves their syntax to them.

| Skill | Commands used |
|---|---|
| `workspace-sheets` | `sheets-get`, `sheets-create`, `sheets-append` |
| `workspace-gmail` | `gmail-search`, `gmail-get` (invoices and statements sent to the agent) |
| `drive` | `drive-export` (the generic base) |

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: `workspace: true`, the `billing-analysis` skill, `roles/bigquery.jobUser`, the BigQuery API, no extra packages |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/billing-analysis/` | The export's tables and columns, the rules for numbers, query templates, and the procedures for a cost report, a spike and a budget or invoice comparison; the `billing-query` command |
| `responsibilities.json` | Empty, with the reason |
| `processes/` | `p-cost-report`, `p-cost-investigation` |
| `memory.md` | The agent's first working memory: the export's location is still to learn |

## Why no responsibility ships

A monthly cost report or a daily spike check needs the export's location and the dataset grant, which
exist only after a billing admin sets them up; at install it would fail every time. Once the export is
reachable, people ask the agent for one and it creates it as its own responsibility.

## Rules the role adds

- Every number traces to a query, a cell or a document line; totals are re-added before delivery.
- Gross cost, credits, tax and adjustments are reported apart, in the account's currency, with the
  data's as-of time.
- Never move money: no payments, transfers, purchases, approvals, or budget, billing or resource
  changes.
- Financial history is append-only in spreadsheets the agent created. Drive is a source and a
  destination: files people shared are read as copies and never edited, moved, renamed, trashed or
  deleted.
