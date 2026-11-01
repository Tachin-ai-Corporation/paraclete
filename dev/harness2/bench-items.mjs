// dev/harness2/bench-items.mjs: the items of the organ benches (bench.mjs), versioned with
// BENCH_VERSION there. Each bench judges one organ at its own job, on inputs fixed here and an answer
// code checks, so it runs in seconds an item where a model-suite task runs a whole mission.
//
// - The cerebellum's (verification): a checkpoint, its acceptance criteria and the evidence its tasks
//   left. Items come in pairs: one where the work meets the criteria, and one where the evidence shows
//   a defect a careful verifier must catch (a missing row, a failing test the prose calls passing, a
//   wrong date, a non-zero exit, a file in the wrong place). A verifier that passes everything, or
//   fails everything, scores half.
// - The memory organ's (recall): what the agent has stored (working memory, Core Memory, past work)
//   and a request. The packet it returns must hold the facts that matter to the request and leave out
//   the distractors, which are stored beside them and reach the organ's candidates too.
//
// Items are `train` or `holdout`, as the model suite's tasks are: a lane's proposer hears what a failed
// training item checked, never a held-out one. This file is the referee's: no lane changes it.

const tool = (command, output) => `[TOOL] runCommand(${command}) → ${output}`;

/** A pair: the clean item passes, the defective one fails; both share the checkpoint. */
function pair({ id, split, instruction, acceptCriteria, clean, defect, flaw }) {
  return [
    { id: `${id}-clean`, organ: 'cerebellum', split, expect: 'pass', instruction, acceptCriteria, rows: clean },
    { id: `${id}-defect`, organ: 'cerebellum', split, expect: 'fail', flaw, instruction, acceptCriteria, rows: defect },
  ];
}

const row = (step, result, agent = 'motor') => ({ step, agent, result });

