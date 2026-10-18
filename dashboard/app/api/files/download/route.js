// GET /api/files/download?path=<files/out/<mission>/<name> | files/in/<upload>/<name>>: answers a
// redirect to a short-lived signed URL that downloads the file straight from the instance's bucket
// under its own name (lib/server/files.mjs). Any dashboard user may download the agent's outgoing
// files and uploaded ones; nothing else in the bucket can be fetched.
import { route } from '@/lib/server/http.mjs';
import { downloadRedirect } from '@/lib/server/files.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, runtime }) => {
  const path = new URL(request.url).searchParams.get('path');
  return downloadRedirect(runtime, { path });
});
