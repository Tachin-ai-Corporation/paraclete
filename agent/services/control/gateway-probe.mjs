// agent/services/control/gateway-probe.mjs: asks the local gateway, over its loopback port, whether it
// is ready and which models it runs. Control never imports the gateway; it reads what the running
// process reports, which is the truth after a restart. Used by the status, brain_config, set_model and
// restart_service commands. The endpoints are documented in agent/gateway/README.md.

const PROBE_TIMEOUT_MS = 5_000;

/**
 * One look at the gateway: `/ready` (no token), and `/status` when a token is given.
 *
 * @param {object}   o
 * @param {string}   o.url      the gateway's base URL
 * @param {string}   [o.token]  the gateway token; without it the models are not read
 * @param {Function} [o.fetch]
 * @returns {Promise<{reachable: boolean, ready: boolean, providers?: object, required?: string[],
 *   models?: object|null, uptime_sec?: number|null, requests?: number|null, sessions?: number|null, error?: string}>}
 */
export async function probeGateway({ url, token, fetch = globalThis.fetch }) {
  let ready;
  try {
    ready = await getJson(fetch, `${url}/ready`);
  } catch (err) {
    return { reachable: false, ready: false, error: `the gateway did not answer: ${err.message}` };
  }
  const probe = {
    reachable: true,
    ready: ready.status === 200 && ready.body?.ready === true,
    providers: ready.body?.providers ?? null,
    required: ready.body?.required ?? null,
    models: null,
    uptime_sec: null,
    requests: null,
    sessions: null,
  };
  if (!token) return probe;
  try {
    const status = await getJson(fetch, `${url}/status`, { Authorization: `Bearer ${token}` });
    if (status.status !== 200) return { ...probe, error: `the gateway's /status answered HTTP ${status.status}` };
    return {
      ...probe,
      models: status.body?.models ?? null,
      uptime_sec: status.body?.uptime_sec ?? null,
      requests: status.body?.requests ?? null,
      sessions: Array.isArray(status.body?.sessions) ? status.body.sessions.length : null,
    };
  } catch (err) {
    return { ...probe, error: `the gateway's /status did not answer: ${err.message}` };
  }
}

/**
 * Probes until the gateway is ready or the time runs out, and returns the last probe. Used after a
 * restart, when the old process may still answer for a moment and the new one is not yet listening.
 *
 * @param {object}   o
 * @param {string}   o.url
 * @param {string}   [o.token]
 * @param {number}   o.timeoutMs
 * @param {number}   [o.intervalMs]
 * @param {Function} [o.fetch]
 * @param {Function} [o.sleep] (ms) => Promise
 * @param {Function} [o.now]   () => ms
 */
export async function waitForGateway({
  url, token, timeoutMs, intervalMs = 1_000, fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const probe = await probeGateway({ url, token, fetch });
    if (probe.ready || now() >= deadline) return probe;
    await sleep(intervalMs);
  }
}

async function getJson(fetch, url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  let body = null;
  try { body = await res.json(); } catch { /* a non-JSON answer leaves the body empty */ }
  return { status: res.status, body };
}
