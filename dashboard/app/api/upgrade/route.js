// GET /api/upgrade: the upgrade in progress or the last one, moved on when its current step finished
// (lib/server/upgrade.mjs). Every user may follow it. POST /api/upgrade { version }: an admin installs
// a published release, newer than the installed one or the same one to finish an upgrade left
// half-done: the agent's VM first, then the dashboard's image and its Cloud Run service.
import { route, readBody } from '@/lib/server/http.mjs';
import { readUpgrade, startUpgrade } from '@/lib/server/upgrade.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => readUpgrade(runtime, { user }));

export const POST = route(async ({ request, user, runtime }) => {
  const { version } = await readBody(request);
  return startUpgrade(runtime, { version, user });
}, { admin: true });
