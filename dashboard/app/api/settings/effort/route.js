// GET /api/settings/effort: the effort level the brain uses, the levels to choose from, and who changed
// it last. PATCH /api/settings/effort { effort }: an admin sets it; only the effort fields of
// config/settings are written (lib/server/settings.mjs).
import { route, readBody } from '@/lib/server/http.mjs';
import { readEffort, setEffort } from '@/lib/server/settings.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => readEffort(runtime));

export const PATCH = route(async ({ request, user, runtime }) => {
  const { effort } = await readBody(request);
  return setEffort(runtime, { effort, user });
}, { admin: true });
