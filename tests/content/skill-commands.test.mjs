// tests/content/skill-commands.test.mjs: the commands that live inside skill packages: web-search and
// web-fetch, secret-read, and the git-artifacts work-* commands. Hermetic: network calls go to a fake
// fetch, git-store to a fake runner, and the git commands run the real git binary in a scratch
// repository with an isolated git configuration.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import * as webSearch from '../../skills/web-search/web-search.mjs';
import * as webFetch from '../../skills/web-search/web-fetch.mjs';
import * as secretRead from '../../skills/secrets/secret-read.mjs';
import * as workStatus from '../../skills/git-artifacts/work-status.mjs';
import * as workDiff from '../../skills/git-artifacts/work-diff.mjs';
import * as workLog from '../../skills/git-artifacts/work-log.mjs';
import * as workCommit from '../../skills/git-artifacts/work-commit.mjs';
import * as workSync from '../../skills/git-artifacts/work-sync.mjs';
import * as workClone from '../../skills/git-artifacts/work-clone.mjs';

/** A stand-in for stdout or stderr that keeps what was written. */
function sink() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    bytes() { return Buffer.concat(chunks); },
  };
}

/** A fake fetch that answers every call with `respond(url, init)` and records the calls. */
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function run(mod, argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await mod.main(argv, { stdout, stderr, ...deps });
  return { code, out: stdout.text(), err: stderr.text(), bytes: stdout.bytes() };
}

describe('every skill command answers --help', () => {
  for (const [name, mod] of Object.entries({ webSearch, webFetch, secretRead, workStatus, workDiff, workLog, workCommit, workSync, workClone })) {
    test(name, async () => {
      const { code, out } = await run(mod, ['--help']);
      assert.equal(code, 0);
      assert.match(out, /^Usage: /);
    });
  }
});

describe('secret-read', () => {
  const token = async () => 'tok';
  const secret = Buffer.from('s3cr3t value\n').toString('base64');

  test('prints the decoded value and nothing else', async () => {
    const fetch = fakeFetch(() => json({ name: 'x', payload: { data: secret } }));
    const r = await run(secretRead, ['--name', 'api-token'], { fetch, getAccessToken: token, project: 'your-gcp-project' });
    assert.equal(r.code, 0);
    assert.equal(r.bytes.toString('utf8'), 's3cr3t value\n');
    assert.equal(r.err, '');
    assert.equal(fetch.calls[0].url, 'https://secretmanager.googleapis.com/v1/projects/your-gcp-project/secrets/api-token/versions/latest:access');
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tok');
  });

  test('reads a named version', async () => {
    const fetch = fakeFetch(() => json({ payload: { data: secret } }));
    await run(secretRead, ['--name', 'api-token', '--version', '3'], { fetch, getAccessToken: token, project: 'p' });
    assert.match(fetch.calls[0].url, /\/versions\/3:access$/);
  });

  test('explains a denied or missing secret without guessing a prefix', async () => {
    const denied = await run(secretRead, ['--name', 'api-token'], { fetch: fakeFetch(() => json({}, 403)), getAccessToken: token, project: 'p' });
    assert.equal(denied.code, 1);
    assert.match(denied.err, /Access denied to secret 'api-token'.*Secret Accessor/);
    const missing = await run(secretRead, ['--name', 'api-token'], { fetch: fakeFetch(() => json({}, 404)), getAccessToken: token, project: 'p' });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not found in project p\. Use the full secret id/);
    assert.equal(missing.out, '');
  });

  test('refuses a name that could reshape the request path, before any request', async () => {
    const fetch = fakeFetch(() => json({}));
    for (const argv of [['--name', '../other'], ['--name', 'a/b'], ['--name', 'ok', '--version', 'latest/../x'], []]) {
      const r = await run(secretRead, argv, { fetch, getAccessToken: token, project: 'p' });
      assert.equal(r.code, 1, argv.join(' '));
    }
    assert.equal(fetch.calls.length, 0);
  });

  test('never writes the value to stderr when the response is malformed', async () => {
    const r = await run(secretRead, ['--name', 'api-token'], { fetch: fakeFetch(() => json({ nothing: true })), getAccessToken: token, project: 'p' });
    assert.equal(r.code, 1);
    assert.match(r.err, /no payload/);
  });
});

