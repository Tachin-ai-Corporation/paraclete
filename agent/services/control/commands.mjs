// agent/services/control/commands.mjs: the closed set of commands the dashboard may send the VM, and
// what each one does. There is no way to run an arbitrary program: each command checks its params
// strictly and calls the module that does the work, and the only programs control ever starts are
// systemctl, systemd-run and journalctl on allowlisted units (systemd.mjs) and the installer's upgrade
// script (upgrade.mjs). Two commands write outside Firestore: drive_check creates and trashes a single
// test file in the admin's Drive output folder (drive-check.mjs), and set_workspace_account writes the
// two files that hold the agent's Workspace account, /etc/paraclete/workspace.json and instance.json,
// and no other (workspace-account.mjs). claude_check sends each Claude model the contracts list one
// short message on Vertex AI, as the agent, and writes nothing (claude-check.mjs). The queue that
// claims and records commands is command-queue.mjs; the request and result shapes are documented in
// README.md.

import { readFileSync } from 'node:fs';
import { createDriveClient } from '../../providers/drive.mjs';
import { SERVICES, serviceUnit } from './systemd.mjs';
import { detached, thenRun } from './command-queue.mjs';
import { probeGateway, waitForGateway } from './gateway-probe.mjs';
import { readStatus, readSkills, readConfig, readWorkspace, readRelease } from './introspection.mjs';
import { readSettingsView, readBrainConfig, setClaude } from './models.mjs';
import { checkClaude } from './claude-check.mjs';
import { listResponsibilities, setResponsibilityEnabled, runResponsibility } from './responsibilities.mjs';
import { startUpgrade, upgradeOutcome } from './upgrade.mjs';
import { checkDrive } from './drive-check.mjs';
import { checkWorkspace } from './workspace-check.mjs';
import { setWorkspaceAccount, writeLastCheck, INSTANCE_FILE } from './workspace-account.mjs';

/** Every command type, in the order README.md documents them. */
export const COMMAND_TYPES = Object.freeze([
  'status', 'skills', 'config', 'workspace', 'brain_config', 'responsibilities',
  'set_responsibility_enabled', 'run_responsibility', 'claude_check', 'set_model', 'restart_service', 'upgrade', 'drive_check',
  'workspace_check', 'set_workspace_account',
]);

/**
 * The handlers, by command type, for createCommandQueue().
 *
 * @param {object}   o
 * @param {object}   o.runtime            the control service's runtime (createServiceRuntime)
 * @param {object}   o.systemd            from createSystemd()
 * @param {object}   o.settings           { readyTimeoutMs, upgradeMaxSeconds } (main.mjs controlSettings)
 * @param {Function} [o.readText]         (path) => string
 * @param {Function} [o.exists]           (path) => boolean; whether the upgrade script is installed
 * @param {Function} [o.now]              () => Date
 * @param {Function} [o.sleep]            (ms) => Promise
 * @param {Function} [o.createDrive]      () => a Drive client acting as the agent (createDriveClient)
 * @param {object}   [o.files]            the file calls set_workspace_account makes on /etc/paraclete
 *   ({ readFileSync, writeFileSync, chmodSync, renameSync }; node:fs by default)
 * @returns {Record<string, {run: Function, watch?: Function}>}
 */
