// POST /api/files/uploads/:id/complete { gcs_path }: after the browser's PUT, checks the file arrived in
// the bucket and records it as the user's upload; answers the attachment a message carries,
// { name, size, gcsPath } (lib/server/uploads.mjs).
import { route, readBody } from '@/lib/server/http.mjs';
import { completeUpload } from '@/lib/server/uploads.mjs';

export const dynamic = 'force-dynamic';

export const POST = route(async ({ request, params, user, runtime }) => {
  const { gcs_path: gcsPath } = await readBody(request);
  return completeUpload(runtime, { user, id: params.id, gcs_path: gcsPath });
});
