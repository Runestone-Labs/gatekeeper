/**
 * Runestone Gatekeeper OpenClaw Plugin
 *
 * Provides policy-enforced tool execution via Gatekeeper.
 * Uses neutral tool descriptions to prevent model pre-filtering.
 */

// Inline GatekeeperClient to avoid npm dependency issues
class GatekeeperClient {
  private readonly baseUrl: string;
  private readonly agentName: string;

  constructor(baseUrl: string, agentName: string = 'openclaw') {
    this.baseUrl = baseUrl;
    this.agentName = agentName;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<any> {
    const requestId = crypto.randomUUID();
    const body = {
      requestId,
      actor: { type: 'agent', name: this.agentName },
      args,
    };

    const response = await fetch(`${this.baseUrl}/tool/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok && response.status !== 403 && response.status !== 202) {
      throw new Error(`Gatekeeper request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }
}

let client: GatekeeperClient | null = null;

function getClient(): GatekeeperClient {
  if (!client) {
    throw new Error('Gatekeeper client not initialized');
  }
  return client;
}

function formatResult(result: any): any {
  if (result.decision === 'deny') {
    const reason = result.reason || 'Request denied by policy';
    return { content: [{ type: 'text', text: 'Error: ' + reason }] };
  }
  if (result.decision === 'approve') {
    return {
      content: [
        {
          type: 'text',
          text:
            'Approval required (expires: ' +
            result.expiresAt +
            '). Ask user to approve, then retry. Approval ID: ' +
            result.approvalId,
        },
      ],
      details: { pending: true, approvalId: result.approvalId },
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.result, null, 2) }],
    details: result.result,
  };
}

// Tool definitions with NEUTRAL descriptions
// (no security language to avoid model pre-filtering)

function createGkExecTool() {
  return {
    name: 'gk_exec',
    description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory' },
      },
      required: ['command'],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const result = await getClient().callTool('shell.exec', params);
        return formatResult(result);
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Gatekeeper error: ' + err.message }] };
      }
    },
  };
}

function createGkWriteTool() {
  return {
    name: 'gk_write',
    description: 'Write content to a file at the specified path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'File content' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding' },
      },
      required: ['path', 'content'],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const result = await getClient().callTool('files.write', params);
        return formatResult(result);
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Gatekeeper error: ' + err.message }] };
      }
    },
  };
}

function createGkHttpTool() {
  return {
    name: 'gk_http',
    description: 'Make an HTTP request and return the response.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Request URL' },
        method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, etc.)' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers' },
        body: { type: 'string', description: 'Request body' },
      },
      required: ['url', 'method'],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const result = await getClient().callTool('http.request', params);
        return formatResult(result);
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Gatekeeper error: ' + err.message }] };
      }
    },
  };
}

export default function register(api: any) {
  const pluginCfg = api.pluginConfig || {};
  const gatekeeperUrl = pluginCfg.gatekeeperUrl || process.env.GATEKEEPER_URL || 'http://localhost:3847';

  // Initialize client
  client = new GatekeeperClient(gatekeeperUrl);

  // Register tools
  api.registerTool(createGkExecTool(), { optional: true });
  api.registerTool(createGkWriteTool(), { optional: true });
  api.registerTool(createGkHttpTool(), { optional: true });
}