describe('web-search', () => {
  const config = { project: 'your-gcp-project', model: 'gemini-3.8-flash', location: 'global' };
  const token = async () => 'tok';
  const answer = {
    candidates: [{
      content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Paris is the capital ' }, { text: 'of France.' }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['capital of France'],
        groundingChunks: [
          { web: { uri: 'https://example.com/a', title: 'example.com' } },
          { web: { uri: 'https://example.com/a', title: 'example.com' } },
          { web: { uri: 'https://example.org/b', title: 'example.org' } },
        ],
      },
    }],
  };

  test('prints the answer, its distinct sources and the searches, never the thoughts', async () => {
    const fetch = fakeFetch(() => json(answer));
    const r = await run(webSearch, ['What is the capital of France?'], { fetch, getAccessToken: token, config });
    assert.equal(r.code, 0);
    assert.equal(r.out, [
      'Paris is the capital of France.',
      '',
      'Sources:',
      '1. example.com https://example.com/a',
      '2. example.org https://example.org/b',
      'Searches: capital of France',
      '',
    ].join('\n'));
    const call = fetch.calls[0];
    assert.equal(call.url, 'https://aiplatform.googleapis.com/v1/projects/your-gcp-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.equal(body.contents[0].parts[0].text, 'What is the capital of France?');
    assert.ok(body.systemInstruction.parts[0].text.length > 0);
  });

  test('takes the question from stdin', async () => {
    const fetch = fakeFetch(() => json(answer));
    const r = await run(webSearch, ['--stdin'], { fetch, getAccessToken: token, config, readStdin: async () => "What's the client's \"best\" option?\n" });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(fetch.calls[0].init.body).contents[0].parts[0].text, 'What\'s the client\'s "best" option?');
  });

  test('says when the answer is not grounded in any source', async () => {
    const ungrounded = { candidates: [{ content: { parts: [{ text: 'An answer.' }] }, finishReason: 'STOP' }] };
    const r = await run(webSearch, ['q'], { fetch: fakeFetch(() => json(ungrounded)), getAccessToken: token, config });
    assert.equal(r.code, 0);
    assert.match(r.out, /Sources: none returned\. .*unverified/);
  });

  test('fails plainly when there is no answer or the service refuses', async () => {
    const spent = { candidates: [{ content: { parts: [{ text: 'x', thought: true }] }, finishReason: 'MAX_TOKENS' }] };
    const r1 = await run(webSearch, ['q'], { fetch: fakeFetch(() => json(spent)), getAccessToken: token, config });
    assert.equal(r1.code, 1);
    assert.match(r1.err, /whole output budget/);
    const r2 = await run(webSearch, ['q'], { fetch: fakeFetch(() => new Response('quota', { status: 429 })), getAccessToken: token, config });
    assert.equal(r2.code, 1);
    assert.match(r2.err, /HTTP 429: quota/);
    const r3 = await run(webSearch, [], { fetch: fakeFetch(() => json(answer)), getAccessToken: token, config });
    assert.equal(r3.code, 1);
  });

  test('uses the fast Gemini model and a regional host outside the global location', () => {
    const contracts = { vertex: { location: 'us-central1', models: { fast: 'vertex-google/gemini-3.8-flash' } } };
    const config2 = webSearch.resolveConfig(contracts, { project: 'p' });
    assert.deepEqual(config2, { project: 'p', model: 'gemini-3.8-flash', location: 'us-central1' });
    assert.match(webSearch.endpoint(config2), /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/p\/locations\/us-central1\//);
    assert.throws(() => webSearch.resolveConfig({ vertex: { models: { fast: 'vertex-anthropic/claude' } } }, { project: 'p' }), /needs a Gemini model/);
  });
});

