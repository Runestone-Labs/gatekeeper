import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, validateConfig } from './config.js';
import { evaluateTool } from './policy/evaluate.js';
import { executeTool, validateToolArgs, toolExists } from './tools/index.js';
import { ToolRequestSchema } from './tools/schemas.js';
import { createApproval, countPendingApprovals, cleanupExpiredApprovals } from './approvals/store.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { logToolRequest, logToolExecution } from './audit/logger.js';
import { redactSecrets } from './utils.js';
import { getApprovalProvider, getPolicySource } from './providers/index.js';

const startTime = Date.now();

// Validate config before starting
validateConfig();

// Get providers
const policySource = getPolicySource();
const approvalProvider = getApprovalProvider();

// Load policy at startup
const policy = await policySource.load();
console.log(`Loaded policy via ${policySource.name} provider`);
console.log(`Policy hash: ${policySource.getHash()}`);
console.log(`Available tools: ${Object.keys(policy.tools).join(', ')}`);
console.log(`Approval provider: ${approvalProvider.name}`);

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
  };
});

// Main tool execution endpoint
app.post<{ Params: { toolName: string } }>(
  '/tool/:toolName',
  async (request, reply) => {
    const { toolName } = request.params;

    // Validate request body
    const bodyResult = ToolRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      const errors = bodyResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      reply.status(400).send({
        error: `Invalid request: ${errors}`,
      });
      return;
    }

    const { requestId, actor, args, context } = bodyResult.data;

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

    // Evaluate against policy
    const evaluation = evaluateTool(toolName, args, policy);

    // Log the request
    logToolRequest({
      requestId,
      tool: toolName,
      decision: evaluation.decision,
      actor,
      argsSummary,
      riskFlags: evaluation.riskFlags,
    });

    // Handle decision
    switch (evaluation.decision) {
      case 'deny': {
        reply.status(403).send({
          decision: 'deny',
          reason: evaluation.reason,
          requestId,
        });
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
        });

        // Send notification via approval provider (don't block on failure)
        approvalProvider.requestApproval(approval, { approveUrl, denyUrl }).catch(err => {
          console.error('Failed to send approval notification:', err);
        });

        // Build response - include URLs in demo mode for programmatic approval
        const response: Record<string, unknown> = {
          decision: 'approve',
          reason: evaluation.reason,
          requestId,
          approvalId: approval.id,
          expiresAt: approval.expiresAt,
          message: `Approval required. Check ${approvalProvider.name} for approval links.`,
        };

        // DEMO_MODE: Include signed URLs for programmatic testing
        if (config.demoMode) {
          response.approveUrl = approveUrl;
          response.denyUrl = denyUrl;
        }

        reply.status(202).send(response);
        return;
      }

      case 'allow': {
        // Execute tool immediately
        const toolPolicy = policy.tools[toolName];
        const result = await executeTool(toolName, args, toolPolicy);

        const resultSummary = redactSecrets(result);

        // Log the execution
        logToolExecution({
          requestId,
          tool: toolName,
          actor,
          argsSummary,
          resultSummary,
          riskFlags: evaluation.riskFlags,
        });

        reply.status(200).send({
          decision: 'allow',
          requestId,
          success: result.success,
          result: result.output,
          error: result.error,
        });
        return;
      }
    }
  }
);

// Register approval routes
registerApprovalRoutes(app);

// Periodic cleanup of expired approvals (every 5 minutes)
setInterval(() => {
  cleanupExpiredApprovals();
}, 5 * 60 * 1000);

// Start server
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Gatekeeper running on http://localhost:${config.port}`);
  console.log(`Health check: http://localhost:${config.port}/health`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
