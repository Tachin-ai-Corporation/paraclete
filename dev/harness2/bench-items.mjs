// dev/harness2/bench-items.mjs: the items of the organ benches (bench.mjs), versioned with
// BENCH_VERSION there. Each bench judges one organ at its own job, on inputs fixed here and an answer
// code checks, so it runs in seconds an item where a model-suite task runs a whole mission.
//
// - The cerebellum's (verification): a checkpoint, its acceptance criteria and the evidence its tasks
//   left. Items come in pairs: one where the work meets the criteria, and one where the evidence shows
//   a defect a careful verifier must catch. Version 2's defects are the quiet ones: a part missing
//   while the prose lists it, a range a day short, a total cut where it should be rounded, a test
//   removed while the count still looks whole, a value in the wrong unit, a deploy to the wrong place,
//   steps in the wrong order, a stale artifact, columns out of order, a duplicate left in. Version 3's
//   clean work is noisy where a too-strict verifier fails it (a search that exits 1 because it found
//   nothing, a skip the criteria allow, a first attempt that timed out, rows in another order), and
//   its defects take reading every row: a row missing from twelve, a total of nine amounts, a change a
//   later step undid, a rate on the wrong base, numbers sorted as text, checksums that differ. A
//   verifier that passes everything, or fails everything, scores half.
// - The memory organ's (recall): what the agent has stored (working memory, Core Memory, past work)
//   and a request. The packet it returns must hold the facts that matter to the request and leave out
//   the distractors stored beside them. Version 2's stores are larger and noisier: many clients alike,
//   requests that need two facts, facts that changed. Version 3's need three facts, tell apart people
//   of one name and contacts of one client, weigh a working-memory note against Core Memory, join past
//   work with a policy, and ask for the deeper history on a training item too.
//
// A check is named for the kind of mistake it catches, from the vocabularies below, never for a fact
// of its item: a lane's planned issue quotes a failing check by its name (dev/loop/planner.mjs), and a
// name that held the item's facts would let a change fit the item instead of the organ.
//
// Items are `train` or `holdout`, as the model suite's tasks are: a lane's proposer hears what a failed
// training item checked, never a held-out one. Items a version retires stay here, run only when named
// (RETIRED_BENCH_ITEMS in bench.mjs). This file is the referee's: no lane changes it.

const tool = (command, output) => `[TOOL] runCommand(${command}) → ${output}`;

/** The kinds of defect a cerebellum item plants: a defective item's check is named for its kind. */
export const DEFECT_KINDS = Object.freeze([
  'a row missing', 'a test failing behind a claim that all pass', 'a wrong date', 'a command that failed',
  'a file in the wrong place', 'an item left out', 'a wrong total', 'a file changed that had to stay',
  'a length over its limit', 'an order broken', 'a time in the wrong zone',
  'a required part missing', 'a range one day short', 'a total cut where it should be rounded',
  'a test removed while the count looks whole', 'a value in the wrong unit', 'a deploy to the wrong place',
  'steps in the wrong order', 'an artifact left stale', 'columns in the wrong order', 'a duplicate left in',
  'a reference left behind', 'a test skipped beyond the one allowed', 'a copy that does not match its source',
  'a change undone by a later step', 'a rate on the wrong base', 'a check run on the wrong version',
]);

/** What a recall packet must keep, and what it must leave out: a memory item's checks are named so. */
export const RECALL_KEEPS = Object.freeze([
  'keeps the fact the request turns on', 'keeps the other fact the request needs', 'keeps the newer of two facts that disagree',
  'keeps a condition the request must meet',
]);
export const RECALL_LEAVES = Object.freeze([
  'leaves out a fact about the same subject for another purpose', 'leaves out a fact about another subject',
  'leaves out past work the request does not need', 'leaves out the older of two facts that disagree',
]);

/** A pair: the clean item passes, the defective one fails; both share the checkpoint. */
function pair({ id, split, kind, flaw, instruction, acceptCriteria, clean, defect }) {
  return [
    { id: `${id}-clean`, organ: 'cerebellum', split, expect: 'pass', kind, instruction, acceptCriteria, rows: clean },
    { id: `${id}-defect`, organ: 'cerebellum', split, expect: 'fail', kind, flaw, instruction, acceptCriteria, rows: defect },
  ];
}

const row = (step, result, agent = 'motor') => ({ step, agent, result });

const SHORTLIST = 'A-03 287500\nA-05 54100\nA-08 125000\nA-12 87650\nA-17 412000\nA-19 43900\nA-22 151300\nA-27 31250\nA-30 76400\nA-41 98200';
const STORES = Array.from({ length: 12 }, (_, i) => `S-${String(i + 1).padStart(2, '0')}`).join('\n');
const STORE_TOTALS = ['S-07,18204.10', 'S-02,9120.00', 'S-11,22410.55', 'S-01,15002.30', 'S-09,7310.80', 'S-05,11980.00',
  'S-12,6402.15', 'S-03,13377.40', 'S-10,8890.25', 'S-06,19544.60', 'S-04,10211.70', 'S-08,12045.95'];
const EXPENSES = 'date,item,amount\n2027-03-02,train to Leeds,120.00\n2027-03-02,hotel dinner,84.50\n2027-03-03,hotel,310.25\n'
  + '2027-03-03,taxi,47.20\n2027-03-04,parking,15.75\n2027-03-08,conference ticket,600.00\n2027-03-09,team lunch,92.10\n'
  + '2027-03-11,printing,33.30\n2027-03-15,flight to Dublin,210.40';