export function createHandlers({
  runtime, systemd, settings, readText = (p) => readFileSync(p, 'utf8'), exists, now = () => new Date(), sleep, createDrive, files,
}) {
  const { contracts, instance, paths, db, collections, subcollections, log, gatewayUrl, fetch } = runtime;
  const driveClient = createDrive || (() => createDriveClient({ instance, getAccessToken: runtime.getAccessToken, fetch }));
  const nowIso = () => now().toISOString();
  const store = { db, collections, subcollections, contracts, paths, instance, readText, log, nowIso };

  // Read on every use: a reinstall may have replaced the token. Control runs as root and can read it.
  const gatewayToken = () => {
    try { return String(readText(instance.gateway_token_file)).trim() || undefined; } catch { return undefined; }
  };
  const gateway = () => ({
    url: gatewayUrl,
    token: gatewayToken(),
    fetch,
    readyTimeoutMs: settings.readyTimeoutMs,
    sleep,
    now: () => now().getTime(),
  });

  async function restartService(service) {
    if (typeof service !== 'string' || !SERVICES.includes(service)) {
      throw new Error(`params.service must be one of ${SERVICES.join(', ')}, got ${JSON.stringify(service)}`);
    }
    const unit = serviceUnit(service);
    if (service === 'control') {
      // Restarting itself ends this process: record the command as done first, then queue the restart.
      return thenRun(
        { service, unit, restarting: true, message: 'the control service is restarting; commands resume once it is back' },
        () => systemd.restart('control', { noBlock: true }),
      );
    }
    await systemd.restart(service);
    const result = { service, unit, state: await systemd.serviceState(service) };
    if (service === 'gateway') {
      const g = gateway();
      result.gateway = await waitForGateway({ url: g.url, token: g.token, timeoutMs: g.readyTimeoutMs, fetch: g.fetch, sleep: g.sleep, now: g.now });
      if (!result.gateway.ready) {
        throw Object.assign(new Error(`the gateway restarted but is not ready${result.gateway.error ? ` (${result.gateway.error})` : ''}`), { result });
      }
    }
    if (result.state.active !== 'active') {
      throw Object.assign(new Error(`${unit} is ${result.state.active} (${result.state.sub}) after the restart`), { result });
    }
    return result;
  }

  return {
    status: {
      run: () => readStatus({
        systemd, probe: () => probeGateway(gateway()), installRoot: paths.installRoot, dataRoot: paths.data.root, readText, now,
      }),
    },
    skills: {
      run: () => readSkills({ paths, instance }),
    },
    config: {
      run: async () => readConfig({
        contracts,
        instance,
        release: readRelease(paths.installRoot, { readText }),
        settings: await readSettingsView({ db, contracts }),
      }),
    },
    workspace: {
      run: () => readWorkspace({ paths, instance }),
    },
    brain_config: {
      run: () => readBrainConfig({ db, contracts, gateway: gateway() }),
    },
    responsibilities: {
      run: () => listResponsibilities({ ...store, now }),
    },
    set_responsibility_enabled: {
      run: (params, ctx) => setResponsibilityEnabled({ ...store, id: params.id, enabled: params.enabled, actor: ctx.requestedBy }),
    },
    run_responsibility: {
      run: (params, ctx) => runResponsibility({ ...store, id: params.id, commandId: ctx.id, actor: ctx.requestedBy }),
    },
    claude_check: {
      run: () => checkClaude({
        candidates: contracts.vertex.models.claude_candidates,
        project: instance.project,
        location: contracts.vertex.anthropic_location,
        fetch,
        getAccessToken: runtime.getAccessToken,
        now,
      }),
    },
    set_model: {
      run: (params, ctx) => setClaude({
        enabled: params.claude_enabled,
        ...(Object.hasOwn(params, 'claude_model') ? { model: params.claude_model } : {}),
        actor: ctx.requestedBy, db, contracts, systemd, gateway: gateway(), nowIso,
      }),
    },
    restart_service: {
      run: (params) => restartService(params.service),
    },
    upgrade: {
      run: async (params, ctx) => {
        await startUpgrade({
          commandId: ctx.id,
          ref: params.ref,
          installRoot: paths.installRoot,
          releasePattern: contracts.versioning.canonical_regex,
          systemd,
          record: ctx.detach,
          maxSeconds: settings.upgradeMaxSeconds,
          now: nowIso,
          ...(exists ? { exists } : {}),
        });
        return detached();
      },
      watch: (record) => upgradeOutcome(record, { systemd }),
    },
    drive_check: {
      run: () => checkDrive({ drive: driveClient(), db, now }),
    },
    workspace_check: {
      run: async (params, ctx) => {
        const result = await checkWorkspace({
          account: params.account,
          project: instance.project,
          fetch,
          getVmAccessToken: runtime.getAccessToken,
          now,
        });
        // The dashboard shows the last check beside the recorded account; a check that cannot be
        // stored still answers the person who ran it.
        try {
          await writeLastCheck(db, collections, { ...result, checked_by: ctx.requestedBy || null });
        } catch (err) {
          log('WARN', `the Workspace check of ${result.account} could not be recorded: ${err.message}`);
        }
        return result;
      },
    },
    set_workspace_account: {
      run: async (params, ctx) => {
        const result = await setWorkspaceAccount({
          params,
          actor: ctx.requestedBy,
          instance,
          paths,
          readText,
          ...(files ? { files } : {}),
          db,
          collections,
          restart: restartService,
          nowIso,
        });
        if (!result.files.includes(INSTANCE_FILE)) return result;
        // Control reads the record too (drive_check acts as the agent's Drive identity): it restarts
        // last, once this command is recorded.
        return thenRun({ ...result, restarting: 'control' }, () => systemd.restart('control', { noBlock: true }));
      },
    },
  };
}
