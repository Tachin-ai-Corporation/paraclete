// agent/services/control/upgrade.mjs: moving the instance to a release tag or a commit. It checks the
// ref against a strict pattern, then starts the installer's upgrade script in its own transient
// systemd unit and reads back how that unit ended. The script is install/upgrade.sh under the install
// root; what it does (fetching that ref's upgrader, installing, migrating, restarting) is the
// installer's. commands.mjs runs the command; command-queue.mjs records the outcome.
//
// Why a unit of its own: an upgrade restarts every service, control included. A script that ran as
// control's child would be killed halfway through by that restart, leaving a half-installed release.
// In its own unit it runs to the end, and the restarted control service finds it by the unit name
// recorded on the command before it started.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { upgradeUnit } from './systemd.mjs';

/** The longest an upgrade may run before systemd stops it. Default; callers pass the contracts value. */
export const UPGRADE_MAX_SECONDS = 1800;

/** How much of the upgrade's log the command result keeps. */
const LOG_LINES = 200;
const LOG_MAX_CHARS = 16_000;

/** A full commit id. Short ids are refused: they can become ambiguous, and branches can move. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Letters, digits and dots, not starting with a dash. Independent of the release pattern from the
 * contracts, so a looser pattern there can never let an option or a path reach the script.
 */
const SAFE_REF = /^[0-9A-Za-z][0-9A-Za-z.]{0,63}$/;

const REF_HINT = 'a release tag such as v2026.10.17.1.1, or a full 40-character commit id';

/**
 * Whether a ref names a release or a commit. A release must match the contracts' version pattern in
 * full; anything else, branch names included, is refused.
 *
 * @param {*} ref
 * @param {{releasePattern: string}} o the contracts' versioning.canonical_regex
 * @returns {{ok: true, kind: 'release'|'commit', ref: string} | {ok: false, reason: string}}
 */
export function checkRef(ref, { releasePattern }) {
  if (typeof ref !== 'string' || ref === '') return { ok: false, reason: `params.ref is required: ${REF_HINT}` };
  if (COMMIT_PATTERN.test(ref)) return { ok: true, kind: 'commit', ref };
  if (SAFE_REF.test(ref)) {
    const match = ref.match(new RegExp(releasePattern));
    if (match && match[0] === ref) return { ok: true, kind: 'release', ref };
  }
  return { ok: false, reason: `'${ref.slice(0, 80)}' is not ${REF_HINT}; branches and short commit ids are refused` };
}

/**
 * Where the installer puts the upgrade script.
 *
 * @param {string} installRoot
 * @returns {string}
 */
export function upgradeScript(installRoot) {
  return join(installRoot, 'install', 'upgrade.sh');
}

/**
 * Starts an upgrade. Records the unit on the command first, then starts it: a control service that
 * stops between the two finds a unit that never started and says so, instead of losing track of one
 * that did.
 *
 * @param {object}   o
 * @param {string}   o.commandId
 * @param {*}        o.ref
 * @param {string}   o.installRoot
 * @param {string}   o.releasePattern  the contracts' versioning.canonical_regex
 * @param {object}   o.systemd         from createSystemd()
 * @param {Function} o.record          async (detached) => void; stores the record on the command
 * @param {Function} [o.exists]        (path) => boolean (injectable for tests)
 * @param {number}   [o.maxSeconds]
 * @param {Function} [o.now]           () => ISO timestamp
 * @returns {Promise<{unit: string, ref: string, kind: string, started_at: string}>}
 */
export async function startUpgrade({
  commandId, ref, installRoot, releasePattern, systemd, record,
  exists = existsSync, maxSeconds = UPGRADE_MAX_SECONDS, now = () => new Date().toISOString(),
}) {
  const check = checkRef(ref, { releasePattern });
  if (!check.ok) throw new Error(check.reason);
  const script = upgradeScript(installRoot);
  if (!exists(script)) {
    throw new Error(`the upgrade script ${script} is not installed, so this instance cannot upgrade itself; `
      + 'install the release with the installer instead');
  }
  const detached = { unit: upgradeUnit(commandId), ref: check.ref, kind: check.kind, started_at: now() };
  await record(detached);
  await systemd.startUpgrade(detached.unit, [script, '--ref', check.ref], {
    description: `paraclete upgrade to ${check.ref}`,
    maxSeconds,
  });
  return detached;
}

/**
 * How a started upgrade stands. Unfinished: `{finished: false}`. Finished: its exit status and the
 * tail of its log, and the unit is unloaded. A unit systemd no longer knows (the VM restarted, or the
 * unit never started) is a failure whose outcome is unknown, never a success.
 *
 * @param {{unit: string, ref: string, kind: string}} detached the record startUpgrade() stored
 * @param {{systemd: object}} o
 * @returns {Promise<{finished: false} | {finished: true, ok: boolean, result: object, error?: string}>}
 */
export async function upgradeOutcome(detached, { systemd }) {
  const { unit, ref, kind } = detached;
  const state = await systemd.upgradeState(unit);
  if (state.load === 'not-found') {
    return {
      finished: true,
      ok: false,
      result: { ref, kind, unit },
      error: `the upgrade unit ${unit} is gone, so how the upgrade to ${ref} ended is unknown (the VM may have `
        + 'restarted while it ran, or it never started); check the version the instance reports before trying again',
    };
  }
  const succeeded = state.active === 'active' && state.sub === 'exited';
  if (!succeeded && state.active !== 'failed' && state.active !== 'inactive') return { finished: false };

  let output;
  try {
    output = tail(await systemd.upgradeLog(unit, LOG_LINES), LOG_MAX_CHARS);
  } catch (err) {
    output = `(the upgrade log could not be read: ${err.message})`;
  }
  await systemd.releaseUpgrade(unit);
  const result = { ref, kind, unit, exit_status: state.exit_status, outcome: state.result, output };
  if (succeeded && state.exit_status === 0) return { finished: true, ok: true, result };
  const how = state.active === 'inactive' ? 'was stopped before it finished'
    : `failed (${state.result || 'unknown'}${state.exit_status != null ? `, exit status ${state.exit_status}` : ''})`;
  return { finished: true, ok: false, result, error: `the upgrade to ${ref} ${how}; its output is in the result` };
}

function tail(text, maxChars) {
  const s = String(text ?? '');
  return s.length <= maxChars ? s : `[… ${s.length - maxChars} earlier characters omitted …]\n${s.slice(s.length - maxChars)}`;
}
