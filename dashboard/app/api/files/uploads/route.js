// POST /api/files/uploads { name, size, content_type }: starts an upload for the signed-in user. Checks
// the size against files.max_upload_mb and answers { upload_id, name, size, gcs_path, url, headers,
// expires_at }: the browser PUTs the bytes to `url` with exactly `headers`, then completes the upload
// (lib/server/uploads.mjs). Any dashboard user may upload.
import { route, readBody } from '@/lib/server/http.mjs';
import { startUpload } from '@/lib/server/uploads.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ request, user, runtime }) => {
  const { name, size, content_type: contentType } = await readBody(request);
  return startUpload(runtime, { user, name, size, content_type: contentType });
});
