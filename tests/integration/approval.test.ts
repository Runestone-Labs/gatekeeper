import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Set up test environment
const TEST_DATA_DIR = '/tmp/gatekeeper-approval-test';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    secret: 'test-secret-key-at-least-32-characters-long',
    baseUrl: 'http://localhost:3847',
    approvalExpiryMs: 60 * 60 * 1000,
    approvalsDir: '/tmp/gatekeeper-approval-test/approvals',
    auditDir: '/tmp/gatekeeper-approval-test/audit',
    policyPath: join(process.cwd(), 'tests/fixtures/test-policy.yaml'),
    version: '1.0.0-test',
  },
}));

// Mock policy
vi.mock('../../src/policy/loadPolicy.js', () => ({
  getPolicyHash: () => 'sha256:test-hash',
  loadPolicy: () => ({
    tools: {
      'shell.exec': {
        decision: 'approve',
        max_output_bytes: 1024,
        max_timeout_ms: 5000,
      },
    },
  }),
}));

const { createApproval, verifyAndConsumeApproval } = await import('../../src/approvals/store.js');

describe('approval flow integration', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, 'audit'), { recursive: true });
  });

  beforeEach(() => {
    // Clean approvals directory
    if (existsSync(join(TEST_DATA_DIR, 'approvals'))) {
      rmSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
      mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    }
  });

  afterAll(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('full approval workflow', () => {
    it('creates approval and verifies with correct signature', () => {
      // Step 1: Create approval
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls -la /tmp' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(approval.status).toBe('pending');
      expect(approval.toolName).toBe('shell.exec');

      // Step 2: Parse approve URL
      const approveUrlParsed = new URL(approveUrl);
      const approveSig = approveUrlParsed.searchParams.get('sig')!;
      const approveExp = approveUrlParsed.searchParams.get('exp')!;

      // Step 3: Verify and consume
      const result = verifyAndConsumeApproval(approval.id, 'approve', approveSig, approveExp);

      expect(result.approval).not.toBeNull();
      expect(result.approval!.status).toBe('approved');
      expect(result.error).toBeUndefined();
    });

    it('prevents replay of consumed approval', () => {
      // Create approval
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'pwd' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440001',
      });

      const url = new URL(approveUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      // First consumption succeeds
      const result1 = verifyAndConsumeApproval(approval.id, 'approve', sig, exp);
      expect(result1.approval).not.toBeNull();

      // Second attempt fails (replay attack)
      const result2 = verifyAndConsumeApproval(approval.id, 'approve', sig, exp);
      expect(result2.approval).toBeNull();
      expect(result2.error).toContain('already');
    });

    it('rejects tampered signature', () => {
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'date' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440002',
      });

      const url = new URL(approveUrl);
      const exp = url.searchParams.get('exp')!;
      const tamperedSig = 'aaaa' + url.searchParams.get('sig')!.slice(4);

      const result = verifyAndConsumeApproval(approval.id, 'approve', tamperedSig, exp);
      expect(result.approval).toBeNull();
      expect(result.error).toContain('Invalid signature');
    });

    it('rejects wrong action with approve signature', () => {
      const { approval, approveUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'whoami' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440003',
      });

      const url = new URL(approveUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      // Try to deny with approve signature
      const result = verifyAndConsumeApproval(approval.id, 'deny', sig, exp);
      expect(result.approval).toBeNull();
      expect(result.error).toContain('Invalid signature');
    });

    it('handles deny action correctly', () => {
      const { approval, denyUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'uptime' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440004',
      });

      const url = new URL(denyUrl);
      const sig = url.searchParams.get('sig')!;
      const exp = url.searchParams.get('exp')!;

      const result = verifyAndConsumeApproval(approval.id, 'deny', sig, exp);
      expect(result.approval).not.toBeNull();
      expect(result.approval!.status).toBe('denied');
    });

    it('generates different signatures for approve vs deny', () => {
      const { approveUrl, denyUrl } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'hostname' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440005',
      });

      const approveUrlParsed = new URL(approveUrl);
      const denyUrlParsed = new URL(denyUrl);

      const approveSig = approveUrlParsed.searchParams.get('sig');
      const denySig = denyUrlParsed.searchParams.get('sig');

      expect(approveSig).not.toBe(denySig);
    });

    it('signature includes canonical args (order-independent)', () => {
      // Create two approvals with same args in different order
      const { approval: approval1 } = createApproval({
        toolName: 'shell.exec',
        args: { cwd: '/tmp', command: 'ls' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440006',
      });

      const { approval: approval2 } = createApproval({
        toolName: 'shell.exec',
        args: { command: 'ls', cwd: '/tmp' },
        actor: { type: 'agent', name: 'test-agent' },
        requestId: '550e8400-e29b-41d4-a716-446655440007',
      });

      // Canonical args should be identical
      expect(approval1.canonicalArgs).toBe(approval2.canonicalArgs);
    });
  });
});
