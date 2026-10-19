// agent/services/control/models.mjs: the dashboard's model switch and model view. Whether Claude is on,
// and which Claude model, live in the admin settings document, `config/settings`, fields
// `claude_enabled` and `claude_model`; the gateway reads them when it starts. Turning Claude on or off
// therefore writes the fields, restarts the gateway, and checks that the restarted gateway runs the
// models the switch implies. Which model each tier uses is decided by the gateway's own code
// (isClaudeEnabled, claudeModel and organModels in agent/services/gateway/settings.mjs), imported here
// so the expectation and the gateway cannot disagree. Whether a Claude model answers at all is the
// claude_check command's (claude-check.mjs). The document's path and its reader are
// service-runtime.mjs's (ADMIN_SETTINGS_PATH, readAdminSettings).

import { firestoreEncode } from '../../storage/firestore.mjs';
import { ADMIN_SETTINGS_PATH, readAdminSettings } from '../service-runtime.mjs';
import { claudeModel, isClaudeEnabled, organModels } from '../gateway/settings.mjs';
import { waitForGateway, probeGateway } from './gateway-probe.mjs';

/** The fields set_model always writes; `claude_model` too when the command names one. Nothing else. */
const CLAUDE_FIELDS = Object.freeze(['claude_enabled', 'claude_updated_at', 'claude_updated_by']);

/**
 * The admin settings the dashboard shows beside the models. Read strictly: an outage is an error,
 * never "Claude is off". `claude_model` is the Claude model the cortex and the strong tier run while
 * Claude is on (the stored choice when the contracts list it, else the contracts' `claude`);
 * `claude_model_ignored` is a stored choice the contracts do not list, which the gateway does not run.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.contracts
 * @returns {Promise<{claude_enabled: boolean, claude_model: string, claude_model_ignored: unknown,
 *   effort: string, claude_updated_at: string|null, claude_updated_by: string|null}>}
 */
export async function readSettingsView({ db, contracts }) {
  const doc = await readAdminSettings(db, { strict: true });
  const claude = claudeModel(contracts.vertex.models, doc);
  return {
    claude_enabled: isClaudeEnabled(doc),
    claude_model: claude.model,
    claude_model_ignored: claude.ignored,
    effort: typeof doc.effort === 'string' ? doc.effort : contracts.effort.default,
    claude_updated_at: doc.claude_updated_at ?? null,
    claude_updated_by: doc.claude_updated_by ?? null,
  };
}

/**
 * Checks set_model's optional `claude_model`: absent, or one of the contracts' `claude_candidates`.
 *
 * @param {unknown} model
 * @param {object}  models the contracts' vertex.models
 * @returns {string|undefined}
 */
export function checkClaudeModel(model, models) {
  if (model === undefined) return undefined;
  const candidates = models.claude_candidates || [];
  if (typeof model !== 'string' || !candidates.includes(model)) {
    throw new Error(`params.claude_model must be one of ${candidates.join(', ')}, got ${JSON.stringify(model)}`);
  }
  return model;
}

/**
 * Turns Claude on or off, and with `model` sets which Claude model runs. Writes only the Claude
 * fields (the effort setting and anything else in the document stay), restarts the gateway, and waits
 * for it to be ready on the expected cortex and strong-tier model. A gateway that is not ready, or
 * runs other models, fails the command with what it reported; the setting stays as written.
 *
 * @param {object}   o
 * @param {boolean}  o.enabled
 * @param {string}   [o.model]          one of the contracts' claude_candidates; absent keeps the stored one
 * @param {string}   [o.actor]          who asked (the command's requested_by)
 * @param {object}   o.db
 * @param {object}   o.contracts
 * @param {object}   o.systemd          from createSystemd()
 * @param {object}   o.gateway          { url, token, readyTimeoutMs, fetch?, sleep?, now? }
 * @param {Function} [o.nowIso]
 * @returns {Promise<object>} the command result
 */
export async function setClaude({
  enabled, model, actor, db, contracts, systemd, gateway, nowIso = () => new Date().toISOString(),
}) {
  if (typeof enabled !== 'boolean') throw new Error('params.claude_enabled must be true or false');
  const models = contracts.vertex.models;
  const chosen = checkClaudeModel(model, models);
  // Without a model named, the gateway keeps the stored choice: read it to know what to expect.
  const settings = chosen !== undefined ? { claude_model: chosen } : enabled ? await readAdminSettings(db, { strict: true }) : {};
  const claude = claudeModel(models, settings).model;

  const fields = {
    claude_enabled: enabled,
    claude_updated_at: nowIso(),
    claude_updated_by: actor || null,
    ...(chosen !== undefined ? { claude_model: chosen } : {}),
  };
  await db.patch(ADMIN_SETTINGS_PATH, [...CLAUDE_FIELDS, ...(chosen !== undefined ? ['claude_model'] : [])],
    firestoreEncode(fields), { strict: true });
  await systemd.restart('gateway');
  const probe = await waitForGateway({
    url: gateway.url,
    token: gateway.token,
    timeoutMs: gateway.readyTimeoutMs,
    fetch: gateway.fetch,
    sleep: gateway.sleep,
    now: gateway.now,
  });
  const expected = organModels(models, { claudeEnabled: enabled, claude });
  const result = { claude_enabled: enabled, claude_model: enabled ? claude : null, expected_cortex: expected.cortex, gateway: probe };
  const switched = `Claude is ${enabled ? `on (${claude})` : 'off'} in the settings, but`;
  if (!probe.ready) {
    throw withResult(new Error(`${switched} the restarted gateway is not ready${probe.error ? ` (${probe.error})` : ''}. `
      + (enabled ? "Check in Settings, Models that the model passes Test (Anthropic's terms accepted in Model Garden), or turn Claude off." : '')), result);
  }
  for (const [tier, label] of [['cortex', 'the cortex'], ['strong', 'the strong tier']]) {
    if (probe.models?.[tier] !== expected[tier]) {
      throw withResult(new Error(`${switched} the gateway runs ${probe.models?.[tier] ?? 'an unknown model'} for ${label}, not ${expected[tier]}`), result);
    }
  }
  return result;
}

/**
 * What the brain runs on: the admin settings, the contracts' model tiers (with the Claude candidates),
 * and the models the running gateway reports.
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
