import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

const TEST_DATA_DIR = '/tmp/gatekeeper-approval-pending-test';
const TEST_SECRET = 'test-secret-key-at-least-32-characters-long';

vi.mock('../../src/config.js', () => ({
  config: {
    secret: 'test-secret-key-at-least-32-characters-long',
    baseUrl: 'http://127.0.0.1:3847',
    approvalExpiryMs: 60 * 60 * 1000,
    approvalsDir: '/tmp/gatekeeper-approval-pending-test/approvals',
    auditDir: '/tmp/gatekeeper-approval-pending-test/audit',
    policyPath: join(process.cwd(), 'tests/fixtures/test-policy.yaml'),
    version: '1.0.0-test',
  },
}));

const { createApproval, listPendingApprovals } = await import('../../src/approvals/store.js');
const { registerApprovalRoutes } = await import('../../src/approvals/routes.js');

function makeApproval(
  overrides: { toolName?: string; ttlMs?: number; args?: Record<string, unknown> } = {}
) {
  return createApproval({
    toolName: overrides.toolName ?? 'shell.exec',
    args: overrides.args ?? { command: 'echo hi' },
    actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
    requestId: '550e8400-e29b-41d4-a716-446655440200',
    ttlMs: overrides.ttlMs,
  });
}

describe('pending approvals listing', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, 'audit'), { recursive: true });
  });

  beforeEach(() => {
    if (existsSync(join(TEST_DATA_DIR, 'approvals'))) {
      rmSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
      mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    }
  });

  afterAll(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  });

  describe('listPendingApprovals (store)', () => {
    it('returns pending approvals with signed action URLs, oldest expiry first', () => {
      const late = makeApproval({ toolName: 'files.write', ttlMs: 2 * 60 * 60 * 1000 });
      const soon = makeApproval({ toolName: 'shell.exec', ttlMs: 5 * 60 * 1000 });

      const pending = listPendingApprovals();
      expect(pending).toHaveLength(2);
      // Sorted by expiry: the one closest to expiring comes first.
      expect(pending[0].approval.id).toBe(soon.approval.id);
      expect(pending[1].approval.id).toBe(late.approval.id);
      // URLs match the ones minted at creation (same payload, same secret).
      expect(pending[0].approveUrl).toBe(soon.approveUrl);
      expect(pending[0].denyUrl).toBe(soon.denyUrl);
      expect(pending[0].approveUrl).toContain('/approve/');
      expect(pending[0].approveUrl).toContain('sig=');
    });

    it('lazily expires overdue holds and excludes them', () => {
      const dead = makeApproval({ ttlMs: -1000 });
      const alive = makeApproval({ toolName: 'http.request' });

      const pending = listPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].approval.id).toBe(alive.approval.id);

      // The overdue hold was transitioned to expired on disk, not just skipped.
      const again = listPendingApprovals();
      expect(again.map((p) => p.approval.id)).not.toContain(dead.approval.id);
    });

    it('excludes consumed approvals and tolerates malformed files', () => {
      makeApproval();
      writeFileSync(join(TEST_DATA_DIR, 'approvals', 'garbage.json'), '{not json');

      const pending = listPendingApprovals();
      expect(pending).toHaveLength(1);
    });
  });

  describe('GET /approvals/pending (route)', () => {
    async function buildApp() {
      const app = Fastify();
      registerApprovalRoutes(app);
      await app.ready();
      return app;
    }

    it('rejects requests without secret auth', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/approvals/pending' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rejects a wrong secret', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/approvals/pending',
        headers: { 'x-gatekeeper-secret': 'wrong-secret' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('lists pending holds with redacted args for an authenticated caller', async () => {
      makeApproval({ args: { command: 'deploy', apiKey: 'sk-super-secret-value' } });
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/approvals/pending',
        headers: { 'x-gatekeeper-secret': TEST_SECRET },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.pending[0].toolName).toBe('shell.exec');
      expect(body.pending[0].approveUrl).toContain('sig=');
      // Redaction: the raw secret value must not appear anywhere in the payload.
      expect(res.body).not.toContain('sk-super-secret-value');
      await app.close();
    });

    it('returns an empty list when nothing is pending', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/approvals/pending',
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pending: [], count: 0 });
      await app.close();
    });
  });
});
