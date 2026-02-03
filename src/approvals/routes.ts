import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAndConsumeApproval } from './store.js';
import { executeTool } from '../tools/index.js';
import { logApprovalConsumed, logToolExecution } from '../audit/logger.js';
import { redactSecrets } from '../utils.js';
import { getApprovalProvider, getPolicySource } from '../providers/index.js';

interface ApprovalParams {
  id: string;
}

interface ApprovalQuery {
  sig: string;
  exp: string;
}

/**
 * Register approval routes.
 */
export function registerApprovalRoutes(app: FastifyInstance): void {
  // GET /approve/:id
  app.get<{ Params: ApprovalParams; Querystring: ApprovalQuery }>(
    '/approve/:id',
    async (
      request: FastifyRequest<{ Params: ApprovalParams; Querystring: ApprovalQuery }>,
      reply: FastifyReply
    ) => {
      return handleApprovalAction(request, reply, 'approve');
    }
  );

  // GET /deny/:id
  app.get<{ Params: ApprovalParams; Querystring: ApprovalQuery }>(
    '/deny/:id',
    async (
      request: FastifyRequest<{ Params: ApprovalParams; Querystring: ApprovalQuery }>,
      reply: FastifyReply
    ) => {
      return handleApprovalAction(request, reply, 'deny');
    }
  );
}

async function handleApprovalAction(
  request: FastifyRequest<{ Params: ApprovalParams; Querystring: ApprovalQuery }>,
  reply: FastifyReply,
  action: 'approve' | 'deny'
): Promise<void> {
  const { id } = request.params;
  const { sig, exp } = request.query;

  if (!sig || !exp) {
    reply.status(400).send({
      error: 'Missing signature or expiry',
    });
    return;
  }

  // Verify and consume the approval
  const { approval, error } = verifyAndConsumeApproval(id, action, sig, exp);

  if (!approval) {
    // Determine appropriate status code
    const statusCode =
      error === 'Approval not found'
        ? 404
        : error === 'Approval has expired'
          ? 410
          : error?.includes('already')
            ? 409
            : 403;

    reply.status(statusCode).send({ error });
    return;
  }

  const argsSummary = redactSecrets(approval.args);

  if (action === 'deny') {
    // Log the denial
    logApprovalConsumed({
      requestId: approval.requestId,
      tool: approval.toolName,
      actor: approval.actor,
      argsSummary,
      approvalId: approval.id,
      action: 'denied',
    });

    // Notify via approval provider
    const provider = getApprovalProvider();
    if (provider.notifyResult) {
      await provider.notifyResult(approval, 'denied');
    }

    reply.send({
      success: true,
      message: `Tool execution denied`,
      approvalId: approval.id,
    });
    return;
  }

  // action === 'approve' - execute the tool
  const policySource = getPolicySource();
  const policy = await policySource.load();
  const toolPolicy = policy.tools[approval.toolName];

  if (!toolPolicy) {
    reply.status(500).send({
      error: `Tool ${approval.toolName} not found in policy`,
    });
    return;
  }

  // Execute the tool
  const result = await executeTool(approval.toolName, approval.args, toolPolicy);

  const resultSummary = redactSecrets(result);

  // Log the execution
  logToolExecution({
    requestId: approval.requestId,
    tool: approval.toolName,
    actor: approval.actor,
    argsSummary,
    resultSummary,
    riskFlags: [],
    approvalId: approval.id,
  });

  logApprovalConsumed({
    requestId: approval.requestId,
    tool: approval.toolName,
    actor: approval.actor,
    argsSummary,
    approvalId: approval.id,
    action: 'approved',
    resultSummary,
  });

  // Notify via approval provider
  const approvalProvider = getApprovalProvider();
  if (approvalProvider.notifyResult) {
    await approvalProvider.notifyResult(
      approval,
      'approved',
      result.success ? 'Execution successful' : result.error
    );
  }

  reply.send({
    success: result.success,
    approvalId: approval.id,
    result: result.output,
    error: result.error,
  });
}
