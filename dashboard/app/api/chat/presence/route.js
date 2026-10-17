// GET /api/chat/presence: the missions the signed-in user's conversation asked for that are not
// finished yet, for the chat's working state (lib/server/chat.mjs).
import { route } from '@/lib/server/http.mjs';
import { threadPresence } from '@/lib/server/chat.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => threadPresence(runtime, { user }));
