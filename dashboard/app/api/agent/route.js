// GET /api/agent: the agent's install state from agent/instance (lib/server/agent.mjs).
import { route } from '@/lib/server/http.mjs';
import { readAgent } from '@/lib/server/agent.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => readAgent(runtime));
