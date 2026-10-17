// DELETE /api/secrets/:name: deletes one of the agent's secrets and every version of it
// (lib/server/secrets.mjs). Admins only.
import { route } from '@/lib/server/http.mjs';
import { deleteSecret } from '@/lib/server/secrets.mjs';

export const dynamic = 'force-dynamic';

export const DELETE = route(async ({ params, user, runtime }) => deleteSecret(runtime, { name: params.name, actor: user }), { admin: true });
