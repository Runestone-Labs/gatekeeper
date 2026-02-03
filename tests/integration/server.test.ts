import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Set up test environment
process.env.GATEKEEPER_SECRET = 'test-secret-key-at-least-32-characters-long';
process.env.POLICY_PATH = join(process.cwd(), 'tests/fixtures/test-policy.yaml');
process.env.DATA_DIR = '/tmp/gatekeeper-integration-test';

const TEST_DATA_DIR = '/tmp/gatekeeper-integration-test';

// Helper to build test app
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Import handlers dynamically to use test config
  const { getPolicySource, resetProviders } = await import('../../src/providers/index.js');
  const { evaluateTool } = await import('../../src/policy/evaluate.js');
  const { executeTool, validateToolArgs, toolExists } = await import('../../src/tools/index.js');
  const { ToolRequestSchema } = await import('../../src/tools/schemas.js');
  const { createApproval } = await import('../../src/approvals/store.js');
  const { registerApprovalRoutes } = await import('../../src/approvals/routes.js');
  const { logToolRequest, logToolExecution } = await import('../../src/audit/logger.js');
  const { redactSecrets } = await import('../../src/utils.js');

  // Reset providers to ensure fresh state
  resetProviders();

  const policySource = getPolicySource();
  const policy = await policySource.load();

  // Health endpoint
  app.get('/health', async () => ({
    version: '1.0.0-test',
    policyHash: policySource.getHash(),
    uptime: 0,
    pendingApprovals: 0,
  }));

  // Tool endpoint
  app.post<{ Params: { toolName: string } }>('/tool/:toolName', async (request, reply) => {
    const { toolName } = request.params;

    const bodyResult = ToolRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({ error: 'Invalid request' });
    }

    const { requestId, actor, args } = bodyResult.data;

    if (!toolExists(toolName)) {
      return reply.status(404).send({ error: `Unknown tool: ${toolName}` });
    }

    const argsValidation = validateToolArgs(toolName, args);
    if (!argsValidation.success) {
      return reply.status(400).send({ error: argsValidation.error });
    }

    const argsSummary = redactSecrets(args);
    const evaluation = evaluateTool(toolName, args, policy);

    logToolRequest({
      requestId,
      tool: toolName,
      decision: evaluation.decision,
      actor,
      argsSummary,
      riskFlags: evaluation.riskFlags,
    });

    switch (evaluation.decision) {
      case 'deny':
        return reply.status(403).send({
          decision: 'deny',
          reason: evaluation.reason,
          requestId,
        });

      case 'approve': {
        const { approval } = createApproval({
          toolName,
          args,
          actor,
          requestId,
        });
        return reply.status(202).send({
          decision: 'approve',
          reason: evaluation.reason,
          requestId,
          approvalId: approval.id,
          expiresAt: approval.expiresAt,
        });
      }

      case 'allow': {
        const toolPolicy = policy.tools[toolName];
        const result = await executeTool(toolName, args, toolPolicy);

        logToolExecution({
          requestId,
          tool: toolName,
          actor,
          argsSummary,
          resultSummary: redactSecrets(result),
          riskFlags: evaluation.riskFlags,
        });

        return reply.status(200).send({
          decision: 'allow',
          requestId,
          success: result.success,
          result: result.output,
          error: result.error,
        });
      }
    }
  });

  registerApprovalRoutes(app);

  return app;
}

describe('server integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Ensure test directories exist
    mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, 'audit'), { recursive: true });
  });

  beforeEach(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('GET /health', () => {
    it('returns health info', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.version).toBeDefined();
      expect(body.policyHash).toMatch(/^sha256:/);
    });
  });

  describe('POST /tool/:toolName', () => {
    it('returns 404 for unknown tool', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/unknown.tool',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: {},
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: 'not-a-uuid',
          actor: { type: 'agent', name: 'test' },
          args: {},
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for invalid tool args', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: '' }, // Empty command not allowed
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 403 for denied command (deny pattern)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'rm -rf /' },
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('deny');
      expect(body.reason).toContain('rm -rf');
    });

    it('returns 202 for command requiring approval', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'ls -la' },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('approve');
      expect(body.approvalId).toBeDefined();
      expect(body.expiresAt).toBeDefined();
    });

    it('returns 200 for allowed http request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/http.request',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: {
            url: 'https://httpbin.org/get',
            method: 'GET',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('allow');
      expect(body.success).toBeDefined();
    }, 10000); // Longer timeout for real HTTP request

    it('returns 403 for http request to blocked domain', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/http.request',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: {
            url: 'https://evil.com/api',
            method: 'GET',
          },
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('deny');
      expect(body.reason).toContain('evil.com');
    });

    it('returns 403 for file write to blocked extension', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/files.write',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent' },
          args: {
            path: '/tmp/.env',
            content: 'SECRET=x',
          },
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.reason).toContain('.env');
    });
  });
});
