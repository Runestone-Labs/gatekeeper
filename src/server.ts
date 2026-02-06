import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, validateConfig } from './config.js';
import { evaluateTool } from './policy/evaluate.js';
import { executeTool, validateToolArgs, toolExists } from './tools/index.js';
import { ToolRequestSchema } from './tools/schemas.js';
import {
  createApproval,
  countPendingApprovals,
  cleanupExpiredApprovals,
} from './approvals/store.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { logToolRequest, logToolExecution, logApprovalConsumed } from './audit/logger.js';
import { redactSecrets, canonicalize, computeHash } from './utils.js';
import { getApprovalProvider, getPolicySource } from './providers/index.js';
import { initDb, closeDb, checkDbHealth, isDbAvailable } from './db/client.js';
import {
  getIdempotencyRecord,
  createPendingRecord,
  completeIdempotencyRecord,
} from './idempotency/store.js';
import { validateCapabilityToken } from './capabilities/token.js';

const startTime = Date.now();

// Validate config before starting
validateConfig();

// Initialize database (optional - memory tools disabled if DATABASE_URL not set)
initDb();

// Get providers
const policySource = getPolicySource();
const approvalProvider = getApprovalProvider();

// Load policy at startup
const policy = await policySource.load();
console.log(`Loaded policy via ${policySource.name} provider`);
console.log(`Policy hash: ${policySource.getHash()}`);
console.log(`Available tools: ${Object.keys(policy.tools).join(', ')}`);
console.log(`Approval provider: ${approvalProvider.name}`);
console.log(`Database: ${isDbAvailable() ? 'connected' : 'not configured'}`);

// Create Fastify instance
const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

// Register CORS
await app.register(cors, {
  origin: true,
});

