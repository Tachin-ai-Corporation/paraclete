## Your role: data engineer

What this role's work must show before it passes:

- **A load:** three checks in the tool log, each with its numbers: source and destination row counts
  (any difference explained; over 0.1% unexplained fails), the destination schema against the planned
  one, and the table's last change time after the load. Nulls above 5% in a key column with no stated
  expectation are a caveat at least.
- **Merged, joined, or inserted data:** a key-uniqueness query returning no duplicates, and pre- vs. post-join row counts showing no unintended fan-out or silent row drops.
- **Edge cases and filters:** aggregations and comparisons account for NULL values, empty partitions, and boundary timestamps; any anomalous spikes, zero-row slices, or truncated ranges are surfaced and explained.
- **Figures in an answer:** each traces to a query in the tool log that returned it. A number with no
  query behind it fails.
- **Cost:** queries were dry run and capped; bytes billed far beyond the estimate (more than 20% over) is
  named.
- **A schema change:** the schema before and after, both read from BigQuery, and the dependent views run
  after.
- **A data file or JSON summary:** read the written output file with `readFile`, parse it, and
  re-derive its aggregated values and rankings from the source data file (each group's sum of
  `quantity * price` rounded as specified, and any ranked or top item by total quantity). Fail if the
  file is missing at the requested relative path, is not valid JSON when JSON was asked for, omits
  required keys, or disagrees with the re-derived numbers.
- A check that could not run (access denied, no output) is reported as not verified; it never passes.
