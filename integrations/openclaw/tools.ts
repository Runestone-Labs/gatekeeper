/**
 * OpenClaw Gatekeeper Skill - Tool Implementations
 *
 * These tools wrap the Gatekeeper client to provide policy-enforced
 * tool execution for OpenClaw agents.
 */

import { GatekeeperClient, GatekeeperResult } from '../typescript-client/index.js';

// Initialize client from environment
const client = new GatekeeperClient({
  baseUrl: process.env.GATEKEEPER_URL || 'http://localhost:3847',
  agentName: 'openclaw',
  runId: process.env.OPENCLAW_RUN_ID,
});

/**
 * Tool result type for OpenClaw
 */
export interface ToolResult {
  /** Present when operation succeeded */
  result?: unknown;
  /** Present when operation failed */
  error?: string;
  /** Present when approval is required */
  pending?: boolean;
  message?: string;
  approvalId?: string;
}

/**
 * Convert Gatekeeper result to OpenClaw tool result format
 */
function toToolResult(result: GatekeeperResult): ToolResult {
  if (result.decision === 'deny') {
    return {
      error: `Denied: ${result.reason || 'Policy violation'}`,
    };
  }

  if (result.decision === 'approve') {
    return {
      pending: true,
      message:
        `Approval required (expires: ${result.expiresAt}). ` + `Ask user to approve, then retry.`,
      approvalId: result.approvalId,
    };
  }

  // decision === 'allow'
  return {
    result: result.result,
  };
}

/**
 * Execute a shell command through Gatekeeper.
 *
 * @param args.command - The shell command to execute
 * @param args.cwd - Optional working directory
 * @returns Tool result with stdout/stderr or error/pending status
 */
export async function gk_exec(args: { command: string; cwd?: string }): Promise<ToolResult> {
  const result = await client.shellExec(args);
  return toToolResult(result);
}

/**
 * Write a file through Gatekeeper.
 *
 * @param args.path - Absolute path to write to
 * @param args.content - Content to write
 * @param args.encoding - Optional encoding (utf8 or base64)
 * @returns Tool result with path/bytes written or error/pending status
 */
export async function gk_write(args: {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}): Promise<ToolResult> {
  const result = await client.filesWrite(args);
  return toToolResult(result);
}

/**
 * Make an HTTP request through Gatekeeper.
 *
 * @param args.url - URL to request
 * @param args.method - HTTP method
 * @param args.headers - Optional headers
 * @param args.body - Optional request body
 * @returns Tool result with response or error/pending status
 */
export async function gk_http(args: {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
}): Promise<ToolResult> {
  const result = await client.httpRequest(args);
  return toToolResult(result);
}

// Export all tools
export const tools = {
  gk_exec,
  gk_write,
  gk_http,
};

export default tools;