// Health check endpoint
app.get('/health', async () => {
  const dbHealth = await checkDbHealth();
  return {
    version: config.version,
    policyHash: policySource.getHash(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pendingApprovals: countPendingApprovals(),
    demoMode: config.demoMode,
    providers: {
      approval: approvalProvider.name,
      policy: policySource.name,
    },
    database: {
      available: isDbAvailable(),
      healthy: dbHealth.ok,
      latencyMs: dbHealth.latencyMs,
    },
  };
});

// Main tool execution endpoint
app.post<{ Params: { toolName: string } }>('/tool/:toolName', async (request, reply) => {
  const { toolName } = request.params;

  // Validate request body
  const bodyResult = ToolRequestSchema.safeParse(request.body);
  if (!bodyResult.success) {
    const errors = bodyResult.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    reply.status(400).send({
      error: `Invalid request: ${errors}`,
    });
    return;
  }

  const {
    requestId,
    actor,
    args,
    context,
    origin,
    taint,
    contextRefs,
    dryRun,
    idempotencyKey: idempotencyKeyInput,
    capabilityToken,
  } = bodyResult.data;

  // Build full envelope for evaluation
  const envelope = {
    requestId,
    actor,
    args,
    context,
    origin,
    taint,
    contextRefs,
  };

  // Check if tool exists
  if (!toolExists(toolName)) {
    reply.status(404).send({
      error: `Unknown tool: ${toolName}`,
    });
    return;
  }

  // Validate tool arguments (strict mode)
  const argsValidation = validateToolArgs(toolName, args);
  if (!argsValidation.success) {
    reply.status(400).send({
      error: argsValidation.error,
    });
    return;
  }

  const argsSummary = redactSecrets(args);
  const argsHash = computeHash(canonicalize(args));
  const idempotencyKey = idempotencyKeyInput || requestId;

  const existingRecord = getIdempotencyRecord(idempotencyKey);
  if (existingRecord) {
    if (existingRecord.argsHash !== argsHash || existingRecord.toolName !== toolName) {
      reply.status(409).send({
        decision: 'deny',
        requestId,
        reasonCode: 'IDEMPOTENCY_KEY_CONFLICT',
        humanExplanation:
          'This idempotency key has already been used with different tool arguments.',
        remediation: 'Use a new idempotency key for different requests.',
        policyVersion: policySource.getHash(),
      });
      return;
    }

    if (existingRecord.status === 'completed' && existingRecord.response) {
      reply
        .status(existingRecord.response.statusCode)
        .send(existingRecord.response.body);
      return;
    }

    reply.status(409).send({
      decision: 'deny',
      requestId,
      reasonCode: 'IDEMPOTENCY_IN_PROGRESS',
      humanExplanation: 'A request with this idempotency key is already in progress.',
      remediation: 'Retry this request after it completes.',
      policyVersion: policySource.getHash(),
    });
    return;
  }

  createPendingRecord({
    key: idempotencyKey,
    requestId,
    toolName,
    argsHash,
  });

  // Evaluate against policy (pass full envelope for v1 features)
  let evaluation = evaluateTool(toolName, args, policy, envelope);

  if (capabilityToken) {
    const capabilityResult = validateCapabilityToken({
      token: capabilityToken,
      toolName,
      argsHash,
      actorRole: actor.role,
      actorName: actor.name,
    });

    if (capabilityResult.valid && evaluation.decision === 'approve') {
      evaluation = {
        ...evaluation,
        decision: 'allow',
        reason: 'Capability token allows this request',
        reasonCode: 'CAPABILITY_TOKEN_ALLOW',
        humanExplanation: 'Capability token authorizes this request without manual approval.',
        remediation: undefined,
        riskFlags: [...evaluation.riskFlags, 'capability_token'],
      };
    } else if (!capabilityResult.valid) {
      evaluation = {
        ...evaluation,
        riskFlags: [
          ...evaluation.riskFlags,
          `capability_token_invalid:${capabilityResult.reasonCode}`,
        ],
      };
    } else if (capabilityResult.valid) {
      evaluation = {
        ...evaluation,
        riskFlags: [...evaluation.riskFlags, 'capability_token'],
      };
    }
  }

  // Log the request (include v1 envelope fields)
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
    origin,
    taint,
    contextRefs,
  });

  // v1: Handle dry run - return evaluation without execution
  if (dryRun) {
    reply.status(200).send({
      decision: evaluation.decision,
      requestId,
      reasonCode: evaluation.reasonCode,
      humanExplanation: evaluation.humanExplanation,
      remediation: evaluation.remediation,
      dryRun: true,
      riskFlags: evaluation.riskFlags,
      policyVersion: policySource.getHash(),
      idempotencyKey,
    });
    completeIdempotencyRecord(idempotencyKey, {
      statusCode: 200,
      body: {
        decision: evaluation.decision,
        requestId,
        reasonCode: evaluation.reasonCode,
        humanExplanation: evaluation.humanExplanation,
        remediation: evaluation.remediation,
        dryRun: true,
        riskFlags: evaluation.riskFlags,
        policyVersion: policySource.getHash(),
        idempotencyKey,
      },
    });
    return;
  }

  // Handle decision
  switch (evaluation.decision) {
    case 'deny': {
      const responseBody = {
        decision: 'deny',
        requestId,
        reasonCode: evaluation.reasonCode,
        humanExplanation: evaluation.humanExplanation,
        remediation: evaluation.remediation,
        denial: {
          reasonCode: evaluation.reasonCode,
          humanExplanation: evaluation.humanExplanation,
          remediation: evaluation.remediation,
        },
        policyVersion: policySource.getHash(),
        idempotencyKey,
      };
      reply.status(403).send(responseBody);
      completeIdempotencyRecord(idempotencyKey, { statusCode: 403, body: responseBody });
      return;
    }

    case 'approve': {
      // Create pending approval
      const { approval, approveUrl, denyUrl } = createApproval({
        toolName,
        args,
        actor,
        context,
        requestId,
        idempotencyKey,
      });

      // Send notification via approval provider (don't block on failure)
      approvalProvider.requestApproval(approval, { approveUrl, denyUrl }).catch((err) => {
        console.error('Failed to send approval notification:', err);
      });

      // Build response - include URLs in demo mode for programmatic approval
      const response: Record<string, unknown> = {
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
        message: `Approval required. Check ${approvalProvider.name} for approval links.`,
        policyVersion: policySource.getHash(),
        idempotencyKey,
      };

      // DEMO_MODE: Include signed URLs for programmatic testing
      if (config.demoMode) {
        response.approveUrl = approveUrl;
        response.denyUrl = denyUrl;
        if (response.approvalRequest && typeof response.approvalRequest === 'object') {
          (response.approvalRequest as Record<string, unknown>).approveUrl = approveUrl;
          (response.approvalRequest as Record<string, unknown>).denyUrl = denyUrl;
        }
      }

      reply.status(202).send(response);
      completeIdempotencyRecord(idempotencyKey, { statusCode: 202, body: response });
      return;
    }

    case 'allow': {
      // Execute tool immediately
      const toolPolicy = policy.tools[toolName];
      const startedAt = new Date();
      const result = await executeTool(toolName, args, toolPolicy);
      const completedAt = new Date();
      const executionReceipt = {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };

      const resultSummary = redactSecrets(result);

      // Log the execution
      logToolExecution({
        requestId,
        tool: toolName,
        actor,
        argsSummary,
        argsHash,
        resultSummary,
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
      reply.status(200).send(responseBody);
      completeIdempotencyRecord(idempotencyKey, { statusCode: 200, body: responseBody });
      return;
    }
  }
});

// Register approval routes
registerApprovalRoutes(app);

// Periodic cleanup of expired approvals (every 5 minutes)
setInterval(
  () => {
    const expired = cleanupExpiredApprovals();
    for (const approval of expired) {
      const argsSummary = redactSecrets(approval.args);
      const argsHash = computeHash(canonicalize(approval.args));
      logApprovalConsumed({
        requestId: approval.requestId,
        tool: approval.toolName,
        actor: approval.actor,
        argsSummary,
        argsHash,
        approvalId: approval.id,
        action: 'denied',
        resultSummary: 'Approval expired',
        reasonCode: 'APPROVAL_EXPIRED',
        humanExplanation: 'The approval request expired and defaulted to deny.',
        remediation: 'Resubmit the request to generate a new approval.',
      });
    }
  },
  5 * 60 * 1000
);

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await closeDb();
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`Gatekeeper running on ${config.baseUrl}`);
  console.log(`Health check: ${config.baseUrl}/health`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