export const CEREBELLUM_ITEMS = Object.freeze([
  ...pair({
    id: 'cb-regions-csv',
    split: 'train',
    flaw: 'West is missing from report.csv',
    instruction: 'Total the sales export by region into report.csv',
    acceptCriteria: 'report.csv has one row for each of North, South, East and West, each with its total',
    clean: [row('1.1', `${tool('cat report.csv', 'region,total\nNorth,4250.10\nSouth,350.50\nEast,195.00\nWest,88.00')}\nWrote report.csv with a total for each region.`)],
    defect: [row('1.1', `${tool('cat report.csv', 'region,total\nNorth,4250.10\nSouth,350.50\nEast,195.00')}\nWrote report.csv with a total for each region.`)],
  }),
  ...pair({
    id: 'cb-tests-pass',
    split: 'train',
    flaw: 'one test fails, though the summary says all pass',
    instruction: 'Fix the date parser so the suite passes',
    acceptCriteria: 'npm test passes with no failing test',
    clean: [row('1.1', `${tool('npm test', 'ℹ tests 41\nℹ pass 41\nℹ fail 0')}\nFixed parseDate for two-digit years; all tests pass.`)],
    defect: [row('1.1', `${tool('npm test', 'ℹ tests 41\nℹ pass 40\nℹ fail 1\n✖ parseDate keeps the century of a four-digit year')}\nFixed parseDate for two-digit years; all tests pass.`)],
  }),
  ...pair({
    id: 'cb-invite-date',
    split: 'train',
    flaw: 'the draft gives 13 March, not 14 March',
    instruction: 'Draft the invitation to the quarterly review',
    acceptCriteria: 'invite.md invites the team to the quarterly review on Thursday 14 March 2027 at 15:00 UTC',
    clean: [row('1.1', `${tool('cat invite.md', 'Subject: Quarterly review\n\nHello all, the quarterly review is on Thursday 14 March 2027 at 15:00 UTC in the main room. Please bring your numbers.')}\nDrafted invite.md.`)],
    defect: [row('1.1', `${tool('cat invite.md', 'Subject: Quarterly review\n\nHello all, the quarterly review is on Thursday 13 March 2027 at 15:00 UTC in the main room. Please bring your numbers.')}\nDrafted invite.md.`)],
  }),
  ...pair({
    id: 'cb-backup-exit',
    split: 'train',
    flaw: 'tar failed with exit status 2, so no archive was made',
    instruction: "Back up the data directory for 1 March",
    acceptCriteria: 'the archive /srv/backups/backup-2027-03-01.tar.gz exists and holds the data directory',
    clean: [row('1.1', `${tool('tar czf /srv/backups/backup-2027-03-01.tar.gz data/ && ls -l /srv/backups', '-rw-r--r-- 1 agent agent 18M Mar  1 02:10 backup-2027-03-01.tar.gz')}\nThe backup is done.`)],
    defect: [row('1.1', `${tool('tar czf /srv/backups/backup-2027-03-01.tar.gz data/', 'tar: data/: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n[exit 2]')}\nThe backup is done.`)],
  }),
  ...pair({
    id: 'cb-summary-path',
    split: 'train',
    flaw: 'the file is in summary/, not summaries/',
    instruction: "Save the quarter's summary",
    acceptCriteria: 'the summary is saved as summaries/q1.md',
    clean: [row('1.1', `${tool('ls summaries && head -3 summaries/q1.md', 'q1.md\n# Q1 2027 summary\nRevenue rose 8% on the quarter, led by the North region; costs held flat.')}\nSaved the quarter's summary.`)],
    defect: [row('1.1', `${tool('ls summary summaries && head -3 summary/q1.md', 'summary:\nq1.md\nls: cannot access \'summaries\': No such file or directory\n# Q1 2027 summary\nRevenue rose 8% on the quarter, led by the North region; costs held flat.')}\nSaved the quarter's summary.`)],
  }),
  ...pair({
    id: 'cb-five-incidents',
    split: 'train',
    flaw: 'INC-4 is not covered',
    instruction: 'Brief the on-call lead on this week\'s incidents',
    acceptCriteria: 'brief.md covers every incident in incidents.json: INC-1, INC-2, INC-3, INC-4 and INC-5',
    clean: [row('1.1', `${tool('cat brief.md', '- INC-1: checkout latency, fixed by a cache flush.\n- INC-2: login errors after the deploy, rolled back.\n- INC-3: a stuck queue worker, restarted.\n- INC-4: certificate warning on the status page, renewed.\n- INC-5: nightly export late, rescheduled.')}\nWrote the brief.`)],
    defect: [row('1.1', `${tool('cat brief.md', '- INC-1: checkout latency, fixed by a cache flush.\n- INC-2: login errors after the deploy, rolled back.\n- INC-3: a stuck queue worker, restarted.\n- INC-5: nightly export late, rescheduled.')}\nWrote the brief, covering every incident.`)],
  }),
  ...pair({
    id: 'cb-invoice-total',
    split: 'train',
    flaw: 'the invoices sum to 2355.75, not 2335.75',
    instruction: 'Report the total of March\'s invoices',
    acceptCriteria: "total.txt holds the sum of the amounts in invoices.csv, to the cent",
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
    flaw: 'config.yaml was modified too',
    instruction: 'Point the local setup at the staging database',
    acceptCriteria: 'only config.local.yaml is changed; config.yaml is left as it was',
    clean: [row('1.1', `${tool('git status --short', ' M config.local.yaml')}\nSet the staging database in config.local.yaml.`)],
    defect: [row('1.1', `${tool('git status --short', ' M config.local.yaml\n M config.yaml')}\nSet the staging database in config.local.yaml.`)],
  }),
  ...pair({
    id: 'cb-word-limit',
    split: 'holdout',
    flaw: 'the announcement is 112 words, over the limit of 80',
    instruction: 'Write the product announcement',
    acceptCriteria: 'announcement.md is at most 80 words',
    clean: [row('1.1', `${tool('wc -w announcement.md', '74 announcement.md')}\nWrote the announcement.`)],
    defect: [row('1.1', `${tool('wc -w announcement.md', '112 announcement.md')}\nWrote the announcement, short and to the point.`)],
  }),
  ...pair({
    id: 'cb-sorted-contacts',
    split: 'holdout',
    flaw: 'Carter comes before Baker',
    instruction: 'Sort the contact list',
    acceptCriteria: 'contacts.txt lists the contacts sorted by last name, A to Z',
    clean: [row('1.1', `${tool('cat contacts.txt', 'Ada Adams\nBen Baker\nCara Carter\nDev Diaz\nEli Evans')}\nSorted the list.`)],
    defect: [row('1.1', `${tool('cat contacts.txt', 'Ada Adams\nCara Carter\nBen Baker\nDev Diaz\nEli Evans')}\nSorted the list.`)],
  }),
  ...pair({
    id: 'cb-meeting-zone',
    split: 'holdout',
    flaw: 'the invite says 16:00 UTC, where the meeting is 16:00 in Berlin (15:00 UTC)',
    instruction: 'Send the Berlin team the time of the planning call',
    acceptCriteria: 'the message gives the call as 16:00 Europe/Berlin, which is 15:00 UTC on 4 March 2027',
    clean: [row('1.1', `${tool('cat message.txt', 'The planning call is on 4 March 2027 at 16:00 Berlin time (15:00 UTC).')}\nWrote the message.`)],
    defect: [row('1.1', `${tool('cat message.txt', 'The planning call is on 4 March 2027 at 16:00 UTC.')}\nWrote the message with the Berlin time.`)],
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

export const MEMORY_ITEMS = Object.freeze([
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
    must: [{ name: 'says Acme wants PDF', re: /\bpdf\b/i }],
    mustNot: [{ name: "leaves out Globex's preference", re: /globex/i }],
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
    must: [{ name: 'names the production deploy window', re: /tuesday|thursday|change policy|09:00/i }],
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
    must: [{ name: "gives the board decks folder's id", re: /folder-board-decks-0001/ }],
    mustNot: [],
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
    must: [{ name: 'says orders-legacy is read-only', re: /read-only/i }],
    mustNot: [{ name: 'leaves out the log rotation', re: /nginx|rotat/i }],
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
    must: [{ name: "names Dana's review", re: /dana/i }],
    mustNot: [{ name: 'leaves out the team lunch', re: /lunch/i }],
  },
  {
    id: 'mem-release-freeze',
    organ: 'temporal-memory',
    split: 'train',
    query: 'Merge the feature branch into release/v3',
    workingMemory: '- 2027-03-01: the release freeze for v3 is in effect until Friday 5 March; only fixes approved by Sam merge.\n- 2027-02-28: the analytics dashboard was moved to the new cluster.',
    coreMemory: [],
    work: [],
    must: [{ name: 'mentions the release freeze', re: /freeze/i }],
    mustNot: [{ name: 'leaves out the dashboard move', re: /analytics|cluster/i }],
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
    must: [{ name: 'names Omar, the billing contact', re: /omar/i }],
    mustNot: [{ name: 'leaves out Priya, the legal contact', re: /priya/i }],
  },
  {
    id: 'mem-cert-history',
    organ: 'temporal-memory',
    split: 'holdout',
    // The renewal is 120 days old, past the 30 days a targeted recall searches: the organ must ask
    // for the deeper history (its escalation) to find it.
    deep: true,
    query: 'When does the api.example.com certificate expire, and how was it renewed last time?',
    workingMemory: '',
    coreMemory: [],
    work: [
      work('w-renew-cert', 'Renew the TLS certificate for api.example.com', 'Renewed the certificate for api.example.com with certbot (DNS challenge). It now expires on 2027-06-01.', { daysAgo: 120 }),
    ],
    must: [{ name: 'gives the expiry, 2027-06-01', re: /2027-06-01/ }, { name: 'says it was renewed with certbot', re: /certbot/i }],
    mustNot: [],
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
    must: [{ name: 'says to use the secrets skill', re: /secrets/i }],
    mustNot: [{ name: "leaves out Acme's report format", re: /acme|pdf/i }],
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
    must: [{ name: 'names the vendor review and Lena', re: /lena|vendor review/i }],
    mustNot: [{ name: "leaves out Globex's report format", re: /excel|workbook/i }],
  },
]);

export { DAY_MS };
