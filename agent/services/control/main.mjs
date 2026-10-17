// agent/services/control/main.mjs: the control service's entry point: the dashboard's bridge to the
// VM. It polls the root `commands` collection and carries out each command (command-queue.mjs,
// commands.mjs). It is the one service that runs as root, because it restarts services and runs
// upgrades; README.md explains how that privilege is fenced. systemd starts it
// (paraclete-control.service).

import { pathToFileURL } from 'node:url';
import { createServiceRuntime } from '../service-runtime.mjs';
import { createSystemd } from './systemd.mjs';
import { createCommandQueue } from './command-queue.mjs';
import { createHandlers } from './commands.mjs';
import { UPGRADE_MAX_SECONDS } from './upgrade.mjs';

/** Timings. Defaults; the contracts' `control` section overrides each one it sets. */
export const DEFAULT_CONTROL_SETTINGS = Object.freeze({
  pollMs: 5_000,
  readyTimeoutMs: 30_000,
  upgradeMaxSeconds: UPGRADE_MAX_SECONDS,
});

/**
 * The control service's timings from the contracts, each falling back to its default.
 *
 * @param {object} contracts
 * @returns {{pollMs: number, readyTimeoutMs: number, upgradeMaxSeconds: number}}
 */
export function controlSettings(contracts) {
  const c = contracts?.control || {};
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return {
    pollMs: pos(c.poll_ms, DEFAULT_CONTROL_SETTINGS.pollMs),
    readyTimeoutMs: pos(c.gateway_ready_timeout_ms, DEFAULT_CONTROL_SETTINGS.readyTimeoutMs),
    upgradeMaxSeconds: pos(c.upgrade_max_seconds, DEFAULT_CONTROL_SETTINGS.upgradeMaxSeconds),
  };
}

/**
 * Builds the control service from a runtime, without starting it. Ticks never overlap: the next one
 * is scheduled when the last one ends.
 *
 * @param {object}   runtime          from createServiceRuntime({ service: 'control' })
 * @param {object}   [deps]           injectable for tests
 * @param {object}   [deps.systemd]   from createSystemd(), or a fake of its shape
 * @param {Function} [deps.readText]
 * @param {Function} [deps.exists]
 * @param {Function} [deps.now]       () => Date
 * @param {Function} [deps.sleep]     (ms) => Promise
 * @param {Function} [deps.setTimer]  setTimeout
 * @param {Function} [deps.clearTimer] clearTimeout
 * @returns {{queue: object, handlers: object, settings: object, start: Function, stop: Function}}
 */
export function buildControl(runtime, deps = {}) {
  const {
    systemd = createSystemd(),
    readText,
    exists,
    now = () => new Date(),
    sleep,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;
  const settings = controlSettings(runtime.contracts);
  const handlers = createHandlers({ runtime, systemd, settings, now, sleep, ...(readText ? { readText } : {}), ...(exists ? { exists } : {}) });
  const queue = createCommandQueue({ db: runtime.db, collections: runtime.collections, handlers, log: runtime.log, now });

  let timer = null;
  let stopped = false;
  let current = Promise.resolve();

  async function tickSafely() {
    try {
      await queue.tick();
    } catch (err) {
      runtime.log('ERROR', `command poll failed: ${err.message}; trying again in ${settings.pollMs}ms`);
    }
  }
  function loop() {
    current = tickSafely().then(() => {
      if (!stopped) timer = setTimer(loop, settings.pollMs);
    });
  }

  return {
    queue,
    handlers,
    settings,
    /** Runs the first tick now and keeps polling. */
    start() {
      loop();
    },
    /** Stops polling and resolves once the command in progress, if any, has been recorded. */
    async stop() {
      stopped = true;
      clearTimer(timer);
      await current;
    },
  };
}

/**
 * Starts the control service and stops it cleanly on SIGTERM or SIGINT.
 *
 * @param {object}   [deps]
 * @param {Function} [deps.createRuntime]
 * @param {object}   [deps.processRef]
 * @returns {object} the running service
 */
export function main({ createRuntime = createServiceRuntime, processRef = process, ...deps } = {}) {
  const runtime = createRuntime({ service: 'control' });
  const control = buildControl(runtime, deps);
  runtime.log('INFO', `polling ${runtime.collections.commands} every ${control.settings.pollMs}ms`);
  control.start();

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    runtime.log('INFO', `${signal}: finishing the command in progress, then stopping`);
    control.stop().then(() => processRef.exit(0));
  };
  processRef.once('SIGTERM', () => stop('SIGTERM'));
  processRef.once('SIGINT', () => stop('SIGINT'));
  return control;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'ERROR', service: 'control', message: `cannot start: ${err.message}` })}\n`);
    process.exit(1);
  }
}
