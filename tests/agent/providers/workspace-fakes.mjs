// tests/agent/providers/workspace-fakes.mjs: what the Workspace client tests share (the provider
// tests here, and the workspace-* skill command tests). A Workspace instance record, a fake delegation
// token source that hands out one token per scope (so a test can see which API's token a call used),
// and a fake Google: routes of method + path to a handler, every call recorded with its URL parts and
// JSON body. Nothing leaves the process.

import { scopeName } from '../../../agent/auth/workspace-scopes.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';

export const ACCOUNT = 'agent@example.com';
export const SIGNER = 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com';
export const INSTANCE = Object.freeze({
  project: 'your-gcp-project', agent_name: 'Paraclete', role: 'executive-assistant', workspace: Object.freeze({ account: ACCOUNT, signer: SIGNER }), endpoints: {},
});
export const NO_WORKSPACE = Object.freeze({ ...INSTANCE, role: 'generic', workspace: null });

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An error as Calendar, Gmail and Drive send it: `errors[].reason`. */
export const googleError = (status, reason, message) => json({ error: { code: status, message, errors: [{ reason, message, domain: 'global' }] } }, status);

/** An error as Docs, Sheets and Slides send it: a gRPC status, and the reason in `details`. */
export const grpcError = (status, grpcStatus, message, reason) => json({
  error: { code: status, message, status: grpcStatus, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] },
}, status);

/** A delegation token source: `tok-<scope name>` per call, every request recorded. */
export function fakeTokens() {
  const asked = [];
  const fn = async (request) => {
    asked.push(request);
    return `tok-${request.scopes.map(scopeName).join('+')}`;
  };
  fn.asked = asked;
  return fn;
}

/**
 * A fake Google. `routes` is a list of [method, path, handler]: the path a string (exact) or a RegExp
 * on the URL's path; the handler gets the call and the match and returns a Response. An unrouted call
 * is a 404 naming it.
 */
export function fakeGoogle(routes = []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = {
      url: String(url), method: init.method || 'GET', origin: u.origin, path: u.pathname, params: u.searchParams,
      headers: init.headers || {}, body: init.body,
      json() { return JSON.parse(init.body); },
    };
    calls.push(call);
    for (const [method, pattern, handler] of routes) {
      if (method !== call.method) continue;
      const match = typeof pattern === 'string' ? (pattern === call.path ? [pattern] : null) : pattern.exec(call.path);
      if (match) return handler(call, match);
    }
    return googleError(404, 'notFound', `No route for ${call.method} ${call.path}`);
  };
  return { fetch, calls };
}

/** A Drive file record the agent owns (or, with `owner`, someone else does). */
export function driveFile(id, { name = 'File', mimeType = GOOGLE_TYPES.document, owner = null, driveId } = {}) {
  return {
    id, name, mimeType, webViewLink: `https://docs.google.com/document/d/${id}/edit`,
    ownedByMe: !owner && !driveId,
    owners: driveId ? undefined : [{ displayName: owner ? 'Pat Example' : 'Paraclete', emailAddress: owner || ACCOUNT }],
    ...(driveId ? { driveId } : {}),
    capabilities: { canEdit: true, canComment: true },
  };
}

/** A route answering Drive's files.get for the given records. */
export function driveFilesRoute(files) {
  return ['GET', /^\/drive\/v3\/files\/([^/]+)$/, (call, m) => (files[decodeURIComponent(m[1])]
    ? json(files[decodeURIComponent(m[1])])
    : googleError(404, 'notFound', `File not found: ${m[1]}.`))];
}

/**
 * A Docs API document of plain paragraphs with real indexes: each spec is `{ text, style? }` (style a
 * named style like HEADING_1). One tab, id t.0.
 */
export function docOf(title, specs, { revisionId = 'rev-1', documentId = '1DocAbcdefghij' } = {}) {
  const content = [{ endIndex: 1, sectionBreak: {} }];
  let at = 1;
  for (const s of specs) {
    const text = `${s.text}\n`;
    content.push({ startIndex: at, endIndex: at + text.length, paragraph: { elements: [{ textRun: { content: text, textStyle: {} } }], paragraphStyle: { namedStyleType: s.style || 'NORMAL_TEXT' } } });
    at += text.length;
  }
  return { documentId, title, revisionId, tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content } } }] };
}

/** A stand-in for stdout or stderr that keeps what was written. */
export function sink() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

/** Runs a command's main with collected output. */
export async function run(mod, argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await mod.main(argv, { stdout, stderr, ...deps });
  return { code, out: stdout.text(), err: stderr.text() };
}
