// POST /api/approvals/:id { decision: 'approved' | 'rejected', reason? }: decides a pending gate as the
// signed-in user. Any dashboard user may; the agent resumes or stops the mission (lib/server/approvals.mjs).
import { route, readBody } from '@/lib/server/http.mjs';
import { resolveApproval } from '@/lib/server/approvals.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ request, params, user, runtime }) => {
  const { decision, reason } = await readBody(request);
  return resolveApproval(runtime, { id: params.id, decision, reason, user });
});
