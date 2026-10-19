// tests/repo/docs.test.mjs: the docs point at things that exist. Every relative link in every Markdown
// file resolves to a file in the repo (a link to a directory, to one that holds files), and a
// #fragment to a heading of the file it names. Every repo path the product docs (docs/ and every
// README.md) name in backticks exists. The root README has one "Open in Cloud Shell" button, and every
// such button clones the project's own repository and opens a file the repo has. See docs/README.md,
// "Rules".
//
// What counts as a repo path: a backticked word that starts with a top-level directory (or a root
// file) and holds a slash or ends in an extension some repo file has. Words with placeholders
// (`<id>`, `{role}`, `your-gcp-project`), globs, or a leading `/` (VM paths such as /opt/paraclete/)
// are not repo paths. Neither is a word that names no directory here and ends in no extension a repo
// file has: that is a Firestore document (`agent/instance`, `config/settings.claude_model`) or an IAM
// role (`roles/run.admin`), whose first segment happens to be a top-level directory's name. A path may be written from the repo root or from the doc's own directory
// (a role's README naming its own `skills/<id>/`). A path git ignores (`agent/node_modules/`, build
// output) is described, not tracked, and passes. Fenced code blocks are commands and output, and are
// not read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { repoRoot, repoFiles, readRepoFile } from './repo-files.mjs';

const files = repoFiles();
const fileSet = new Set(files);
const markdown = files.filter((path) => path.endsWith('.md'));
/** The product docs: everything in docs/, and every directory's README. */
const productDocs = markdown.filter((path) => path.startsWith('docs/') || posix.basename(path) === 'README.md');

const topDirectories = new Set(files.filter((path) => path.includes('/')).map((path) => path.split('/')[0]));
const rootFiles = new Set(files.filter((path) => !path.includes('/')));
/** Extensions some repo file has. `.claude_model` in `config/settings.claude_model` is a field, not one. */
const extensions = new Set(files.map((path) => posix.extname(path)).filter(Boolean));

/**
 * What an install button must clone: hygiene.test.mjs exports it, and it is read here as text, because
 * importing a test file would run its tests a second time.
 */
const PROJECT_REPO_URL = /export const PROJECT_REPO_URL = '([^']+)'/.exec(readRepoFile('tests/repo/hygiene.test.mjs'))?.[1];
const CLOUD_SHELL = 'https://shell.cloud.google.com/cloudshell/editor';

/** The file's lines with fenced code blocks blanked out, so line numbers still hold. */
function proseLines(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    return line;
  });
}

/** A line without its inline code spans, so a link written as code is not taken for a link. */
function withoutCode(line) {
  return line.replace(/(`+)[^`]*?\1/g, '');
}

/** The link targets on one line of prose: inline links and images, reference definitions, and HTML href/src. */
function linkTargets(line) {
  const text = withoutCode(line);
  const targets = [];
  for (const m of text.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
    targets.push(m[1].replace(/^<|>$/g, ''));
  }
  const definition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(text);
  if (definition) targets.push(definition[1].replace(/^<|>$/g, ''));
  for (const m of text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)) targets.push(m[1]);
  return targets;
}

/** A heading's anchor, as GitHub makes it from the heading's text. */
function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** The anchors a Markdown file offers: one per heading (a repeat gets -1, -2...), and explicit HTML ids. */
function anchors(text) {
  const found = new Set();
  const counts = new Map();
  const add = (base) => {
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    found.add(n ? `${base}-${n}` : base);
  };
  const lines = proseLines(text);
  lines.forEach((line, i) => {
    const atx = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) add(slug(atx[1]));
    const previous = lines[i - 1] ?? '';
    if (/^ {0,3}(=+|-+)\s*$/.test(line) && previous.trim() && !/^\s*[|#>*-]/.test(previous)) add(slug(previous));
    for (const m of withoutCode(line).matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) found.add(m[1]);
  });
  return found;
}

const anchorCache = new Map();
function anchorsOf(path) {
  if (!anchorCache.has(path)) anchorCache.set(path, anchors(readRepoFile(path)));
  return anchorCache.get(path);
}

/** Why a link target from `from` does not resolve, or null when it does. External links are not checked. */
function brokenLink(from, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const hash = target.indexOf('#');
  const rawPath = hash >= 0 ? target.slice(0, hash) : target;
  const fragment = hash >= 0 ? target.slice(hash + 1) : '';
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return 'is not a valid link';
  }
  const resolved = !decoded
    ? from
    : posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(from), decoded));
  if (resolved.startsWith('../') || resolved === '..') return 'leaves the repository';
  const path = resolved.replace(/\/$/, '');
  if (!fileSet.has(path)) {
    const directory = path === '.' ? '' : `${path}/`;
    if (files.some((file) => file.startsWith(directory))) return fragment ? 'names a directory, which has no headings' : null;
    return `names ${path}, which the repo does not have`;
  }
  if (fragment && path.endsWith('.md') && !anchorsOf(path).has(fragment)) return `names #${fragment}, which ${path} has no heading for`;
  return null;
}

