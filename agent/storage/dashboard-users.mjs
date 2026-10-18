// agent/storage/dashboard-users.mjs: what makes someone a dashboard user, in one place. The dashboard
// writes `users/{email}` records; the agent reads them to decide whose word counts: who may approve a
// gate from Google Chat, and which Chat senders are dashboard users. Both sides import the roles from
// here, so a role added later is honored everywhere at once.

/** The dashboard roles a `users` record may hold. Anything else is no user at all. */
export const DASHBOARD_ROLES = Object.freeze(['admin', 'member']);

/**
 * Whether a `users` record names a dashboard user.
 *
 * @param {object|null|undefined} record
 * @returns {boolean}
 */
export function isDashboardUser(record) {
  return Boolean(record) && DASHBOARD_ROLES.includes(record.role);
}
