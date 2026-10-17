// POST /api/commands { type, params }: signs and queues a command for the VM's control service
// (lib/server/commands.mjs). Views are open to every user; changes are for admins. Answers { id }.
import { route, readBody } from '@/lib/server/http.mjs';
import { sendCommand } from '@/lib/server/commands.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ request, user, runtime }) => {
  const { type, params } = await readBody(request);
  return sendCommand(runtime, { type: String(type || ''), params: params ?? {}, user });
});
