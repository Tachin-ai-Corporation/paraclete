// dev/harness2/lab-updater.mjs: what keeps the harness lab's VMs on main's head, and the commands that
// put it on them. Lab only: a product instance moves only to the releases its dashboard offers, never
// to main, and nothing here is in install/manifest.txt. It builds the systemd units
// paraclete-lab-follow-main.timer and .service, the root scripts that install or remove them with the
// updater (lab-follow-main.sh, which does the work on the VM), and the one-line remote command that
// carries a script to a VM over `gcloud compute ssh`; and it reads back what those scripts print. It
// runs nothing itself: live-runner.mjs (provisionGcpLab, manageLabFollowMain, inspectGcpLabStatus)
// runs the commands over IAP SSH, and `node dev/harness2/cli.mjs lab-follow-main` calls it.
//
// The units live in /usr/local/lib/systemd/system, not /etc/systemd/system: install/bootstrap.sh
// takes every /etc/systemd/system/paraclete-*.service for one of the agent's services, stops it for an
// upgrade and removes it when a release does not ship it. There, the updater would stop itself in the
// middle of the upgrade it started, and the first upgrade would delete it.

import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

export const FOLLOW_MAIN = Object.freeze({
  unit: 'paraclete-lab-follow-main',
  timerUnit: 'paraclete-lab-follow-main.timer',
  serviceUnit: 'paraclete-lab-follow-main.service',
  /** The updater, root's, read-only to the agent's user. */
  script: '/usr/local/sbin/paraclete-lab-follow-main',
  unitDir: '/usr/local/lib/systemd/system',
  /** The driver's harness checkout, owned by the paraclete user. */
  harnessCheckout: '/var/lib/paraclete/harness2-repo',
  busyFile: '/var/lib/paraclete/lab-follow-main.busy-since',
  upgradeLog: '/var/log/paraclete-lab-follow-main-upgrade.log',
  defaultIntervalMinutes: 30,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 24 * 60,
});

const HEREDOC_END = 'PARACLETE_LAB_FOLLOW_MAIN_EOF';
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The timer's interval in minutes: the default when none is given, else a whole number of minutes from
 * 5 to 1440. Throws on anything else.
 *
 * @param {string|number|boolean|undefined} value  --interval as given
 * @returns {number}
 */
export function parseIntervalMinutes(value) {
  if (value === undefined || value === null) return FOLLOW_MAIN.defaultIntervalMinutes;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`--interval must be a whole number of minutes, got '${String(value).slice(0, 40)}'`);
  }
  const minutes = Number(text);
  if (minutes < FOLLOW_MAIN.minIntervalMinutes || minutes > FOLLOW_MAIN.maxIntervalMinutes) {
    throw new Error(`--interval must be from ${FOLLOW_MAIN.minIntervalMinutes} to ${FOLLOW_MAIN.maxIntervalMinutes} minutes, got ${minutes}`);
  }
  return minutes;
}

/** The updater script (lab-follow-main.sh), as it is installed. */
export function followMainScript() {
  return readFileSync(new URL('./lab-follow-main.sh', import.meta.url), 'utf8');
}

/** The updater's arguments on one VM: the driver's harness checkout, or none. */
function updaterArgs(harnessCheckout) {
  if (!harnessCheckout) return [];
  if (!ABSOLUTE_PATH.test(harnessCheckout)) {
    throw new Error(`the harness checkout must be an absolute path without spaces, got '${harnessCheckout}'`);
  }
  return ['--harness-checkout', harnessCheckout];
}

/**
 * The two systemd units: a oneshot service that runs the updater as root, and the timer that starts
 * it `intervalMinutes` after the timer starts (at boot, or on install) and then that long after each
 * run began.
 *
 * @param {object} [o]
 * @param {number} [o.intervalMinutes]
 * @param {string|null} [o.harnessCheckout]  the driver's checkout; null on the canary
 * @returns {{service: string, timer: string}}
 */
