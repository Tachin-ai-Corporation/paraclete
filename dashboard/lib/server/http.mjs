// dashboard/lib/server/http.mjs: the shape every API route shares. A route is a plain async function
// that gets the signed-in user and returns data; route() turns it into a Next.js handler that checks
// who is asking first, answers JSON, and turns a thrown HttpError into its status. Anything else
// thrown is logged and answered as a 500 without its details.

import { getRuntime } from './runtime.mjs';
import { requestUser } from './auth.mjs';
import { HttpError } from './errors.mjs';

export { HttpError };

/**
 * A JSON response.
 *
 * @param {unknown} body
 * @param {number}  [status]
 * @returns {Response}
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Reads a request's JSON body as an object; a missing or unreadable body is a 400.
 *
 * @param {Request} request
 * @returns {Promise<object>}
 */
export async function readBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'the request body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the request body must be a JSON object');
  return body;
}

/**
 * Wraps a route's function as a Next.js route handler.
 *
 * @param {(ctx: {request: Request, params: object, user: object, runtime: object}) => Promise<unknown>} fn
 *   returns the response body, or a Response
 * @param {object}  [options]
 * @param {boolean} [options.admin]   only dashboard admins may call it
 * @param {Function} [options.runtime] () => runtime; tests pass their own
 * @returns {(request: Request, context?: {params?: Promise<object>}) => Promise<Response>}
 */
export function route(fn, { admin = false, runtime: runtimeOf = getRuntime } = {}) {
  return async function handler(request, context = {}) {
    const runtime = runtimeOf();
    try {
      const user = await requestUser(runtime, request.headers);
      if (!user) throw new HttpError(403, 'you are not a user of this dashboard; ask one of its admins to add you');
      if (admin && user.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can do this');
      const params = (await context.params) || {};
      const result = await fn({ request, params, user, runtime });
      return result instanceof Response ? result : json(result ?? {});
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err?.name === 'IapError') return json({ error: `sign-in could not be checked: ${err.message}` }, 401);
      runtime.log('ERROR', `${request.method} ${new URL(request.url).pathname} failed: ${err?.stack || err}`);
      return json({ error: 'something went wrong on the dashboard server; the error is in its log' }, 500);
    }
  };
}
