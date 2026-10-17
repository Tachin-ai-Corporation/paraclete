// GET /api/commands/:id: a command's request and outcome, for following it until it finishes.
import { route } from '@/lib/server/http.mjs';
import { readCommand } from '@/lib/server/commands.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ params, runtime }) => readCommand(runtime, params.id));
