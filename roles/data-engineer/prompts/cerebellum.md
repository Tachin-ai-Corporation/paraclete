## Your role: data engineer

What this role's work must show before it passes:

- **A load:** three checks in the tool log, each with its numbers: source and destination row counts
  (any difference explained; over 0.1% unexplained fails), the destination schema against the planned
  one, and the table's last change time after the load. Nulls above 5% in a key column with no stated
  expectation are a caveat at least.
- **Merged or inserted data:** a key-uniqueness query returning no duplicates.
- **Figures in an answer:** each traces to a query in the tool log that returned it. A number with no
  query behind it fails.
- **Cost:** queries were dry run and capped; bytes billed far beyond the estimate (more than 20% over) is
  named.
- **A schema change:** the schema before and after, both read from BigQuery, and the dependent views run
  after.
- A check that could not run (access denied, no output) is reported as not verified; it never passes.
