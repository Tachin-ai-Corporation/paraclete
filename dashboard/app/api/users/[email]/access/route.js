// The IAP grant alone, for fixing one side of a user (lib/server/user-admin.mjs). POST
// /api/users/:email/access: grants a user who has a record but no grant. DELETE
// /api/users/:email/access: revokes the grant of someone who has no record. Admins only.
import { route } from '@/lib/server/http.mjs';
import { emailFromPath, grantUserAccess, revokeAccessWithoutUser } from '@/lib/server/user-admin.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ params, user, runtime }) => (
  grantUserAccess(runtime, { email: emailFromPath(params.email), actor: user })
), { admin: true });

export const DELETE = route(async ({ params, user, runtime }) => (
  revokeAccessWithoutUser(runtime, { email: emailFromPath(params.email), actor: user })
), { admin: true });
