// GET /api/library/projects: every stored project, archived ones included (lib/server/library.mjs).
import { route } from '@/lib/server/http.mjs';
import { listProjects } from '@/lib/server/library.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => listProjects(runtime));
