// GET /api/chat/notices?limit=<n>: the agent's newest messages that belong to no conversation, newest
// first (lib/server/chat.mjs). The same for every user.
import { route } from '@/lib/server/http.mjs';
import { listNotices } from '@/lib/server/chat.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, runtime }) => {
  const limit = new URL(request.url).searchParams.get('limit') ?? undefined;
  return listNotices(runtime, { limit });
});