export function followMainUnits({ intervalMinutes = FOLLOW_MAIN.defaultIntervalMinutes, harnessCheckout = null } = {}) {
  const minutes = parseIntervalMinutes(intervalMinutes);
  const execStart = [FOLLOW_MAIN.script, ...updaterArgs(harnessCheckout)].join(' ');
  const service = `# ${FOLLOW_MAIN.unitDir}/${FOLLOW_MAIN.serviceUnit}: written by dev/harness2/lab-updater.mjs on
# a harness lab VM only. A product instance never has it: it moves to the releases its dashboard offers.
[Unit]
Description=Harness lab: move this VM to main's head (lab only)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${execStart}
SyslogIdentifier=${FOLLOW_MAIN.unit}
# An upgrade must never be cut off halfway, so a run has no time limit.
TimeoutStartSec=infinity
`;
  const timer = `# ${FOLLOW_MAIN.unitDir}/${FOLLOW_MAIN.timerUnit}: written by dev/harness2/lab-updater.mjs on
# a harness lab VM only.
[Unit]
Description=Harness lab: follow main every ${minutes} minutes (lab only)

[Timer]
OnActiveSec=${minutes}min
OnUnitActiveSec=${minutes}min
AccuracySec=1min

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** `root` for the scripts below: a directory every path they write is under, for the tests. */
function rootLine(root) {
  if (root && !/^[A-Za-z0-9._:/ -]+$/.test(root)) throw new Error(`unusable root '${root}'`);
  return `ROOT='${root || ''}'`;
}

function heredoc(text) {
  if (text.split('\n').includes(HEREDOC_END)) throw new Error(`a file to install contains the line ${HEREDOC_END}`);
  return `<<'${HEREDOC_END}'\n${text.endsWith('\n') ? text : `${text}\n`}${HEREDOC_END}`;
}

/**
 * The root script that installs the updater and its units and enables the timer. Idempotent: a file
 * whose content is already right is not written again, systemd reloads only when a file changed, and a
 * timer already running on the same units is left running. A file is replaced by rename, so a run in
 * progress keeps reading the script it started with. Prints lab-follow-main.<key>=<value> lines.
 *
 * @param {object} [o]
 * @param {number} [o.intervalMinutes]
 * @param {string|null} [o.harnessCheckout]
 * @param {string} [o.root]  prefix for every path written; '' on a VM
 */
export function followMainInstallScript({ intervalMinutes, harnessCheckout = null, root = '' } = {}) {
  const minutes = parseIntervalMinutes(intervalMinutes);
  const units = followMainUnits({ intervalMinutes: minutes, harnessCheckout });
  const { unit, script, unitDir, serviceUnit, timerUnit } = FOLLOW_MAIN;
  return `set -euo pipefail
${rootLine(root)}
UNIT=${unit}
TMP=''
trap 'rm -f "$TMP"' EXIT
changed=0
put() {  # put <mode> <file> < content: replaces the file by rename, and only when its content differs
  TMP="$(mktemp "$2.XXXXXX")"
  cat > "$TMP"
  if [[ -f "$2" ]] && cmp -s "$TMP" "$2"; then
    rm -f "$TMP"
  else
    chmod "$1" "$TMP"
    mv -fT "$TMP" "$2"
    changed=1
  fi
  TMP=''
  chmod "$1" "$2"
}
install -d -m 0755 "$ROOT${script.slice(0, script.lastIndexOf('/'))}" "$ROOT${unitDir}"
put 0755 "$ROOT${script}" ${heredoc(followMainScript())}
put 0644 "$ROOT${unitDir}/${serviceUnit}" ${heredoc(units.service)}
put 0644 "$ROOT${unitDir}/${timerUnit}" ${heredoc(units.timer)}
if (( changed )); then systemctl daemon-reload; fi
systemctl enable --quiet "$UNIT.timer"
if (( changed )) || ! systemctl is-active --quiet "$UNIT.timer"; then systemctl restart "$UNIT.timer"; fi
if (( changed )); then state=changed; else state=unchanged; fi
printf 'lab-follow-main.installed=%s\\n' "$state"
printf 'lab-follow-main.interval_minutes=%s\\n' ${minutes}
printf 'lab-follow-main.timer_enabled=%s\\n' "$(systemctl is-enabled "$UNIT.timer" 2>/dev/null || true)"
printf 'lab-follow-main.timer_active=%s\\n' "$(systemctl is-active "$UNIT.timer" 2>/dev/null || true)"
`;
}

/**
 * The root script that stops and disables the timer and removes the updater, its units, its busy-since
 * file and its upgrade log. It never stops a run in progress (that could be an upgrade halfway
 * through): it reports one, which finishes on its own. Safe to run twice.
 *
 * @param {object} [o]
 * @param {string} [o.root]
 */
export function followMainUninstallScript({ root = '' } = {}) {
  const { unit, script, unitDir, serviceUnit, timerUnit, busyFile, upgradeLog } = FOLLOW_MAIN;
  return `set -uo pipefail
${rootLine(root)}
UNIT=${unit}
systemctl disable --now --quiet "$UNIT.timer" 2>/dev/null || true
running="$(systemctl is-active "$UNIT.service" 2>/dev/null || true)"
removed=no
for file in "$ROOT${unitDir}/${timerUnit}" "$ROOT${unitDir}/${serviceUnit}" "$ROOT${script}"; do
  if [[ -e "$file" ]]; then rm -f "$file"; removed=yes; fi
done
if [[ "$removed" == yes ]]; then systemctl daemon-reload; fi
systemctl reset-failed "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
rm -f "$ROOT${busyFile}" "$ROOT${upgradeLog}"
printf 'lab-follow-main.removed=%s\\n' "$removed"
printf 'lab-follow-main.service_active=%s\\n' "$running"
`;
}

/**
 * The remote command that runs `script` as root on a VM: one line, the script gzipped and in base64,
 * so no shell or SSH client on the way (PuTTY's on Windows included) can re-quote it. stdin is
 * /dev/null, so nothing the script runs can wait on the terminal.
 *
 * @param {string} script
 * @param {string[]} [args]  the script's arguments; fixed words, never user input
 * @returns {string}
 */
export function followMainRemoteCommand(script, args = []) {
  for (const arg of args) {
    if (!/^[A-Za-z0-9._/=-]+$/.test(arg)) throw new Error(`unsafe argument '${arg}'`);
  }
  const encoded = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
  return [`sudo bash -c "$(echo ${encoded} | base64 -d | gunzip)"`, FOLLOW_MAIN.unit, ...args, '< /dev/null'].join(' ');
}

/**
 * The script and arguments a followMainRemoteCommand() carries, for the tests' fake VMs.
 *
 * @param {string} command
 * @returns {{script: string, args: string[]}|null}
 */
export function decodeFollowMainRemoteCommand(command) {
  const m = /^sudo bash -c "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d \| gunzip\)" (\S+)((?: \S+)*?) < \/dev\/null$/.exec(String(command));
  if (!m || m[2] !== FOLLOW_MAIN.unit) return null;
  return { script: gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8'), args: m[3].split(' ').filter(Boolean) };
}

/**
 * The remote command for one action on one lab VM: the install script, the uninstall script, or the
 * updater itself with --status.
 *
 * @param {'install'|'uninstall'|'status'} action
 * @param {{harnessCheckout?: string|null}} vm
 * @param {{intervalMinutes?: number}} [o]
 */
export function followMainCommandFor(action, vm, { intervalMinutes } = {}) {
  const harnessCheckout = vm.harnessCheckout || null;
  if (action === 'install') return followMainRemoteCommand(followMainInstallScript({ intervalMinutes, harnessCheckout }));
  if (action === 'uninstall') return followMainRemoteCommand(followMainUninstallScript());
  if (action === 'status') return followMainRemoteCommand(followMainScript(), ['--status', ...updaterArgs(harnessCheckout)]);
  throw new Error(`unknown lab-follow-main action '${action}'`);
}

/**
 * The lab-follow-main.<key>=<value> lines of a script's output. Anything else (gcloud's own notes)
 * is ignored.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseFollowMainOutput(text) {
  const fields = {};
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const m = /^lab-follow-main\.([a-z_]+)=(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

/**
 * One VM's follow-main state from the updater's --status fields.
 *
 * @param {Record<string, string>} fields
 */
export function followMainStatusFrom(fields) {
  const value = (v) => (v && v !== 'n/a' ? v : null);
  const commit = (v) => (COMMIT.test(v || '') ? v : null);
  const enabled = value(fields.timer_enabled);
  const active = value(fields.timer_active);
  const installed = commit(fields.installed);
  const head = commit(fields.head);
  let timer = 'not installed';
  if (enabled && enabled !== 'not-found') timer = enabled === 'enabled' && active === 'active' ? 'active' : `${enabled}, ${active || 'unknown'}`;
  const busySince = /^\d{1,12}$/.test(fields.busy_since || '') ? new Date(Number(fields.busy_since) * 1000).toISOString() : null;
  return {
    timer,
    running: fields.service_active === 'active' || fields.service_active === 'activating',
    lastRun: value(fields.last_run),
    lastResult: value(fields.last_result),
    lastLine: value(fields.last_line),
    repo: value(fields.repo),
    installed,
    mainHead: head,
    onMainHead: installed && head ? installed === head : null,
    agent: value(fields.agent) || 'idle',
    busySince,
    ...(fields.checkout !== undefined ? { checkout: value(fields.checkout) } : {}),
  };
}

/**
 * What one action's output says, as a result for the VM: ok when the script got to its end.
 *
 * @param {'install'|'uninstall'|'status'} action
 * @param {Record<string, string>} fields
 */
export function followMainResult(action, fields) {
  if (action === 'install') {
    const ok = fields.installed === 'changed' || fields.installed === 'unchanged';
    return {
      ok,
      ...(ok ? {} : { error: 'the install script did not finish' }),
      installed: fields.installed || null,
      intervalMinutes: fields.interval_minutes ? Number(fields.interval_minutes) : null,
      timer: followMainStatusFrom(fields).timer,
    };
  }
  if (action === 'uninstall') {
    const ok = fields.removed === 'yes' || fields.removed === 'no';
    const running = fields.service_active === 'active' || fields.service_active === 'activating';
    return {
      ok,
      ...(ok ? {} : { error: 'the uninstall script did not finish' }),
      removed: fields.removed === 'yes',
      ...(running ? { note: 'a run was in progress; it finishes on its own' } : {}),
    };
  }
  const ok = 'timer_active' in fields && 'installed' in fields;
  return { ok, ...(ok ? {} : { error: 'the status probe did not finish' }), ...followMainStatusFrom(fields) };
}
