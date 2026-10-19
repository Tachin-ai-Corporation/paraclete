// agent/services/control/claude-check.mjs: the claude_check command, the Test button of the dashboard's
// Settings, Models tab. Before an admin turns Claude on, it asks Vertex AI, as the agent's own service
// account and from its VM, whether this project can use each Claude model the contracts list
// (vertex.models.claude_candidates, newest first): one short message with a few output tokens to each,
// on Vertex AI's Anthropic endpoint in the contracts' Claude region (vertex.anthropic_location). Each
// model gets its answer: whether it worked, the HTTP status, Google's message, and the one thing to do
// when it did not (accept Anthropic's terms in Model Garden, ask for quota, turn the API on...), with a
// link to the model's Model Garden page. `best` is the newest model that answered: the one the
// dashboard offers to turn Claude on with (set_model, models.mjs).
//
// The call is made with fetch, not the gateway's Anthropic SDK: control never imports agent/gateway/
// (agent/README.md). The request matches the endpoint's documented shape and nothing more, so a
// passing test means the project may call the model, not that every request the gateway makes will
// be accepted. It writes nothing anywhere; each test costs a handful of tokens per model.

/** The API version Vertex AI's Anthropic endpoint takes in the request body. */
export const ANTHROPIC_VERSION = 'vertex-2023-10-16';

/** The test message, and how many tokens a model may answer it with. */
export const PROBE_MESSAGE = 'Reply with one word: ready';
export const PROBE_MAX_TOKENS = 16;

const CALL_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARS = 300;
const PROVIDER_PREFIX = 'vertex-anthropic/';

/**
 * A model string's id on Vertex AI: 'vertex-anthropic/claude-opus-5-5' is 'claude-opus-5-5'.
 *
 * @param {string} model
 * @returns {string}
 */
export function modelIdOf(model) {
  const s = String(model ?? '');
  return s.startsWith(PROVIDER_PREFIX) ? s.slice(PROVIDER_PREFIX.length) : s;
}

/**
 * The Cloud console's Model Garden page for a Claude model, where an owner enables it and accepts
 * Anthropic's terms. A dated snapshot (`claude-x@20260101`) has its model's page.
 *
 * @param {string} model    a model string or a bare id
 * @param {string} project
 * @returns {string}
 */
export function modelGardenUrl(model, project) {
  const id = modelIdOf(model).split('@')[0];
  return `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`;
}

/** Where a project asks for more Vertex AI quota. */
export function quotaUrl(project) {
  return `https://console.cloud.google.com/iam-admin/quotas?project=${encodeURIComponent(project)}`;
}

/**
 * Vertex AI's rawPredict endpoint for a Claude model. The global location has a host without a region.
 *
 * @param {object} o
 * @param {string} o.project
 * @param {string} o.location
 * @param {string} o.model    a model string or a bare id
 * @returns {string}
 */
