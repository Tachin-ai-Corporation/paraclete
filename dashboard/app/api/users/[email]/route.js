// PATCH /api/users/:email { role }: changes a user's role. DELETE /api/users/:email: removes a user, the
// record and then the IAP grant (lib/server/user-admin.mjs); a grant that could not be removed comes
// back in `access_error`. Admins only.
import { route, readBody } from '@/lib/server/http.mjs';
import { emailFromPath, removeDashboardUser, setDashboardUserRole } from '@/lib/server/user-admin.mjs';

export const dynamic = 'force-dynamic';

export const PATCH = route(async ({ request, params, user, runtime }) => {
  const { role } = await readBody(request);
  return setDashboardUserRole(runtime, { email: emailFromPath(params.email), role: String(role || ''), actor: user });
}, { admin: true });

export const DELETE = route(async ({ params, user, runtime }) => (
  removeDashboardUser(runtime, { email: emailFromPath(params.email), actor: user })
), { admin: true });
