// POST /api/secrets/:name/access: grants the agent's service account read access to one secret again,
// when it was removed outside the dashboard (lib/server/secrets.mjs). Admins only.
import { route } from '@/lib/server/http.mjs';
import { grantSecretToAgent } from '@/lib/server/secrets.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ params, user, runtime }) => grantSecretToAgent(runtime, { name: params.name, actor: user }), { admin: true });
