/**
 * OpenClaw Gatekeeper Tool Plugin
 *
 * Provides policy-enforced tool execution for OpenClaw agents via Runestone Gatekeeper.
 * Implements the OpenClaw ToolPlugin interface for proper integration.
 */

import { Type, Static } from '@sinclair/typebox';
import { GatekeeperClient, GatekeeperResult } from '@runestone/gatekeeper-client';

// Plugin configuration schema
const ConfigSchema = Type.Object({
  gatekeeperUrl: Type.Optional(
    Type.String({
      description: 'Gatekeeper URL (default: http://localhost:3847)',
    })
  ),
});

type PluginConfig = Static<typeof ConfigSchema>;

// Tool input schemas
const ExecInputSchema = Type.Object({
  command: Type.String({ description: 'Shell command to execute' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory' })),
});

const WriteInputSchema = Type.Object({
  path: Type.String({ description: 'File path to write' }),
  content: Type.String({ description: 'File content' }),
  encoding: Type.Optional(
    Type.Union([Type.Literal('utf8'), Type.Literal('base64')], {
      description: 'Content encoding (default: utf8)',
    })
  ),
});

const HttpInputSchema = Type.Object({
  url: Type.String({ description: 'Request URL' }),
  method: Type.String({ description: 'HTTP method (GET, POST, PUT, DELETE, etc.)' }),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Request headers',
    })
  ),
  body: Type.Optional(Type.String({ description: 'Request body' })),
});

// Singleton client instance
let client: GatekeeperClient | null = null;

/**
 * Get or create the Gatekeeper client
 */
function getClient(configUrl?: string): GatekeeperClient {
  if (!client) {
    const url = configUrl || process.env.GATEKEEPER_URL || 'http://localhost:3847';
    client = new GatekeeperClient({
      baseUrl: url,
      agentName: 'openclaw',
      runId: process.env.OPENCLAW_RUN_ID,
    });
  }
  return client;
}

/**
 * Format Gatekeeper result for OpenClaw tool response
 */
function formatResult(result: GatekeeperResult): Record<string, unknown> {
  if (result.decision === 'deny') {
    return {
      error: result.reason || 'Request denied by policy',
    };
  }

  if (result.decision === 'approve') {
    return {
      pending: true,
      approvalId: result.approvalId,
      message: `Approval required (expires: ${result.expiresAt}). Ask user to approve, then retry.`,
    };
  }

  // decision === 'allow'
  return {
    result: result.result,
  };
}

/**
 * OpenClaw Tool Plugin Definition
 *
 * Exports tools that route through Gatekeeper for policy enforcement.
 */
const gatekeeperPlugin = {
  id: 'gatekeeper',
  slot: 'tool' as const,
  schema: ConfigSchema,

  init(config: PluginConfig) {
    // Initialize client with config URL if provided
    if (config.gatekeeperUrl) {
      client = new GatekeeperClient({
        baseUrl: config.gatekeeperUrl,
        agentName: 'openclaw',
        runId: process.env.OPENCLAW_RUN_ID,
      });
    }

    return {
      tools: [
        {
          name: 'gk_exec',
          description:
            'Execute a shell command through Gatekeeper policy enforcement. ' +
            'Commands are validated against security policies before execution.',
          inputSchema: ExecInputSchema,
          async execute(params: Static<typeof ExecInputSchema>) {
            try {
              const result = await getClient(config.gatekeeperUrl).shellExec(params);
              return formatResult(result);
            } catch (err) {
              return {
                error: `Gatekeeper error: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        },
        {
          name: 'gk_write',
          description:
            'Write a file through Gatekeeper policy enforcement. ' +
            'File paths and extensions are validated against security policies.',
          inputSchema: WriteInputSchema,
          async execute(params: Static<typeof WriteInputSchema>) {
            try {
              const result = await getClient(config.gatekeeperUrl).filesWrite(params);
              return formatResult(result);
            } catch (err) {
              return {
                error: `Gatekeeper error: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        },
        {
          name: 'gk_http',
          description:
            'Make an HTTP request through Gatekeeper with SSRF protection. ' +
            'URLs are validated against domain allowlists and private IP ranges are blocked.',
          inputSchema: HttpInputSchema,
          async execute(params: Static<typeof HttpInputSchema>) {
            try {
              const result = await getClient(config.gatekeeperUrl).httpRequest(params);
              return formatResult(result);
            } catch (err) {
              return {
                error: `Gatekeeper error: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        },
      ],
    };
  },
};

export default gatekeeperPlugin;

// Also export for direct usage in tests
export { getClient, formatResult, ConfigSchema, ExecInputSchema, WriteInputSchema, HttpInputSchema };
