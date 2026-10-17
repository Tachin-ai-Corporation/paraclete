// GET /api/library/processes/:id: one stored playbook with its narrative and earlier versions
// (lib/server/library.mjs).
import { route } from '@/lib/server/http.mjs';
import { getProcess } from '@/lib/server/library.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ params, runtime }) => getProcess(runtime, params.id));
