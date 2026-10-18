// GET /api/workspace/setup: what an admin needs to set up the agent's Google Workspace account: the
// delegation signer's client ID, the scope list, the Admin console's pages and a suggested address
// (lib/server/workspace.mjs). Admins only.
import { route } from '@/lib/server/http.mjs';
import { readWorkspaceSetup } from '@/lib/server/workspace.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => readWorkspaceSetup(runtime, user), { admin: true });
