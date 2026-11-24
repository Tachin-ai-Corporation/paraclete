#!/usr/bin/env node
// skills/workspace-mcp/workspace-mcp.mjs: CLI for Google Workspace's official remote MCP
// servers (Universal Search across Gmail, Drive, Calendar, and Chat plus read-safe tool discovery
// and invocation) authenticated through domain-wide delegation as the agent's Workspace account.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createWorkspaceMcpClient } from '../../agent/providers/workspace-mcp.mjs';

export const USAGE = [
  'Usage: workspace-mcp servers [--json]',
  '       workspace-mcp tools <server> [--json]',
  '       workspace-mcp search "<query>" [--json]',
  "       workspace-mcp call <server> <tool> [--args '<json>'] [--json]",
].join('\n');

export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        args: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [sub, ...rest] = positionals;
  if (!sub || !['servers', 'tools', 'search', 'call'].includes(sub)) {
    return { error: sub ? `unknown subcommand '${sub}'` : 'a subcommand is required (servers, tools, search, or call)' };
  }
  const json = values.json === true;
  if (sub === 'servers') {
    if (rest.length) return { error: 'servers takes no positional arguments' };
    return { sub, json };
  }
  if (sub === 'tools') {
    if (rest.length !== 1) return { error: 'tools requires one server id (for example: universal, gmail, drive)' };
    return { sub, server: rest[0], json };
  }
  if (sub === 'search') {
    const query = rest.join(' ').trim();
    if (!query) return { error: 'search requires a query string' };
    return { sub, query, json };
  }
  if (rest.length !== 2) return { error: 'call requires <server> <tool>' };
  let toolArgs = {};
  if (values.args !== undefined) {
    try {
      const decoded = JSON.parse(values.args);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        return { error: '--args must be a JSON object' };
      }
      toolArgs = decoded;
    } catch (err) {
      return { error: `--args is not valid JSON: ${err.message}` };
    }
  }
  return { sub, server: rest[0], tool: rest[1], toolArgs, json };
}

function formatTextContent(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((p) => (p?.type === 'text' ? p.text : JSON.stringify(p))).filter(Boolean).join('\n');
  if (text) return text;
  if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  return JSON.stringify(result ?? {}, null, 2);
}

/**
 * Entry point for `workspace-mcp`.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (msg, code = 1) => { stderr.write(`workspace-mcp: ${msg}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const client = deps.mcp || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createWorkspaceMcpClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();

    if (args.sub === 'servers') {
      const servers = client.listServers();
      if (args.json) {
        stdout.write(`${JSON.stringify({ servers }, null, 2)}\n`);
        return 0;
      }
      for (const s of servers) stdout.write(`${s.id}: ${s.name} (${s.url})\n`);
      return 0;
    }

    if (args.sub === 'tools') {
      const res = await client.listTools(args.server);
      if (args.json) {
        stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        return 0;
      }
      stdout.write(`${res.server.name} (${res.tools.length} tool(s)):\n`);
      for (const t of res.tools) stdout.write(`- ${t.name}${t.description ? `: ${t.description}` : ''}\n`);
      return 0;
    }

    if (args.sub === 'search') {
      const res = await client.searchCorpus(args.query);
      if (args.json) {
        stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        return 0;
      }
      stdout.write(`${formatTextContent(res.result)}\n`);
      return 0;
    }

    const res = await client.callTool(args.server, args.tool, args.toolArgs);
    if (args.json) {
      stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatTextContent(res.result)}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
