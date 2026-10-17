// GET /api/setup: the server's part of the setup checklist, for every user: user counts, Claude on or
// off, and the role (lib/server/setup.mjs).
import { route } from '@/lib/server/http.mjs';
import { readSetup } from '@/lib/server/setup.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => readSetup(runtime));
