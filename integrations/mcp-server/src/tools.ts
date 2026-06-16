/**
 * MCP tool definitions. Each tool is a thin adapter that forwards to a
 * Gatekeeper tool through the gated-call seam, which pins identity/provenance
 * server-side and maps the decision fail-closed (see translate.ts).
 *
 * Only the tool ARGS cross the boundary from the caller — never actor, role,
 * origin, taint, or capabilityToken. There is no code path by which a tool
 * argument can become any of those, so the LLM cannot escalate its privileges.
 */

import { z } from 'zod';
import type { GatekeeperClient } from '@runestone-labs/gatekeeper-client';
import type { ServerConfig } from './config.js';
import {
  assertValidToolName,
  decisionToToolResult,
  errorToToolResult,
  TOOL_NAME_RE,
  type ToolResult,
} from './translate.js';

/** The slice of the client the tools need — lets tests inject a fake. */
export type GatekeeperLike = Pick<GatekeeperClient, 'callTool' | 'health'>;

export interface ToolDef {
  name: string;
  /** Gatekeeper tool this maps to (undefined for non-gated tools like health). */
  gatekeeperTool?: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * The single seam every gated tool funnels through. Validates the tool name
 * (anti-traversal), forwards ONLY args + server-pinned options, and maps the
 * decision fail-closed. Any throw becomes a fail-closed error result.
 */
async function gatedCall(
  client: GatekeeperLike,
  config: ServerConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    assertValidToolName(tool);
    const result = await client.callTool(tool, args, {
      origin: config.origin,
      taint: config.taint,
    });
    return decisionToToolResult(result, config.baseUrl);
  } catch (err) {
    return errorToToolResult(err, config.baseUrl);
  }
}

const DESTRUCTIVE = { destructiveHint: true, openWorldHint: true, readOnlyHint: false } as const;

export function buildTools(client: GatekeeperLike, config: ServerConfig): ToolDef[] {
  return [
    {
      name: 'shell_exec',
      gatekeeperTool: 'shell.exec',
      config: {
        title: 'Run a shell command (policy-gated)',
        description:
          'Execute a shell command through Gatekeeper. The command is subject to policy: it may be allowed, require human approval, or be denied. Returns stdout/stderr/exitCode on allow.',
        inputSchema: {
          command: z.string().min(1).describe('The shell command to run.'),
          cwd: z.string().optional().describe('Working directory.'),
          timeoutMs: z.number().int().positive().optional().describe('Per-call timeout in ms.'),
        },
        annotations: { ...DESTRUCTIVE },
      },
      handler: (args) => gatedCall(client, config, 'shell.exec', args),
    },
    {
      name: 'files_write',
      gatekeeperTool: 'files.write',
      config: {
        title: 'Write a file (policy-gated)',
        description:
          'Write content to a file through Gatekeeper. Subject to policy (allow / approve / deny). Returns the path and bytes written on allow.',
        inputSchema: {
          path: z.string().min(1).describe('Destination file path.'),
          content: z.string().describe('File content to write.'),
          encoding: z.literal('utf8').optional(),
        },
        annotations: { ...DESTRUCTIVE },
      },
      handler: (args) => gatedCall(client, config, 'files.write', args),
    },
    {
      name: 'http_request',
      gatekeeperTool: 'http.request',
      config: {
        title: 'Make an HTTP request (policy-gated)',
        description:
          'Make an HTTP GET/POST through Gatekeeper. The destination host is subject to egress policy (allow / approve / deny). Returns status/headers/body on allow.',
        inputSchema: {
          url: z.string().url().describe('Absolute URL.'),
          method: z.enum(['GET', 'POST']),
          headers: z.record(z.string()).optional(),
          body: z.string().optional(),
          timeout_ms: z.number().int().positive().optional(),
        },
        annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
      },
      handler: (args) => gatedCall(client, config, 'http.request', args),
    },
    {
      name: 'gatekeeper_call',
      config: {
        title: 'Call any Gatekeeper tool (generic, policy-gated)',
        description:
          'Escape hatch: invoke any Gatekeeper tool by name (e.g. memory.query) with an args object. The call is policy-gated exactly like the typed tools. The tool name is validated; identity/role/origin are fixed by the server and cannot be set here.',
        inputSchema: {
          // Validated at the schema boundary too (not just the runtime guard in
          // gatedCall) so a traversal attempt is rejected before the handler.
          tool: z
            .string()
            .max(64)
            .regex(TOOL_NAME_RE, 'must be a dotted lowercase identifier (no slashes, no traversal)')
            .describe('Gatekeeper tool name, e.g. "memory.query" (dotted lowercase; no slashes).'),
          args: z.record(z.unknown()).default({}).describe('Arguments object for the tool.'),
        },
        annotations: { openWorldHint: true },
      },
      handler: (args) => {
        const tool = args.tool;
        if (typeof tool !== 'string') {
          return Promise.resolve(errorToToolResult(new Error('`tool` must be a string'), config.baseUrl));
        }
        const inner = (args.args && typeof args.args === 'object' ? args.args : {}) as Record<string, unknown>;
        return gatedCall(client, config, tool, inner);
      },
    },
    {
      name: 'gatekeeper_health',
      config: {
        title: 'Gatekeeper health',
        description: 'Check whether the configured Gatekeeper server is reachable and report its version/policy hash.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async () => {
        try {
          const h = await client.health();
          return { content: [{ type: 'text', text: JSON.stringify(h, null, 2) }], isError: false };
        } catch (err) {
          return errorToToolResult(err, config.baseUrl);
        }
      },
    },
  ];
}
