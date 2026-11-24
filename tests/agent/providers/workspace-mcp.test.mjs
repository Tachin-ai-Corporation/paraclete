// Tests for agent/providers/workspace-mcp.mjs: Google Workspace remote MCP servers over
// Streamable HTTP + JSON-RPC 2.0 via Domain-Wide Delegation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceMcpClient, parseMcpResponse } from '../../../agent/providers/workspace-mcp.mjs';

const INSTANCE = {
  project: 'your-gcp-project',
  workspace: { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' },
};

describe('parseMcpResponse', () => {
  test('parses application/json and text/event-stream payloads', () => {
    assert.deepEqual(parseMcpResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 'application/json'), {
      jsonrpc: '2.0', id: 1, result: { ok: true },
    });
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search_corpus"}]}}',
      '',
    ].join('\n');
    assert.deepEqual(parseMcpResponse(sse, 'text/event-stream'), {
      jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search_corpus' }] },
    });
  });
});

describe('createWorkspaceMcpClient', () => {
  test('handshakes with initialize + notifications/initialized, propagates Mcp-Session-Id, and searches corpus', async () => {
    const seen = [];
    const fetch = async (url, init = {}) => {
      const rpc = JSON.parse(init.body);
      seen.push({ url: String(url), headers: init.headers, rpc });
      if (rpc.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { serverInfo: { name: 'workspace-mcp' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc' },
        });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (rpc.method === 'tools/list') {
        return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'search_corpus' }] } })}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (rpc.method === 'tools/call') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: 'Found 2 documents' }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected rpc method ${rpc.method}`);
    };

    const mcp = createWorkspaceMcpClient({ instance: INSTANCE, getDwdToken: async () => 'dwd-tok', fetch });
    const servers = mcp.listServers();
    assert.ok(servers.some((s) => s.id === 'universal' && s.url === 'https://workspacemcp.googleapis.com/mcp/v1'));

    const tools = await mcp.listTools('universal');
    assert.equal(tools.tools[0].name, 'search_corpus');
    assert.equal(seen[0].headers.Authorization, 'Bearer dwd-tok');
    assert.equal(seen[0].headers['X-Goog-User-Project'], 'your-gcp-project');
    assert.equal(seen[1].headers['Mcp-Session-Id'], 'sess-abc');
    assert.equal(seen[2].headers['Mcp-Session-Id'], 'sess-abc');

    const res = await mcp.searchCorpus('SOC 2 report');
    assert.equal(res.result.content[0].text, 'Found 2 documents');
    assert.equal(seen.at(-1).rpc.params.name, 'search_corpus');
    assert.deepEqual(seen.at(-1).rpc.params.arguments, { query: 'SOC 2 report' });
  });

  test('blocks outbound Chat/Gmail send tools and surfaces SERVICE_DISABLED & elicitation clearly', async () => {
    const mcp = createWorkspaceMcpClient({ instance: INSTANCE, getDwdToken: async () => 'dwd-tok', fetch: async () => new Response('{}', { status: 200 }) });
    await assert.rejects(mcp.callTool('chat', 'chat.create_message', {}), /Blocked 'chat\.create_message'/);
    await assert.rejects(mcp.callTool('gmail', 'gmail.send_email', {}), /Blocked 'gmail\.send_email'/);

    const disabledFetch = async () => new Response(JSON.stringify({
      error: { code: 403, message: 'workspacemcp.googleapis.com has not been used in project your-gcp-project before or it is disabled.' },
    }), { status: 403 });
    const disabledMcp = createWorkspaceMcpClient({ instance: INSTANCE, getDwdToken: async () => 'dwd-tok', fetch: disabledFetch });
    await assert.rejects(disabledMcp.searchCorpus('q'), /gcloud services enable workspacemcp\.googleapis\.com --project=your-gcp-project/);

    const elicitFetch = async (url, init) => {
      const rpc = JSON.parse(init.body);
      if (rpc.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }), { status: 200 });
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { mode: 'form', requestedSchema: { type: 'object' } } }), { status: 200 });
    };
    const elicitMcp = createWorkspaceMcpClient({ instance: INSTANCE, getDwdToken: async () => 'dwd-tok', fetch: elicitFetch });
    await assert.rejects(elicitMcp.callTool('drive', 'delete_file', {}), /elicitation prompt/);
  });
});
