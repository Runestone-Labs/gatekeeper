import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  verifyAndConsumeApproval,
  consumeApprovalDirect,
  createApproval,
  getApprovalStatus,
} from './store.js';
import { executeTool } from '../tools/index.js';
import { logApprovalConsumed, logToolExecution } from '../audit/logger.js';
import { redactSecrets, canonicalize, computeHash, generateId } from '../utils.js';
import { getApprovalProvider, getPolicySource } from '../providers/index.js';
import { config } from '../config.js';
import type { Actor } from '../types.js';

interface ApprovalParams {
  id: string;
}

interface ApprovalQuery {
  sig: string;
  exp: string;
}

interface ApprovalBody {
  sig?: string;
  exp?: string;
}

/**
 * Body for POST /approvals/register — lets a trusted client (the premium app)
 * register a pending approval for an action gatekeeper does NOT itself execute.
 */
interface RegisterApprovalBody {
  toolName: string;
  args?: Record<string, unknown>;
  actor?: Actor;
  /** Opaque application context (decision card, serialized action ref, channels…). */
  metadata?: Record<string, unknown>;
  /** Expiry window in ms from now (defaults to the gatekeeper approval TTL). */
  ttlMs?: number;
  /** Defaults to true for this endpoint (decision-only; caller executes). */
  external?: boolean;
  requestId?: string;
  idempotencyKey?: string;
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

  // POST /approvals/:id/approve
  app.post<{ Params: ApprovalParams; Body: ApprovalBody }>(
    '/approvals/:id/approve',
    async (
      request: FastifyRequest<{ Params: ApprovalParams; Body: ApprovalBody }>,
      reply: FastifyReply
    ) => {
      return handleApprovalAction(request, reply, 'approve');
    }
  );

  // POST /approvals/:id/deny
  app.post<{ Params: ApprovalParams; Body: ApprovalBody }>(
    '/approvals/:id/deny',
    async (
      request: FastifyRequest<{ Params: ApprovalParams; Body: ApprovalBody }>,
      reply: FastifyReply
    ) => {
      return handleApprovalAction(request, reply, 'deny');
    }
  );

  // POST /approvals/register — register a decision-only approval (secret-auth).
  // The control plane owns the lifecycle + audit; the caller executes its own
  // action after observing the decision. Returns signed approve/deny URLs.
  app.post<{ Body: RegisterApprovalBody }>(
    '/approvals/register',
    async (request: FastifyRequest<{ Body: RegisterApprovalBody }>, reply: FastifyReply) => {
      if (!hasSecretAuth(request)) {
        reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
      const body = (request.body as RegisterApprovalBody) || ({} as RegisterApprovalBody);
      if (!body.toolName || typeof body.toolName !== 'string') {
        reply.status(400).send({ error: 'toolName is required' });
        return;
      }
      const actor: Actor = body.actor ?? { type: 'agent', name: 'external', role: 'navigator' };
      const { approval, approveUrl, denyUrl } = createApproval({
        toolName: body.toolName,
        args: body.args ?? {},
        actor,
        requestId: body.requestId ?? generateId(),
        idempotencyKey: body.idempotencyKey,
        metadata: body.metadata,
        external: body.external ?? true,
        ttlMs: body.ttlMs,
      });
      reply.send({
        id: approval.id,
        status: approval.status,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
        approveUrl,
        denyUrl,
      });
    }
  );

  // GET /approvals/:id/status — poll a decision (secret-auth). Lets a consumer
  // reconcile after a restart and learn approve/deny/expire out of band.
  app.get<{ Params: ApprovalParams }>(
    '/approvals/:id/status',
    async (request: FastifyRequest<{ Params: ApprovalParams }>, reply: FastifyReply) => {
      if (!hasSecretAuth(request)) {
        reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
      const status = getApprovalStatus(request.params.id);
      if (!status) {
        reply.status(404).send({ error: 'Approval not found' });
        return;
      }
      reply.send(status);
    }
  );
}

async function handleApprovalAction(
  request: FastifyRequest<{ Params: ApprovalParams }>,
  reply: FastifyReply,
  action: 'approve' | 'deny'
): Promise<void> {
  const { id } = request.params;
  const query = request.query as ApprovalQuery | undefined;
  const body = (request.body as ApprovalBody | undefined) || {};
  const sig = query?.sig || body.sig;
  const exp = query?.exp || body.exp;
  const authorizedBySecret = hasSecretAuth(request);

  if (!authorizedBySecret && (!sig || !exp)) {
    reply.status(400).send({
      error: 'Missing signature or expiry',
    });
    return;
  }

  // Verify and consume the approval
  const { approval, error } = authorizedBySecret
    ? consumeApprovalDirect(id, action)
    : verifyAndConsumeApproval(id, action, sig as string, exp as string);

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
  const argsHash = computeHash(canonicalize(approval.args));

  if (action === 'deny') {
    // Log the denial
    logApprovalConsumed({
      requestId: approval.requestId,
      tool: approval.toolName,
      actor: approval.actor,
      argsSummary,
      argsHash,
      approvalId: approval.id,
      action: 'denied',
      reasonCode: 'APPROVAL_DENIED',
      humanExplanation: 'The approval request was denied by the user.',
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

  // action === 'approve'
  // External (decision-only) approvals: record + audit the decision, but DO NOT
  // execute a governed tool. The registering client polls status and runs its
  // own action. This lets the control plane own approvals for actions it does
  // not itself execute (trades, publishing, …).
  if (approval.external) {
    logApprovalConsumed({
      requestId: approval.requestId,
      tool: approval.toolName,
      actor: approval.actor,
      argsSummary,
      argsHash,
      approvalId: approval.id,
      action: 'approved',
      reasonCode: 'APPROVAL_APPROVED',
      humanExplanation: 'External approval approved; execution delegated to the registering client.',
    });

    const provider = getApprovalProvider();
    if (provider.notifyResult) {
      await provider.notifyResult(approval, 'approved');
    }

    reply.send({ success: true, approvalId: approval.id, external: true });
    return;
  }

  // Governed-tool approval — execute the tool.
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
  const startedAt = new Date();
  const result = await executeTool(approval.toolName, approval.args, toolPolicy);
  const completedAt = new Date();
  const executionReceipt = {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };

  const resultSummary = redactSecrets(result);

  // Log the execution
  logToolExecution({
    requestId: approval.requestId,
    tool: approval.toolName,
    actor: approval.actor,
    argsSummary,
    argsHash,
    resultSummary,
    riskFlags: [],
    executionReceipt,
    approvalId: approval.id,
  });

  logApprovalConsumed({
    requestId: approval.requestId,
    tool: approval.toolName,
    actor: approval.actor,
    argsSummary,
    argsHash,
    approvalId: approval.id,
    action: 'approved',
    resultSummary,
    reasonCode: 'APPROVAL_APPROVED',
    humanExplanation: 'The approval request was approved and executed.',
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
    executionReceipt,
  });
}

function hasSecretAuth(request: FastifyRequest): boolean {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    return token === config.secret;
  }

  const headerSecret = request.headers['x-gatekeeper-secret'];
  if (typeof headerSecret === 'string') {
    return headerSecret === config.secret;
  }

  return false;
}
