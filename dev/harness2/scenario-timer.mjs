// dev/harness2/scenario-timer.mjs: the systemd units that run the canary's scenario batteries
// (scenarios.mjs, `cli.mjs scenarios --battery all`) every hour on the harness lab's driver, and the
// commands that set them up. It only prints: nothing installs the units, so the batteries run on a
// schedule only once a person installs them by hand. It does not decide what a call does: each scenario
// starts a run every 24 or 72 hours (scenario-items.mjs), and the hourly call sends whatever steps are
// due, so a step goes out within an hour of falling due and a call with nothing due sends nothing.
//
// The calls run in a clone of their own, never in the harness checkout, as a lane's cycles do
// (dev/loop/timer.mjs): the clone keeps the batteries' state and harvests in its `.local/canary/`, and
// before each call it is fast-forwarded to `--branch` (main unless named), so the batteries run as they
// stand there. It links the harness checkout's `.local/instance.env` (the canary's coordinates), its
// private denylist (for the harvests' scrub) and its installed packages. While a call runs, the lab's
// follow-main timer leaves the harness checkout where it is, as it does for any dev/harness2 process
// (lab-follow-main.sh), so a call that sends steps can hold the checkout behind main for its length.
//
//   node dev/harness2/scenario-timer.mjs [--branch <name>] [--clone <dir>] [--checkout <dir>] [--user <name>]

import { pathToFileURL } from 'node:url';

export const SCENARIO_UNIT = 'paraclete-canary-scenarios';

/** Where the batteries' clone lives on the driver. */
export const SCENARIO_CLONE = '/var/lib/paraclete/canary-scenarios';

/** A value that goes into a unit file unquoted: no spaces, quotes or shell characters. */
const SAFE = /^[A-Za-z0-9_./@:-]+$/;

/**
 * The service and timer units, and the commands that set the clone up and install them.
 *
 * @param {object} [o]
 * @param {string} [o.branch]    the branch the clone follows; default main
 * @param {string} [o.clone]     where the clone lives
 * @param {string} [o.checkout]  the harness checkout the clone is set up from
 * @param {string} [o.user]      the owner of both
 * @returns {{ service: string, timer: string, setup: string[], install: string[], uninstall: string[] }}
 */
export function scenarioUnits({ branch = 'main', clone = SCENARIO_CLONE, checkout = '/var/lib/paraclete/harness2-repo', user = 'paraclete' } = {}) {
  for (const [name, value] of [['branch', branch], ['clone', clone], ['checkout', checkout], ['user', user]]) {
    if (!SAFE.test(String(value))) throw new Error(`--${name} has characters a unit file cannot hold: ${value}`);
  }
  const service = [
    '[Unit]',
    "Description=Paraclete canary scenarios: send the batteries' due steps (dev/harness2/cli.mjs scenarios)",
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `User=${user}`,
    `WorkingDirectory=${clone}`,
    `ExecStartPre=/usr/bin/git -C ${clone} pull --ff-only --quiet origin ${branch}`,
    `ExecStart=/usr/bin/node ${clone}/dev/harness2/cli.mjs scenarios --battery all`,
    // Every battery in one call, so their steps go one at a time and never contend for the state's lock.
    // A call killed here leaves its lock, which the next call takes over once it is 3 hours old
    // (scenarios.mjs), so the limit never stops the batteries for long.
    'TimeoutStartSec=3h',
    'Nice=10',
    '',
  ].join('\n');
  const timer = [
    '[Unit]',
    "Description=Send the Paraclete canary scenarios' due steps every hour",
    '',
    '[Timer]',
    'OnCalendar=hourly',
    'RandomizedDelaySec=5min',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  const dir = '/usr/local/lib/systemd/system';
  const asUser = (cmd) => `sudo -u ${user} ${cmd}`;
  return {
    service,
    timer,
    setup: [
      asUser(`git clone --quiet ${checkout} ${clone}`),
      asUser(`sh -c 'git -C ${clone} remote set-url origin "$(git -C ${checkout} remote get-url origin)"'`),
      asUser(`git -C ${clone} fetch --quiet origin ${branch}`),
      asUser(`git -C ${clone} checkout --quiet -B ${branch} FETCH_HEAD`),
      asUser(`install -d ${clone}/.local`),
      asUser(`ln -s ${checkout}/.local/instance.env ${clone}/.local/instance.env`),
      asUser(`sh -c 'test ! -e ${checkout}/.local/denylist.txt || ln -s ${checkout}/.local/denylist.txt ${clone}/.local/denylist.txt'`),
      asUser(`ln -s ${checkout}/agent/node_modules ${clone}/agent/node_modules`),
    ],
    install: [
      `sudo install -d ${dir}`,
      `sudo tee ${dir}/${SCENARIO_UNIT}.service   # paste the service unit`,
      `sudo tee ${dir}/${SCENARIO_UNIT}.timer     # paste the timer unit`,
      'sudo systemctl daemon-reload',
      `sudo systemctl enable --now ${SCENARIO_UNIT}.timer`,
    ],
    uninstall: [
      `sudo systemctl disable --now ${SCENARIO_UNIT}.timer`,
      `sudo rm -f ${dir}/${SCENARIO_UNIT}.service ${dir}/${SCENARIO_UNIT}.timer`,
      'sudo systemctl daemon-reload',
      `sudo rm -rf ${clone}   # the clone, with the batteries' state and harvests, once nothing of it is wanted`,
    ],
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--branch') o.branch = argv[++i];
    else if (a === '--clone') o.clone = argv[++i];
    else if (a === '--checkout') o.checkout = argv[++i];
    else if (a === '--user') o.user = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  return o;
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`${opts.error}\n`);
    return 2;
  }
  try {
    const u = scenarioUnits(opts);
    stdout.write([
      `# ${SCENARIO_UNIT}.service`, u.service,
      `# ${SCENARIO_UNIT}.timer`, u.timer,
      '# To set the clone up, on the driver:', ...u.setup, '',
      '# To install, on the driver:', ...u.install, '',
      '# To take it off:', ...u.uninstall, '',
    ].join('\n'));
    return 0;
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
