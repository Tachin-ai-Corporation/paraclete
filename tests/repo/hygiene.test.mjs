// tests/repo/hygiene.test.mjs: nothing that belongs outside the repo gets in. No private dev state,
// tool config or credentials; no email address outside the placeholder domains; nothing on the
// developer's private denylist (.local/denylist.txt, never committed); no CRLF line endings; no
// oversized files. See DEVELOPING.md section 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, repoFiles, isText, readRepoFile } from './repo-files.mjs';

const files = repoFiles();
const textFiles = files.filter(isText);

const FORBIDDEN_PATHS = [
  /^\.local\//,
  /(^|\/)\.(claude|cursor|codex|gemini|vscode|idea)\//,
  /(^|\/)\.aider/,
  /(^|\/)node_modules\//,
  /(^|\/)\.env(\.(?!example$)[^/]+)?$/,
  /\.(pem|key|log|zip|tgz)$/,
  /\.tar\.gz$/,
  /-key\.json$/,
  /credentials[^/]*\.json$/,
];

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const PLACEHOLDER_DOMAINS = /^(example\.(com|org|net)|your-gcp-project\.iam\.gserviceaccount\.com)$/i;
const ALLOWED_ADDRESSES = new Set(['git@github.com']);

const DENYLIST = join(repoRoot, '.local', 'denylist.txt');
// The license names its copyright holder, which a developer may also have on their denylist.
const DENYLIST_EXEMPT = new Set(['LICENSE']);

const MAX_FILE_BYTES = 1024 * 1024;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('no private dev state, tool config, credentials or archives', () => {
  const forbidden = files.filter((path) => FORBIDDEN_PATHS.some((pattern) => pattern.test(path)));
  assert.deepEqual(forbidden, []);
});

test('email addresses use placeholder domains', () => {
  const found = [];
  for (const path of textFiles) {
    for (const match of readRepoFile(path).matchAll(EMAIL)) {
      if (!PLACEHOLDER_DOMAINS.test(match[1]) && !ALLOWED_ADDRESSES.has(match[0])) {
        found.push(`${path}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test("nothing on the developer's private denylist appears", (t) => {
  if (!existsSync(DENYLIST)) return t.skip('no .local/denylist.txt on this machine');
  const terms = readFileSync(DENYLIST, 'utf8')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#'));
  const found = [];
  for (const path of textFiles) {
    if (DENYLIST_EXEMPT.has(path)) continue;
    const haystack = `${path}\n${readRepoFile(path)}`.toLowerCase();
    for (const term of terms) {
      const word = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`);
      if (word.test(haystack)) found.push(`${path}: ${term}`);
    }
  }
  assert.deepEqual(found, []);
});

test('text files use LF line endings', () => {
  const crlf = textFiles.filter((path) => readFileSync(join(repoRoot, path)).includes('\r\n'));
  assert.deepEqual(crlf, []);
});

test('no file is larger than 1 MB', () => {
  const large = files.filter((path) => statSync(join(repoRoot, path)).size > MAX_FILE_BYTES);
  assert.deepEqual(large, []);
});
