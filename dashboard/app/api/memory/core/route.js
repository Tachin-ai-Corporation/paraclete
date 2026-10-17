// GET /api/memory/core?status=active|superseded|retired|all: the agent's Core Memory entries, most
// valuable first, for the Agent page to search and filter (lib/server/memory.mjs).
import { route } from '@/lib/server/http.mjs';
import { listCoreMemory } from '@/lib/server/memory.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, runtime }) => {
  const status = new URL(request.url).searchParams.get('status') || 'active';
  return listCoreMemory(runtime, { status });
});