const UPLOAD_TIMEOUT = row('1.1', `${tool('gcloud storage cp archive.tar.gz gs://example-backups/2027-03/', 'ERROR: (gcloud.storage.cp) HTTPSConnectionPool: Read timed out. (read timeout=60)\n[exit 1]')}\nThe upload timed out; trying again.`);
const upload = (remoteMd5) => row('1.2', `${tool('gcloud storage cp archive.tar.gz gs://example-backups/2027-03/ && md5sum archive.tar.gz && gcloud storage hash gs://example-backups/2027-03/archive.tar.gz --hex',
  `Copying file://archive.tar.gz to gs://example-backups/2027-03/archive.tar.gz\n  Completed files 1/1 | 1.2GiB/1.2GiB\n9e107d9d372bb6826bd81d3542a419d6  archive.tar.gz\nhash_md5: ${remoteMd5}\nurl: gs://example-backups/2027-03/archive.tar.gz`)}\nUploaded the archive on the second try; its checksum matches.`);

export const CEREBELLUM_ITEMS = Object.freeze([
  // Version 3.
  ...pair({
    id: 'cb3-no-old-imports',
    split: 'train',
    kind: 'a reference left behind',
    flaw: 'src/jobs/nightly.mjs still imports the old logger',
    instruction: 'Move every module off the old logger',
    acceptCriteria: 'no file under src/ imports lib/log-old.mjs any more, and the test suite still passes',
    clean: [row('1.1', `${tool('grep -rn "lib/log-old" src/; echo "grep exit $?"; npm test 2>&1 | tail -3', 'grep exit 1\nℹ tests 64\nℹ pass 64\nℹ fail 0')}\nMoved the last three modules to lib/log.mjs.`)],
    defect: [row('1.1', `${tool('grep -rn "lib/log-old" src/; echo "grep exit $?"; npm test 2>&1 | tail -3', "src/jobs/nightly.mjs:3:import log from '../lib/log-old.mjs';\ngrep exit 0\nℹ tests 64\nℹ pass 64\nℹ fail 0")}\nMoved the last three modules to lib/log.mjs.`)],
  }),
  ...pair({
    id: 'cb3-allowed-skip',
    split: 'train',
    kind: 'a test skipped beyond the one allowed',
    flaw: 'a checkout test is skipped as well as the network test the criteria allow',
    instruction: 'Fix the checkout tests',
    acceptCriteria: "npm test has no failing test; the network suite's one test may stay skipped, and no other test is skipped",
    clean: [row('1.1', `${tool('npm test 2>&1 | tail -8', '(node:4121) ExperimentalWarning: VM Modules is an experimental feature and might change at any time\n﹣ network suite reaches the mock server # SKIP needs network\nℹ tests 58\nℹ suites 9\nℹ pass 57\nℹ fail 0\nℹ skipped 1\nℹ duration_ms 2210')}\nFixed the checkout tests; only the network test is skipped.`)],
    defect: [row('1.1', `${tool('npm test 2>&1 | tail -9', '(node:4121) ExperimentalWarning: VM Modules is an experimental feature and might change at any time\n﹣ network suite reaches the mock server # SKIP needs network\n﹣ checkout applies the spring discount # SKIP\nℹ tests 58\nℹ suites 9\nℹ pass 56\nℹ fail 0\nℹ skipped 2\nℹ duration_ms 2190')}\nFixed the checkout tests; only the network test is skipped.`)],
  }),
  ...pair({
    id: 'cb3-upload-checksum',
    split: 'train',
    kind: 'a copy that does not match its source',
    flaw: "the uploaded object's MD5 ends a41f02, the local file's a419d6",
    instruction: "Upload the month's archive to the backup bucket",
    acceptCriteria: 'gs://example-backups/2027-03/archive.tar.gz exists and is the same file as the local archive.tar.gz: the same MD5',
    clean: [UPLOAD_TIMEOUT, upload('9e107d9d372bb6826bd81d3542a419d6')],
    defect: [UPLOAD_TIMEOUT, upload('9e107d9d372bb6826bd81d3542a41f02')],
  }),
  ...pair({
    id: 'cb3-store-rows',
    split: 'train',
    kind: 'a row missing',
    flaw: 'store S-09 has no row',
    instruction: "Total each store's March sales",
    acceptCriteria: 'totals.csv has one row for each of the twelve stores in stores.txt, in any order, each with its March total',
    clean: [row('1.1', tool('cat stores.txt', STORES)), row('1.2', `${tool('cat totals.csv', `store,total\n${STORE_TOTALS.join('\n')}`)}\nWrote a total for every store.`)],
    defect: [row('1.1', tool('cat stores.txt', STORES)), row('1.2', `${tool('cat totals.csv', `store,total\n${STORE_TOTALS.filter((s) => !s.startsWith('S-09')).join('\n')}`)}\nWrote a total for every store.`)],
  }),
  ...pair({
    id: 'cb3-expense-sum',
    split: 'train',
    kind: 'a wrong total',
    flaw: 'the nine amounts sum to 1513.50; 1466.30 leaves out the 47.20 taxi',
    instruction: "Total March's expense claim",
    acceptCriteria: 'total.txt holds the sum of all nine amounts in expenses.csv, to the cent',
    clean: [row('1.1', tool('cat expenses.csv', EXPENSES)), row('1.2', `${tool('cat total.txt', '1513.50')}\nThe claim's total is in total.txt.`)],
    defect: [row('1.1', tool('cat expenses.csv', EXPENSES)), row('1.2', `${tool('cat total.txt', '1466.30')}\nThe claim's total is in total.txt.`)],
  }),
  ...pair({
    id: 'cb3-undone-later',
    split: 'train',
    kind: 'a change undone by a later step',
    flaw: 'the build regenerated config/app.json from its template, putting maxUploadMb back to 10',
    instruction: 'Raise the upload limit to 50 MB and rebuild the app',
    acceptCriteria: 'when the checkpoint ends, config/app.json sets maxUploadMb to 50, and the build succeeded',
    clean: [
      row('1.1', `${tool('grep -n maxUploadMb config/app.json', '7:  "maxUploadMb": 50,')}\nSet the upload limit to 50 MB.`),
      row('1.2', `${tool('npm run build && grep -n maxUploadMb config/app.json', '> app@3.2.0 build\n> node scripts/build.mjs\nBuilt dist/ in 4.1s\n7:  "maxUploadMb": 50,')}\nRebuilt the app.`),
    ],
    defect: [
      row('1.1', `${tool('grep -n maxUploadMb config/app.json', '7:  "maxUploadMb": 50,')}\nSet the upload limit to 50 MB.`),
      row('1.2', `${tool('npm run build && grep -n maxUploadMb config/app.json', '> app@3.2.0 build\n> node scripts/build.mjs\nconfig/app.json regenerated from config/app.template.json\nBuilt dist/ in 4.3s\n7:  "maxUploadMb": 10,')}\nRebuilt the app.`),
    ],
  }),
  ...pair({
    id: 'cb3-churn-base',
    split: 'train',
    kind: 'a rate on the wrong base',
    flaw: '3.5% divides the 45 lost by the 1,285 customers at the end of March; by the 1,250 at its start it is 3.6%',
    instruction: "Report March's churn",
    acceptCriteria: "summary.md gives March's churn rate: the customers lost in March divided by the customers at the start of March, as a percentage to one decimal place",
    clean: [
      row('1.1', tool('cat metrics/march.json', '{ "customers_start": 1250, "customers_lost": 45, "customers_gained": 80, "customers_end": 1285 }')),
      row('1.2', `${tool('cat summary.md', '# March\n\nWe began March with 1,250 customers and ended it with 1,285. Churn: 3.6% (45 customers lost).')}\nWrote the churn summary.`),
    ],
    defect: [
      row('1.1', tool('cat metrics/march.json', '{ "customers_start": 1250, "customers_lost": 45, "customers_gained": 80, "customers_end": 1285 }')),
      row('1.2', `${tool('cat summary.md', '# March\n\nWe began March with 1,250 customers and ended it with 1,285. Churn: 3.5% (45 customers lost).')}\nWrote the churn summary.`),
    ],
  }),
  ...pair({
    id: 'cb3-top-balances',
    split: 'train',
    kind: 'an order broken',
    flaw: 'the balances are sorted as text, so 98200 comes first and 412000 sixth',
    instruction: 'Rank the shortlisted accounts by balance',
    acceptCriteria: 'ranked.txt lists the ten accounts of shortlist.txt by balance, largest first',
    clean: [
      row('1.1', tool('cat shortlist.txt', SHORTLIST)),
      row('1.2', `${tool('cat ranked.txt', 'A-17 412000\nA-03 287500\nA-22 151300\nA-08 125000\nA-41 98200\nA-12 87650\nA-30 76400\nA-05 54100\nA-19 43900\nA-27 31250')}\nRanked the accounts.`),
    ],
    defect: [
      row('1.1', tool('cat shortlist.txt', SHORTLIST)),
      row('1.2', `${tool('cat ranked.txt', 'A-41 98200\nA-12 87650\nA-30 76400\nA-05 54100\nA-19 43900\nA-17 412000\nA-27 31250\nA-03 287500\nA-22 151300\nA-08 125000')}\nRanked the accounts.`),
    ],
  }),
  ...pair({
    id: 'cb3-site-mirror',
    split: 'holdout',
    kind: 'a copy that does not match its source',
    flaw: 'pricing.html is in site/ but not in /srv/www',
    instruction: 'Publish the site to the web root',
    acceptCriteria: '/srv/www holds exactly the files of site/, with the same content',
    clean: [row('1.1', `${tool('rsync -a --delete site/ /srv/www/; diff -rq site/ /srv/www/; echo "diff exit $?"', 'diff exit 0')}\nPublished the site.`)],
    defect: [row('1.1', `${tool('rsync -a --delete site/ /srv/www/; diff -rq site/ /srv/www/; echo "diff exit $?"', 'rsync: [sender] send_files failed to open "site/pricing.html": Permission denied (13)\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.2.7]\nOnly in site/: pricing.html\ndiff exit 1')}\nPublished the site.`)],
  }),
  ...pair({
    id: 'cb3-tested-commit',
    split: 'holdout',
    kind: 'a check run on the wrong version',
    flaw: 'the tests ran at 9b1e7d0, not at the fix 4f2a9c1',
    instruction: 'Run the test suite on the rounding fix',
    acceptCriteria: 'the full test suite passes at commit 4f2a9c1, the rounding fix',
    clean: [row('1.1', `${tool('git log --oneline -1 && npm test 2>&1 | tail -3', '4f2a9c1 (HEAD -> fix/rounding) Round invoice totals half-up\nℹ tests 212\nℹ pass 212\nℹ fail 0')}\nThe suite passes on the fix.`)],
    defect: [row('1.1', `${tool('git log --oneline -1 && npm test 2>&1 | tail -3', '9b1e7d0 (HEAD -> main) Bump the date library\nℹ tests 212\nℹ pass 212\nℹ fail 0')}\nThe suite passes on the fix.`)],
  }),
  ...pair({
    id: 'cb3-summer-time-call',
    split: 'holdout',
    kind: 'a time in the wrong zone',
    flaw: 'Berlin is on summer time (UTC+2) from 28 March 2027, so 16:00 there on 30 March is 14:00 UTC, not 15:00',
    instruction: 'Send the Berlin team the time of the launch call',
    acceptCriteria: 'the message gives the call as 16:00 Berlin time on Tuesday 30 March 2027, with its UTC time right',
    clean: [row('1.1', `${tool('cat message.txt', 'The launch call is on Tuesday 30 March 2027 at 16:00 Berlin time (14:00 UTC).')}\nWrote the message.`)],
    defect: [row('1.1', `${tool('cat message.txt', 'The launch call is on Tuesday 30 March 2027 at 16:00 Berlin time (15:00 UTC).')}\nWrote the message.`)],
  }),
  // Version 2's: version 3 retired all but cb2-rounded-total, cb-tests-pass and cb2-stale-report.
  ...pair({
    id: 'cb2-report-sections',
    split: 'train',
    kind: 'a required part missing',
    flaw: 'the report has no recommendation, though the prose says it does',
    instruction: 'Write the quarterly report',
    acceptCriteria: 'report.md has three parts: a summary of the quarter, a table of the four regions, and a recommendation for next quarter',
    clean: [row('1.1', `${tool('cat report.md', '# Q1 report\n\n## Summary\nRevenue rose 8% on the quarter, led by the North.\n\n## Regions\n| Region | Revenue |\n|---|---|\n| North | 4250 |\n| South | 350 |\n| East | 195 |\n| West | 88 |\n\n## Recommendation\nMove two sales reps from East to North, where demand outruns supply.')}\nWrote report.md with the summary, the regional table and a recommendation.`)],
    defect: [row('1.1', `${tool('cat report.md', '# Q1 report\n\n## Summary\nRevenue rose 8% on the quarter, led by the North.\n\n## Regions\n| Region | Revenue |\n|---|---|\n| North | 4250 |\n| South | 350 |\n| East | 195 |\n| West | 88 |')}\nWrote report.md with the summary, the regional table and a recommendation.`)],
  }),
  ...pair({
    id: 'cb2-march-export',
    split: 'train',
    kind: 'a range one day short',
    flaw: 'the export stops at 30 March',
    instruction: "Export March's sales",
    acceptCriteria: 'march.csv holds the sales of every day of March 2027, 1 to 31 March',
    clean: [row('1.1', `${tool('export-sales --from 2027-03-01 --to 2027-03-31 --out march.csv', 'Exported 31 days, 4,955 rows to march.csv')}\nExported March.`)],
    defect: [row('1.1', `${tool('export-sales --from 2027-03-01 --to 2027-03-30 --out march.csv', 'Exported 30 days, 4,812 rows to march.csv')}\nExported March.`)],
  }),
  ...pair({
    id: 'cb2-rounded-total',
    split: 'train',
    kind: 'a total cut where it should be rounded',
    flaw: 'the amounts sum to 2355.756, which rounds to 2355.76; 2355.75 cut it',
    instruction: "Report the total of the supplier's invoices",
    acceptCriteria: 'total.txt holds the sum of the amounts in invoices.csv, rounded to the nearest cent',
    clean: [
      row('1.1', tool('cat invoices.csv', 'invoice,amount\nS-201,1200.128\nS-202,845.500\nS-203,310.128')),
      row('1.2', `${tool("python3 -c \"print(f'{round(1200.128 + 845.5 + 310.128, 2):.2f}')\" > total.txt && cat total.txt", '2355.76')}\nThe total is in total.txt.`),
    ],
    defect: [
      row('1.1', tool('cat invoices.csv', 'invoice,amount\nS-201,1200.128\nS-202,845.500\nS-203,310.128')),
      row('1.2', `${tool("python3 -c \"print(int((1200.128 + 845.5 + 310.128) * 100) / 100)\" > total.txt && cat total.txt", '2355.75')}\nThe total is in total.txt.`),
    ],
  }),
  ...pair({
    id: 'cb2-leap-year-test',
    split: 'train',
    kind: 'a test removed while the count looks whole',
    flaw: 'a test was deleted, so 41 tests pass where 42 should',
    instruction: 'Add a leap-year test to the date library',
    acceptCriteria: 'all 41 existing tests still pass, and a new test for 29 February passes too',
    clean: [row('1.1', `${tool('git diff --stat main && npm test', ' tests/date.test.mjs | 9 +++++++++\nℹ tests 42\nℹ pass 42\nℹ fail 0')}\nAdded the leap-year test; every test passes.`)],
    defect: [row('1.1', `${tool('git diff --stat main && npm test', ' tests/date.test.mjs | 21 ++++++++++------------\nℹ tests 41\nℹ pass 41\nℹ fail 0')}\nAdded the leap-year test; every test passes.`)],
  }),
  ...pair({
    id: 'cb2-timeout-unit',
    split: 'train',
    kind: 'a value in the wrong unit',
    flaw: 'timeoutMs is 30, thirty milliseconds, not thirty seconds',
    instruction: "Raise the client's request timeout",
    acceptCriteria: "the client's request timeout is 30 seconds",
    clean: [row('1.1', `${tool('grep -n timeout config/client.json', '4:  "timeoutMs": 30000,')}\nSet the timeout to 30 seconds.`)],
    defect: [row('1.1', `${tool('grep -n timeout config/client.json', '4:  "timeoutMs": 30,')}\nSet the timeout to 30 seconds.`)],
  }),
  ...pair({
    id: 'cb2-deploy-target',
    split: 'train',
    kind: 'a deploy to the wrong place',
    flaw: 'version 2.4.1 went to staging',
    instruction: 'Ship version 2.4.1',
    acceptCriteria: 'version 2.4.1 runs in production (shop-prod) and its health check passes there',
    clean: [row('1.1', `${tool('deploy --project shop-prod --version 2.4.1 && status --project shop-prod', 'Deployed 2.4.1 to shop-prod\nshop-prod: version 2.4.1, health ok')}\nShipped 2.4.1.`)],
    defect: [row('1.1', `${tool('deploy --project shop-staging --version 2.4.1 && status --project shop-staging', 'Deployed 2.4.1 to shop-staging\nshop-staging: version 2.4.1, health ok')}\nShipped 2.4.1.`)],
  }),
  ...pair({
    id: 'cb2-backup-first',
    split: 'train',
    kind: 'steps in the wrong order',
    flaw: 'the migration ran at 02:01, before the backup at 02:05',
    instruction: 'Migrate the orders database',
    acceptCriteria: 'the orders database was backed up before the migration ran, and the migration applied',
    clean: [row('1.1', `${tool('journalctl -u db-maintenance --since 01:55 -o short', '01:58:12 backup: wrote orders-2027-03-04.dump (2.1 GB)\n02:01:40 migrate: applied 0042_add_order_index')}\nBacked up and migrated.`)],
    defect: [row('1.1', `${tool('journalctl -u db-maintenance --since 01:55 -o short', '02:01:40 migrate: applied 0042_add_order_index\n02:05:03 backup: wrote orders-2027-03-04.dump (2.1 GB)')}\nBacked up and migrated.`)],
  }),
  ...pair({
    id: 'cb-tests-pass',
    split: 'train',
    kind: 'a test failing behind a claim that all pass',
    flaw: 'one test fails, though the summary says all pass',
    instruction: 'Fix the date parser so the suite passes',
    acceptCriteria: 'npm test passes with no failing test',
    clean: [row('1.1', `${tool('npm test', 'ℹ tests 41\nℹ pass 41\nℹ fail 0')}\nFixed parseDate for two-digit years; all tests pass.`)],
    defect: [row('1.1', `${tool('npm test', 'ℹ tests 41\nℹ pass 40\nℹ fail 1\n✖ parseDate keeps the century of a four-digit year')}\nFixed parseDate for two-digit years; all tests pass.`)],
  }),
  ...pair({
    id: 'cb2-stale-report',
    split: 'holdout',
    kind: 'an artifact left stale',
    flaw: 'report.pdf is from 1 March, before the 4 March data it must hold',
    instruction: 'Regenerate the report from the data loaded on 4 March 2027',
    acceptCriteria: "report.pdf was regenerated on 4 March 2027, after that morning's 09:00 data load",
    // Version 3 shows the data load beside the report: version 2's clean evidence showed only the
    // report's time, and every run failed it, so the load the criteria name was never in evidence.
    clean: [row('1.1', `${tool('ls -l --time-style=long-iso data/loads/2027-03-04.csv report.pdf', '-rw-r--r-- 1 agent agent 5120330 2027-03-04 09:00 data/loads/2027-03-04.csv\n-rw-r--r-- 1 agent agent  182044 2027-03-04 10:31 report.pdf')}\nRegenerated the report.`)],
    defect: [row('1.1', `${tool('ls -l --time-style=long-iso data/loads/2027-03-04.csv report.pdf', '-rw-r--r-- 1 agent agent 5120330 2027-03-04 09:00 data/loads/2027-03-04.csv\n-rw-r--r-- 1 agent agent  179120 2027-03-01 09:12 report.pdf')}\nRegenerated the report.`)],
  }),
  ...pair({
    id: 'cb2-column-order',
    split: 'holdout',
    kind: 'columns in the wrong order',
    flaw: 'the columns are id, email, name',
    instruction: 'Export the customer list',
    acceptCriteria: 'export.csv has the columns id, name and email, in that order',
    clean: [row('1.1', `${tool('head -2 export.csv', 'id,name,email\n7,Ada Adams,ada@example.com')}\nExported the customers.`)],
    defect: [row('1.1', `${tool('head -2 export.csv', 'id,email,name\n7,ada@example.com,Ada Adams')}\nExported the customers.`)],
  }),
  ...pair({
    id: 'cb2-no-duplicates',
    split: 'holdout',
    kind: 'a duplicate left in',
    flaw: 'customer C-1042 appears twice',
    instruction: 'Merge the two customer lists',
    acceptCriteria: 'customers.csv lists each customer once',
    clean: [row('1.1', `${tool('cut -d, -f1 customers.csv | sort | uniq -d', '(no output)')}\nMerged the lists without duplicates.`)],
    defect: [row('1.1', `${tool('cut -d, -f1 customers.csv | sort | uniq -d', 'C-1042')}\nMerged the lists without duplicates.`)],
  }),
  ...pair({
    id: 'cb-meeting-zone',
    split: 'holdout',
    kind: 'a time in the wrong zone',
    flaw: 'the message says 16:00 UTC, where the meeting is 16:00 in Berlin (15:00 UTC)',
    instruction: 'Send the Berlin team the time of the planning call',
    acceptCriteria: 'the message gives the call as 16:00 Europe/Berlin, which is 15:00 UTC on 4 March 2027',
    clean: [row('1.1', `${tool('cat message.txt', 'The planning call is on 4 March 2027 at 16:00 Berlin time (15:00 UTC).')}\nWrote the message.`)],
    defect: [row('1.1', `${tool('cat message.txt', 'The planning call is on 4 March 2027 at 16:00 UTC.')}\nWrote the message with the Berlin time.`)],
  }),
  // Version 1's, retired: every one was judged right in every run of the first bench baseline.
  ...pair({
    id: 'cb-regions-csv',
    split: 'train',
    kind: 'a row missing',
    flaw: 'West is missing from report.csv',
    instruction: 'Total the sales export by region into report.csv',
    acceptCriteria: 'report.csv has one row for each of North, South, East and West, each with its total',
    clean: [row('1.1', `${tool('cat report.csv', 'region,total\nNorth,4250.10\nSouth,350.50\nEast,195.00\nWest,88.00')}\nWrote report.csv with a total for each region.`)],
    defect: [row('1.1', `${tool('cat report.csv', 'region,total\nNorth,4250.10\nSouth,350.50\nEast,195.00')}\nWrote report.csv with a total for each region.`)],
  }),
  ...pair({
    id: 'cb-invite-date',
    split: 'train',
    kind: 'a wrong date',
    flaw: 'the draft gives 13 March, not 14 March',
    instruction: 'Draft the invitation to the quarterly review',
    acceptCriteria: 'invite.md invites the team to the quarterly review on Thursday 14 March 2027 at 15:00 UTC',
    clean: [row('1.1', `${tool('cat invite.md', 'Subject: Quarterly review\n\nHello all, the quarterly review is on Thursday 14 March 2027 at 15:00 UTC in the main room. Please bring your numbers.')}\nDrafted invite.md.`)],
    defect: [row('1.1', `${tool('cat invite.md', 'Subject: Quarterly review\n\nHello all, the quarterly review is on Thursday 13 March 2027 at 15:00 UTC in the main room. Please bring your numbers.')}\nDrafted invite.md.`)],
  }),
  ...pair({
    id: 'cb-backup-exit',
    split: 'train',
    kind: 'a command that failed',
    flaw: 'tar failed with exit status 2, so no archive was made',
    instruction: 'Back up the data directory for 1 March',
    acceptCriteria: 'the archive /srv/backups/backup-2027-03-01.tar.gz exists and holds the data directory',
    clean: [row('1.1', `${tool('tar czf /srv/backups/backup-2027-03-01.tar.gz data/ && ls -l /srv/backups', '-rw-r--r-- 1 agent agent 18M Mar  1 02:10 backup-2027-03-01.tar.gz')}\nThe backup is done.`)],
    defect: [row('1.1', `${tool('tar czf /srv/backups/backup-2027-03-01.tar.gz data/', 'tar: data/: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n[exit 2]')}\nThe backup is done.`)],
  }),
  ...pair({
    id: 'cb-summary-path',
    split: 'train',
    kind: 'a file in the wrong place',
    flaw: 'the file is in summary/, not summaries/',
    instruction: "Save the quarter's summary",
    acceptCriteria: 'the summary is saved as summaries/q1.md',
    clean: [row('1.1', `${tool('ls summaries && head -3 summaries/q1.md', 'q1.md\n# Q1 2027 summary\nRevenue rose 8% on the quarter, led by the North region; costs held flat.')}\nSaved the quarter's summary.`)],
    defect: [row('1.1', `${tool('ls summary summaries && head -3 summary/q1.md', 'summary:\nq1.md\nls: cannot access \'summaries\': No such file or directory\n# Q1 2027 summary\nRevenue rose 8% on the quarter, led by the North region; costs held flat.')}\nSaved the quarter's summary.`)],
  }),
  ...pair({
    id: 'cb-five-incidents',
    split: 'train',
    kind: 'an item left out',
    flaw: 'INC-4 is not covered',
    instruction: 'Brief the on-call lead on this week\'s incidents',
    acceptCriteria: 'brief.md covers every incident in incidents.json: INC-1, INC-2, INC-3, INC-4 and INC-5',
    clean: [row('1.1', `${tool('cat brief.md', '- INC-1: checkout latency, fixed by a cache flush.\n- INC-2: login errors after the deploy, rolled back.\n- INC-3: a stuck queue worker, restarted.\n- INC-4: certificate warning on the status page, renewed.\n- INC-5: nightly export late, rescheduled.')}\nWrote the brief.`)],
    defect: [row('1.1', `${tool('cat brief.md', '- INC-1: checkout latency, fixed by a cache flush.\n- INC-2: login errors after the deploy, rolled back.\n- INC-3: a stuck queue worker, restarted.\n- INC-5: nightly export late, rescheduled.')}\nWrote the brief, covering every incident.`)],
  }),
  ...pair({
    id: 'cb-invoice-total',
    split: 'train',
    kind: 'a wrong total',
    flaw: 'the invoices sum to 2355.75, not 2335.75',
    instruction: 'Report the total of March\'s invoices',
    acceptCriteria: 'total.txt holds the sum of the amounts in invoices.csv, to the cent',
    clean: [
      row('1.1', tool('cat invoices.csv', 'invoice,amount\nA-101,1200.00\nA-102,845.50\nA-103,310.25')),
      row('1.2', `${tool('cat total.txt', '2355.75')}\nThe total is in total.txt.`),
    ],
    defect: [
      row('1.1', tool('cat invoices.csv', 'invoice,amount\nA-101,1200.00\nA-102,845.50\nA-103,310.25')),
      row('1.2', `${tool('cat total.txt', '2335.75')}\nThe total is in total.txt.`),
    ],
  }),
  ...pair({
    id: 'cb-config-untouched',
    split: 'train',
    kind: 'a file changed that had to stay',
    flaw: 'config.yaml was modified too',
    instruction: 'Point the local setup at the staging database',
    acceptCriteria: 'only config.local.yaml is changed; config.yaml is left as it was',
    clean: [row('1.1', `${tool('git status --short', ' M config.local.yaml')}\nSet the staging database in config.local.yaml.`)],
    defect: [row('1.1', `${tool('git status --short', ' M config.local.yaml\n M config.yaml')}\nSet the staging database in config.local.yaml.`)],
  }),
  ...pair({
    id: 'cb-word-limit',
    split: 'holdout',
    kind: 'a length over its limit',
    flaw: 'the announcement is 112 words, over the limit of 80',
    instruction: 'Write the product announcement',
    acceptCriteria: 'announcement.md is at most 80 words',
    clean: [row('1.1', `${tool('wc -w announcement.md', '74 announcement.md')}\nWrote the announcement.`)],
    defect: [row('1.1', `${tool('wc -w announcement.md', '112 announcement.md')}\nWrote the announcement, short and to the point.`)],
  }),
  ...pair({
    id: 'cb-sorted-contacts',
    split: 'holdout',
    kind: 'an order broken',
    flaw: 'Carter comes before Baker',
    instruction: 'Sort the contact list',
    acceptCriteria: 'contacts.txt lists the contacts sorted by last name, A to Z',
    clean: [row('1.1', `${tool('cat contacts.txt', 'Ada Adams\nBen Baker\nCara Carter\nDev Diaz\nEli Evans')}\nSorted the list.`)],
    defect: [row('1.1', `${tool('cat contacts.txt', 'Ada Adams\nCara Carter\nBen Baker\nDev Diaz\nEli Evans')}\nSorted the list.`)],
  }),
]);

const DAY_MS = 86_400_000;

/** A Core Memory entry, `daysAgo` before the bench's clock. */
const fact = (id, text, { category = 'facts', tags = [], importance = 0.8, confidence = 0.9, daysAgo = 10 } = {}) => ({
  id, fact: text, category, tags, importance, confidence, daysAgo,
});

/** A finished mission in the work collection, `daysAgo` before the bench's clock. */
const work = (id, title, output, { daysAgo = 3, status = 'complete', instruction = title } = {}) => ({
  id, type: 'M', status, title, instruction, output, daysAgo,
});

const [TURNS, OTHER, NEWER, CONDITION] = RECALL_KEEPS;
const [SAME_SUBJECT, OTHER_SUBJECT, OTHER_WORK] = RECALL_LEAVES;

/** Clients alike, each with a carrier and a contact: the noise a request about one of them recalls past. */
const CLIENT_NOISE = [
  fact('mem-globex-carrier', 'Globex ships only with Contoso Logistics', { category: 'preferences', tags: ['globex', 'shipping', 'carrier'] }),
  fact('mem-umbrella-carrier', 'Umbrella Corp uses Litware Courier for every shipment', { category: 'preferences', tags: ['umbrella', 'shipping', 'carrier'] }),
  fact('mem-hooli-carrier', 'Hooli has its parcels sent by Fabrikam Express', { category: 'preferences', tags: ['hooli', 'shipping', 'carrier'] }),
  fact('mem-globex-contact', "Globex's purchasing contact is Lena", { category: 'people', tags: ['globex', 'purchasing'] }),
  fact('mem-umbrella-contact', "Umbrella Corp's purchasing contact is Sam", { category: 'people', tags: ['umbrella', 'purchasing'] }),
  fact('mem-hooli-hours', "Hooli's warehouse takes deliveries from 08:00 to 14:00", { category: 'facts', tags: ['hooli', 'deliveries'] }),
];

export const MEMORY_ITEMS = Object.freeze([
  // Version 3.
  {
    id: 'mem3-client-contacts',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Get Acme to approve the purchase order for 20 more licences',
    workingMemory: '',
    coreMemory: [
      fact('mem-acme-po', "Tomas in Acme's procurement team approves every purchase order Acme receives", { category: 'people', tags: ['acme', 'procurement', 'purchase order'] }),
      fact('mem-acme-invoices', "Ines handles Acme's invoices and payment reminders", { category: 'people', tags: ['acme', 'billing', 'invoice'] }),
      fact('mem-acme-counsel', "Priya, Acme's legal counsel, signs their contracts and NDAs", { category: 'people', tags: ['acme', 'legal', 'contract'] }),
      fact('mem-acme-eng', "Raj leads Acme's engineering team and answers API and integration questions", { category: 'people', tags: ['acme', 'engineering', 'api'] }),
      fact('mem-acme-ceo', "Mara is Acme's CEO; she joins only the annual review", { category: 'people', tags: ['acme', 'executive'] }),
      fact('mem-licence-price', 'Licences cost 30 EUR a seat a month on the standard plan', { category: 'facts', tags: ['licences', 'pricing'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /tomas/i }],
    mustNot: [{ name: SAME_SUBJECT, re: /\b(priya|raj|mara)\b/i }],
  },
  {
    id: 'mem3-restore-runbook',
    organ: 'temporal-memory',
    split: 'train',
    query: "Restore the orders database from last night's snapshot, the way we did it last time",
    // The restore is 95 days old, past the 30 days a targeted recall searches: the organ must ask for
    // the deeper history, as mem-cert-history's must, here on a training item. A deep item's
    // `deepCues` are the cues the tests' fair organ escalates with (bench.test.mjs).
    deep: true,
    deepCues: ['restore', 'orders', 'snapshot'],
    workingMemory: '',
    coreMemory: [],
    work: [
      work('w-restore-orders', 'Restore the orders database from the nightly snapshot', 'Put the shop in maintenance mode, then restored the orders database with pg-restore-snapshot --pitr from the orders-nightly-snapshots bucket; it took 40 minutes.', { daysAgo: 95 }),
      work('w-restore-search', 'Restore the search index', 'Rebuilt the search index from the catalogue with reindex --full.', { daysAgo: 5 }),
      work('w-backup-crm', 'Back up the CRM database', 'Backed up the CRM database to the crm-weekly bucket with pg_dump.', { daysAgo: 3 }),
    ],
    must: [{ name: TURNS, re: /pg-restore-snapshot/i }, { name: CONDITION, re: /maintenance mode/i }],
    mustNot: [{ name: OTHER_WORK, re: /reindex|crm-weekly/i }],
  },
  {
    id: 'mem3-offsite-venue',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Book a venue in Lisbon for the team offsite in May, for the 12 of us',
    workingMemory: '',
    coreMemory: [
      fact('mem-venue-booking', 'Wen books every offsite venue, through the company TravelDesk account', { category: 'people', tags: ['offsite', 'venue', 'booking'] }),
      fact('mem-offsite-cap', 'Team offsites are capped at 150 EUR a person a night, venue and rooms together', { category: 'policies', tags: ['offsite', 'budget', 'venue'] }),
      fact('mem-offsite-access', 'Offsite venues must be step-free: two of the team use wheelchairs', { category: 'preferences', tags: ['offsite', 'venue', 'access'] }),
      fact('mem-lisbon-client', 'Our Lisbon client Fabrikam prefers meetings in the morning', { category: 'preferences', tags: ['lisbon', 'fabrikam', 'meetings'] }),
      fact('mem-berlin-office', 'The Berlin office seats 30 people', { category: 'facts', tags: ['berlin', 'office'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /\bwen\b|traveldesk/i }, { name: OTHER, re: /\b150\b/ }, { name: CONDITION, re: /step-free|wheelchair/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /fabrikam/i }],
  },
  {
    id: 'mem3-same-name',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Email Lena at Globex about the late delivery of order G-881',
    workingMemory: '',
    coreMemory: [
      fact('mem-globex-lena', "Lena Ortiz is Globex's purchasing contact (lena.ortiz@example.com)", { category: 'people', tags: ['globex', 'purchasing', 'orders'] }),
      fact('mem-hooli-lena', 'Lena Park runs procurement at Hooli (lena.park@example.com)', { category: 'people', tags: ['hooli', 'procurement', 'orders'] }),
      fact('mem-globex-ships', 'Globex ships only with Contoso Logistics', { category: 'preferences', tags: ['globex', 'shipping', 'delivery'] }),
      fact('mem-hooli-dock', "Hooli's warehouse takes deliveries from 08:00 to 14:00", { category: 'facts', tags: ['hooli', 'deliveries'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /ortiz/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /lena park|lena\.park/i }],
  },
  {
    id: 'mem3-payroll-rerun',
    organ: 'temporal-memory',
    split: 'train',
    query: "Rerun last week's payroll export for the Lisbon team",
    workingMemory: '',
    coreMemory: [
      fact('mem-payroll-encrypt', 'Payroll exports are encrypted with the finance key before they leave the VPC', { category: 'policies', tags: ['payroll', 'export', 'security'] }),
    ],
    work: [
      work('w-payroll-pt', 'Export the Lisbon payroll', 'Exported the Lisbon payroll with payroll-export --entity PT-02 --period 2027-02; the file went to the finance-pt bucket.', { daysAgo: 6 }),
      work('w-payroll-de', 'Export the Berlin payroll', 'Exported the Berlin payroll with payroll-export --entity DE-01 --period 2027-02; the file went to the finance-de bucket.', { daysAgo: 6 }),
      work('w-close-expenses', 'Close the February expense reports', 'Closed 41 expense reports for February.', { daysAgo: 4 }),
    ],
    must: [{ name: TURNS, re: /PT-02/ }, { name: CONDITION, re: /encrypt/i }],
    mustNot: [{ name: OTHER_WORK, re: /DE-01/ }],
  },
  {
    id: 'mem3-note-over-core',
    organ: 'temporal-memory',
    split: 'train',
    query: "Book the shipment of Initech's spare parts with their carrier",
    workingMemory: '- 2027-03-02: Initech has moved all its shipping from Northwind Freight to Tailspin Cargo, from this month.\n- 2027-03-01: the Q1 board deck is in the board decks folder.',
    coreMemory: [
      fact('mem-initech-ships', 'Initech ships only with Northwind Freight', { category: 'preferences', tags: ['initech', 'shipping', 'carrier'], importance: 0.9, daysAgo: 220 }),
      ...CLIENT_NOISE,
    ],
    work: [],
    must: [{ name: NEWER, re: /tailspin/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /contoso|litware|fabrikam/i }],
  },
  {
    id: 'mem3-two-addresses',
    organ: 'temporal-memory',
    split: 'holdout',
    query: 'Ship the replacement parts to Globex',
    workingMemory: '',
    coreMemory: [
      fact('mem-globex-accounts', "Globex's invoices go to its accounts office at 2 Quay Street, Perth", { category: 'facts', tags: ['globex', 'invoice', 'address'] }),
      fact('mem-globex-warehouse', 'Globex takes deliveries at its warehouse, 77 Dock Road, Perth', { category: 'facts', tags: ['globex', 'deliveries', 'address', 'shipping'] }),
      fact('mem-umbrella-address', "Umbrella Corp's office is at 5 Kirk Lane, Dundee", { category: 'facts', tags: ['umbrella', 'address'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /dock road/i }],
    mustNot: [{ name: SAME_SUBJECT, re: /quay street/i }],
  },
  // Version 2's: version 3 retired all but mem2-rotation-due, mem-billing-contact and the held-out items.
  {
    id: 'mem2-carrier-among-many',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Book the shipment of the new server racks to Initech with their usual carrier',
    workingMemory: '',
    coreMemory: [
      fact('mem-initech-carrier', 'Initech ships only with Northwind Freight, and needs a tail-lift truck', { category: 'preferences', tags: ['initech', 'shipping', 'carrier'] }),
      ...CLIENT_NOISE,
    ],
    work: [],
    must: [{ name: TURNS, re: /northwind/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /contoso|litware|fabrikam/i }],
  },
  {
    id: 'mem2-two-facts',
    organ: 'temporal-memory',
    split: 'train',
    query: "Set up next quarter's review meeting with Acme",
    workingMemory: '',
    coreMemory: [
      fact('mem-acme-reviews', "Acme's quarterly reviews are run by Dana in their finance team", { category: 'people', tags: ['acme', 'review', 'quarterly'] }),
      fact('mem-acme-days', 'Acme only takes meetings on Tuesdays and Thursdays', { category: 'preferences', tags: ['acme', 'meetings'] }),
      fact('mem-acme-legal-2', "Acme's legal contact is Priya, for contracts", { category: 'people', tags: ['acme', 'legal', 'contract'] }),
      fact('mem-office-friday', 'Our office closes at 18:00 on Fridays', { category: 'facts', tags: ['office'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /dana/i }, { name: OTHER, re: /tuesday|thursday/i }],
    mustNot: [{ name: SAME_SUBJECT, re: /priya/i }],
  },
  {
    id: 'mem2-moved-office',
    organ: 'temporal-memory',
    split: 'train',
    query: "Post the signed contract to Acme's office",
    workingMemory: '',
    coreMemory: [
      fact('mem-acme-old-office', "Acme's office is at 12 Harbour Road, Leith", { category: 'facts', tags: ['acme', 'office', 'address'], daysAgo: 200 }),
      fact('mem-acme-new-office', 'Acme moved its office to 4 Mill Lane, Leith, on 1 March', { category: 'facts', tags: ['acme', 'office', 'address'], daysAgo: 4 }),
      fact('mem-globex-office', "Globex's office is at 9 Station Street, Perth", { category: 'facts', tags: ['globex', 'office', 'address'] }),
    ],
    work: [],
    must: [{ name: NEWER, re: /4 Mill Lane/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /station street/i }],
  },
  {
    id: 'mem2-rotation-due',
    organ: 'temporal-memory',
    split: 'train',
    query: "When is the billing service's next API key rotation due?",
    workingMemory: '- 2027-03-02: the support rota changed; Wen covers Mondays now.',
    coreMemory: [
      fact('mem-rotation-log', 'Key rotations are announced in the security channel before they happen', { category: 'policies', tags: ['key', 'rotation', 'security'] }),
    ],
    work: [
      work('w-rotate-billing', 'Rotate the billing service API keys', 'Rotated the billing service API keys on 2027-02-20. The next rotation is due on 2027-05-20.', { daysAgo: 12 }),
      work('w-rotate-search', 'Rotate the search service API keys', 'Rotated the search service API keys; next due 2027-04-02.', { daysAgo: 25 }),
      work('w-fix-invoice-pdf', 'Fix the invoice PDF layout', 'Fixed the footer overlap in the invoice PDFs.', { daysAgo: 2 }),
    ],
    must: [{ name: TURNS, re: /2027-05-20/ }],
    mustNot: [{ name: OTHER_WORK, re: /2027-04-02|footer/i }],
  },
  {
    id: 'mem-billing-contact',
    organ: 'temporal-memory',
    split: 'train',
    query: "Who should get Acme's overdue invoice reminder?",
    workingMemory: '',
    coreMemory: [
      fact('mem-acme-billing', "Acme's billing contact is Omar (omar@example.com)", { category: 'people', tags: ['acme', 'billing', 'invoice'] }),
      fact('mem-acme-legal', "Acme's legal contact is Priya (priya@example.com)", { category: 'people', tags: ['acme', 'legal', 'contract'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /omar/i }],
    mustNot: [{ name: SAME_SUBJECT, re: /priya/i }],
  },
  {
    id: 'mem-legacy-readonly',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Write the new refund rows into orders-legacy',
    workingMemory: '',
    coreMemory: [],
    work: [
      work('w-migrate-orders', 'Migrate the orders database to Postgres 16', 'Migrated orders to Postgres 16. The old MySQL instance orders-legacy is read-only until 30 April; write to orders-pg instead.', { daysAgo: 20 }),
      work('w-rotate-logs', 'Rotate the web server logs', 'Rotated the nginx logs and set a weekly rotation.', { daysAgo: 2 }),
    ],
    must: [{ name: TURNS, re: /read-only/i }],
    mustNot: [{ name: OTHER_WORK, re: /nginx|rotat/i }],
  },
  {
    id: 'mem2-vendor-review',
    organ: 'temporal-memory',
    split: 'holdout',
    query: "Renew Hooli's support contract",
    workingMemory: '',
    coreMemory: [
      fact('mem-hooli-renewal', "Hooli's support contract is renewed only after the vendor review in May, which Lena in procurement runs", { category: 'policies', tags: ['hooli', 'contract', 'renewal'] }),
      ...CLIENT_NOISE,
    ],
    work: [],
    must: [{ name: TURNS, re: /vendor review|may/i }],
    mustNot: [{ name: SAME_SUBJECT, re: /fabrikam|08:00/i }],
  },
  {
    id: 'mem2-price-change',
    organ: 'temporal-memory',
    split: 'holdout',
    query: "Quote Globex for 40 hours of support at this year's rate",
    workingMemory: '',
    coreMemory: [
      fact('mem-globex-rate-old', 'Globex pays 95 EUR an hour for support', { category: 'facts', tags: ['globex', 'rate', 'support'], daysAgo: 300 }),
      fact('mem-globex-rate-new', "From January, Globex's support rate is 110 EUR an hour", { category: 'facts', tags: ['globex', 'rate', 'support'], daysAgo: 40 }),
      fact('mem-umbrella-rate', "Umbrella Corp's support rate is 120 EUR an hour", { category: 'facts', tags: ['umbrella', 'rate', 'support'] }),
    ],
    work: [],
    must: [{ name: NEWER, re: /110/ }],
    mustNot: [{ name: OTHER_SUBJECT, re: /\b120\b|umbrella/i }],
  },
  {
    id: 'mem-cert-history',
    organ: 'temporal-memory',
    split: 'holdout',
    query: 'When does the api.example.com certificate expire, and how was it renewed last time?',
    // The renewal is 120 days old, past the 30 days a targeted recall searches: the organ must ask
    // for the deeper history (its escalation) to find it.
    deep: true,
    deepCues: ['certificate', 'api.example.com'],
    workingMemory: '',
    coreMemory: [],
    work: [
      work('w-renew-cert', 'Renew the TLS certificate for api.example.com', 'Renewed the certificate for api.example.com with certbot (DNS challenge). It now expires on 2027-06-01.', { daysAgo: 120 }),
    ],
    must: [{ name: TURNS, re: /2027-06-01/ }, { name: OTHER, re: /certbot/i }],
    mustNot: [],
  },
  // Version 1's, retired: every one was recalled right in every run of the first bench baseline.
  {
    id: 'mem-client-format',
    organ: 'temporal-memory',
    split: 'train',
    query: "Send Acme their February report",
    workingMemory: '- 2027-02-27: the February numbers are final.',
    coreMemory: [
      fact('mem-acme-pdf', "Acme's finance team wants monthly reports as PDF, never as spreadsheets", { category: 'preferences', tags: ['acme', 'reports'] }),
      fact('mem-globex-xlsx', 'Globex wants monthly reports as Excel workbooks', { category: 'preferences', tags: ['globex', 'reports'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /\bpdf\b/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /globex/i }],
  },
  {
    id: 'mem-deploy-window',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Deploy the billing fix to production on Friday evening',
    workingMemory: '',
    coreMemory: [
      fact('mem-change-window', 'Production deploys happen only Tuesday to Thursday, 09:00 to 15:00 UTC, under the change policy', { category: 'policies', tags: ['deploy', 'production'] }),
      fact('mem-staging-any', 'Staging can be deployed at any time', { category: 'policies', tags: ['deploy', 'staging'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /tuesday|thursday|change policy|09:00/i }],
    mustNot: [],
  },
  {
    id: 'mem-board-folder',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Put the Q2 board deck in the board decks folder',
    workingMemory: '',
    coreMemory: [
      fact('mem-res-board', 'drive_folder: "Board decks" = folder-board-decks-0001', { category: 'resources', tags: ['board', 'decks'] }),
      fact('mem-res-sales', 'drive_folder: "Sales decks" = folder-sales-decks-0002', { category: 'resources', tags: ['sales', 'decks'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /folder-board-decks-0001/ }],
    mustNot: [],
  },
  {
    id: 'mem-copy-review',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Publish the new landing page copy',
    workingMemory: '',
    coreMemory: [
      fact('mem-dana-review', 'Dana, the head of design, reviews all external copy before it is published', { category: 'people', tags: ['copy', 'review', 'publish'] }),
      fact('mem-lunch', 'The team lunch is on the first Friday of the month', { category: 'facts', tags: ['team'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /dana/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /lunch/i }],
  },
  {
    id: 'mem-release-freeze',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Merge the feature branch into release/v3',
    workingMemory: '- 2027-03-01: the release freeze for v3 is in effect until Friday 5 March; only fixes approved by Sam merge.\n- 2027-02-28: the analytics dashboard was moved to the new cluster.',
    coreMemory: [],
    work: [],
    must: [{ name: TURNS, re: /freeze/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /analytics|cluster/i }],
  },
  {
    id: 'mem-key-rotation',
    organ: 'temporal-memory',
    split: 'holdout',
    query: "Rotate the analytics service account's key",
    workingMemory: '',
    coreMemory: [
      fact('mem-keys-secrets', 'Service account keys are rotated through the secrets skill, never by hand', { category: 'policies', tags: ['key', 'rotate', 'secrets'] }),
      fact('mem-acme-pdf-2', "Acme's finance team wants monthly reports as PDF", { category: 'preferences', tags: ['acme', 'reports'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /secrets/i }],
    mustNot: [{ name: OTHER_SUBJECT, re: /acme|pdf/i }],
  },
  {
    id: 'mem-vendor-renewal',
    organ: 'temporal-memory',
    split: 'holdout',
    query: 'Renew the Globex support contract',
    workingMemory: '',
    coreMemory: [
      fact('mem-globex-renewal', 'Globex support contracts are renewed only after the vendor review in May, by Lena in procurement', { category: 'policies', tags: ['globex', 'contract', 'renewal'] }),
      fact('mem-globex-xlsx-2', 'Globex wants monthly reports as Excel workbooks', { category: 'preferences', tags: ['globex', 'reports'] }),
    ],
    work: [],
    must: [{ name: TURNS, re: /lena|vendor review/i }],
    mustNot: [{ name: SAME_SUBJECT, re: /excel|workbook/i }],
  },
]);

export { DAY_MS };