export function rawPredictUrl({ project, location, model }) {
  const host = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}`
    + `/publishers/anthropic/models/${encodeURIComponent(modelIdOf(model))}:rawPredict`;
}

const clip = (text) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
};

/**
 * Google's error from an answer's body: Vertex AI's `{ error: { message, status } }` (sometimes inside
 * a one-element list), or Anthropic's `{ type: 'error', error: { type, message } }`.
 *
 * @param {number} status
 * @param {string} text
 * @returns {{status: number, message: string, kind: string}}
 */
export function answerError(status, text) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON: the text is the message */ }
  if (Array.isArray(body)) body = body[0];
  const error = body?.error && typeof body.error === 'object' ? body.error : {};
  const reasons = (Array.isArray(error.details) ? error.details : []).map((d) => d?.reason).filter(Boolean);
  return {
    status,
    message: clip(error.message || (typeof body?.error === 'string' ? body.error : '') || text || `HTTP ${status}`),
    kind: [error.status, error.type, ...reasons].filter(Boolean).join(' '),
  };
}

// A model the project has not enabled: Google words it as terms, an agreement, enabling, or not being
// allowed to use the publisher's model (a failed precondition, once an organization policy is ruled out).
const TERMS = /terms|agreement|accept|consent|not (been )?enabled|enable (the |this )?model|model garden|marketplace|subscri|not allowed to use|FAILED_PRECONDITION/i;
const API_OFF = /SERVICE_DISABLED|has not been used in project|it is disabled|API is disabled|accessNotConfigured/i;
const ORG_POLICY = /organi[sz]ation polic|orgpolicy|constraints\//i;
const NO_PERMISSION = /PERMISSION_DENIED|IAM_PERMISSION|permission .*denied|aiplatform\.endpoints\.predict|does not have permission/i;

/**
 * The one thing to do about a model that did not answer, from its status and Google's message.
 *
 * @param {object} e   { status, message, kind } from answerError(); status null when nothing answered
 * @param {object} c   { model, project, location }
 * @returns {string}
 */
export function claudeFix(e, { model, project, location }) {
  const id = modelIdOf(model);
  const garden = modelGardenUrl(model, project);
  const agent = `paraclete-agent@${project}.iam.gserviceaccount.com`;
  const text = `${e.message} ${e.kind}`;
  if (e.status === null) return `Vertex AI could not be reached from the agent's VM. Run Test again in a minute.`;
  if (e.status === 429) {
    return `${project} has no quota left for ${id} in ${location}: a new project often starts with none for Claude. Ask for it under IAM & Admin, Quotas (Vertex AI API, requests per minute for the Anthropic base model, region ${location}): ${quotaUrl(project)}. If the quota is there, the model was just busy; run Test again in a minute.`;
  }
  if (e.status === 404) {
    return `Vertex AI does not offer ${id} to ${project} in ${location}. Open its Model Garden page, ${garden}: if it asks you to enable the model or accept Anthropic's terms, do that and run Test again. If the model is not offered in ${location}, this instance cannot use it; a model further down the list may be.`;
  }
  if (e.status === 403 && API_OFF.test(text)) {
    return `The Vertex AI API (aiplatform.googleapis.com) is off in ${project}. Turn it on, or run install/install.sh again, which does; a just-enabled API can take a few minutes to answer.`;
  }
  if ((e.status === 403 || e.status === 400) && ORG_POLICY.test(text)) {
    return `An organization policy keeps ${project} from using ${id} (Vertex AI's allowed-models constraint). Ask whoever runs your organization's policies to allow publishers/anthropic/models/${id}, then run Test again.`;
  }
  if ((e.status === 403 || e.status === 400) && TERMS.test(text)) {
    return `Accept Anthropic's terms for this model in Model Garden: open ${garden}, choose Enable and accept the terms (a project owner can), then run Test again. It can take a few minutes to apply.`;
  }
  if (e.status === 403 && NO_PERMISSION.test(text)) {
    return `The agent's service account, ${agent}, may not call Vertex AI models in ${project}. Run install/install.sh again: it grants that account the Vertex AI User role (roles/aiplatform.user).`;
  }
  if (e.status === 403) {
    return `Vertex AI refused ${id} for ${project}. Open its Model Garden page, ${garden}, and enable it and accept Anthropic's terms if it asks; then run Test again.`;
  }
  if (e.status === 401) return 'Vertex AI did not accept the VM\'s token. Run Test again in a minute.';
  if (e.status >= 500) return `Vertex AI failed on its side for ${id}. Run Test again in a minute.`;
  return `Vertex AI refused the test request for ${id} (HTTP ${e.status}). Run Test again; if it keeps failing, Google's message says why.`;
}

/**
 * One model's test: a short message, a few tokens back.
 *
 * @returns {Promise<{model: string, id: string, ok: boolean, status: number|null, error: string|null,
 *   fix: string|null, model_garden: string}>}
 */
async function testModel({ model, project, location, token, fetch }) {
  const entry = { model, id: modelIdOf(model), ok: false, status: null, error: null, fix: null, model_garden: modelGardenUrl(model, project) };
  let response;
  try {
    response = await fetch(rawPredictUrl({ project, location, model }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropic_version: ANTHROPIC_VERSION,
        messages: [{ role: 'user', content: PROBE_MESSAGE }],
        max_tokens: PROBE_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    entry.error = clip(err?.message || err);
    entry.fix = claudeFix({ status: null, message: entry.error, kind: '' }, { model, project, location });
    return entry;
  }
  entry.status = response.status;
  const text = await response.text().catch(() => '');
  if (response.ok) {
    entry.ok = true;
    return entry;
  }
  const e = answerError(response.status, text);
  entry.error = e.message;
  entry.fix = claudeFix(e, { model, project, location });
  return entry;
}

/**
 * Runs the test: every candidate at once, reported newest first. Google's answers become the result,
 * never a thrown error; only a VM that cannot get its own access token fails the command.
 *
 * @param {object}   o
 * @param {string[]} o.candidates       the contracts' vertex.models.claude_candidates, newest first
 * @param {string}   o.project          the instance's project
 * @param {string}   o.location         the contracts' vertex.anthropic_location
 * @param {Function} o.fetch
 * @param {Function} o.getAccessToken   the VM service account's token
 * @param {Function} [o.now]            () => Date
 * @returns {Promise<{checked_at: string, project: string, location: string, models: object[], best: string|null}>}
 */
export async function checkClaude({ candidates, project, location, fetch, getAccessToken, now = () => new Date() }) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('the contracts list no Claude models to test (vertex.models.claude_candidates)');
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    throw new Error(`the VM could not get its access token from the metadata server (${err.message}), so nothing was tested`);
  }
  const models = await Promise.all(candidates.map((model) => testModel({ model, project, location, token, fetch })));
  return {
    checked_at: now().toISOString(),
    project,
    location,
    models,
    best: models.find((entry) => entry.ok)?.model ?? null,
  };
}
