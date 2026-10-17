// GET /api/work/:id: one envelope in full: its plan and verdicts, messages, approvals, step history
// and what it waits for (lib/server/work.mjs).
import { route } from '@/lib/server/http.mjs';
import { getWork } from '@/lib/server/work.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ params, runtime }) => getWork(runtime, params.id));
