import { describe, it, expect, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Budget ceilings must be computed over EVERY usage group in the window, not
// just the top-N groups a summary query returns. Before the fix, the enforcer
// asked the sink for at most 1,000 (actor × role × tool × day) groups and
// treated that as complete history, so once a role- or run-scoped rule spanned
// more than 1,000 groups the smallest groups silently dropped out of the count
// and a hard max_calls / max_usd ceiling stopped binding.

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'gk-budget-complete-'));

vi.mock('../../src/config.js', () => ({
  config: { auditDir: AUDIT_DIR, version: 'test', auditSink: 'jsonl' },
}));

const { JsonlAuditSink } = await import('../../src/providers/jsonl-audit.js');
const { enforceBudget, computeBudgetStatus } = await import('../../src/budget/enforcer.js');
const { BudgetMode, BudgetWindow } = await import('../../src/types.js');
import type { Actor, AuditEntry, Policy } from '../../src/types.js';

const sink = new JsonlAuditSink();

/**
 * Write `n` completed (executed) calls straight to today's JSONL file, one per
 * distinct actor name unless `names` collapses them. Bypasses sink.write's
 * per-entry chain verification (O(n²) at this volume); summarizeUsage does not
 * read the chain fields.
 */
function seedExecutedCalls(
  n: number,
  nameFor: (i: number) => string,
  tool = 'files.write',
  decision: AuditEntry['decision'] = 'executed'
) {
  mkdirSync(AUDIT_DIR, { recursive: true });
  const ts = new Date(Date.now() - 60_000).toISOString();
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry: AuditEntry = {
      timestamp: ts,
      requestId: `req-${i}`,
      tool,
      decision,
      actor: { type: 'agent', name: nameFor(i), role: 'probe' },
      argsSummary: '{}',
      riskFlags: [],
      policyHash: 'h',
      gatekeeperVersion: 'test',
    };
    lines.push(JSON.stringify(entry));
  }
  appendFileSync(join(AUDIT_DIR, `${ts.slice(0, 10)}.jsonl`), lines.join('\n') + '\n');
}

function policyWith(limits: { max_calls?: number; max_usd: number }): Policy {
  return {
    tools: { 'files.write': { decision: 'allow', cost_usd: 1 } },
    budgets: [
      {
        name: 'probe-cap',
        match: { actor_role: 'probe' },
        window: BudgetWindow.Day,
        mode: BudgetMode.Hard,
        ...limits,
      },
    ],
  };
}

const nextCaller: Actor = { type: 'agent', name: 'agent-0', role: 'probe' };

describe('budget enforcement counts every usage group (jsonl sink)', () => {
  afterEach(() => {
    rmSync(AUDIT_DIR, { recursive: true, force: true });
  });

  it('denies call max_calls+1 when completed calls span more than 1,000 groups', async () => {
    seedExecutedCalls(1001, (i) => `agent-${i}`); // 1,001 groups of 1 call
    const policy = policyWith({ max_calls: 1001, max_usd: 10_000 });

    const status = await computeBudgetStatus(policy.budgets![0], nextCaller, policy, sink);
    expect(status?.currentCalls).toBe(1001);

    const denial = await enforceBudget('files.write', nextCaller, policy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
  });

  it('control: the same 1,001 calls in 1,000 groups also deny', async () => {
    seedExecutedCalls(1001, (i) => `agent-${Math.min(i, 999)}`); // last two share a group
    const policy = policyWith({ max_calls: 1001, max_usd: 10_000 });

    const denial = await enforceBudget('files.write', nextCaller, policy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
  });

  it('counts USD across every group, not just the top 1,000', async () => {
    seedExecutedCalls(1500, (i) => `agent-${i}`); // $1 flat × 1,500 calls
    const policy = policyWith({ max_usd: 1200 });

    const status = await computeBudgetStatus(policy.budgets![0], nextCaller, policy, sink);
    expect(status?.currentUsd).toBe(1500);

    const denial = await enforceBudget('files.write', nextCaller, policy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
  });

  it('does not charge denied calls, even in groups with no executions', async () => {
    seedExecutedCalls(1200, (i) => `denied-${i}`, 'files.write', 'deny');
    seedExecutedCalls(5, (i) => `agent-${i}`);
    const policy = policyWith({ max_calls: 6, max_usd: 10_000 });

    const status = await computeBudgetStatus(policy.budgets![0], nextCaller, policy, sink);
    expect(status?.currentCalls).toBe(5);
    expect(status?.currentUsd).toBe(5);

    const denial = await enforceBudget('files.write', nextCaller, policy, sink);
    expect(denial).toBeNull();
  });

  it('still allows a call that is genuinely under the ceiling at high group counts', async () => {
    seedExecutedCalls(1500, (i) => `agent-${i}`);
    const policy = policyWith({ max_calls: 1501, max_usd: 10_000 });

    const denial = await enforceBudget('files.write', nextCaller, policy, sink);
    expect(denial).toBeNull();
  });
});

describe('jsonl summarizeUsage limit semantics', () => {
  afterEach(() => {
    rmSync(AUDIT_DIR, { recursive: true, force: true });
  });

  it('caps reporting queries and flags them truncated; limit: null returns every group', async () => {
    seedExecutedCalls(1200, (i) => `agent-${i}`);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 1000).toISOString();

    const capped = await sink.summarizeUsage({ since, until, limit: 1000 });
    expect(capped.rows).toHaveLength(1000);
    expect(capped.truncated).toBe(true);

    const all = await sink.summarizeUsage({ since, until, limit: null });
    expect(all.rows).toHaveLength(1200);
    expect(all.truncated).toBe(false);
    expect(all.totalCalls).toBe(1200);
  });
});
