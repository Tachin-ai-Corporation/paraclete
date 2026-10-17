// dashboard/lib/server/agent.mjs: the agent as the dashboard's header shows it. `agent/instance` is
// written by install/bootstrap.sh at the end of every install or upgrade run on the VM: ready or
// failed, on which release and commit. Whether the services are running right now is the `status`
// command's job (commands.mjs); this is the cheap answer every page can ask for.

/**
 * @param {object} runtime
 * @returns {Promise<object>} `{ name, role, status, release, commit, ready_at, failed_at, error }`
 */
export async function readAgent(runtime) {
  const doc = (await runtime.db.read(`${runtime.collections.agent}/instance`)) || {};
  return {
    name: runtime.settings.agentName,
    role: runtime.settings.role,
    status: doc.status || 'unknown',
    release: doc.release ?? null,
    commit: doc.commit ?? null,
    ready_at: doc.ready_at ?? null,
    failed_at: doc.failed_at ?? null,
    error: doc.error ?? null,
  };
}
