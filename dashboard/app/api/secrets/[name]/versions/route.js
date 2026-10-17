// POST /api/secrets/:name/versions { value }: replaces a secret's value with a new version, which the
// agent reads from then on (lib/server/secrets.mjs). Answers the version number, never the value.
// Admins only.
import { route, readBody } from '@/lib/server/http.mjs';
import { replaceSecretValue } from '@/lib/server/secrets.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ request, params, user, runtime }) => {
  const { value } = await readBody(request);
  return replaceSecretValue(runtime, { name: params.name, value, actor: user });
}, { admin: true });
