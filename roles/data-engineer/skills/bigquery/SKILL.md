# Skill: BigQuery

## When to use

When the work reads or writes BigQuery: discovering datasets and tables, querying, loading, exporting,
changing a schema, and checking what a load produced. There are no commands of its own: you run `bq`,
which comes with the Google Cloud CLI, as this machine's service account. For a local look at exported
data, `python3` with `pandas` or the `csv` module.

## Ground rules

- Pass `--project_id=<project>` on every command (`gcloud config get-value project` gives the instance's
  own), and `--location=<location>` for jobs on data outside the `US` multi-region. Write table names in
  full: `<project>:<dataset>.<table>` for `bq` flags and arguments, `` `<project>.<dataset>.<table>` `` in
  SQL.
- Standard SQL always: `--use_legacy_sql=false` on every `bq query`.
- **A query is charged for the bytes it scans,** in on-demand pricing. `LIMIT` does not reduce them;
  naming only the columns you need, and filtering on the partition column, does. Never `SELECT *` on a
  table you have not sized.
- **Every query runs with a cap:** `--maximum_bytes_billed=<bytes>`, so a mistake fails instead of
  billing. Use the dry run's estimate, rounded up, as the cap; 10 GB (`10000000000`) for exploring.
  When a dry run says one query would scan more than 1 TB, stop and ask the person, with the estimate.
- A command is stopped after about two minutes. A long query or load runs as a job without waiting
  (`--synchronous_mode=false` prints its id), then `bq wait <job-id> 100` or `bq show -j <job-id>` until
  it is done.

## Read

| What | Command |
|---|---|
| Datasets | `bq ls --project_id=<project>` |
| Tables in a dataset | `bq ls --max_results=1000 <project>:<dataset>` |
| A table's schema | `bq show --schema --format=prettyjson <project>:<dataset>.<table>` |
| Its size, rows, partitioning, clustering, last change | `bq show --format=prettyjson <project>:<dataset>.<table>` (`numBytes`, `numRows`, `timePartitioning`, `clustering`, `lastModifiedTime`) |
| A sample of rows, free of query charges | `bq head --max_rows=20 --selected_fields=<col1>,<col2> <project>:<dataset>.<table>` |
| Recent jobs | `bq ls --jobs=true --max_results=20 --project_id=<project>` |
| One job, with its bytes billed | `bq show --format=prettyjson -j <job-id>` |

## Procedures

### Run a query

1. Write the SQL in a file in your workspace (`queries/<name>.sql`), naming only the columns you need,
   with a partition filter when the table has one.
2. Dry run it: `bq query --use_legacy_sql=false --dry_run --project_id=<project> < queries/<name>.sql`.
   It prints the bytes it would process.
3. Run it with that number, rounded up, as the cap:
   `bq query --use_legacy_sql=false --maximum_bytes_billed=<bytes> --max_rows=100 --format=prettyjson --project_id=<project> < queries/<name>.sql`.
   `--format=csv` writes results for a file; to keep large results, write them to a table instead
   (`--destination_table=<project>:<dataset>.<table> --replace`) and export it.
4. Report the estimate and the bytes billed with the result.

### Load data, through a staging table

1. Inspect the source: its row count, its header, a few lines, its encoding. Know the count you expect.
2. Load into a staging table, replacing it, so a rerun gives the same result:
   `bq load --source_format=CSV --skip_leading_rows=1 --replace <project>:<dataset>.<table>_staging gs://<bucket>/<path>.csv <schema.json>`
   (`--source_format=NEWLINE_DELIMITED_JSON` or `PARQUET` for those; `--autodetect` instead of a schema
   file only for exploring). A local file can be loaded directly, by its path instead of the `gs://` one.
3. Check the staging table (below). A failed check stops here.
4. Move it into the target with one statement that can run twice: a `MERGE` on the key, or, when the
   target is replaced whole, `bq cp --force <staging> <target>` behind an approval gate.
5. Check the target the same way, and compare its count with what you expected.

### Check a load's quality

Run these against the table you loaded, and put each result in your output:

