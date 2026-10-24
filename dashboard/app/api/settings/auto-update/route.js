// GET /api/settings/auto-update: whether automatic updates are on (and who changed that last), and what
// the update job's last run found and did. PATCH /api/settings/auto-update { enabled }: an admin turns
// them on or off; only the setting's own fields of config/settings are written (lib/server/settings.mjs).
import { route, readBody } from '@/lib/server/http.mjs';
import { readAutoUpdate, setAutoUpdate } from '@/lib/server/settings.mjs';
import { readAutoUpdateStatus } from '@/lib/server/auto-update.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => ({
  setting: await readAutoUpdate(runtime),
  last_run: await readAutoUpdateStatus(runtime),
}));

export const PATCH = route(async ({ request, user, runtime }) => {
  const { enabled } = await readBody(request);
  return { setting: await setAutoUpdate(runtime, { enabled, user }), last_run: await readAutoUpdateStatus(runtime) };
}, { admin: true });
