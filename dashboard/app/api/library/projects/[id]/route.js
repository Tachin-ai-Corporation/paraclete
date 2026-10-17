// GET /api/library/projects/:id: one project with its context, canon, linked playbooks, deploy target
// and suggested context (lib/server/library.mjs).
import { route } from '@/lib/server/http.mjs';
import { getProject } from '@/lib/server/library.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ params, runtime }) => getProject(runtime, params.id));
