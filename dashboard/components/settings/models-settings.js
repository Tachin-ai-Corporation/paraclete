// dashboard/components/settings/models-settings.js: the Settings, Models tab's decisions, as data for
// ModelsTab.jsx and the Setup checklist. Pure (no React, no fetching). It takes what the views fetched
// (the `brain_config` command's result: the settings, the contracts' model tiers with their Claude
// candidates, and what the running gateway reports; the `claude_check` command's result; the project
// from GET /api/me) and says what Claude's state is, how each candidate model reads with its Model
// Garden link and its last test, and whether the switch may turn Claude on, with which model, or why
// not. Claude is turned on only with a model that passed a recent test from the agent's VM; the
// control service still refuses a model the contracts do not list (agent/services/control/models.mjs).
//
// modelGardenLink repeats the control service's modelGardenUrl
// (agent/services/control/claude-check.mjs), which the browser cannot import; the test's own links win
// when there is a test, and tests/ pins the two together.

const CLAUDE_PREFIX = 'vertex-anthropic/';

/** How long a test result may be trusted to turn Claude on. */
export const TEST_FRESH_MS = 60 * 60 * 1000;

/**
 * A model string's id: 'vertex-anthropic/claude-opus-5-5' is 'claude-opus-5-5'.
 *
 * @param {string} model
 * @returns {string}
 */
