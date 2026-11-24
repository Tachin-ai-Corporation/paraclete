// agent/providers/workspace-mcp.mjs: client for Google Workspace's official remote MCP servers
// (Streamable HTTP + JSON-RPC 2.0), authenticated via Domain-Wide Delegation as the agent's
// Workspace user (https://developers.google.com/workspace/guides/configure-mcp-servers).
//
// Enforces two product rules:
//   - "One way out": blocks Chat posting and direct email send tools here; Chat replies leave
//     through the mouth service (and support-propose), and support email replies go through
//     gmail-reply so loop/duplicate/ledger guards hold.
//   - Plain errors: turns HTTP 403 SERVICE_DISABLED / accessNotConfigured into exact `gcloud
//     services enable` fixes and surfaces MCP form-elicitation prompts clearly.

import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';
import { createDwdTokenSource } from '../auth/dwd-token.mjs';
import { WORKSPACE_MCP_SERVERS } from '../auth/workspace-scopes.mjs';
import { WorkspaceError, workspaceAccount } from './workspace.mjs';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 60_000;

// Tools that send external messages are refused here so outbound mail and Chat stay behind the
// product's single-exit and safety guards.
const BLOCKED_SEND_TOOLS = /(^|[._-])(send_message|send_email|send_reply|post_message|create_message|reply_message|messages\.send|messages\.create)($|[._-])/i;

/**
 * Parses either an `application/json` payload or a `text/event-stream` (SSE) MCP response into JSON-RPC
 * objects, returning the final matching response envelope (or all parsed frames on request).
 *
 * @param {string} raw
 * @param {string} [contentType]
 * @returns {object}
 */
export function parseMcpResponse(raw, contentType = '') {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const isSse = /text\/event-stream/i.test(contentType) || /^data:/m.test(text);
  if (!isSse) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new WorkspaceError(`Workspace MCP server returned invalid JSON: ${err.message}`, { kind: 'bad_request' });
    }
  }
  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (!payload || payload === '[DONE]') return;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      // ignore partial/comment SSE payloads
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  if (!messages.length) {
    throw new WorkspaceError('Workspace MCP server returned an empty event stream.', { kind: 'unavailable' });
  }
  return messages.findLast((m) => Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error')) || messages.at(-1);
}

/** Maps a failed HTTP response from a Google remote MCP server to a clear WorkspaceError. */
function mapMcpHttpError(server, status, bodyText, project) {
  let detail = String(bodyText ?? '').trim();
  let parsed = null;
  try { parsed = JSON.parse(detail); } catch { /* plain text */ }
  const msg = parsed?.error?.message || parsed?.message || detail || `HTTP ${status}`;
  if (status === 401) {
    return new WorkspaceError(`${server.name} rejected credentials (${msg}). Check Domain-Wide Delegation scopes.`, {
      kind: 'auth', status, google: msg,
    });
  }
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(msg)) {
    const enableCmd = `gcloud services enable ${server.service}${project ? ` --project=${project}` : ''}`;
    return new WorkspaceError(
      `${server.name} (${server.service}) is not enabled in this Google Cloud project. Turn it on with: ${enableCmd}`,
      { kind: 'api_disabled', status, reason: 'SERVICE_DISABLED', google: msg },
    );
  }
  if (status === 403) {
    return new WorkspaceError(`${server.name} denied access: ${msg}`, { kind: 'permission', status, google: msg });
  }
  if (status === 429) {
    return new WorkspaceError(`${server.name} is rate limiting requests. Try again in a minute.`, { kind: 'quota', status, google: msg });
  }
  return new WorkspaceError(`${server.name} answered HTTP ${status}: ${msg}`, {
    kind: status >= 500 ? 'unavailable' : 'bad_request', status, google: msg,
  });
}

/**
 * Checks if a tool invocation returned an MCP form elicitation prompt (human-in-the-loop confirmation
 * required for sensitive DWD actions).
 */
function hasElicitation(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.elicitation || result.mode === 'form' || result.requestedSchema) return true;
  if (Array.isArray(result.content)) {
    return result.content.some((part) => part?.type === 'elicitation' || /elicitation/i.test(String(part?.text || '')) && /confirm|approval/i.test(String(part?.text || '')));
  }
  return false;
}

/**
 * Creates a client for Google Workspace remote MCP servers using Domain-Wide Delegation.
 *
 * @param {object} [options]
 * @param {object} options.instance
 * @param {Function} [options.getAccessToken]
 * @param {Function} [options.getDwdToken]
 * @param {Function} [options.fetch]
 * @param {Function} [options.now]
 * @param {Record<string, string>} [options.endpoints]
 */