/** The words of an inline code span that look like repo paths (see the header), with what is around them trimmed. */
function pathCandidates(span) {
  const candidates = [];
  for (const raw of span.split(/\s+/)) {
    const word = raw.replace(/^[("']+|[)"',;:]+$/g, '').replace(/#.*$/, '');
    if (!word || /[<>{}[\]*?$|=\\]|\.\.\.|your-|example\./.test(word)) continue;
    const first = word.split('/')[0];
    if (!topDirectories.has(first) && !rootFiles.has(first)) continue;
    if (!word.includes('/') && !extensions.has(posix.extname(word))) continue;
    candidates.push(word);
  }
  return candidates;
}

/** Whether the repo has this file, or a directory holding files. */
function inRepo(path) {
  return fileSet.has(path) || files.some((file) => file.startsWith(`${path}/`));
}

/**
 * Whether a candidate that the doc at `from` names is in the repo, written from the root or from the
 * doc's own directory, or is something the repo describes but ignores.
 */
function pathExists(word, from = 'README.md') {
  const path = word.replace(/\/$/, '');
  if (inRepo(path) || inRepo(posix.join(posix.dirname(from), path))) return true;
  if (!word.endsWith('/') && !extensions.has(posix.extname(word))) return true; // a Firestore document, not a path
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', word], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('the checks find what they are for, and only that', () => {
  assert.deepEqual(linkTargets('See [a](b.md#c "t") and ![i](<d e.png>) but not `[x](y.md)`.'), ['b.md#c', 'd e.png']);
  assert.deepEqual(linkTargets('[![Open](https://img.example.com/b.svg)](https://example.com/x?a=1&b=2)'),
    ['https://img.example.com/b.svg', 'https://example.com/x?a=1&b=2']);
  assert.deepEqual(linkTargets('[ref]: ../x.md'), ['../x.md']);
  assert.equal(slug('Workspace: the agent\'s own Google account'), 'workspace-the-agents-own-google-account');
  assert.equal(slug('`install.sh` and the [button](x.md)'), 'installsh-and-the-button');
  assert.equal(slug('Moving an instance to another role (a developer path)'), 'moving-an-instance-to-another-role-a-developer-path');
  assert.deepEqual([...anchors('# A\n## A\n```\n# not\n```\nB\n---\n')], ['a', 'a-1', 'b']);
  assert.deepEqual(pathCandidates('node dev/deploy.mjs <branch> --repo <owner>/paraclete'), ['dev/deploy.mjs']);
  assert.deepEqual(pathCandidates('roles/<id>/role.json'), []);
  assert.deepEqual(pathCandidates('/opt/paraclete/agent/work/x.mjs'), []);
  assert.deepEqual(pathCandidates('agent/work/'), ['agent/work/']);
  assert.deepEqual(pathCandidates('DEVELOPING.md'), ['DEVELOPING.md']);
  assert.ok(pathExists('agent/instance'), 'a Firestore document is not a repo path');
  assert.ok(pathExists('config/settings.claude_model'), 'a field of a Firestore document is not a repo path');
  assert.ok(pathExists('roles/run.admin'), 'an IAM role is not a repo path');
  assert.ok(pathExists('agent/node_modules/'), 'an ignored path is described, not tracked');
  assert.ok(!pathExists('agent/work/no-such-file.mjs'));
  assert.ok(!pathExists('docs/no-such-directory/'));
  assert.ok(pathExists('skills/bigquery/', 'roles/data-engineer/README.md'), "a role's README names its own skills");
  assert.ok(!pathExists('skills/bigquery/', 'README.md'));
});

test('every relative link in a Markdown file resolves', () => {
  const broken = [];
  for (const path of markdown) {
    proseLines(readRepoFile(path)).forEach((line, i) => {
      for (const target of linkTargets(line)) {
        const why = brokenLink(path, target);
        if (why) broken.push(`${path}:${i + 1}: (${target}) ${why}`);
      }
    });
  }
  assert.deepEqual(broken, []);
});

test('every repo path the product docs name in backticks exists', () => {
  const missing = [];
  for (const path of productDocs) {
    proseLines(readRepoFile(path)).forEach((line, i) => {
      for (const m of line.matchAll(/(`+)([^`]+?)\1/g)) {
        for (const word of pathCandidates(m[2])) {
          if (!pathExists(word, path)) missing.push(`${path}:${i + 1}: ${word}`);
        }
      }
    });
  }
  assert.deepEqual(missing, []);
});

/** Every "Open in Cloud Shell" link in a Markdown file, as a URL. */
function cloudShellLinks(path) {
  return proseLines(readRepoFile(path))
    .flatMap(linkTargets)
    .filter((target) => target.startsWith(`${CLOUD_SHELL}?`))
    .map((target) => new URL(target));
}

test("the README's install button clones the project's repository", () => {
  assert.ok(PROJECT_REPO_URL, 'tests/repo/hygiene.test.mjs must export PROJECT_REPO_URL');
  assert.equal(cloudShellLinks('README.md').length, 1, `README.md must have one link to ${CLOUD_SHELL}`);
  for (const path of markdown) {
    for (const button of cloudShellLinks(path)) {
      assert.equal(button.searchParams.get('cloudshell_git_repo')?.replace(/\.git$/, ''), PROJECT_REPO_URL,
        `${path}: the Cloud Shell button must clone ${PROJECT_REPO_URL}`);
      // The files it opens are relative to its workspace, the repo's root when that is empty or '.'.
      const workspace = button.searchParams.get('cloudshell_workspace') || '.';
      for (const name of ['cloudshell_open_in_editor', 'cloudshell_tutorial', 'cloudshell_print']) {
        for (const file of button.searchParams.getAll(name)) {
          const opened = posix.normalize(posix.join(workspace, file));
          assert.ok(fileSet.has(opened), `${path}: the button's ${name} names ${opened}, which the repo does not have`);
        }
      }
    }
  }
});
