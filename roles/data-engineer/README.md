# roles/data-engineer/

An agent that works with the organization's data in BigQuery: it finds and explains datasets, writes queries
that stay within a cost cap, loads data through staging tables with quality checks, exports results, and
changes schemas without breaking what reads them.

| Part | Data Engineer |
|---|---|
| Purpose | Queries and analysis, loads and transforms, exports, schema changes, data quality |
| Channel | Dashboard chat |
| Skills | The base skills, plus `bigquery` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): every query dry run and capped, and over 1 TB only with a go-ahead; discover before changing; writes through staging; quality gates at every crossing; schema changes carry their way back; counts reconciled, keys unique, figures traced to a query or deterministic script; local data and JSON summaries read back and re-derived |
| Responsibilities | None: what to watch (a dataset's freshness, a cost budget) depends on the organization's data; the agent sets one up when asked |
| Processes | `p-data-load` and `p-schema-change`, on top of generic's |
| GCP roles | The generic base set, plus the two below |
| APIs | BigQuery, turned on by the installer |
| Workspace | No |

## What it adds to generic

| Skill | For | Runs |
|---|---|---|
| `bigquery` | Discovery, free samples with `bq head`, queries with a dry run and `--maximum_bytes_billed`, loads into a staging table and a repeatable move into the target, quality checks (counts, unique keys, nulls, ranges, schema), exports to Cloud Storage, safe schema changes, partitioned and clustered tables, long jobs without waiting | `bq`, `python3` |

It has no commands of its own. Results reach people as files through the base `files` skill.

## GCP roles

Granted on the project to `paraclete-agent@` by the installer, on top of the generic base set:

| Role | Why |
|---|---|
| `roles/bigquery.user` | Run query, load, extract and copy jobs; list datasets and tables; create datasets, which the agent then owns |
| `roles/bigquery.dataEditor` | Read and write table data, and create, update and delete tables, in the project's datasets: `bigquery.user` alone reaches only datasets the agent created |

Not granted: deleting datasets others created and changing who may read a dataset (`bigquery.dataOwner`,
`bigquery.admin`). Data in other projects needs their owners' grant; a bucket other than the instance's own
needs a grant before the agent can load from it or export to it. `dataEditor` on the project covers every
dataset in it: when only some datasets are the agent's business, a person can grant it on those datasets
instead and drop the project grant.

## What it needs at install

Nothing in this project: the installer turns on the BigQuery API (`apis` in `role.json`), which most new
projects have on already. Data in other projects, or in buckets other than the instance's, needs their
owners' grants to `paraclete-agent@<project>.iam.gserviceaccount.com`.

## Setup packages

| Kind | Packages | For |
|---|---|---|
| Debian | `python3-pandas` | Looking at and reshaping exported data on the VM (Debian 12's pandas 1.5, without its recommended extras) |

`bq` is not listed: it comes with the Google Cloud CLI that Debian 12's Compute Engine image installs.

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: no Workspace, the `bigquery` skill, the two GCP roles, the BigQuery API, the package above |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/bigquery/` | The skill above: `SKILL.md` and `skill.json` |
| `responsibilities.json` | Empty |
| `processes/p-data-load.json` | Inspect the source, stage, check, move, check again |
| `processes/p-schema-change.json` | Save, find dependents, change in place or rebuild behind approval, read back |
| `memory.md` | The agent's first working memory |
