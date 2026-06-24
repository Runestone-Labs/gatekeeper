import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end "stop the burn": real JsonlAuditSink writes proxied model-call
// rows → real summarizeUsage aggregates per-run cost/tokens → real enforceBudget
// denies once the run exceeds its cap. This is the chain the unit tests stub.

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'gk-run-budget-'));

vi.mock('../../src/config.js', () => ({
  config: { auditDir: AUDIT_DIR, version: 'test', auditSink: 'jsonl' },
}));

const { JsonlAuditSink } = await import('../../src/providers/jsonl-audit.js');
const { enforceBudget } = await import('../../src/budget/enforcer.js');
const { BudgetWindow } = await import('../../src/types.js');
import type { AuditEntry, Policy, Actor } from '../../src/types.js';

const sink = new JsonlAuditSink();

let seq = 0;
async function writeProxyCall(runId: string, costUsd: number, tokens: number): Promise<void> {
  const entry: AuditEntry = {
    // Stamp a few seconds back: these are COMPLETED calls, always strictly
    // before the enforcement check's exclusive `until` boundary (avoids a
    // same-millisecond flake where the just-written row is excluded).
    timestamp: new Date(Date.now() - 5000).toISOString(),
    requestId: `req-${seq++}`,
    tool: 'anthropic.proxy',
    decision: 'executed',
    actor: { type: 'agent', name: 'openclaw', role: 'openclaw', runId },
    argsSummary: '{}',
    riskFlags: [],
    policyHash: 'h',
    gatekeeperVersion: 'test',
    model: 'claude-opus-4-8',
    usage: { inputTokens: tokens, outputTokens: 0 },
    costUsd,
  };
  await sink.write(entry);
}

const runPolicy: Policy = {
  tools: { 'anthropic.proxy': { decision: 'allow' } },
  budgets: [
    {
      name: 'per-run-cap',
      match: { actor_role: 'openclaw' },
      scope: 'run',
      window: BudgetWindow.Day,
      max_usd: 5,
    },
  ],
};
const runA: Actor = { type: 'agent', name: 'openclaw', role: 'openclaw', runId: 'run-A' };

describe('per-run budget end-to-end (jsonl sink)', () => {
  beforeEach(() => {
    seq = 0;
  });
  afterEach(() => {
    rmSync(AUDIT_DIR, { recursive: true, force: true });
  });

  it('aggregates REAL per-token cost/tokens and isolates by runId', async () => {
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-B', 99.0, 9_000_000); // different run — must not leak

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 1000).toISOString();
    const summary = await sink.summarizeUsage({ runId: 'run-A', since, until });
    const proxy = summary.rows.find((r) => r.tool === 'anthropic.proxy')!;
    expect(proxy.callCount).toBe(3);
    expect(proxy.totalCostUsd).toBeCloseTo(3.0, 6);
    expect(proxy.totalTokens).toBe(300_000);
  });

  it('permits under the run cap, then denies once the run exceeds it', async () => {
    // $3 spent so far — under the $5 cap.
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-A', 1.0, 100_000);
    expect(await enforceBudget('anthropic.proxy', runA, runPolicy, sink)).toBeNull();

    // Three more $1 calls push the run to $6 — over the $5 cap.
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-A', 1.0, 100_000);
    await writeProxyCall('run-A', 1.0, 100_000);

    const denial = await enforceBudget('anthropic.proxy', runA, runPolicy, sink);
    expect(denial).not.toBeNull();
    expect(denial!.reasonCode).toBe('RUN_BUDGET_EXCEEDED');
    expect(denial!.humanExplanation).toContain('run-A');
    expect(denial!.humanExplanation).toContain('$6.00'); // run-B's $99 did not leak in
  });
});
