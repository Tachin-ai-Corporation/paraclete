// GET /api/work/:id/files: the files a mission handed back, newest first, from their 'out' records in
// `files`: name, size, type, when, where they came from, and a Drive link when one was saved
// (lib/server/files.mjs).
import { route } from '@/lib/server/http.mjs';
import { listMissionFiles } from '@/lib/server/files.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ params, runtime }) => listMissionFiles(runtime, params.id));
