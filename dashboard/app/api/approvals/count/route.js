// GET /api/approvals/count: { pending } gates someone can decide now, for the navigation badge
// (lib/server/approvals.mjs).
import { route } from '@/lib/server/http.mjs';
import { countPending } from '@/lib/server/approvals.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => countPending(runtime));
