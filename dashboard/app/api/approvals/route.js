// GET /api/approvals: the approval gates waiting for a decision, then the recently decided ones
// (lib/server/approvals.mjs).
import { route } from '@/lib/server/http.mjs';
import { listApprovals } from '@/lib/server/approvals.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => listApprovals(runtime));
