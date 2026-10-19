// agent/release/versions.mjs: what a release is, written once for everything that names one. A
// release is a git tag in the commit version format, vYYYY.MM.DD.N.N, published as a GitHub release
// with notes once its tests passed (.github/workflows/release.yml). This module parses and orders
// those versions, and reads GitHub's answer about a repository's releases. Pure: no network, no file,
// no configuration; callers fetch and pass the JSON in. Used by the dashboard (which release is newer
// than the one installed), dev/release.mjs (cutting one), install/vm/release-record.mjs (the version a
// commit carries) and the brain (the version stamped on work).
//
// The format is also config/contracts.json's versioning.canonical_regex; a test keeps the two equal.

/** A version, whole: v, the date, the day's index and its subindex. */
const VERSION = /^v(\d{4})\.(\d{2})\.(\d{2})\.(\d+)\.(\d+)$/;

/** The version a commit message starts with (`v2026.10.18.9.4: ...`). */
const LEADING_VERSION = /^(v\d{4}\.\d{2}\.\d{2}\.\d+\.\d+)(?![.\d])/;

/** The GitHub REST API, which answers 60 unauthenticated requests an hour per address. */
export const GITHUB_API = 'https://api.github.com';

/** How many releases one listing asks for: plenty to find every release newer than the installed one. */
export const RELEASES_PAGE_SIZE = 30;

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;

/**
 * A version's parts, or null when the text is not exactly one version.
 *
 * @param {unknown} text
 * @returns {{version: string, parts: number[]}|null}
 */
export function parseVersion(text) {
  const m = VERSION.exec(String(text ?? '').trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  const [, month, day] = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { version: `v${m.slice(1).join('.')}`, parts };
}

/** Whether a text is exactly one version, such as a release tag. */
export function isVersion(text) {
  return parseVersion(text) !== null;
}

/**
 * The version a commit message (or any text) starts with, or null.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function versionFromText(text) {
  const m = LEADING_VERSION.exec(String(text ?? '').trim());
  return m && isVersion(m[1]) ? m[1] : null;
}

/**
 * Orders two versions by date, then index, then subindex: negative when `a` is older, positive when
 * newer, 0 when equal. Null when either is not a version.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number|null}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < pa.parts.length; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] < pb.parts[i] ? -1 : 1;
  }
  return 0;
}

/** Whether `a` is a later version than `b`; false when either is not a version. */
export function isNewer(a, b) {
  return (compareVersions(a, b) ?? 0) > 0;
}

/**
 * @typedef {object} Release
 * @property {string} version       the tag, a version
 * @property {string} name          the release's title (the tag when it has none)
 * @property {string} notes         its notes, Markdown as written
 * @property {string|null} url      its page on GitHub
 * @property {string|null} published_at
 */

/**
 * The published releases in GitHub's answer to GET /repos/{repo}/releases, newest version first.
 * Drafts, prereleases and tags that are not versions are left out; so is anything malformed.
 *
 * @param {unknown} json
 * @returns {Release[]}
 */
export function releasesFromGitHub(json) {
  if (!Array.isArray(json)) return [];
  const seen = new Set();
  const releases = [];
  for (const r of json) {
    if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true) continue;
    const parsed = parseVersion(r.tag_name);
    if (!parsed || seen.has(parsed.version)) continue;
    seen.add(parsed.version);
    releases.push({
      version: parsed.version,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : parsed.version,
      notes: typeof r.body === 'string' ? r.body : '',
      url: typeof r.html_url === 'string' ? r.html_url : null,
      published_at: typeof r.published_at === 'string' ? r.published_at : null,
    });
  }
  return releases.sort((x, y) => compareVersions(y.version, x.version));
}

/**
 * The releases later than `current`, newest first. Nothing when `current` is not a version: an
 * instance that cannot say what it runs is not told it is behind.
 *
 * @param {Release[]} releases
 * @param {unknown} current
 * @returns {Release[]}
 */
export function newerReleases(releases, current) {
  if (!isVersion(current)) return [];
  return releases.filter((r) => isNewer(r.version, current));
}

function needRepo(repo) {
  if (!REPO.test(String(repo ?? ''))) throw new Error(`'${repo}' is not a GitHub repository (owner/name)`);
}

/** The URL that lists a repository's releases. */
export function releasesUrl(repo) {
  needRepo(repo);
  return `${GITHUB_API}/repos/${repo}/releases?per_page=${RELEASES_PAGE_SIZE}`;
}

/** The URL that resolves a tag (or any ref) to its commit: GET it, and the answer's `sha` is the commit. */
export function commitUrl(repo, ref) {
  needRepo(repo);
  if (!isVersion(ref) && !/^[0-9a-f]{40}$/.test(String(ref))) throw new Error(`'${ref}' is neither a version nor a commit`);
  return `${GITHUB_API}/repos/${repo}/commits/${ref}`;
}
