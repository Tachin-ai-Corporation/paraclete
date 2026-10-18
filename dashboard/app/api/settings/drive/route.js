// GET /api/settings/drive: the Drive output folder (an id or null) and who changed it last. PATCH
// /api/settings/drive { drive_output_folder }: an admin sets it to a folder id or clears it with null;
// only its own fields of config/settings are written (lib/server/settings.mjs).
import { route, readBody } from '@/lib/server/http.mjs';
import { readDriveSettings, setDriveOutputFolder } from '@/lib/server/settings.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ runtime }) => readDriveSettings(runtime));

export const PATCH = route(async ({ request, user, runtime }) => {
  const { drive_output_folder: folder } = await readBody(request);
  return setDriveOutputFolder(runtime, { folder, user });
}, { admin: true });
