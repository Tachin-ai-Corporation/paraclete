// GET /api/users: every dashboard user with whether IAP lets them through, plus IAP grants that have no
// user (lib/server/user-admin.mjs). POST /api/users { email, role }: adds a user, the IAP grant and the
// record together; role defaults to member. Admins only.
import { route, readBody } from '@/lib/server/http.mjs';
import { addDashboardUser, listUserAccess } from '@/lib/server/user-admin.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => listUserAccess(runtime, { actor: user }), { admin: true });

export const POST = route(async ({ request, user, runtime }) => {
  const { email, role } = await readBody(request);
  return addDashboardUser(runtime, { email, role: String(role || 'member'), actor: user });
}, { admin: true });