export function createWorkspaceMcpClient({
  instance,
  getAccessToken = getVmAccessToken,
  getDwdToken,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  endpoints = {},
} = {}) {
  const { account, signer } = workspaceAccount(instance);
  const project = instance?.project || '';
  const dwdToken = getDwdToken || createDwdTokenSource({ fetch: fetchImpl, now, getVmAccessToken: getAccessToken });
  let rpcId = 0;

  function resolveServer(serverId) {
    const base = WORKSPACE_MCP_SERVERS[serverId];
    if (!base) {
      throw new WorkspaceError(`Unknown Google Workspace MCP server '${serverId}'. Available: ${Object.keys(WORKSPACE_MCP_SERVERS).join(', ')}.`, {
        kind: 'bad_request',
      });
    }
    const url = String(endpoints[serverId] || instance?.endpoints?.[`${serverId}mcp`] || base.url);
    return { ...base, url };
  }

  async function postJsonRpc(server, token, payload, sessionId = null, customScopes = null) {
    const scopes = customScopes?.length ? customScopes : [...server.scopes];
    const auth = token || await dwdToken({ signerServiceAccount: signer, subjectEmail: account, scopes });
    const headers = {
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (project) headers['X-Goog-User-Project'] = project;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    let res;
    try {
      res = await fetchImpl(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new WorkspaceError(`${server.name} could not be reached: ${err.message}`, { kind: 'unavailable' });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw mapMcpHttpError(server, res.status, body, project);
    }
    const nextSessionId = res.headers?.get?.('mcp-session-id') || res.headers?.get?.('Mcp-Session-Id') || sessionId;
    if (res.status === 202 || payload.id === undefined) return { envelope: null, sessionId: nextSessionId, token: auth };
    const raw = await res.text();
    const contentType = res.headers?.get?.('content-type') || '';
    const envelope = parseMcpResponse(raw, contentType);
    if (envelope?.error) {
      throw new WorkspaceError(`${server.name} error (${envelope.error.code ?? 'rpc'}): ${envelope.error.message || 'request rejected'}`, {
        kind: 'bad_request',
        google: envelope.error.message || null,
      });
    }
    return { envelope, sessionId: nextSessionId, token: auth };
  }

  async function openSession(serverId, customScopes = null) {
    const server = resolveServer(serverId);
    const scopes = customScopes?.length ? customScopes : [...server.scopes];
    const token = await dwdToken({ signerServiceAccount: signer, subjectEmail: account, scopes });
    rpcId += 1;
    const init = await postJsonRpc(server, token, {
      jsonrpc: '2.0',
      id: rpcId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'paraclete-workspace-mcp', version: '1.0.0' },
      },
    });
    // Notify initialized best-effort (some stateless servers accept or skip 202)
    await postJsonRpc(server, token, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, init.sessionId);
    return { server, token, sessionId: init.sessionId, serverInfo: init.envelope?.result || {} };
  }

  return {
    account,

    listServers() {
      return Object.values(WORKSPACE_MCP_SERVERS).map((s) => ({
        id: s.id,
        name: s.name,
        service: s.service,
        url: String(endpoints[s.id] || instance?.endpoints?.[`${s.id}mcp`] || s.url),
        scopes: [...s.scopes],
      }));
    },

    async listTools(serverId, { scopes } = {}) {
      const session = await openSession(serverId, scopes);
      rpcId += 1;
      const { envelope } = await postJsonRpc(session.server, session.token, {
        jsonrpc: '2.0',
        id: rpcId,
        method: 'tools/list',
        params: {},
      }, session.sessionId);
      return {
        server: session.server,
        serverInfo: session.serverInfo,
        tools: Array.isArray(envelope?.result?.tools) ? envelope.result.tools : [],
      };
    },

    async callTool(serverId, toolName, args = {}, { scopes } = {}) {
      const cleanName = String(toolName || '').trim();
      if (!cleanName) throw new WorkspaceError('MCP tool name is required.', { kind: 'bad_request' });
      if ((serverId === 'chat' || serverId === 'gmail') && BLOCKED_SEND_TOOLS.test(cleanName)) {
        throw new WorkspaceError(
          `Blocked '${cleanName}' on ${serverId} MCP: outbound Chat messages leave through mouth/support-propose, and support Gmail replies go through gmail-reply so duplicate and loop protections run.`,
          { kind: 'permission' },
        );
      }
      const session = await openSession(serverId, scopes);
      rpcId += 1;
      const { envelope } = await postJsonRpc(session.server, session.token, {
        jsonrpc: '2.0',
        id: rpcId,
        method: 'tools/call',
        params: { name: cleanName, arguments: args || {} },
      }, session.sessionId);
      const result = envelope?.result || {};
      if (hasElicitation(result)) {
        throw new WorkspaceError(
          `${session.server.name} tool '${cleanName}' returned a human-in-the-loop elicitation prompt that cannot be completed autonomously via domain-wide delegation.`,
          { kind: 'elicitation' },
        );
      }
      if (result.isError) {
        const msg = (result.content || []).map((c) => c?.text).filter(Boolean).join('\n') || 'MCP tool call failed';
        throw new WorkspaceError(msg, { kind: 'bad_request' });
      }
      return { server: session.server, tool: cleanName, result };
    },

    async searchCorpus(query, extraArgs = {}) {
      const q = String(query || '').trim();
      if (!q) throw new WorkspaceError('searchCorpus requires a non-empty query string.', { kind: 'bad_request' });
      return this.callTool('universal', 'search_corpus', { query: q, ...extraArgs });
    },
  };
}
