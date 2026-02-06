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
  const {
    getIdempotencyRecord,
    createPendingRecord,
    completeIdempotencyRecord,
  } = await import('../../src/idempotency/store.js');
  const { registerApprovalRoutes } = await import('../../src/approvals/routes.js');
  const { logToolRequest, logToolExecution } = await import('../../src/audit/logger.js');
  const { redactSecrets, canonicalize, computeHash } = await import('../../src/utils.js');

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

    const { requestId, actor, args, idempotencyKey: idempotencyKeyInput } = bodyResult.data;

    if (!toolExists(toolName)) {
      return reply.status(404).send({ error: `Unknown tool: ${toolName}` });
    }

    const argsValidation = validateToolArgs(toolName, args);
    if (!argsValidation.success) {
      return reply.status(400).send({ error: argsValidation.error });
    }

    const argsSummary = redactSecrets(args);
    const argsHash = computeHash(canonicalize(args));
    const idempotencyKey = idempotencyKeyInput || requestId;

    const existingRecord = getIdempotencyRecord(idempotencyKey);
    if (existingRecord) {
      if (existingRecord.argsHash !== argsHash || existingRecord.toolName !== toolName) {
        return reply.status(409).send({
          decision: 'deny',
          requestId,
          reasonCode: 'IDEMPOTENCY_KEY_CONFLICT',
          humanExplanation:
            'This idempotency key has already been used with different tool arguments.',
          remediation: 'Use a new idempotency key for different requests.',
          policyVersion: policySource.getHash(),
        });
      }

      if (existingRecord.status === 'completed' && existingRecord.response) {
        return reply
          .status(existingRecord.response.statusCode)
          .send(existingRecord.response.body);
      }

      return reply.status(409).send({
        decision: 'deny',
        requestId,
        reasonCode: 'IDEMPOTENCY_IN_PROGRESS',
        humanExplanation: 'A request with this idempotency key is already in progress.',
        remediation: 'Retry this request after it completes.',
        policyVersion: policySource.getHash(),
      });
    }

    createPendingRecord({
      key: idempotencyKey,
      requestId,
      toolName,
      argsHash,
    });
    const evaluation = evaluateTool(toolName, args, policy);

    logToolRequest({
      requestId,
      tool: toolName,
      decision: evaluation.decision,
      actor,
      argsSummary,
      argsHash,
      riskFlags: evaluation.riskFlags,
      reasonCode: evaluation.reasonCode,
      humanExplanation: evaluation.humanExplanation,
      remediation: evaluation.remediation,
    });

    switch (evaluation.decision) {
      case 'deny':
        const responseBody = {
          decision: 'deny',
          reasonCode: evaluation.reasonCode,
          humanExplanation: evaluation.humanExplanation,
          remediation: evaluation.remediation,
          denial: {
            reasonCode: evaluation.reasonCode,
            humanExplanation: evaluation.humanExplanation,
            remediation: evaluation.remediation,
          },
          requestId,
          policyVersion: policySource.getHash(),
          idempotencyKey,
        };

        completeIdempotencyRecord(idempotencyKey, { statusCode: 403, body: responseBody });
        return reply.status(403).send(responseBody);

      case 'approve': {
        const { approval } = createApproval({
          toolName,
          args,
          actor,
          requestId,
        });
        const responseBody = {
          decision: 'approve',
          requestId,
          approvalId: approval.id,
          expiresAt: approval.expiresAt,
          reasonCode: evaluation.reasonCode,
          humanExplanation: evaluation.humanExplanation,
          remediation: evaluation.remediation,
          approvalRequest: {
            approvalId: approval.id,
            expiresAt: approval.expiresAt,
            reasonCode: evaluation.reasonCode,
            humanExplanation: evaluation.humanExplanation,
            remediation: evaluation.remediation,
          },
          policyVersion: policySource.getHash(),
          idempotencyKey,
        };

        completeIdempotencyRecord(idempotencyKey, { statusCode: 202, body: responseBody });
        return reply.status(202).send(responseBody);
      }

      case 'allow': {
        const toolPolicy = policy.tools[toolName];
        const startedAt = new Date();
        const result = await executeTool(toolName, args, toolPolicy);
        const completedAt = new Date();
        const executionReceipt = {
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };

        logToolExecution({
          requestId,
          tool: toolName,
          actor,
          argsSummary,
          argsHash,
          resultSummary: redactSecrets(result),
          riskFlags: evaluation.riskFlags,
          executionReceipt,
        });

        const responseBody = {
          decision: 'allow',
          requestId,
          success: result.success,
          result: result.output,
          error: result.error,
          reasonCode: evaluation.reasonCode,
          humanExplanation: evaluation.humanExplanation,
          remediation: evaluation.remediation,
          executionReceipt,
          policyVersion: policySource.getHash(),
          idempotencyKey,
        };

        completeIdempotencyRecord(idempotencyKey, { statusCode: 200, body: responseBody });
        return reply.status(200).send(responseBody);
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
    const idempotencyDir = join(TEST_DATA_DIR, 'idempotency');
    if (existsSync(idempotencyDir)) {
      rmSync(idempotencyDir, { recursive: true });
    }
    mkdirSync(idempotencyDir, { recursive: true });
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
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
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
          actor: { type: 'agent', name: 'test', role: 'openclaw' },
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
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
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
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
          args: { command: 'rm -rf /' },
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('deny');
      expect(body.reasonCode).toBe('TOOL_DENY_PATTERN');
      expect(body.humanExplanation).toBeDefined();
      expect(body.policyVersion).toMatch(/^sha256:/);
    });

    it('returns 202 for command requiring approval', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
          args: { command: 'ls -la' },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('approve');
      expect(body.approvalId).toBeDefined();
      expect(body.expiresAt).toBeDefined();
      expect(body.reasonCode).toBe('POLICY_APPROVAL_REQUIRED');
    });

    it('replays idempotent approval response', async () => {
      const payload = {
        requestId: '550e8400-e29b-41d4-a716-446655440010',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        args: { command: 'ls -la' },
        idempotencyKey: 'idem-approval-1',
      };

      const response1 = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload,
      });

      const response2 = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload,
      });

      expect(response1.statusCode).toBe(202);
      expect(response2.statusCode).toBe(202);

      const body1 = JSON.parse(response1.body);
      const body2 = JSON.parse(response2.body);
      expect(body1.approvalId).toBe(body2.approvalId);
    });

    it('rejects idempotency key reuse with different args', async () => {
      const base = {
        requestId: '550e8400-e29b-41d4-a716-446655440011',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        idempotencyKey: 'idem-conflict-1',
      };

      await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: { ...base, args: { command: 'ls -la' } },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/tool/shell.exec',
        payload: { ...base, args: { command: 'pwd' } },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.reasonCode).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('returns 200 for allowed http request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/http.request',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
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
      expect(body.reasonCode).toBe('POLICY_ALLOW');
    }, 10000); // Longer timeout for real HTTP request

    it('returns 403 for http request to blocked domain', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/http.request',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
          args: {
            url: 'https://evil.com/api',
            method: 'GET',
          },
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.decision).toBe('deny');
      expect(body.reasonCode).toBe('DOMAIN_DENIED');
    });

    it('returns 403 for file write to blocked extension', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tool/files.write',
        payload: {
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
          args: {
            path: '/tmp/.env',
            content: 'SECRET=x',
          },
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.reasonCode).toBe('EXTENSION_DENIED');
    });
  });
});
