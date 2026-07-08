/**
 * Server configuration — all of it server-side and PINNED.
 *
 * The MCP client (an LLM) must not be able to influence the identity or
 * provenance Gatekeeper sees, or it could escalate past policy. So role,
 * agent name, origin, and taint are read from the server's environment here and
 * are NEVER taken from tool arguments.
 */

import type { Origin } from '@runestone-labs/gatekeeper-client';

export interface ServerConfig {
  baseUrl: string;
  role: string;
  agentName: string;
  /**
   * Optional run correlation id (pinned server-side, never from tool args) so
   * all calls from this MCP server count toward one per-run budget.
   */
  runId?: string;
  /** Pinned: these calls originate from an LLM via MCP, not a human. */
  origin: Origin;
  /** Pinned taint — marks everything from this server as MCP-sourced. */
  taint: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const role = env.GATEKEEPER_ROLE;
  if (!role) {
    throw new Error(
      'GATEKEEPER_ROLE is required — it is the role this MCP server presents to Gatekeeper for policy enforcement. ' +
        'Set it (and GATEKEEPER_URL) in the MCP server environment.',
    );
  }
  return {
    baseUrl: env.GATEKEEPER_URL || 'http://127.0.0.1:3847',
    role,
    agentName: env.GATEKEEPER_AGENT_NAME || 'mcp-client',
    ...(env.GATEKEEPER_RUN_ID ? { runId: env.GATEKEEPER_RUN_ID } : {}),
    origin: 'model_inferred',
    taint: ['mcp_client'],
  };
}
