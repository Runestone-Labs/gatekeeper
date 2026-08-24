import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../../src/types.js';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    runestoneApiUrl: 'https://cloud.example.test',
    runestoneApiKey: 'gki_fixture',
    runestoneInstanceId: 'instance-1',
    cloudRequestTimeoutMs: 100,
    cloudPollIntervalMs: 1,
    cloudCustomSummaryFields: [],
    baseUrl: 'http://127.0.0.1:3847',
    secret: 'local-secret',
  },
}));

vi.mock('../../src/config.js', () => ({ config: mockConfig }));

import { computeApprovalActionDigest } from '../../src/cloud/privacy.js';
import { RunestoneCloudApproval } from '../../src/providers/runestone-cloud.js';

function pending(): PendingApproval {
  return {
    id: 'd17a7d0e-6b60-4de1-a2aa-bc7e53792cc4',
    status: 'pending',
    toolName: 'shell.exec',
    args: { command: 'npm test' },
    canonicalArgs: '{"command":"npm test"}',
    actor: { type: 'agent', name: 'builder', role: 'developer' },
    requestId: 'request-1',
    createdAt: '2026-08-23T12:00:00.000Z',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    policyHash: `sha256:${'a'.repeat(64)}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Runestone Cloud outbound approval provider', () => {
  it('fails closed on a conflicting approval registration', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"error":"digest conflict"}', { status: 409 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new RunestoneCloudApproval().requestApproval(pending(), {
        approveUrl: 'http://local/approve',
        denyUrl: 'http://local/deny',
      })
    ).rejects.toThrow(/registration failed \(409\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies only an exactly bound, unexpired decision to localhost', async () => {
    const approval = pending();
    const digest = computeApprovalActionDigest(approval);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/v1/approvals')) return new Response('{}', { status: 201 });
        if (url.includes('/v1/decisions')) {
          return Response.json({
            decision: {
              schemaVersion: 'cloud-decision.v1',
              decisionId: 'f17a7d0e-6b60-4de1-a2aa-bc7e53792cc5',
              approvalId: approval.id,
              instanceId: 'instance-1',
              actionDigest: digest,
              status: 'approved',
              decidedAt: new Date().toISOString(),
              expiresAt: approval.expiresAt,
              approver: { id: 'user-1', displayName: 'Named approver' },
            },
          });
        }
        if (url.includes(`/approvals/${approval.id}/approve`))
          return Response.json({ success: true });
        throw new Error(`unexpected request ${url}`);
      })
    );

    await new RunestoneCloudApproval().requestApproval(approval, {
      approveUrl: 'http://local/approve',
      denyUrl: 'http://local/deny',
    });
    await vi.waitFor(() => {
      expect(calls.some((url) => url.includes(`/approvals/${approval.id}/approve`))).toBe(true);
    });
  });

  it('keeps a hold pending and registers it after a transient Cloud outage', async () => {
    const approval = pending();
    const digest = computeApprovalActionDigest(approval);
    let registrations = 0;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/v1/approvals')) {
          registrations++;
          return new Response('{}', { status: registrations === 1 ? 503 : 201 });
        }
        if (url.includes('/v1/decisions')) {
          return Response.json({
            decision: {
              schemaVersion: 'cloud-decision.v1',
              decisionId: 'f17a7d0e-6b60-4de1-a2aa-bc7e53792cc5',
              approvalId: approval.id,
              instanceId: 'instance-1',
              actionDigest: digest,
              status: 'denied',
              decidedAt: new Date().toISOString(),
              expiresAt: approval.expiresAt,
              approver: { id: 'user-1' },
            },
          });
        }
        if (url.includes(`/approvals/${approval.id}/deny`)) {
          return Response.json({ success: true });
        }
        throw new Error(`unexpected request ${url}`);
      })
    );

    const delivered = await new RunestoneCloudApproval().requestApproval(approval, {
      approveUrl: 'http://local/approve',
      denyUrl: 'http://local/deny',
    });
    expect(delivered).toBe(false);
    await vi.waitFor(() => {
      expect(registrations).toBeGreaterThanOrEqual(2);
      expect(calls.some((url) => url.includes(`/approvals/${approval.id}/deny`))).toBe(true);
    });
  });

  it('rejects a digest mismatch and acknowledges failure without touching localhost', async () => {
    const approval = pending();
    const calls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (typeof init?.body === 'string') bodies.push(init.body);
        if (url.endsWith('/v1/approvals')) return new Response('{}', { status: 201 });
        if (url.includes('/v1/decisions')) {
          return Response.json({
            decision: {
              schemaVersion: 'cloud-decision.v1',
              decisionId: 'f17a7d0e-6b60-4de1-a2aa-bc7e53792cc5',
              approvalId: approval.id,
              instanceId: 'instance-1',
              actionDigest: `sha256:${'d'.repeat(64)}`,
              status: 'approved',
              decidedAt: new Date().toISOString(),
              expiresAt: approval.expiresAt,
              approver: { id: 'user-1' },
            },
          });
        }
        if (url.endsWith(`/v1/approvals/${approval.id}/ack`))
          return Response.json({ acknowledged: true });
        throw new Error(`unexpected request ${url}`);
      })
    );

    await new RunestoneCloudApproval().requestApproval(approval, {
      approveUrl: 'http://local/approve',
      denyUrl: 'http://local/deny',
    });
    await vi.waitFor(() => {
      expect(bodies.some((body) => body.includes('DECISION_BINDING_MISMATCH'))).toBe(true);
    });
    expect(calls.some((url) => url.startsWith(mockConfig.baseUrl))).toBe(false);
  });
});
