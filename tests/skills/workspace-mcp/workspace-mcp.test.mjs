// Tests for skills/workspace-mcp/workspace-mcp.mjs: CLI flag parsing and execution against a fake MCP client.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as workspaceMcp from '../../../skills/workspace-mcp/workspace-mcp.mjs';

function capture(fn) {
  let out = '';
  let err = '';
  const stdout = { write: (s) => { out += s; } };
  const stderr = { write: (s) => { err += s; } };
  return fn(stdout, stderr).then((code) => ({ code, out, err }));
}

describe('workspace-mcp CLI', () => {
  test('--help and servers/tools/search/call work', async () => {
    const help = await capture((stdout, stderr) => workspaceMcp.main(['--help'], { stdout, stderr }));
    assert.equal(help.code, 0);
    assert.match(help.out, /^Usage: workspace-mcp/);

    const mcp = {
      listServers: () => [{ id: 'universal', name: 'Workspace Universal Search', service: 'workspacemcp.googleapis.com', url: 'https://workspacemcp.googleapis.com/mcp/v1', scopes: [] }],
      listTools: async (id) => ({ server: { id, name: 'Workspace Universal Search' }, tools: [{ name: 'search_corpus', description: 'Search' }] }),
      searchCorpus: async (q) => ({ server: { id: 'universal' }, tool: 'search_corpus', result: { content: [{ type: 'text', text: `Match for ${q}` }] } }),
      callTool: async (s, t, args) => ({ server: { id: s }, tool: t, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } }),
    };

    const servers = await capture((stdout, stderr) => workspaceMcp.main(['servers', '--json'], { stdout, stderr, mcp }));
    assert.equal(servers.code, 0);
    assert.equal(JSON.parse(servers.out).servers[0].id, 'universal');

    const tools = await capture((stdout, stderr) => workspaceMcp.main(['tools', 'universal'], { stdout, stderr, mcp }));
    assert.equal(tools.code, 0);
    assert.match(tools.out, /search_corpus/);

    const search = await capture((stdout, stderr) => workspaceMcp.main(['search', 'SOC 2'], { stdout, stderr, mcp }));
    assert.equal(search.code, 0);
    assert.match(search.out, /Match for SOC 2/);

    const call = await capture((stdout, stderr) => workspaceMcp.main(['call', 'gmail', 'search_threads', '--args', '{"q":"to:support@example.com"}'], { stdout, stderr, mcp }));
    assert.equal(call.code, 0);
    assert.match(call.out, /support@example\.com/);

    const bad = await capture((stdout, stderr) => workspaceMcp.main(['call', 'gmail', 'search_threads', '--args', 'not-json'], { stdout, stderr, mcp }));
    assert.equal(bad.code, 2);
  });
});
