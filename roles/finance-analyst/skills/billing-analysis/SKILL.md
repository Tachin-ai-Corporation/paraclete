# Skill: Billing Analysis

## When to use

When a request is about what Google Cloud costs: a period's costs by service, project or SKU, credits,
a trend, a change or a spike, a comparison with a budget or an invoice, or a cost report. Also when
someone shares spreadsheets or invoices about cloud spending.

## What you can reach

| Source | How | What it needs |
|---|---|---|
| The Cloud Billing export in BigQuery | `billing-query` (below) | A billing admin turned on the export into a BigQuery dataset and granted your service account, `paraclete-agent@<project>.iam.gserviceaccount.com`, BigQuery Data Viewer on that dataset. Your queries run in this instance's project, where you hold BigQuery Job User |
| Spreadsheets people share | `sheets-get` (workspace-sheets), or `drive-export <link> --format xlsx` (drive) | Shared with your address |
| Invoices and statements sent to you | `gmail-search`, `gmail-get` (workspace-gmail) | Sent or forwarded to your Workspace address |
| Files dropped in chat | `file-get`, `file-read` (files) | Nothing |

You cannot reach the billing console, budgets or billing account settings: those need a role on the
billing account itself, which this instance is not given. Budgets come from people, as a number or a
spreadsheet.

