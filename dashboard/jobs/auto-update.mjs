#!/usr/bin/env node
// dashboard/jobs/auto-update.mjs: one run of the automatic-update job. Cloud Scheduler starts the Cloud
// Run job contracts.auto_update.job_name (install/install.sh creates both) on its schedule; the job runs
// this file in the dashboard's own image, as the dashboard's own account, with the dashboard's
// environment plus PARACLETE_SERVICE (a job is not a service, so Cloud Run sets no K_SERVICE). It runs
// lib/server/auto-update.mjs runAutoUpdate once and exits: 0 when the run did what it decided, 1 when
// it could not read or write what it needs (Cloud Logging has the reason). A run that starts an upgrade
// follows it for at most the job's time; the next run picks up the rest.

import { runAutoUpdate } from '../lib/server/auto-update.mjs';
import { getRuntime } from '../lib/server/runtime.mjs';

const runtime = getRuntime();
if (runtime.settings.missing.length) {
  runtime.log('ERROR', `auto-update: the job is missing ${runtime.settings.missing.join(', ')}, which install/install.sh sets`);
  process.exit(1);
}

try {
  const result = await runAutoUpdate(runtime);
  runtime.log('INFO', `auto-update: done: ${result.action}${result.version ? ` ${result.version}` : ''}${result.upgrade ? ` (upgrade ${result.upgrade.state})` : ''}`);
  process.exit(0);
} catch (err) {
  runtime.log('ERROR', `auto-update: the run failed: ${err?.stack || err}`);
  process.exit(1);
}
