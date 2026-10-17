// agent/work/deploy-target.mjs: a project's authoritative deploy target: which hosting site, in
// which Google Cloud project, from which source. A mission scoped to a project deploys that
// project's content to that project's site instead of guessing. Pure: no I/O, no clock. It does not
// deploy anything (the agent does, with its skills). Used by projects.mjs, which renders the target
// into the project context, and by whatever writes a project's `deploy` field.
//
// Why it exists: a deploy once confused the Firebase project id with the Hosting site id, so a bare
// deploy hit the project's default site, and a second deploy shipped a placeholder because the
// source was never placed in the deploy directory. The target is a top-level project field, not a
// context packet entry, because the packet render surfaces only kind, name, ref, url and summary:
// the structured site and project would never reach the agent.

const SOURCE_KINDS = new Set(['drive', 'git', 'repo']);

function s(v) { return (v == null ? '' : String(v)).trim(); }

/** A normalized descriptor passes through; anything else is normalized first. */
function normalized(d) {
  return (d && d.platform && d.hosting_site !== undefined) ? d : normalizeDeployDescriptor(d);
}

/**
 * Coerces loosely shaped input (a planner's decision, the project command's JSON, a project
 * document) into a clean descriptor.
 *
 * A Drive source may declare its shape: a single `file` (one self-contained page, the site's
 * index.html) or a `folder` (a tree of pages and assets). Without it, a single-file source was once
 * treated as an incomplete folder, and the plan required "download all files from the folder", a
 * criterion that could never pass. Shape is optional and Drive-only; when absent, the agent inspects
 * what the download yields. `drive_file` and `drive_folder` are accepted as kind aliases for `drive`
 * plus a shape.
 *
 * @param {object} input - { platform?, gcp_project?, hosting_site?, source?: {kind, ref, shape?}, flow? }
 * @returns {null | {platform: string, gcp_project: string, hosting_site: string,
 *   source: ({kind: string, ref: string, shape?: string}|null), flow: string}} null when nothing is usable
 */
export function normalizeDeployDescriptor(input) {
  if (!input || typeof input !== 'object') return null;
  const platform = s(input.platform) || 'firebase-hosting';
  const gcp_project = s(input.gcp_project || input.gcpProject || input.project);
  const hosting_site = s(input.hosting_site || input.hostingSite || input.site);
  const flow = s(input.flow);

  let source = null;
  const rawSrc = input.source;
  if (rawSrc && typeof rawSrc === 'object') {
    let kind = s(rawSrc.kind).toLowerCase();
    if (kind === 'repo') kind = 'git';
    let shape = s(rawSrc.shape).toLowerCase();
    if (kind === 'drive_file') { kind = 'drive'; shape = shape || 'file'; }
    else if (kind === 'drive_folder') { kind = 'drive'; shape = shape || 'folder'; }
    if (shape !== 'file' && shape !== 'folder') shape = '';
    if (kind !== 'drive') shape = ''; // a git source is always a tree
    const ref = s(rawSrc.ref || rawSrc.id || rawSrc.url);
    if (SOURCE_KINDS.has(kind) && ref) source = shape ? { kind, ref, shape } : { kind, ref };
  }

  if (!gcp_project && !hosting_site && !source) return null;
  return { platform, gcp_project, hosting_site, source, flow };
}

/**
 * Validates a descriptor for deploying. For firebase-hosting the target is ambiguous without both
 * the hosting site (`--site`) and the Google Cloud project (`--project`), which is exactly the
 * confusion this field exists to remove.
 *
 * @param {object} d - a normalized descriptor, or raw input (normalized first)
 * @returns {{ok: boolean, reason: string}}
 */
export function validateDeployDescriptor(d) {
  const n = normalized(d);
  if (!n) return { ok: false, reason: 'empty or unusable deploy descriptor' };
  if (n.platform === 'firebase-hosting') {
    if (!n.hosting_site) return { ok: false, reason: 'firebase-hosting requires hosting_site (the --site deploy target)' };
    if (!n.gcp_project) return { ok: false, reason: 'firebase-hosting requires gcp_project (the --project)' };
  } else if (!n.platform) {
    return { ok: false, reason: 'platform is required' };
  }
  if (n.source && !SOURCE_KINDS.has(n.source.kind)) {
    return { ok: false, reason: `source.kind must be one of ${[...SOURCE_KINDS].join('|')}` };
  }
  return { ok: true, reason: '' };
}

/**
 * The Deployment block of the project context the agent reads. Labels the site and the project
 * distinctly so neither is mistaken for the other, and states the exact deploy command. Returns ''
 * when there is no valid descriptor, so callers can concatenate unconditionally.
 *
 * @param {object} d
 * @returns {string}
 */
export function renderDeployBlock(d) {
  const n = normalized(d);
  if (!n) return '';
  if (!validateDeployDescriptor(n).ok) return '';
  const lines = ['## Deployment (authoritative — how THIS project ships; do not infer the site)'];
  if (n.platform === 'firebase-hosting') {
    lines.push(`- Hosting site (deploy TARGET — firebase \`--site\`): \`${n.hosting_site}\``);
    lines.push(`- Firebase/GCP project (firebase \`--project\`): \`${n.gcp_project}\`   ← NOT the deploy site`);
    if (n.source) {
      let how;
      if (n.source.kind === 'drive') {
        if (n.source.shape === 'folder') {
          how = `Google Drive FOLDER \`${n.source.ref}\` — fetch ALL its files with the drive skill into the clean deploy dir, preserving structure (a multi-page site: pages + assets)`;
        } else if (n.source.shape === 'file') {
          how = `Google Drive FILE \`${n.source.ref}\` — a single self-contained page; fetch it with the drive skill and place it as \`index.html\` in the clean deploy dir. A one-page site is COMPLETE with just that file — do NOT treat a missing \`images/\` as incomplete`;
        } else {
          how = `Google Drive source \`${n.source.ref}\` — fetch it with the drive skill into the clean deploy dir, then INSPECT what landed: a single file IS the site (place as \`index.html\`); a folder is the whole tree. Deploy what the source actually contains — do not assume a folder`;
        }
      } else {
        how = `git repo \`${n.source.ref}\` — clone it into a clean dir and deploy that`;
      }
      lines.push(`- Source content: ${how}`);
    }
    lines.push(`- ${n.flow || 'Flow: staging channel → share URL → owner approval → promote to live (hosting:clone)'}`);
    lines.push(`- Deploy to staging with: \`firebase hosting:channel:deploy staging --site ${n.hosting_site} --project ${n.gcp_project}\``);
  } else {
    lines.push(`- Platform: ${n.platform}`);
    if (n.gcp_project) lines.push(`- Project: \`${n.gcp_project}\``);
    if (n.hosting_site) lines.push(`- Target: \`${n.hosting_site}\``);
    if (n.source) lines.push(`- Source: ${n.source.kind} \`${n.source.ref}\``);
    if (n.flow) lines.push(`- ${n.flow}`);
  }
  return lines.join('\n');
}