When the export is not set up, tell the person what a billing admin does: in the Google Cloud console,
Billing, then "Billing export", then "BigQuery export": turn on "Standard usage cost" (and "Detailed
usage cost" for costs per resource) into a dataset; then, on that dataset, add your service account as
BigQuery Data Viewer. Usage from before the export was turned on may be missing: check the earliest date
before reporting on older periods.

## The export's tables

| Table | Holds |
|---|---|
| `gcp_billing_export_v1_<billing account id>` | Standard usage cost: one row per service, SKU, project and hour. The id's dashes become underscores |
| `gcp_billing_export_resource_v1_<billing account id>` | Detailed usage cost: the same, plus `resource.name` and `resource.global_name` |
| `cloud_pricing_export` | List prices, when the pricing export is on |

The columns you will use:

| Column | Means |
|---|---|
| `service.description`, `sku.description` | What was used |
| `project.id`, `project.name`, `labels`, `project.labels` | Where, and the tags on it |
| `usage_start_time`, `usage_end_time` | When it was used (UTC) |
| `cost` | The cost before credits, in `currency` |
| `credits` | A list per row: `name`, `amount` (negative), `type` |
| `invoice.month` | The invoice it lands on, as `YYYYMM` |
| `cost_type` | `regular`, `tax`, `adjustment` or `rounding_error` |
| `currency` | The billing account's currency. Never assume dollars |
| `export_time` | When the row was written: how fresh the data is |

Find the tables once and record the full path (`<project>.<dataset>.<table>`) in the project's context
or working memory, so later missions do not search again. Single quotes keep the shell away from the
backticks:

```bash
billing-query --sql 'SELECT table_name FROM `<project>.<dataset>.INFORMATION_SCHEMA.TABLES`'
```

## The command

`billing-query (--sql <query> | --file <path>) [--dry-run] [--max-gb <n>] [--format csv|json] [--out <path>] [--limit <rows>] [--project <id>]`

- Runs one read-only GoogleSQL query: `SELECT`, or `WITH ... SELECT`. Anything else, or several
  statements, is refused before BigQuery sees it.
- Every run starts with a dry run. The query runs only when it would process at most `--max-gb`
  gigabytes (default 10, at most 200), and BigQuery enforces the same cap on the bytes it bills. On a
  refusal, narrow the query; raise `--max-gb` only when the answer is worth the cost, and say so.
- `--dry-run` prints the estimate and runs nothing.
- Rows print as CSV with a header (`--format json` for a list of objects). Records and lists print as
  JSON in their cell, timestamps as ISO 8601 UTC, and numbers exactly as BigQuery sent them. A summary
  line (rows, bytes processed, the job) goes to stderr.
- `--out <path>` writes the rows to a file and prints the summary instead. `--limit` caps the rows read
  (default 10,000): aggregate in SQL rather than pulling raw rows.
- `--project` runs the query in another project (where you also need BigQuery Job User); the default is
  this instance's project.
- Write any query longer than a line to a file in the mission tree and pass `--file`: the file is your
  evidence, and a query starting with a comment cannot go in `--sql`.
- Exit codes: 0 success, 1 BigQuery refused or the cap stopped the query (the message says what to grant
  or fix), 2 a mistake in the command.

## Rules for numbers

1. **Every number comes from a query result or a cell,** never from arithmetic in your head. Keep each
   query (`queries/<name>.sql`) and its result (`--out results/<name>.csv`) in the mission tree, and
   name the query behind each number in what you deliver.
2. **State the freshness:** the latest `export_time` and how far `usage_end_time` reaches. The export
   runs hours behind usage, sometimes more than a day.
3. **Keep gross cost, credits, tax and adjustments apart.** Net is `cost` plus the credits (credits are
   negative). Never net them silently.
4. **Sum credits with a subquery,** `IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)`.
   Joining `UNNEST(credits)` repeats a row's cost once for every credit on it.
5. **Say which dates you used:** `invoice.month` for anything compared with an invoice, `usage_start_time`
   for when things were used. They differ at month edges.
6. **One currency,** the account's. Round money to two decimals only when you write the report.
7. **Check before delivering:** the parts add up to the totals (within a cent per line) and percentages
   to 100 (within 0.1).
8. **Explain change:** compare with the previous period in amount and percent. Attribute every change
   over 5% to the services and SKUs that drove it; a change over 15% needs its cause; over 30% leads the
   report.

## Queries

Replace `TABLE` with the export's full path, and the months with real ones.

Freshness:

```sql
SELECT MAX(export_time) AS last_export, MAX(usage_end_time) AS usage_through
FROM `TABLE`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
```

Costs by service for an invoice month:

```sql
SELECT
  service.description AS service,
  SUM(cost) AS cost,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,
  SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net,
  ANY_VALUE(currency) AS currency
FROM `TABLE`
WHERE invoice.month = '202609' AND cost_type = 'regular'
GROUP BY service
ORDER BY net DESC
```

Change `service.description` to `project.id` for costs by project, or group by `service.description,
sku.description` with `LIMIT 20` for the top SKUs.

Tax, adjustments and rounding, as their own lines:

```sql
SELECT cost_type, SUM(cost) AS cost,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits
FROM `TABLE`
WHERE invoice.month = '202609'
GROUP BY cost_type
```

Credits by type:

```sql
SELECT c.type, c.name, SUM(c.amount) AS amount
FROM `TABLE`, UNNEST(credits) AS c
WHERE invoice.month = '202609'
GROUP BY c.type, c.name
ORDER BY amount
```

Month over month, by service:

```sql
WITH monthly AS (
  SELECT invoice.month AS month, service.description AS service,
    SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net
  FROM `TABLE`
  WHERE invoice.month IN ('202608', '202609') AND cost_type = 'regular'
  GROUP BY month, service
)
SELECT service,
  SUM(IF(month = '202608', net, 0)) AS previous,
  SUM(IF(month = '202609', net, 0)) AS current,
  SUM(IF(month = '202609', net, 0)) - SUM(IF(month = '202608', net, 0)) AS change
FROM monthly
GROUP BY service
ORDER BY ABS(change) DESC
```

Daily net cost, to find when something started:

```sql
SELECT DATE(usage_start_time) AS day,
  SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net
FROM `TABLE`
WHERE usage_start_time >= TIMESTAMP('2026-09-01') AND usage_start_time < TIMESTAMP('2026-10-01')
GROUP BY day
ORDER BY day
```

A label's value as a column: `(SELECT value FROM UNNEST(labels) WHERE key = 'team') AS team`.

When a dry run is large, the export tables are usually partitioned by day: add
`AND _PARTITIONTIME >= TIMESTAMP('<a few days before the range starts>')`, since rows are written a
little after their usage. If BigQuery answers `Unrecognized name: _PARTITIONTIME`, that table is not
partitioned that way: drop the filter.

## Procedures

### A cost report for a period

1. Settle the scope: which billing account and projects, which period, and whether it must match an
   invoice (use `invoice.month`) or the usage dates.
2. Check freshness and state it.
3. Query costs by service, by project and the top SKUs; tax and adjustments; credits by type.
4. Compare with the previous period, and with any budget people gave you.
5. Check the sums (rule 7).
6. Write the report: the scope and as-of time first, then totals, the breakdowns, the changes with
   their drivers, and recommendations with their cost impact and the do-nothing option. Each table
   names its query.
7. Deliver it: `file-make docx --from md` for a document, or `file-make xlsx --from csv` for the tables,
   then `file-share`. When people want a Google Sheet, create one with `sheets-create` (your own, in
   your My Drive or a folder shared with you as Editor) and `sheets-append` the rows.

### Explain a change or a spike

1. Daily net cost over a window that starts well before the change: when did it start?
2. By service over the change, then by SKU within the services that moved, then by project and labels,
   and by resource when the detailed export exists, until a few lines account for most of the change.
3. Separate a one-time charge or an ending credit from real growth in usage (`usage.amount` grew?).
4. Report the size of the change, what drove it with the numbers, the likely cause with how you know
   it (verified, inferred or assumed), and options with their cost impact. Investigating is read-only:
   you never stop, resize or delete anything.

### Compare with a budget or an invoice

- **A budget** someone gives (a number, or a sheet you read): actual against budget, in amount and
  percent, with the forecast to the period's end only when you state how you projected it.
- **An invoice** (a PDF from chat or Drive, or attached to mail sent to you and saved with
  `gmail-get <message id> --attachment <number> --mission <mission id>`, then read with `file-read`):
  query by its `invoice.month`, put the invoice's lines and your totals side by side, and explain any
  difference over 1% before calling them reconciled.

## Spreadsheets and documents

Drive is a source and a destination. Read spreadsheets and documents people share as copies, and hand
results back as new files. Never edit, move, rename, trash or delete a file someone shared with you,
even with Editor access: a correction to their sheet is an adjustment you give them, or a row in a
sheet of your own. In a spreadsheet your own account created, financial history is append-only: a
correction is a new adjustment row that cites the original, with the reason and the date.

## Never

- Move money: no payment, transfer, purchase, subscription or commitment change, invoice approval, or
  change to a budget or billing setting, even when asked. Say you cannot, and give the analysis the
  person needs to do it.
- Change cloud resources to save money. Recommend, with the impact; a person acts.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `access denied ... BigQuery Data Viewer` | Your service account was not granted the export's dataset | Ask a billing admin to grant it, naming your service account and the dataset |
| `may not run queries in project` | No BigQuery Job User where the query runs | For this instance's project the install grants it; for another `--project`, ask its owner |
| `the BigQuery API is turned off` | The API is off in the project the query runs in | Ask a project owner to turn it on; the message has the command |
| `not found` | A wrong dataset or table name, or the export is not set up | List the dataset's tables; if there are none, the export is not on (see above) |
| `over the ... cap, so it did not run` | The query reads too much | Shorter date range, fewer columns, a partition filter; then `--dry-run` again |
| The latest days look low | The export runs behind usage | Say so with the as-of time; don't report a drop that is only lag |
