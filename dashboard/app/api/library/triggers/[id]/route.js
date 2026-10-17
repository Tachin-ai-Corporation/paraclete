// GET /api/library/triggers/:id: a "run now" trigger as the brain left it, for following a
// run_responsibility command until the responsibility fires, is skipped or fails
// (lib/server/library.mjs). Admins only, like the command that creates it.
import { route } from '@/lib/server/http.mjs';
import { readTrigger } from '@/lib/server/library.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ params, runtime }) => readTrigger(runtime, params.id), { admin: true });