describe('web-fetch', () => {
  const page = [
    '<html><head><title>The &amp; Page</title>',
    '<meta content="A short summary" name="description">',
    '<style>body { color: red }</style><script>var secret = 1;</script></head>',
    '<body><nav>Home | About</nav><h1>Heading</h1><p>First&nbsp;paragraph &mdash; with an entity &#39;quoted&#39;.</p>',
    '<img src="https://example.com/photo.jpg"><img src="https://example.com/logo.png"><img src="/pixel.gif">',
    '<footer>Copyright</footer></body></html>',
  ].join('\n');
  const html = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

  test('prints the title, description, images and readable text of a page', async () => {
    const fetch = fakeFetch(() => html(page));
    const r = await run(webFetch, ['--url', 'https://example.com/'], { fetch });
    assert.equal(r.code, 0);
    assert.match(r.out, /^TITLE: The & Page\nDESCRIPTION: A short summary\nIMAGES \(1 found\): https:\/\/example\.com\/photo\.jpg\n/);
    assert.match(r.out, /Heading\nFirst paragraph — with an entity 'quoted'\./);
    for (const gone of ['color: red', 'var secret', 'Home | About', 'Copyright']) assert.ok(!r.out.includes(gone), gone);
    assert.equal(fetch.calls[0].init.redirect, 'follow');
    assert.match(fetch.calls[0].init.headers['User-Agent'], /AgentResearch/);
  });

  test('prints raw HTML with --format html, and names the final URL after a redirect', async () => {
    const fetch = fakeFetch(() => {
      const res = html(page);
      Object.defineProperty(res, 'url', { value: 'https://example.com/final' });
      return res;
    });
    const r = await run(webFetch, ['--url', 'https://example.com/start', '--format', 'html'], { fetch });
    assert.equal(r.code, 0);
    assert.ok(r.out.startsWith('URL: https://example.com/final\n<html>'));
  });

  test('reads a long page up to the cap and says it was cut, instead of failing', async () => {
    const long = `<html><body><p>${'word '.repeat(5000)}</p></body></html>`;
    const r = await run(webFetch, ['--url', 'https://example.com/long', '--max', '1000'], { fetch: fakeFetch(() => html(long)) });
    assert.equal(r.code, 0);
    assert.match(r.out, /cut at 1000 bytes/);
    assert.ok(r.out.length < 2000);
  });

  test('passes plain text and JSON through as they are', async () => {
    const r = await run(webFetch, ['--url', 'https://example.com/data.json'], { fetch: fakeFetch(() => json({ a: '<b>' })) });
    assert.equal(r.code, 0);
    assert.equal(r.out, '{"a":"<b>"}\n');
  });

  test('refuses a document that is not a web page, with the route to the files skill', async () => {
    const pdf = () => new Response(Buffer.from('%PDF-1.7\n...binary...'), { status: 200, headers: { 'content-type': 'application/pdf' } });
    const r = await run(webFetch, ['--url', 'https://example.com/report.pdf'], { fetch: fakeFetch(pdf) });
    assert.equal(r.code, 1);
    assert.match(r.err, /is a PDF, not a web page: fetch it with the files skill \(file-get <url>\)/);
    assert.equal(r.out, '');
    assert.equal(webFetch.binaryKind(Buffer.from('hello'), 'application/octet-stream'), "'application/octet-stream'");
    assert.equal(webFetch.binaryKind(Buffer.from('<html>'), 'application/xhtml+xml'), null);
  });

  test('fails plainly on an error status, a timeout or bad arguments', async () => {
    const notFound = await run(webFetch, ['--url', 'https://example.com/x'], { fetch: fakeFetch(() => new Response('no', { status: 404 })) });
    assert.equal(notFound.code, 1);
    assert.match(notFound.err, /HTTP 404 for https:\/\/example\.com\/x/);
    const slow = await run(webFetch, ['--url', 'https://example.com/x', '--timeout', '3'], {
      fetch: async () => { throw new DOMException('aborted', 'TimeoutError'); },
    });
    assert.equal(slow.code, 1);
    assert.match(slow.err, /no answer within 3 seconds/);
    for (const argv of [[], ['--url', 'ftp://example.com/'], ['--url', 'https://example.com', '--format', 'pdf'], ['--url', 'https://example.com', '--max', '0']]) {
      const r = await run(webFetch, argv, { fetch: fakeFetch(() => html(page)) });
      assert.equal(r.code, 1, argv.join(' '));
    }
  });

  test('extractText cuts the text to its budget and says so', () => {
    const text = webFetch.extractText(`<p>${'a'.repeat(100)}</p>`, 10);
    assert.match(text, /a{10}\.\.\.\[truncated/);
    assert.equal(webFetch.decodeEntities('&lt;b&gt; &#x41;&#66; &unknown;'), '<b> AB &unknown;');
  });
});

describe('git-artifacts commands on a real repository', () => {
  let scratch;
  let repo;
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'skill-commands-'));
    // An isolated git configuration with no committer: the developer's own settings never change a
    // result, and work-commit's fallback identity is exercised.
    const config = join(scratch, 'gitconfig');
    writeFileSync(config, '[core]\n  autocrlf = false\n[commit]\n  gpgsign = false\n[init]\n  defaultBranch = main\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    repo = mkdtempSync(join(scratch, 'repo-'));
    git('init', '-q');
    git('checkout', '-q', '-b', 'mission/m-1');
  });

  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));

  test('work-log and work-status on a repository with no commits yet', async () => {
    const log = await run(workLog, ['--dir', repo]);
    assert.equal(log.code, 0);
    assert.equal(log.out, '(no commits yet)\n');
    const status = await run(workStatus, ['--dir', repo]);
    assert.equal(status.code, 0);
    assert.deepEqual(JSON.parse(status.out), { branch: 'mission/m-1', clean: true, staged: [], modified: [], untracked: [] });
  });

  test('work-commit refuses when nothing is staged, then commits everything with --add-all', async () => {
    writeFileSync(join(repo, 'index.html'), '<h1>Proof</h1>\n');
    const status = JSON.parse((await run(workStatus, ['--dir', repo])).out);
    assert.deepEqual(status.untracked, ['index.html']);
    assert.equal(status.clean, false);

    const refused = await run(workCommit, ['first page', '--dir', repo]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /nothing is staged/);

    const done = await run(workCommit, ['first page', '--dir', repo, '--add-all']);
    assert.equal(done.code, 0, done.err);
    const result = JSON.parse(done.out);
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.equal(result.message, 'first page');
    assert.equal(result.filesChanged, 1);
    assert.equal(git('config', 'user.email').stdout.trim(), 'paraclete@localhost');
  });

  test('work-diff shows a change, its summary, and says when there is none', async () => {
    const none = await run(workDiff, ['--dir', repo]);
    assert.equal(none.out, '(no changes)\n');
    writeFileSync(join(repo, 'index.html'), '<h1>The proof</h1>\n');
    const diff = await run(workDiff, ['--dir', repo]);
    assert.match(diff.out, /-<h1>Proof<\/h1>\n\+<h1>The proof<\/h1>/);
    const stat = await run(workDiff, ['--dir', repo, '--stat']);
    assert.match(stat.out, /index\.html \| 2 \+-/);
    assert.deepEqual(workDiff.diffArgs({ staged: true, stat: true, file: 'a b.txt' }), ['diff', '--cached', '--stat', '--', 'a b.txt']);
  });

  test('work-commit commits only what was staged, and work-log lists it', async () => {
    writeFileSync(join(repo, 'scratch.txt'), 'not mine\n');
    git('add', 'index.html');
    const done = await run(workCommit, ["retitle the heading's text", '--dir', repo]);
    assert.equal(done.code, 0, done.err);
    assert.equal(JSON.parse(done.out).filesChanged, 1);
    const status = JSON.parse((await run(workStatus, ['--dir', repo])).out);
    assert.deepEqual(status.untracked, ['scratch.txt']);

    const oneline = await run(workLog, ['--dir', repo, '--oneline', '--count', '1']);
    assert.match(oneline.out, /^[0-9a-f]+ retitle the heading's text\n$/);
    const full = await run(workLog, ['--dir', repo, '--count', '5']);
    assert.equal(full.out.trim().split('\n').length, 2);
    assert.match(full.out, /^[0-9a-f]{40} \d{4}-\d{2}-\d{2} /);
  });

  test('the commands refuse outside a repository, and bad arguments', async () => {
    const outside = mkdtempSync(join(scratch, 'plain-'));
    const commit = await run(workCommit, ['msg', '--dir', outside, '--add-all']);
    assert.equal(commit.code, 1);
    assert.match(commit.err, /not inside a git repository/);
    assert.equal((await run(workStatus, ['--dir', outside])).code, 1);
    assert.equal((await run(workCommit, ['--dir', repo])).code, 1, 'a message is required');
    assert.equal((await run(workLog, ['--count', '0'])).code, 1);
    assert.equal((await run(workDiff, ['--bogus'])).code, 1);
  });

  test('the committed file reads back as written', () => {
    assert.equal(readFileSync(join(repo, 'index.html'), 'utf8'), '<h1>The proof</h1>\n');
  });
});

