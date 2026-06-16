#!/usr/bin/env node
/**
 * gatekeeper-mcp — stdio MCP server entrypoint.
 *
 * Configure via env: GATEKEEPER_URL (default http://127.0.0.1:3847),
 * GATEKEEPER_ROLE (required), GATEKEEPER_AGENT_NAME (default mcp-client).
 */

import { runStdio } from './server.js';

runStdio().catch((err) => {
  console.error('[gatekeeper-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
