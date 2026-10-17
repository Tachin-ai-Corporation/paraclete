// GET /api/secrets: the agent's secrets the dashboard manages, without their values
// (lib/server/secrets.mjs). POST /api/secrets { name, value, description }: creates one and lets the
// agent read it; the value is never sent back. Admins only.
import { route, readBody } from '@/lib/server/http.mjs';
import { createSecret, listSecrets } from '@/lib/server/secrets.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => listSecrets(runtime, { actor: user }), { admin: true });

export const POST = route(async ({ request, user, runtime }) => {
  const { name, value, description } = await readBody(request);
  return createSecret(runtime, { name, value, description, actor: user });
}, { admin: true });
