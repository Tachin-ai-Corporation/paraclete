// dashboard/lib/server/setup.mjs: the parts of the setup checklist (Settings, Setup) only the server can
// answer, for every dashboard user: how many users the dashboard has (counts, never who), whether
// Claude is on, and the agent's role. The rest of the checklist comes from the agent's install record
// (agent.mjs), the `status` command and GET /api/me (the agent's service-account address), which the
// browser asks for itself. Called by GET /api/setup.

import { listUsers } from './users.mjs';

/**
 * @param {object} runtime
 * @returns {Promise<{users: {total: number, admins: number}, role: string, workspace: 'not_needed'|'unknown',
 *   claude_enabled: boolean}>}
 */
export async function readSetup(runtime) {
  const [users, settings] = await Promise.all([
    listUsers(runtime),
    runtime.db.read(`${runtime.collections.config}/settings`),
  ]);
  const { role } = runtime.settings;
  return {
    users: { total: users.length, admins: users.filter((user) => user.role === 'admin').length },
    role,
    // Which roles need a Workspace account is the role's own `workspace` flag, which the dashboard
    // learns with the role catalog (build plan phase 8). The generic role never needs one.
    workspace: role === 'generic' ? 'not_needed' : 'unknown',
    claude_enabled: settings?.claude_enabled === true,
  };
}
