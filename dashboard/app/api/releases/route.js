// GET /api/releases: the release the instance runs and the newer published ones, with their notes,
// from GitHub's list as the dashboard keeps it (lib/server/releases.mjs). Every user may look.
// POST /api/releases: an admin asks GitHub again now, at most every five minutes.
import { route } from '@/lib/server/http.mjs';
import { readReleases } from '@/lib/server/releases.mjs';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, runtime }) => readReleases(runtime, { user }));

export const POST = route(async ({ user, runtime }) => readReleases(runtime, { user, refresh: true }), { admin: true });
