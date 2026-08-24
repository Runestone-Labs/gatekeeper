import { describe, expect, it } from 'vitest';
import {
  auditEntryToCloudEvent,
  computeApprovalActionDigest,
  createCloudReviewSummary,
  scrubCloudString,
} from '../../src/cloud/privacy.js';
import { cloudApprovalV1Schema } from '../../src/cloud/schemas.js';
import type { AuditEntry, PendingApproval } from '../../src/types.js';

describe('Cloud privacy boundary', () => {
  it('scrubs embedded credentials rather than only secret-named keys', () => {
    const value = scrubCloudString(
      'curl -H "Authorization: Bearer ghp_abcdefghijklmnop" https://example.com?token=secret-value'
    );
    expect(value).not.toContain('ghp_abcdefghijklmnop');
    expect(value).not.toContain('secret-value');
    expect(value).toContain('[REDACTED]');
  });

  it('normalizes Unix and Windows home paths before Cloud serialization', () => {
    expect(scrubCloudString('/Users/alice/private/report.txt')).toBe('$HOME/private/report.txt');
    expect(scrubCloudString('/home/alice/private/report.txt')).toBe('$HOME/private/report.txt');
    expect(scrubCloudString('C:\\Users\\alice\\private\\report.txt')).toBe(
      '$HOME\\private\\report.txt'
    );
  });

  it('sends only method and origin for HTTP actions', () => {
    const summary = createCloudReviewSummary('http.request', {
      method: 'POST',
      url: 'https://api.example.com/private/path?token=ghp_abcdefghijklmnop',
      headers: { authorization: 'Bearer private' },
      body: 'customer-private-body',
    });
    expect(summary).toEqual({ kind: 'http', method: 'POST', origin: 'https://api.example.com' });
    expect(JSON.stringify(summary)).not.toContain('private/path');
    expect(JSON.stringify(summary)).not.toContain('customer-private-body');
  });

  it('hashes file content while omitting the content', () => {
    const summary = createCloudReviewSummary('files.write', {
      path: '/tmp/report.txt',
      content: 'fixture-private-secret',
    });
    expect(summary.kind).toBe('file');
    expect(summary.byteCount).toBe(Buffer.byteLength('fixture-private-secret'));
    expect(summary.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(summary)).not.toContain('fixture-private-secret');
  });

  it('binds a decision digest to the exact local action', () => {
    const base: PendingApproval = {
      id: 'd17a7d0e-6b60-4de1-a2aa-bc7e53792cc4',
      status: 'pending',
      toolName: 'shell.exec',
      args: { command: 'npm test' },
      canonicalArgs: '{"command":"npm test"}',
      actor: { type: 'agent', name: 'builder', role: 'developer' },
      requestId: 'request-1',
      createdAt: '2026-08-23T12:00:00.000Z',
      expiresAt: '2026-08-23T13:00:00.000Z',
      policyHash: `sha256:${'a'.repeat(64)}`,
    };
    const changed = { ...base, canonicalArgs: '{"command":"npm publish"}' };
    expect(computeApprovalActionDigest(base)).not.toEqual(computeApprovalActionDigest(changed));
  });

  it('Cloud events omit local arg/result summaries entirely', () => {
    const entry: AuditEntry = {
      timestamp: '2026-08-23T12:00:00.000Z',
      requestId: 'request-1',
      tool: 'shell.exec',
      decision: 'executed',
      actor: { type: 'agent', name: 'builder', role: 'developer' },
      argsSummary: 'fixture-private-command',
      resultSummary: 'fixture-private-result',
      riskFlags: [],
      policyHash: `sha256:${'a'.repeat(64)}`,
      gatekeeperVersion: '0.7.0',
      sequence: 42,
      previousEntryHash: `sha256:${'b'.repeat(64)}`,
      entryHash: `sha256:${'c'.repeat(64)}`,
    };
    const event = auditEntryToCloudEvent(entry, 'instance-1');
    expect(JSON.stringify(event)).not.toContain('fixture-private-command');
    expect(JSON.stringify(event)).not.toContain('fixture-private-result');
    expect(event.tool).toBe('shell.exec');
    expect(event.localSequence).toBe(42);
    expect(event.localPreviousEntryHash).toBe(entry.previousEntryHash);
    expect(event.localEntryHash).toBe(entry.entryHash);
  });

  it('versioned approval schema rejects raw arguments and callbacks', () => {
    const safe = {
      schemaVersion: 'cloud-approval.v1',
      approvalId: 'd17a7d0e-6b60-4de1-a2aa-bc7e53792cc4',
      instanceId: 'instance-1',
      requestId: 'request-1',
      actor: { type: 'agent', name: 'builder', role: 'developer' },
      tool: 'shell.exec',
      status: 'pending',
      policyHash: `sha256:${'a'.repeat(64)}`,
      actionDigest: `sha256:${'b'.repeat(64)}`,
      summary: { kind: 'shell', executable: 'npm', arguments: ['test'] },
      createdAt: '2026-08-23T12:00:00.000Z',
      expiresAt: '2026-08-23T13:00:00.000Z',
    };
    expect(cloudApprovalV1Schema.safeParse(safe).success).toBe(true);
    expect(cloudApprovalV1Schema.safeParse({ ...safe, args: { command: 'private' } }).success).toBe(
      false
    );
    expect(
      cloudApprovalV1Schema.safeParse({ ...safe, callbacks: { approveUrl: 'localhost' } }).success
    ).toBe(false);
  });
});
