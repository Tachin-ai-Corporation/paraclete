// GET /api/chat/messages[?before=<ISO time> | ?since=<ISO time>][&limit=<n>]: a page of the signed-in
// user's conversation, oldest first: the newest messages, older ones for paging back in time, or the
// ones since a time for polling. POST /api/chat/messages { text, attachments? }: sends the agent a
// message in that conversation, creating the thread on the first one; `attachments` are the user's
// completed uploads ([{ gcsPath }], from /api/files/uploads), and a message may be files alone.
// Answers { message }. The thread is always the caller's own (lib/server/chat.mjs).
import { route, readBody } from '@/lib/server/http.mjs';
import { listMessages, sendMessage } from '@/lib/server/chat.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, user, runtime }) => {
  const query = new URL(request.url).searchParams;
  return listMessages(runtime, {
    user, before: query.get('before'), since: query.get('since'), limit: query.get('limit') ?? undefined,
  });
});

export const POST = route(async ({ request, user, runtime }) => {
  const { text, attachments } = await readBody(request);
  return sendMessage(runtime, { user, text, attachments });
});
