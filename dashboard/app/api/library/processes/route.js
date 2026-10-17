// GET /api/library/processes: the agent's stored process playbooks (lib/server/library.mjs).
import { route } from '@/lib/server/http.mjs';
import { listProcesses } from '@/lib/server/library.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => listProcesses(runtime));
