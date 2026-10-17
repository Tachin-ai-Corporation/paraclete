// agent/services/control/systemd.mjs: the control service's only way to touch systemd. It holds the
// fixed list of paraclete services control may inspect or restart, the one pattern of transient unit
// it may start (an upgrade), and the systemctl, systemd-run and journalctl calls it makes. Every call
// passes its arguments as an array to execFile, never through a shell, and every unit name comes from
// the list or the pattern. It decides nothing about when to act: commands.mjs and upgrade.mjs do.

import { execFile } from 'node:child_process';

/** The services control may report on and restart. Nothing else is ever named to systemctl. */
export const SERVICES = Object.freeze(['gateway', 'brain', 'ears', 'mouth', 'control']);

/** The only transient units control starts: one per upgrade command. */
const UPGRADE_UNIT_PATTERN = /^paraclete-upgrade-[A-Za-z0-9]{1,64}\.service$/;

const SHOW_PROPERTIES = Object.freeze([
  'LoadState', 'ActiveState', 'SubState', 'Result', 'MainPID', 'NRestarts', 'ExecMainStatus', 'ActiveEnterTimestamp',
]);

const CALL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * The systemd unit of a paraclete service.
 *
 * @param {string} service one of SERVICES
 * @returns {string} e.g. 'paraclete-gateway.service'
 */
export function serviceUnit(service) {
  if (!SERVICES.includes(service)) {
    throw new Error(`'${service}' is not a paraclete service (expected one of ${SERVICES.join(', ')})`);
  }
  return `paraclete-${service}.service`;
}

/**
 * The transient unit an upgrade command runs in. Derived from the command id, so a restarted control
 * service finds the same unit again; anything but letters and digits is dropped.
 *
 * @param {string} commandId
 * @returns {string} e.g. 'paraclete-upgrade-a1B2c3.service'
 */
export function upgradeUnit(commandId) {
  const tag = String(commandId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  if (!tag) throw new Error(`no upgrade unit name can be made from command id '${commandId}'`);
  return `paraclete-upgrade-${tag}.service`;
}

function checkUpgradeUnit(unit) {
  if (!UPGRADE_UNIT_PATTERN.test(unit)) throw new Error(`'${unit}' is not an upgrade unit`);
}

/**
 * `systemctl show` output (Key=Value lines) as an object.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseShow(text) {
  const props = {};
  for (const line of String(text ?? '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return props;
}

/**
 * The parts of a unit's properties the dashboard shows. Numbers that systemd reports as empty (a unit
 * that never ran has no exit status) come back as null.
 *
 * @param {Record<string, string>} props from parseShow()
 * @returns {{load: string, active: string, sub: string, result: string|null, main_pid: number|null,
 *   restarts: number|null, exit_status: number|null, since: string|null}}
 */
export function unitState(props) {
  const int = (v) => (/^-?\d+$/.test(v ?? '') ? Number(v) : null);
  return {
    load: props.LoadState || 'unknown',
    active: props.ActiveState || 'unknown',
    sub: props.SubState || 'unknown',
    result: props.Result || null,
    main_pid: int(props.MainPID),
    restarts: int(props.NRestarts),
    exit_status: int(props.ExecMainStatus),
    since: props.ActiveEnterTimestamp || null,
  };
}

/**
 * Runs a program with an argument array, no shell. Rejects with the program's stderr in the message.
 *
 * @param {object} [o]
 * @param {number} [o.timeoutMs]
 * @returns {(file: string, args: string[]) => Promise<{stdout: string, stderr: string}>}
 */
export function execFileRunner({ timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      const detail = String(stderr || '').trim().split('\n')[0] || err.message;
      reject(Object.assign(new Error(`${file} ${args.join(' ')} failed: ${detail}`), { code: err.code, stdout, stderr }));
    });
  });
}

/**
 * The systemd calls control makes.
 *
 * @param {object}   [o]
 * @param {Function} [o.run] (file, args) => Promise<{stdout, stderr}> (injectable for tests)
 */
export function createSystemd({ run = execFileRunner() } = {}) {
  async function show(unit) {
    const { stdout } = await run('systemctl', ['show', unit, `--property=${SHOW_PROPERTIES.join(',')}`]);
    return unitState(parseShow(stdout));
  }

  return {
    /** A paraclete service's state. */
    async serviceState(service) {
      const unit = serviceUnit(service);
      return { service, unit, ...(await show(unit)) };
    },

    /**
     * Restarts a paraclete service. With noBlock, systemd queues the restart and this returns at
     * once: the only way for control to restart itself and still finish the command first.
     */
    async restart(service, { noBlock = false } = {}) {
      await run('systemctl', ['restart', ...(noBlock ? ['--no-block'] : []), serviceUnit(service)]);
    },

    /**
     * Starts an upgrade unit: a transient service outside control's own process group and sandbox, so
     * restarting control does not stop it. It stays loaded after it exits (RemainAfterExit), so its
     * outcome can be read, and is stopped after maxSeconds.
     *
     * @param {string}   unit       from upgradeUnit()
     * @param {string[]} argv       the program and its arguments
     * @param {object}   o
     * @param {string}   o.description
     * @param {number}   o.maxSeconds
     */
    async startUpgrade(unit, argv, { description, maxSeconds }) {
      checkUpgradeUnit(unit);
      await run('systemd-run', [
        `--unit=${unit}`,
        `--description=${description}`,
        '--property=RemainAfterExit=yes',
        `--property=RuntimeMaxSec=${Math.max(1, Math.floor(maxSeconds))}`,
        '--',
        ...argv,
      ]);
    },

    /** An upgrade unit's state; `load: 'not-found'` once systemd no longer knows it. */
    async upgradeState(unit) {
      checkUpgradeUnit(unit);
      return show(unit);
    },

    /** The last lines an upgrade unit logged. */
    async upgradeLog(unit, lines) {
      checkUpgradeUnit(unit);
      const { stdout } = await run('journalctl', [`--unit=${unit}`, '--no-pager', '--output=cat', `--lines=${lines}`]);
      return stdout;
    },

    /** Unloads a finished upgrade unit. Best effort: a unit already gone is fine. */
    async releaseUpgrade(unit) {
      checkUpgradeUnit(unit);
      for (const args of [['stop', unit], ['reset-failed', unit]]) {
        try { await run('systemctl', args); } catch { /* already stopped or unloaded */ }
      }
    },
  };
}
