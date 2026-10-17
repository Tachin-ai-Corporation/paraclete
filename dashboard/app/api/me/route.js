// GET /api/me: who is signed in, and what the dashboard is.
import { route } from '@/lib/server/http.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => ({
  user,
  dashboard: {
    project: runtime.settings.project,
    release: runtime.settings.release,
    commit: runtime.settings.commit,
    agentAccount: runtime.settings.agentAccount,
  },
}));
