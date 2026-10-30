// dev/loop/timer.mjs: the systemd units that run one loop cycle (cycle.mjs) on a schedule on the
// harness lab's driver, and how to put them on. It only prints: nothing installs the timer, and no
// install or provisioning step puts it on, so the loop runs on a schedule only once a person installs
// it by hand. The cycle runs as the harness checkout's owner, from that checkout, which the lab's
// follow-main timer keeps on main's head: each cycle runs the loop as it stands on main.
//
//   node dev/loop/timer.mjs [--interval-hours <h>] [--checkout <dir>] [--user <name>] [--repo <owner/name>]

import { pathToFileURL } from 'node:url';

export const LOOP_UNIT = 'paraclete-loop-cycle';

/** A value that goes into a unit file unquoted: no spaces, quotes or shell characters. */
const SAFE = /^[A-Za-z0-9_./@:-]+$/;

/**
 * The service and timer units, and the commands that install them.
 *
 * @param {object} [o]
 * @param {number} [o.intervalHours]  between cycles; default 6 (the loop's daily cap stops it anyway)
 * @param {string} [o.checkout]       the harness checkout on the driver
 * @param {string} [o.user]           its owner
 * @param {string} [o.repo]           owner/name for gh, when the checkout's remote does not say
 * @returns {{ service: string, timer: string, install: string[], uninstall: string[] }}
 */
export function loopUnits({ intervalHours = 6, checkout = '/var/lib/paraclete/harness2-repo', user = 'paraclete', repo } = {}) {
  const hours = Number(intervalHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error('--interval-hours must be a whole number from 1 to 24');
  for (const [name, value] of [['checkout', checkout], ['user', user], ...(repo ? [['repo', repo]] : [])]) {
    if (!SAFE.test(value)) throw new Error(`--${name} has characters a unit file cannot hold: ${value}`);
  }
  const service = [
    '[Unit]',
    'Description=Paraclete self-improvement loop: one cycle (dev/loop/cycle.mjs)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `User=${user}`,
    `WorkingDirectory=${checkout}`,
    `ExecStart=/usr/bin/node dev/loop/cycle.mjs${repo ? ` --repo ${repo}` : ''}`,
    // A change to what the agent reads is measured on both sides, three real-model runs of each model
    // suite task (42 a side, and more for a target or a task that looks worse), about 8 minutes each; a
    // cycle never runs twice at once, so a long one only delays the next.
    'TimeoutStartSec=20h',
    'Nice=10',
    '',
  ].join('\n');
  const timer = [
    '[Unit]',
    `Description=Run a Paraclete loop cycle every ${hours} hour(s)`,
    '',
    '[Timer]',
    'OnBootSec=15min',
    `OnUnitActiveSec=${hours}h`,
    'RandomizedDelaySec=10min',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  const dir = '/usr/local/lib/systemd/system';
  return {
    service,
    timer,
    install: [
      `sudo install -d ${dir}`,
      `sudo tee ${dir}/${LOOP_UNIT}.service   # paste the service unit`,
      `sudo tee ${dir}/${LOOP_UNIT}.timer     # paste the timer unit`,
      'sudo systemctl daemon-reload',
      `sudo systemctl enable --now ${LOOP_UNIT}.timer`,
    ],
    uninstall: [
      `sudo systemctl disable --now ${LOOP_UNIT}.timer`,
      `sudo rm -f ${dir}/${LOOP_UNIT}.service ${dir}/${LOOP_UNIT}.timer`,
      'sudo systemctl daemon-reload',
    ],
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--interval-hours') o.intervalHours = Number(argv[++i]);
    else if (a === '--checkout') o.checkout = argv[++i];
    else if (a === '--user') o.user = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
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
    const u = loopUnits(opts);
    stdout.write([
      `# ${LOOP_UNIT}.service`, u.service,
      `# ${LOOP_UNIT}.timer`, u.timer,
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
