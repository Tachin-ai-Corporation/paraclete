// agent/gateway/health.mjs: the gateway's liveness and readiness answers. /healthz says the process
// serves; /ready says every provider some organ is routed to has a client. Neither calls a model, and
// neither needs the gateway token, so service checks can probe them. server.mjs routes to it.

/**
 * Whether every required provider has a client.
 *
 * @param {Record<string, {available: boolean}>} status from providerStatus()
 * @param {string[]} requiredProviders the providers the organs' models and fallbacks use
 * @returns {boolean}
 */
export function isReady(status, requiredProviders) {
  return requiredProviders.every((p) => status?.[p]?.available === true);
}

/**
 * Answers /healthz and /ready.
 *
 * @param {string} path the request path
 * @param {import('node:http').ServerResponse} res
 * @param {object} o
 * @param {Record<string, {available: boolean, location: string|null}>} o.status from providerStatus()
 * @param {string[]} o.requiredProviders
 * @returns {boolean} true when the path was a health path and has been answered
 */
export function handleHealth(path, res, { status, requiredProviders }) {
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return true;
  }
  if (path === '/ready') {
    const ready = isReady(status, requiredProviders);
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready, providers: status, required: requiredProviders }));
    return true;
  }
  return false;
}