- **Counts:** `SELECT COUNT(*) FROM ...`, against the source's count. Any difference is explained, or the
  load failed.
- **Keys unique:** `SELECT <key>, COUNT(*) AS n FROM ... GROUP BY <key> HAVING n > 1 LIMIT 10` returns
  nothing.
- **Nulls in key columns:** `SELECT COUNTIF(<col> IS NULL) AS nulls, COUNT(*) AS total FROM ...`. Over 5%
  in a key column is a warning to report, when nobody said what to expect.
- **Ranges:** `MIN` and `MAX` of dates and amounts are plausible: no dates in the future in a history, no
  negative quantities where none can be.
- **Schema:** the loaded schema (`bq show --schema`) matches the one planned: no column renamed, retyped
  or missing.

### Export to Cloud Storage

`bq extract --destination_format=CSV <project>:<dataset>.<table> gs://<bucket>/exports/<table>-*.csv`
(the `*` lets a large table split into several files; `NEWLINE_DELIMITED_JSON`, `AVRO` or `PARQUET` for
other formats). The instance's own bucket, `<project>-paraclete`, takes exports your account writes; to
hand a result to a person, fetch it into the mission and share it with the files skill.

### Change a schema

1. Save the current schema: `bq show --schema --format=prettyjson <table> > schema-before.json`.
2. Find what reads the table. For each dataset that could, run (with a dry run and a cap, as always):

   ```sql
   SELECT table_name FROM `<project>.<dataset>`.INFORMATION_SCHEMA.VIEWS
   WHERE view_definition LIKE '%<table>%'
   ```

   Ask the person about anything outside BigQuery that reads it (reports, jobs, pipelines).
3. In place, BigQuery allows only adding `NULLABLE` columns and relaxing `REQUIRED` to `NULLABLE`:
   write the new schema file and `bq update <project>:<dataset>.<table> schema-after.json`. Any other
   change (a rename, a type change, a dropped column) rebuilds the table: copy it first
   (`bq cp <table> <table>_backup_<date>`), then rebuild with a `CREATE OR REPLACE TABLE ... AS SELECT`,
   behind an approval gate.
4. Read the schema back and run the views that depend on it. Report the before and after.

### Create a table that will grow

A table expected to pass about 1 GB is partitioned (by a date column, or ingestion time) and clustered
on the columns queries filter by most (up to four):
`bq mk --table --time_partitioning_field=<date column> --time_partitioning_type=DAY --clustering_fields=<a>,<b> <project>:<dataset>.<table> <schema.json>`.
Check it with `bq show` (`timePartitioning`, `clustering`).

## What your account can do

Run queries and jobs, create datasets (you own those), and read, write, create and delete tables in the
project's datasets. It cannot delete a dataset it did not create, change who can read a dataset, or read
data in other projects unless they granted it. Loading from a bucket needs read access to that bucket:
the instance's own bucket works; another needs a person's grant.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `Query exceeded limit for bytes billed` | The cap worked | Narrow the query (columns, partition filter), dry run again; raise the cap only with the person's agreement over 1 TB |
| `Not found: Table` or `Dataset` | A wrong name or location | `bq ls` again; pass `--location` for data outside `US` |
| `Access Denied` | A dataset or bucket in another project, or a missing grant | Report the resource and the permission named |
| `Provided Schema does not match` on load | The file's columns differ from the table's | Compare the header with `bq show --schema`; load to staging with the file's real schema |
| `Too many errors encountered` on load | Bad rows | Read the errors in `bq show -j <job-id>`; fix the source, or `--max_bad_records=<n>` only with the person's agreement and the bad rows reported |
| The command is stopped before the job ends | The two-minute limit | Run it with `--synchronous_mode=false`, then `bq wait` |

## Safety

- Dry run first, cap always.
- Writes land in a staging table, never straight into a table people read; moving them into it is a
  `MERGE` or a copy you can repeat.
- Deleting a table, replacing one people use, or a `DELETE` or `UPDATE` without a narrow `WHERE`: copy
  what changes first, show the scope (the rows or the table, with counts and size), and wait for
  approval.
