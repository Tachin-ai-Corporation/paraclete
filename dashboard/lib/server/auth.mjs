// dashboard/lib/server/auth.mjs: from a request to a dashboard user. Two checks, both needed:
//   1. IAP's signed header says who the person is (iap.mjs). IAP only lets in people with the IAP
//      grant on the service, so reaching the dashboard at all takes that grant.
//   2. Their `users` record says what they may do: `admin` or `member`. Someone with the IAP grant
//      but no record (granted in the console, say) is signed in but not a user, and sees nothing.
// Adding and removing a user changes both together (users.mjs, iap-access.mjs).

import { createIapVerifier, IAP_HEADER } from './iap.mjs';
import { getUser } from './users.mjs';

const verifiers = new WeakMap();

function verifierFor(runtime) {
  let verify = verifiers.get(runtime);
  if (!verify) {
    verify = createIapVerifier({ audience: runtime.settings.iapAudience, fetch: runtime.fetch });
    verifiers.set(runtime, verify);
  }
  return verify;
}

/**
 * The email of whoever sent the request, from IAP's signed header (or, off Cloud Run only, the
 * developer's PARACLETE_DEV_USER). Throws IapError when the header is missing or does not verify.
 *
 * @param {object}  runtime
 * @param {Headers} headers
 * @returns {Promise<string>}
 */
export async function signedInEmail(runtime, headers) {
  if (runtime.settings.devUser) return runtime.settings.devUser;
  const { email } = await verifierFor(runtime)(headers.get(IAP_HEADER));
  return email;
}

/**
 * The dashboard user who sent the request (their users record, users.mjs), or null when the person is
 * signed in but has no user record.
 *
 * @param {object}  runtime
 * @param {Headers} headers
 * @returns {Promise<object|null>}
 */
export async function requestUser(runtime, headers) {
  const email = await signedInEmail(runtime, headers);
  return getUser(runtime, email);
}
