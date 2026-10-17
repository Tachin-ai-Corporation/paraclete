// dashboard/lib/client/api.js: how the browser calls the dashboard's own API routes. Every call is
// same-origin JSON; a failed call throws an Error carrying the server's message, which views show as
// is (the server writes them for people).

/**
 * Calls an API route and returns its JSON body.
 *
 * @param {string} path            e.g. '/api/messages'
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.body]  sent as JSON
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>}
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // a body that is not JSON is reported below
  }
  if (!response.ok) {
    const error = new Error(data?.error || `the dashboard answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