export function modelId(model) {
  const s = String(model ?? '');
  const slash = s.indexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * A model's name for people: 'vertex-anthropic/claude-opus-5-5' is 'Claude Opus 5.5',
 * 'claude-opus-5' is 'Claude Opus 5'. A dated snapshot (`@20260101`) reads as its model.
 *
 * @param {string} model
 * @returns {string}
 */
export function modelLabel(model) {
  const parts = modelId(model).split('@')[0].split('-').filter(Boolean);
  const words = [];
  for (const part of parts) {
    const last = words.length - 1;
    if (/^\d+$/.test(part) && last >= 0 && /^\d+(\.\d+)*$/.test(words[last])) words[last] = `${words[last]}.${part}`;
    else words.push(/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part);
  }
  return words.join(' ');
}

/**
 * The Cloud console's Model Garden page for a Claude model, where an owner enables it and accepts
 * Anthropic's terms. The same link the control service's test reports.
 *
 * @param {string} model
 * @param {string} project
 * @returns {string}
 */
export function modelGardenLink(model, project) {
  const id = modelId(model).split('@')[0];
  return `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/${encodeURIComponent(id)}?project=${encodeURIComponent(project || '')}`;
}

/**
 * Claude's state, from the `brain_config` result: whether it is on, the Claude model that runs while it
 * is on, a stored choice the contracts no longer list (and so the gateway ignores), who switched it
 * last, the candidates, the Claude region, and whether the running gateway differs from the setting
 * (it reads the setting when it starts).
 *
 * @param {object|null} config  the brain_config result
 * @returns {object|null}
 */
export function claudeState(config) {
  if (!config || typeof config !== 'object') return null;
  const settings = config.settings || {};
  const tiers = config.tiers || {};
  const on = settings.claude_enabled === true;
  const model = settings.claude_model || tiers.claude || null;
  const candidates = (Array.isArray(tiers.claude_candidates) ? tiers.claude_candidates : [])
    .filter((entry) => typeof entry === 'string' && entry.startsWith(CLAUDE_PREFIX));
  const expected = on ? { cortex: model, strong: model } : { cortex: tiers.cortex, strong: tiers.strong };
  const running = config.running?.models || null;
  const gatewayDiffers = Boolean(running) && ['cortex', 'strong'].some((tier) => running[tier] && running[tier] !== expected[tier]);
  return {
    on,
    model,
    label: model ? modelLabel(model) : '',
    ignored: settings.claude_model_ignored ?? null,
    updatedBy: settings.claude_updated_by || null,
    updatedAt: settings.claude_updated_at || null,
    candidates,
    location: config.locations?.anthropic || null,
    fallback: tiers.claude_fallback || null,
    running,
    gatewayDiffers,
  };
}

/**
 * One row per candidate, newest first: its name, Model Garden link, whether it is the one Claude runs,
 * and what the last test said of it (null when it was not tested).
 *
 * @param {object} o
 * @param {string[]}    o.candidates  claudeState().candidates
 * @param {object|null} o.check       the claude_check result
 * @param {string}      o.project
 * @param {object|null} [o.state]     claudeState()
 * @returns {Array<{model: string, id: string, label: string, link: string, current: boolean,
 *   best: boolean, test: {ok: boolean, status: number|null, error: string|null, fix: string|null}|null}>}
 */
export function candidateRows({ candidates, check, project, state = null }) {
  const tested = new Map((Array.isArray(check?.models) ? check.models : []).map((entry) => [entry?.model, entry]));
  return (candidates || []).map((model) => {
    const entry = tested.get(model) || null;
    return {
      model,
      id: modelId(model),
      label: modelLabel(model),
      link: entry?.model_garden || modelGardenLink(model, project),
      current: Boolean(state?.on) && state.model === model,
      best: Boolean(check?.best) && check.best === model,
      test: entry ? { ok: entry.ok === true, status: entry.status ?? null, error: entry.error ?? null, fix: entry.fix ?? null } : null,
    };
  });
}

/**
 * The test in one line: how many models answered and which is the newest that did.
 *
 * @param {object|null} check
 * @returns {string}
 */
export function checkSummary(check) {
  const models = Array.isArray(check?.models) ? check.models : [];
  if (!models.length) return '';
  const answered = models.filter((entry) => entry?.ok).length;
  if (!check.best) return `None of the ${models.length} Claude models answered.`;
  return `${answered} of ${models.length} Claude models answered; the newest is ${modelLabel(check.best)}.`;
}

/**
 * Whether the switch may turn Claude on (or move it to another model), and with which: the newest
 * model that answered a test from the agent's VM, no older than TEST_FRESH_MS and one the contracts
 * still list. Otherwise why not, in a sentence.
 *
 * @param {object} o
 * @param {object|null} o.state  claudeState()
 * @param {object|null} o.check  the claude_check result
 * @param {number}      [o.now]  ms
 * @returns {{allowed: boolean, action: 'on'|'switch'|null, model: string|null, label: string, reason: string}}
 */
export function switchDecision({ state, check, now = Date.now() }) {
  const no = (reason) => ({ allowed: false, action: null, model: null, label: '', reason });
  if (!state) return no('Waiting for the agent\'s VM to report the current setting.');
  if (!check) return no('Run Test first: Claude is turned on only with a model that answered a test from the agent\'s VM.');
  const checkedAt = Date.parse(check.checked_at);
  if (!Number.isFinite(checkedAt) || now - checkedAt > TEST_FRESH_MS) return no('The last test is more than an hour old. Run Test again.');
  if (!check.best) return no('No Claude model answered the test. Do what it says for the model you want, then run Test again.');
  if (!state.candidates.includes(check.best)) return no('The tested model is not one the agent can run any more. Run Test again.');
  const label = modelLabel(check.best);
  if (state.on && state.model === check.best) return no(`Claude is on with ${label}, the newest model that answered.`);
  return { allowed: true, action: state.on ? 'switch' : 'on', model: check.best, label, reason: '' };
}

/**
 * The outcome of a set_model command, for the notice above the tab.
 *
 * @param {object|null} command  the command as GET /api/commands/:id returns it
 * @param {{enabling: boolean, model?: string|null}} o
 * @returns {{kind: 'ok'|'warn'|'error', text: string}}
 */
export function switchOutcome(command, { enabling, model = null }) {
  if (command?.status === 'done') {
    const runs = command.result?.claude_model || model;
    return enabling
      ? { kind: 'ok', text: `Claude is on: the cortex and the strong tier run ${runs ? modelLabel(runs) : 'Claude'}, with Gemini as the fallback.` }
      : { kind: 'ok', text: 'Claude is off: Gemini runs every organ again.' };
  }
  if (command?.status === 'failed') return { kind: 'error', text: `Not switched: ${command.error || 'the agent refused the change'}` };
  return { kind: 'warn', text: 'The switch was asked for, but the agent has not answered yet; its VM may be restarting. Refresh in a minute.' };
}
