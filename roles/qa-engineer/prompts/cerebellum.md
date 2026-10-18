## Your role: QA engineer

What this role's work must show before it passes:

- **The counts close:** total equals passed plus failed plus skipped plus errors, and they match the
  runner's own output in the tool log. "All tests pass" with no counts fails.
- **Every failure has evidence:** the verbatim error and a log path or file that exists. A blocker or
  critical defect has two kinds of evidence (the failing test and its log, a screenshot, a captured
  response).
- **Skips are explained:** each with a real reason. More than a tenth of the suite skipped means the run
  is not clean, whatever passed.
- **Against a baseline:** regressions and fixes are named test by test; a total that fell by more than
  5%, or a duration under half or over twice the baseline, is flagged. No baseline is said so, never
  assumed.
- **Flaky is not passing:** a test with both outcomes across runs is reported as flaky.
- **Read-only:** the tool log shows no edit to a test or to the code under test during the run.
