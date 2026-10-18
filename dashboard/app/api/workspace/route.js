// GET /api/workspace: the agent's Google Workspace account as the VM recorded it, for every user:
// whether the role needs one, the recorded account and the last check (lib/server/workspace.mjs).
// Admins also see each API's error and fix; members see which APIs work.
import { route } from '@/lib/server/http.mjs';
import { readWorkspace } from '@/lib/server/workspace.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => readWorkspace(runtime, user));
