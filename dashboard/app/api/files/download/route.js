// GET /api/files/download?path=files/out/<mission>/<name>: streams one of the agent's outgoing files
// from the instance's bucket as a download (lib/server/files.mjs). Any dashboard user may download;
// nothing outside the outgoing files can be fetched.
import { route } from '@/lib/server/http.mjs';
import { downloadFile } from '@/lib/server/files.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ request, runtime }) => {
  const path = new URL(request.url).searchParams.get('path');
  return downloadFile(runtime, { path });
});
