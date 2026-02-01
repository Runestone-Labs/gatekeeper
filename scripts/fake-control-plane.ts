#!/usr/bin/env tsx
/**
 * Fake Runestone Control Plane
 *
 * A minimal control plane server for testing the Runestone approval provider.
 * Stores approvals in memory and provides endpoints to approve/deny them.
 *
 * Usage:
 *   npm run control-plane
 *
 * Then start gatekeeper with:
 *   APPROVAL_PROVIDER=runestone RUNESTONE_API_URL=http://localhost:3848 npm start
 */

import Fastify from 'fastify';

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '3848', 10);

interface StoredApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  actor: { type: string; name: string };
  context?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  callbacks: {
    approveUrl: string;
    denyUrl: string;
  };
  status: 'pending' | 'approved' | 'denied';
  result?: string;
}

// In-memory storage
const approvals = new Map<string, StoredApproval>();

const app = Fastify({
  logger: {
    level: 'info',
  },
});

// Receive approval request from gatekeeper
app.post<{ Body: Omit<StoredApproval, 'status'> }>('/approvals', async (request, reply) => {
  const approval: StoredApproval = {
    ...request.body,
    status: 'pending',
  };

  approvals.set(approval.id, approval);

  console.log('\n' + '='.repeat(60));
  console.log('NEW APPROVAL REQUEST');
  console.log('='.repeat(60));
  console.log(`ID:   ${approval.id}`);
  console.log(`Tool: ${approval.toolName}`);
  console.log(`Args: ${JSON.stringify(approval.args)}`);
  console.log(`Actor: ${approval.actor.name} (${approval.actor.type})`);
  console.log('');
  console.log('To approve:');
  console.log(`  curl -X POST http://localhost:${PORT}/approvals/${approval.id}/approve`);
  console.log('');
  console.log('To deny:');
  console.log(`  curl -X POST http://localhost:${PORT}/approvals/${approval.id}/deny`);
  console.log('='.repeat(60) + '\n');

  reply.status(201).send({ id: approval.id, status: 'pending' });
});

// List all approvals
app.get('/approvals', async () => {
  return Array.from(approvals.values()).map(a => ({
    id: a.id,
    toolName: a.toolName,
    actor: a.actor.name,
    status: a.status,
    createdAt: a.createdAt,
  }));
});

// Get single approval
app.get<{ Params: { id: string } }>('/approvals/:id', async (request, reply) => {
  const approval = approvals.get(request.params.id);
  if (!approval) {
    reply.status(404).send({ error: 'Approval not found' });
    return;
  }
  return approval;
});

// Approve - calls back to gatekeeper
app.post<{ Params: { id: string } }>('/approvals/:id/approve', async (request, reply) => {
  const approval = approvals.get(request.params.id);
  if (!approval) {
    reply.status(404).send({ error: 'Approval not found' });
    return;
  }

  if (approval.status !== 'pending') {
    reply.status(400).send({ error: `Approval already ${approval.status}` });
    return;
  }

  console.log(`\nApproving ${approval.id}...`);

  // Call back to gatekeeper
  const response = await fetch(approval.callbacks.approveUrl, { method: 'GET' });
  const result = await response.json() as Record<string, unknown>;

  approval.status = 'approved';
  approval.result = JSON.stringify(result);

  console.log(`Approved! Result: ${approval.result.slice(0, 100)}...`);

  return { status: 'approved', result };
});

// Deny - calls back to gatekeeper
app.post<{ Params: { id: string } }>('/approvals/:id/deny', async (request, reply) => {
  const approval = approvals.get(request.params.id);
  if (!approval) {
    reply.status(404).send({ error: 'Approval not found' });
    return;
  }

  if (approval.status !== 'pending') {
    reply.status(400).send({ error: `Approval already ${approval.status}` });
    return;
  }

  console.log(`\nDenying ${approval.id}...`);

  // Call back to gatekeeper
  const response = await fetch(approval.callbacks.denyUrl, { method: 'GET' });
  const result = await response.json() as Record<string, unknown>;

  approval.status = 'denied';

  console.log(`Denied!`);

  return { status: 'denied', result };
});

// Receive result notification from gatekeeper
app.post<{ Params: { id: string }; Body: { action: string; result?: string } }>(
  '/approvals/:id/result',
  async (request, reply) => {
    const approval = approvals.get(request.params.id);
    if (!approval) {
      reply.status(404).send({ error: 'Approval not found' });
      return;
    }

    console.log(`\nResult notification for ${approval.id}: ${request.body.action}`);
    if (request.body.result) {
      console.log(`  Result: ${request.body.result}`);
    }

    return { received: true };
  }
);

// Health check
app.get('/health', async () => {
  return {
    service: 'fake-control-plane',
    pendingApprovals: Array.from(approvals.values()).filter(a => a.status === 'pending').length,
  };
});

// Start server
try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          FAKE RUNESTONE CONTROL PLANE                        ║
╠══════════════════════════════════════════════════════════════╣
║  Running on http://localhost:${PORT}                            ║
║                                                              ║
║  Start gatekeeper with:                                      ║
║    APPROVAL_PROVIDER=runestone \\                             ║
║    RUNESTONE_API_URL=http://localhost:${PORT} \\                 ║
║    npm start                                                 ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /approvals           - List all approvals            ║
║    GET  /approvals/:id       - Get approval details          ║
║    POST /approvals/:id/approve - Approve and execute         ║
║    POST /approvals/:id/deny    - Deny approval               ║
╚══════════════════════════════════════════════════════════════╝
`);
} catch (err) {
  console.error('Failed to start fake control plane:', err);
  process.exit(1);
}
