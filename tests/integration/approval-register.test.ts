import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = '/tmp/gatekeeper-approval-register-test';

vi.mock('../../src/config.js', () => ({
  config: {
    secret: 'test-secret-key-at-least-32-characters-long',
    baseUrl: 'http://127.0.0.1:3847',
    approvalExpiryMs: 60 * 60 * 1000,
    approvalsDir: '/tmp/gatekeeper-approval-register-test/approvals',
    auditDir: '/tmp/gatekeeper-approval-register-test/audit',
    policyPath: join(process.cwd(), 'tests/fixtures/test-policy.yaml'),
    version: '1.0.0-test',
  },
}));

const { createApproval, getApprovalStatus, verifyAndConsumeApproval } =
  await import('../../src/approvals/store.js');

describe('external decision-only approvals (register + status)', () => {
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

  it('persists opaque metadata, the external flag, and a custom TTL', () => {
    const before = Date.now();
    const { approval } = createApproval({
      toolName: 'runestone.trade',
      args: { symbol: 'BTC-USD' },
      actor: { type: 'agent', name: 'runestone', role: 'navigator' },
      requestId: '550e8400-e29b-41d4-a716-446655440100',
      metadata: { kind: 'trade', ref: { tradesDir: '/x', entryId: 'e1' } },
      external: true,
      ttlMs: 5 * 60 * 1000,
    });

    expect(approval.external).toBe(true);
    expect(approval.metadata).toEqual({ kind: 'trade', ref: { tradesDir: '/x', entryId: 'e1' } });
    const ttl = new Date(approval.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThan(6 * 60 * 1000);
  });

  it('getApprovalStatus returns a snapshot (incl. metadata + external) or null', () => {
    const { approval } = createApproval({
      toolName: 'runestone.publish',
      args: {},
      actor: { type: 'agent', name: 'runestone', role: 'navigator' },
      requestId: '550e8400-e29b-41d4-a716-446655440101',
      metadata: { draftId: 'd1' },
      external: true,
    });

    const status = getApprovalStatus(approval.id);
    expect(status).not.toBeNull();
    expect(status!.id).toBe(approval.id);
    expect(status!.status).toBe('pending');
    expect(status!.external).toBe(true);
    expect(status!.metadata).toEqual({ draftId: 'd1' });

    expect(getApprovalStatus('nonexistent-id')).toBeNull();
  });

  it('an external approval still consumes to approved via the signed URL', () => {
    const { approval, approveUrl } = createApproval({
      toolName: 'runestone.trade',
      args: { symbol: 'ETH-USD' },
      actor: { type: 'agent', name: 'runestone', role: 'navigator' },
      requestId: '550e8400-e29b-41d4-a716-446655440102',
      external: true,
    });
    const url = new URL(approveUrl);
    const result = verifyAndConsumeApproval(
      approval.id,
      'approve',
      url.searchParams.get('sig')!,
      url.searchParams.get('exp')!
    );
    expect(result.approval).not.toBeNull();
    expect(result.approval!.status).toBe('approved');
    expect(getApprovalStatus(approval.id)!.status).toBe('approved');
  });

  it('getApprovalStatus reflects lazy expiry', () => {
    const { approval } = createApproval({
      toolName: 'runestone.publish',
      args: {},
      actor: { type: 'agent', name: 'runestone', role: 'navigator' },
      requestId: '550e8400-e29b-41d4-a716-446655440103',
      external: true,
      ttlMs: -1000, // already expired
    });
    expect(getApprovalStatus(approval.id)!.status).toBe('expired');
  });
});