describe('work-sync and work-clone hand off to git-store', () => {
  /** A fake runner: git answers with the branch, git-store with a JSON result. */
  function fakeRun(branch = 'mission/m-1', storeResult = { status: 'pushed', sha: 'abc', attempts: 1 }) {
    const calls = [];
    const fn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'git') return branch ? { status: 0, stdout: `${branch}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: `${JSON.stringify(storeResult)}\n`, stderr: '[git-store] pushing\n' };
    };
    fn.calls = calls;
    return fn;
  }

  test('work-sync pushes the checked-out branch with the documented arguments', async () => {
    const runner = fakeRun();
    const r = await run(workSync, ['acme-site', '--dir', 'tree'], { run: runner, defaultBranch: 'main' });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { status: 'pushed', sha: 'abc', attempts: 1 });
    assert.equal(r.err, '[git-store] pushing\n');
    const push = runner.calls.find((c) => c.cmd === 'git-store');
    // No --actor: git-store records the agent's own name.
    assert.deepEqual(push.args, ['push', 'acme-site', 'mission/m-1', resolve('tree')]);
  });

  test('work-sync takes --branch and --actor', async () => {
    const runner = fakeRun();
    await run(workSync, ['acme-site', '--branch', 'mission/m-2', '--actor', 'agent'], { run: runner, defaultBranch: 'main' });
    assert.deepEqual(runner.calls.find((c) => c.cmd === 'git-store').args.slice(2), ['mission/m-2', resolve('.'), 'agent']);
  });

  test('work-sync refuses to push the default branch, or a detached tree', async () => {
    const onMain = fakeRun('main');
    const r = await run(workSync, ['acme-site'], { run: onMain, defaultBranch: 'main' });
    assert.equal(r.code, 1);
    assert.match(r.err, /refusing to push 'main'/);
    assert.ok(!onMain.calls.some((c) => c.cmd === 'git-store'));
    const explicit = await run(workSync, ['acme-site', '--branch', 'main'], { run: fakeRun(), defaultBranch: 'main' });
    assert.equal(explicit.code, 1);
    const detached = await run(workSync, ['acme-site'], { run: fakeRun(null), defaultBranch: 'main' });
    assert.equal(detached.code, 1);
    assert.match(detached.err, /not on a branch/);
  });

  test("work-sync passes git-store's failure through", async () => {
    const failing = (cmd) => (cmd === 'git'
      ? { status: 0, stdout: 'mission/m-1\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '[git-store] ERROR: Invalid repoId\n' });
    const r = await run(workSync, ['Bad Id'], { run: failing, defaultBranch: 'main' });
    assert.equal(r.code, 1);
    assert.match(r.err, /Invalid repoId/);
  });

  test('work-clone always names the branch and the directory', async () => {
    const runner = fakeRun();
    await run(workClone, ['acme-site'], { run: runner, defaultBranch: 'main' });
    assert.deepEqual(runner.calls[0].args, ['clone', 'acme-site', '--ref', 'main', '--dir', resolve('acme-site')]);
    const runner2 = fakeRun();
    await run(workClone, ['acme-site', '--dir', 'inputs', '--ref', 'mission/m-9'], { run: runner2, defaultBranch: 'main' });
    assert.deepEqual(runner2.calls[0].args, ['clone', 'acme-site', '--ref', 'mission/m-9', '--dir', resolve('inputs')]);
    const missing = await run(workClone, ['--ref', 'main'], { run: fakeRun(), defaultBranch: 'main' });
    assert.equal(missing.code, 1);
  });
});
