// agent/services/control/models.mjs: the dashboard's model switch and model view. Whether Claude is on
// lives in the admin settings document, `config/settings`, field `claude_enabled`; the gateway reads it
// when it starts. Turning Claude on or off therefore writes the field, restarts the gateway, and checks
// that the restarted gateway runs the cortex model the switch implies. Which model each tier uses is
// the contracts' and the gateway's business (agent/services/gateway/settings.mjs), not this file's. The
// document's path and its reader are service-runtime.mjs's (ADMIN_SETTINGS_PATH, readAdminSettings).

import { firestoreEncode } from '../../storage/firestore.mjs';
import { ADMIN_SETTINGS_PATH, readAdminSettings } from '../service-runtime.mjs';
import { waitForGateway, probeGateway } from './gateway-probe.mjs';

/** The fields set_model writes; nothing else in the document is touched. */
const CLAUDE_FIELDS = Object.freeze(['claude_enabled', 'claude_updated_at', 'claude_updated_by']);

/**
 * The admin settings the dashboard shows beside the models. Read strictly: an outage is an error,
 * never "Claude is off".
 *
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.contracts
 * @returns {Promise<{claude_enabled: boolean, effort: string, claude_updated_at: string|null, claude_updated_by: string|null}>}
 */
export async function readSettingsView({ db, contracts }) {
  const doc = await readAdminSettings(db, { strict: true });
  return {
    claude_enabled: doc.claude_enabled === true,
    effort: typeof doc.effort === 'string' ? doc.effort : contracts.effort.default,
    claude_updated_at: doc.claude_updated_at ?? null,
    claude_updated_by: doc.claude_updated_by ?? null,
  };
}

/**
 * Turns Claude on or off. Writes only the Claude fields (the effort setting and anything else in the
 * document stay), restarts the gateway, and waits for it to be ready on the expected cortex model.
 * A gateway that is not ready, or runs another model, fails the command with what it reported.
 *
 * @param {object}   o
 * @param {boolean}  o.enabled
 * @param {string}   [o.actor]          who asked (the command's requested_by)
 * @param {object}   o.db
 * @param {object}   o.contracts
 * @param {object}   o.systemd          from createSystemd()
 * @param {object}   o.gateway          { url, token, readyTimeoutMs, fetch?, sleep?, now? }
 * @param {Function} [o.nowIso]
 * @returns {Promise<object>} the command result
 */
export async function setClaude({ enabled, actor, db, contracts, systemd, gateway, nowIso = () => new Date().toISOString() }) {
  if (typeof enabled !== 'boolean') throw new Error('params.claude_enabled must be true or false');
  await db.patch(ADMIN_SETTINGS_PATH, [...CLAUDE_FIELDS],
    firestoreEncode({ claude_enabled: enabled, claude_updated_at: nowIso(), claude_updated_by: actor || null }), { strict: true });
  await systemd.restart('gateway');
  const probe = await waitForGateway({
    url: gateway.url,
    token: gateway.token,
    timeoutMs: gateway.readyTimeoutMs,
    fetch: gateway.fetch,
    sleep: gateway.sleep,
    now: gateway.now,
  });
  const expectedCortex = enabled ? contracts.vertex.models.claude : contracts.vertex.models.cortex;
  const result = { claude_enabled: enabled, expected_cortex: expectedCortex, gateway: probe };
  const switched = `Claude is ${enabled ? 'on' : 'off'} in the settings, but`;
  if (!probe.ready) {
    throw withResult(new Error(`${switched} the restarted gateway is not ready${probe.error ? ` (${probe.error})` : ''}. `
      + (enabled ? "Check that Anthropic's terms are accepted in Model Garden for this project, or turn Claude off." : '')), result);
  }
  if (probe.models?.cortex !== expectedCortex) {
    throw withResult(new Error(`${switched} the gateway runs ${probe.models?.cortex ?? 'an unknown model'} for the cortex, not ${expectedCortex}`), result);
  }
  return result;
}

/**
 * What the brain runs on: the admin settings, the contracts' model tiers, and the models the running
 * gateway reports.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.contracts
 * @param {object} o.gateway  { url, token, fetch? }
 * @returns {Promise<object>}
 */
export async function readBrainConfig({ db, contracts, gateway }) {
  const [settings, running] = await Promise.all([
    readSettingsView({ db, contracts }),
    probeGateway({ url: gateway.url, token: gateway.token, fetch: gateway.fetch }),
  ]);
  return {
    settings,
    tiers: { ...contracts.vertex.models },
    locations: { google: contracts.vertex.location, anthropic: contracts.vertex.anthropic_location },
    running,
    organ_max_steps: contracts.organs.max_steps,
    service_models: {
      utility: contracts.utility.model,
      ears_preprocess: contracts.ears.preprocess.model,
      mouth: contracts.mouth.model,
    },
  };
}

function withResult(err, result) {
  err.result = result;
  return err;
}
