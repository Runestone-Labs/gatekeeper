import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';

// Mock config before importing store
vi.mock('../../src/config.js', () => ({
  config: {
    secret: 'test-secret-key-at-least-32-characters-long',
    baseUrl: 'http://127.0.0.1:3847',
    approvalExpiryMs: 60 * 60 * 1000, // 1 hour
    approvalsDir: '/tmp/gatekeeper-test-approvals',
  },
}));

// Import after mocking
const { createApproval, verifyAndConsumeApproval, countPendingApprovals, consumeApprovalDirect } =
  await import('../../src/approvals/store.js');

const TEST_DIR = '/tmp/gatekeeper-test-approvals';

describe('approval store', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('createApproval', () => {
    it('creates approval with unique ID', () => {
      const { approval } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(approval.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(approval.status).toBe('pending');
      expect(approval.toolName).toBe('shell.exec');
    });

    it('sets correct expiry time', () => {
      const before = new Date();
      const { approval } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });
      const after = new Date();

      const expiry = new Date(approval.expiresAt);
      const expectedMin = new Date(before.getTime() + 60 * 60 * 1000 - 1000);
      const expectedMax = new Date(after.getTime() + 60 * 60 * 1000 + 1000);

      expect(expiry.getTime()).toBeGreaterThan(expectedMin.getTime());
      expect(expiry.getTime()).toBeLessThan(expectedMax.getTime());
    });

    it('generates signed URLs', () => {
      const { approveUrl, denyUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(approveUrl).toContain('/approve/');
      expect(approveUrl).toContain('sig=');
      expect(approveUrl).toContain('exp=');

      expect(denyUrl).toContain('/deny/');
      expect(denyUrl).toContain('sig=');
    });

    it('saves approval to disk', () => {
      const { approval } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      const files = readdirSync(TEST_DIR);
      expect(files).toContain(`${approval.id}.json`);
    });

    it('canonicalizes args for consistent signing', () => {
      const { approval: approval1 } = createApproval({
        toolName: 'shell.exec',
        args: { b: 2, a: 1 },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      const { approval: approval2 } = createApproval({
        toolName: 'shell.exec',
        args: { a: 1, b: 2 },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440001',
      });

      expect(approval1.canonicalArgs).toBe(approval2.canonicalArgs);
    });
  });

  describe('verifyAndConsumeApproval', () => {
    it('verifies valid signature and consumes approval', () => {
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      // Extract sig and exp from URL
      const url = new URL(approveUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      const result = verifyAndConsumeApproval(approval.id, 'approve', sig, exp);

      expect(result.approval).not.toBeNull();
      expect(result.approval?.status).toBe('approved');
      expect(result.error).toBeUndefined();
    });

    it('rejects invalid signature', () => {
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      const url = new URL(approveUrl);
      const exp = url.searchParams.get('exp')!;

      const result = verifyAndConsumeApproval(approval.id, 'approve', 'invalid-signature', exp);

      expect(result.approval).toBeNull();
      expect(result.error).toContain('Invalid signature');
    });

    it('rejects already consumed approval (single-use)', () => {
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      const url = new URL(approveUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      // First consumption
      const result1 = verifyAndConsumeApproval(approval.id, 'approve', sig, exp);
      expect(result1.approval).not.toBeNull();

      // Second attempt (replay)
      const result2 = verifyAndConsumeApproval(approval.id, 'approve', sig, exp);
      expect(result2.approval).toBeNull();
      expect(result2.error).toContain('already');
    });

    it('rejects signature for wrong action', () => {
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      // Use approve URL but try to deny
      const url = new URL(approveUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      const result = verifyAndConsumeApproval(approval.id, 'deny', sig, exp);

      expect(result.approval).toBeNull();
      expect(result.error).toContain('Invalid signature');
    });

    it('rejects non-existent approval', () => {
      const result = verifyAndConsumeApproval('non-existent-id', 'approve', 'sig', 'exp');
      expect(result.approval).toBeNull();
      expect(result.error).toContain('not found');
    });

    it('handles deny action correctly', () => {
      const { approval, denyUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      const url = new URL(denyUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      const result = verifyAndConsumeApproval(approval.id, 'deny', sig, exp);

      expect(result.approval).not.toBeNull();
      expect(result.approval?.status).toBe('denied');
    });
  });

  describe('consumeApprovalDirect', () => {
    it('consumes approval without signature', () => {
      const { approval } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440010',
      });

      const result = consumeApprovalDirect(approval.id, 'approve');
      expect(result.approval).not.toBeNull();
      expect(result.approval?.status).toBe('approved');
    });
  });

  describe('countPendingApprovals', () => {
    it('counts only pending approvals', () => {
      // Create 3 approvals
      createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440001',
      });

      const { approval: approval2, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'pwd' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440002',
      });

      createApproval({
        toolName: 'shell.exec',
        args: { command: 'date' },
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        requestId: '550e8400-e29b-41d4-a716-446655440003',
      });

      expect(countPendingApprovals()).toBe(3);

      // Consume one
      const url = new URL(approveUrl);
      verifyAndConsumeApproval(
        approval2.id,
        'approve',
        url.searchParams.get('sig')!,
        url.searchParams.get('exp')!
      );

      expect(countPendingApprovals()).toBe(2);
    });
  });
});
