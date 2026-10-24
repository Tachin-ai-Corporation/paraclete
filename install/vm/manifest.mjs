#!/usr/bin/env node
// install/vm/manifest.mjs: reads install/manifest.txt and stages what it lists. bootstrap.sh runs it
// on the VM to copy a downloaded release into the staging root, each path at its repo path;
// tests/repo/structure.test.mjs uses the same parser, so the repo's rules and the VM read the manifest
// alike. It copies files and nothing else: npm packages, launchers and release.json are bootstrap.sh's.
//
// The format (install/README.md): one repo path per line; `#` starts a comment; a path ending in `/`
// is a directory, installed with everything beneath it except node_modules/; `{role}` stands for the
// instance's role. Nothing is renamed on the way: the repo path is the VM path.
//
//   node install/vm/manifest.mjs stage --source <release dir> --dest <staging root> --role <role>

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ROLE_PLACEHOLDER = '{role}';

/** Where the manifest sits in a release, relative to its root. */
export const MANIFEST_PATH = 'install/manifest.txt';

/** A role id is one path segment here. Whether it names a real role is config/instance.mjs's rule. */
const ROLE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** One segment of a repo path: no spaces, no shell-special characters. */
const PATH_SEGMENT = /^[A-Za-z0-9_.@+-]+$/;

/**
 * The manifest's entries, in order. Throws, naming every bad line, when a line is not one repo path.
 *
 * @param {string} text the manifest's content
 * @returns {Array<{path: string, directory: boolean, line: number}>}
 */
export function parseManifest(text) {
  const entries = [];
  const problems = [];
  const seen = new Set();
  String(text).split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const where = `line ${index + 1}`;
    const problem = pathProblem(line);
    if (problem) {
      problems.push(`${where}: ${problem}: '${line}'`);
      return;
    }
    if (seen.has(line)) {
      problems.push(`${where}: '${line}' is listed twice`);
      return;
    }
    seen.add(line);
    entries.push({ path: line, directory: line.endsWith('/'), line: index + 1 });
  });
  if (problems.length) throw new Error(`install/manifest.txt is not valid:\n- ${problems.join('\n- ')}`);
  return entries;
}

/** Why a manifest line is not a repo path, or null when it is one. */
function pathProblem(path) {
  if (/\s/.test(path)) return 'one repo path per line, with no spaces (the repo path is the VM path)';
  if (path.startsWith('/')) return 'a repo path is relative to the repo root';
  if (path.includes('\\')) return 'repo paths use forward slashes';
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  for (const segment of segments) {
    if (segment === ROLE_PLACEHOLDER) continue;
    if (segment === '' || segment === '.' || segment === '..') return 'empty, . and .. segments are not allowed';
    if (segment.includes(ROLE_PLACEHOLDER)) return `${ROLE_PLACEHOLDER} must be a whole path segment`;
    if (!PATH_SEGMENT.test(segment)) return 'a path segment holds only letters, digits and . _ - @ +';
  }
  return null;
}

/**
 * The repo paths the manifest installs for one role, in manifest order, without duplicates (with the
 * generic role, `roles/{role}/` and `roles/generic/` are the same directory). Directories keep their
 * trailing slash.
 *
 * @param {Array<{path: string}>} entries from parseManifest()
 * @param {string} role
 * @returns {string[]}
 */
export function expandManifest(entries, role) {
  if (typeof role !== 'string' || !ROLE_SEGMENT.test(role)) {
    throw new Error(`the role must be a role id like 'generic', got ${JSON.stringify(role)}`);
  }
  const paths = [];
  for (const { path } of entries) {
    const expanded = path.split(ROLE_PLACEHOLDER).join(role);
    if (!paths.includes(expanded)) paths.push(expanded);
  }
  return paths;
}

/**
 * Copies every path the release's manifest lists from the release into the staging root, at the same
 * path. Refuses a listed path the release does not have, a file listed as a directory (or the other
 * way round), and any symbolic link: the installed tree holds only real files.
 *
 * @param {object} o
 * @param {string} o.sourceRoot the extracted release
 * @param {string} o.stageRoot  where it is staged (created as needed)
 * @param {string} o.role
 * @returns {string[]} the repo paths staged
 */
export function stageRelease({ sourceRoot, stageRoot, role }) {
  const paths = expandManifest(parseManifest(readFileSync(join(sourceRoot, MANIFEST_PATH), 'utf8')), role);
  const problems = [];
  for (const path of paths) {
    // Checked without the trailing slash: on Linux a file named with one does not exist at all, which
    // would hide that the path is a file, not a directory.
    const source = join(sourceRoot, path.replace(/\/+$/, ''));
    if (!existsSync(source)) {
      problems.push(`${path} is listed but the release does not have it`);
      continue;
    }
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) problems.push(`${path} is a symbolic link`);
    else if (path.endsWith('/') && !stat.isDirectory()) problems.push(`${path} is listed as a directory but is a file`);
    else if (!path.endsWith('/') && !stat.isFile()) problems.push(`${path} is listed as a file but is not one`);
  }
  if (problems.length) throw new Error(`cannot stage the release:\n- ${problems.join('\n- ')}`);

  for (const path of paths) {
    const source = join(sourceRoot, path.replace(/\/+$/, ''));
    const dest = join(stageRoot, path.replace(/\/+$/, ''));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, {
      recursive: true,
      force: true,
      filter: (from) => {
        if (basename(from) === 'node_modules') return false;
        if (lstatSync(from).isSymbolicLink()) throw new Error(`cannot stage the release: ${from} is a symbolic link`);
        return true;
      },
    });
  }
  return paths;
}

/**
 * The command line: `stage --source <dir> --dest <dir> --role <role>`.
 *
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 * @returns {number} exit code
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { source: { type: 'string' }, dest: { type: 'string' }, role: { type: 'string' } },
    });
    if (positionals[0] !== 'stage' || positionals.length !== 1 || !values.source || !values.dest || !values.role) {
      stderr.write('Usage: manifest.mjs stage --source <release dir> --dest <staging root> --role <role>\n');
      return 2;
    }
    const paths = stageRelease({ sourceRoot: values.source, stageRoot: values.dest, role: values.role });
    stdout.write(`staged ${paths.length} manifest paths into ${values.dest}\n`);
    return 0;
  } catch (err) {
    stderr.write(`manifest: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
