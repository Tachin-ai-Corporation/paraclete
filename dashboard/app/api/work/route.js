// GET /api/work?view=all|active|waiting|done|failed&before=<next>&replies=1: the agent's missions,
// newest first, a page at a time, with how many are running and waiting (lib/server/work.mjs).
import { route } from '@/lib/server/http.mjs';
import { listWork } from '@/lib/server/work.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, runtime }) => {
  const query = new URL(request.url).searchParams;
  return listWork(runtime, {
    view: query.get('view') || 'all',
    before: query.get('before') || undefined,
    replies: query.get('replies') === '1',
  });
});
