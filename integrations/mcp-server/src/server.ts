/**
 * MCP server wiring: construct the Gatekeeper client, register the tools, and
 * (for the bin entry) connect over stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GatekeeperClient } from '@runestone-labs/gatekeeper-client';
import { loadConfig, type ServerConfig } from './config.js';
import { buildTools, type GatekeeperLike } from './tools.js';

export const SERVER_NAME = 'runestone-gatekeeper';
export const SERVER_VERSION = '0.1.0';

export function createServer(client: GatekeeperLike, config: ServerConfig): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of buildTools(client, config)) {
    server.registerTool(
      tool.name,
      tool.config,
      // Our tool list is heterogeneous (different arg shapes), so we erase the
      // per-tool arg type the SDK would infer and validate at the handler. The
      // SDK has already parsed args against inputSchema before calling us.
      ((args: Record<string, unknown>) => tool.handler(args ?? {})) as never,
    );
  }
  return server;
}

export async function runStdio(): Promise<void> {
  const config = loadConfig();
  const client = new GatekeeperClient({
    baseUrl: config.baseUrl,
    agentName: config.agentName,
    agentRole: config.role,
    runId: config.runId,
  });
  const server = createServer(client, config);
  await server.connect(new StdioServerTransport());
  // Log to STDERR only — stdout carries the JSON-RPC stream and must stay clean.
  console.error(`[gatekeeper-mcp] connected (gatekeeper=${config.baseUrl}, role=${config.role}, agent=${config.agentName})`);
}
