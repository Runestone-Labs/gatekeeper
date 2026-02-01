import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Set up test environment
process.env.GATEKEEPER_SECRET = 'test-secret-key-at-least-32-characters-long';
process.env.POLICY_PATH = join(process.cwd(), 'tests/fixtures/test-policy.yaml');
process.env.DATA_DIR = '/tmp/gatekeeper-demo-test';

const TEST_DATA_DIR = '/tmp/gatekeeper-demo-test';

// Helper to build test app with configurable demo mode
async function buildApp(demoMode: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Mock config with demo mode setting
  const mockConfig = {
    demoMode,
    baseUrl: 'http://localhost:3847',
    secret: 'test-secret-key-at-least-32-characters-long',
    approvalExpiryMs: 60 * 60 * 1000,
    approvalsDir: join(TEST_DATA_DIR, 'approvals'),
    version: '1.0.0-test',
  };

  // Import handlers dynamically
  const { getPolicySource, resetProviders } = await import('../../src/providers/index.js');
  const { evaluateTool } = await import('../../src/policy/evaluate.js');
  const { validateToolArgs, toolExists } = await import('../../src/tools/index.js');
  const { ToolRequestSchema } = await import('../../src/tools/schemas.js');
  const { createApproval } = await import('../../src/approvals/store.js');

  resetProviders();
  const policySource = getPolicySource();
  const policy = await policySource.load();

  // Tool endpoint with demo mode logic
  app.post<{ Params: { toolName: string } }>('/tool/:toolName', async (request, reply) => {
    const { toolName } = request.params;

    const bodyResult = ToolRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({ error: 'Invalid request' });
    }

    const { requestId, actor, args, context } = bodyResult.data;

    if (!toolExists(toolName)) {
      return reply.status(404).send({ error: `Unknown tool: ${toolName}` });
    }

    const argsValidation = validateToolArgs(toolName, args);
    if (!argsValidation.success) {
      return reply.status(400).send({ error: argsValidation.error });
    }

    const evaluation = evaluateTool(toolName, args, policy);

    if (evaluation.decision === 'approve') {
      const { approval, approveUrl, denyUrl } = createApproval({
        toolName,
        args,
        actor,
        context,
        requestId,
      });

      const response: Record<string, unknown> = {
        decision: 'approve',
        reason: evaluation.reason,
        requestId,
        approvalId: approval.id,
        expiresAt: approval.expiresAt,
      };

      // Demo mode includes URLs
      if (mockConfig.demoMode) {
        response.approveUrl = approveUrl;
        response.denyUrl = denyUrl;
      }

      return reply.status(202).send(response);
    }

    return reply.status(403).send({ decision: 'deny', reason: evaluation.reason });
  });

  return app;
}

describe('DEMO_MODE behavior', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, 'audit'), { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('when DEMO_MODE=true', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildApp(true);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('includes approveUrl in 202 response', async () => {
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
      expect(body.approveUrl).toBeDefined();
      expect(body.approveUrl).toContain('/approve/');
      expect(body.approveUrl).toContain('sig=');
    });

    it('includes denyUrl in 202 response', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440001',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'ls -la' },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.denyUrl).toBeDefined();
      expect(body.denyUrl).toContain('/deny/');
      expect(body.denyUrl).toContain('sig=');
    });

    it('URLs contain valid signature and expiry params', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440002',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'ls -la' },
        },
      });

      const body = JSON.parse(response.body);
      // Check URL contains signature and expiry params
      expect(body.approveUrl).toContain('sig=');
      expect(body.approveUrl).toContain('exp=');
      // Signature should be a hex string (64 chars for SHA256)
      const sigMatch = body.approveUrl.match(/sig=([a-f0-9]+)/);
      expect(sigMatch).toBeDefined();
      expect(sigMatch![1].length).toBe(64);
    });
  });

  describe('when DEMO_MODE=false', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildApp(false);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('omits approveUrl from 202 response', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440003',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'ls -la' },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('approve');
      expect(body.approveUrl).toBeUndefined();
    });

    it('omits denyUrl from 202 response', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440004',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'ls -la' },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.denyUrl).toBeUndefined();
    });

    it('still includes approvalId and expiresAt', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440005',
          actor: { type: 'agent', name: 'test-agent' },
          args: { command: 'ls -la' },
        },
      });

      const body = JSON.parse(response.body);
      expect(body.approvalId).toBeDefined();
      expect(body.expiresAt).toBeDefined();
    });
  });
});
