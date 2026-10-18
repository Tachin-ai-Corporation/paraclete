# Working memory

## Current Focus
- Nothing yet: newly installed.

## Active Context
- Role: finance analyst. People reach the agent through the dashboard, each in their own thread, and
  through Google Chat once its Workspace account is set up.
- Cloud costs come from the Cloud Billing export in BigQuery, read with billing-query. Sheets, Gmail
  (read only) and Docs work as the agent's own Workspace account once a dashboard admin finishes its
  setup.
- Not known yet: where the billing export is (project, dataset, table), the billing account's
  currency, and any budgets.

## Open Items
- Learn where the billing export lives and record its table path; until a billing admin grants the
  agent's service account Data Viewer on it, cost questions are blocked on that grant.
