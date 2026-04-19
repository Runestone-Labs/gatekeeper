import { describe, it, expect } from 'vitest';
import {
  enforceBudget,
  matchBudgetRule,
  computeBudgetStatus,
  windowStartISO,
} from '../../src/budget/enforcer.js';
import type { AuditSink } from '../../src/providers/types.js';
import { BudgetMode, BudgetWindow } from '../../src/types.js';
import type { Policy, UsageSummary, UsageFilter, Actor } from '../../src/types.js';

/** Stub audit sink that returns a scripted summary from summarizeUsage. */
function stubSink(summaries: UsageSummary | Error | null): AuditSink {
  return {
    name: 'stub',
    async write() {},
    async flush() {},
    async summarizeUsage(filter: UsageFilter) {
      if (summaries instanceof Error) throw summaries;
      if (summaries === null)
        return {
          rows: [],
          totalCalls: 0,
          distinctActors: 0,
          distinctTools: 0,
          filter,
          generatedAt: new Date().toISOString(),
        };
      return { ...summaries, filter };
    },
  };
}

function makeSummary(rows: Array<{ tool: string; callCount: number }>): UsageSummary {
  return {
    rows: rows.map((r) => ({
      actorName: 'agent',
      actorRole: 'researcher',
      tool: r.tool,
      day: '2026-04-19',
      callCount: r.callCount,
      totalDurationMs: r.callCount * 100,
      decisions: { allow: r.callCount },
    })),
    totalCalls: rows.reduce((s, r) => s + r.callCount, 0),
    distinctActors: 1,
    distinctTools: rows.length,
    filter: {},
    generatedAt: new Date().toISOString(),
  };
}

const baseActor: Actor = { type: 'agent', name: 'agent', role: 'researcher' };

const policyWithBudget: Policy = {
  tools: {
    'http.request': { decision: 'allow', cost_usd: 0.01 },
    'shell.exec': { decision: 'allow', cost_usd: 0.0001 },
    'files.read': { decision: 'allow' }, // no cost → should bypass
  },
  budgets: [
    {
      name: 'researcher-daily',
      match: { actor_role: 'researcher' },
      window: BudgetWindow.Day,
      max_usd: 1.0,
    },
  ],
};

describe('budget matchBudgetRule', () => {
  it('matches on actor_role', () => {
    expect(matchBudgetRule(baseActor, policyWithBudget)?.name).toBe('researcher-daily');
  });

  it('returns null when no budgets configured', () => {
    expect(matchBudgetRule(baseActor, { tools: {} })).toBeNull();
  });

  it('returns null when actor does not match any rule', () => {
    const actor: Actor = { type: 'agent', name: 'other', role: 'admin' };
    expect(matchBudgetRule(actor, policyWithBudget)).toBeNull();
  });

  it('matches on actor_name exactly', () => {
    const policy: Policy = {
      tools: {},
      budgets: [
        {
          name: 'specific',
          match: { actor_name: 'myagent' },
          window: BudgetWindow.Hour,
          max_usd: 5,
        },
      ],
    };
    expect(matchBudgetRule({ type: 'agent', name: 'myagent', role: 'any' }, policy)?.name).toBe(
      'specific'
    );
    expect(matchBudgetRule({ type: 'agent', name: 'other', role: 'any' }, policy)).toBeNull();
  });
});

describe('budget windowStartISO', () => {
  it('hour window is 1h ago', () => {
    const now = new Date('2026-04-19T12:00:00Z');
    expect(windowStartISO(BudgetWindow.Hour, now)).toBe('2026-04-19T11:00:00.000Z');
  });
  it('day window is 24h ago', () => {
    const now = new Date('2026-04-19T12:00:00Z');
    expect(windowStartISO(BudgetWindow.Day, now)).toBe('2026-04-18T12:00:00.000Z');
  });
  it('week window is 7d ago', () => {
    const now = new Date('2026-04-19T12:00:00Z');
    expect(windowStartISO(BudgetWindow.Week, now)).toBe('2026-04-12T12:00:00.000Z');
  });
});

describe('budget computeBudgetStatus', () => {
  const rule = policyWithBudget.budgets![0];

  it('sums cost across tools weighted by cost_usd', async () => {
    // 50 http.request @ $0.01 = $0.50
    // 100 shell.exec @ $0.0001 = $0.01
    // 100 files.read @ $0 = $0 (excluded)
    const sink = stubSink(
      makeSummary([
        { tool: 'http.request', callCount: 50 },
        { tool: 'shell.exec', callCount: 100 },
        { tool: 'files.read', callCount: 100 },
      ])
    );
    const status = await computeBudgetStatus(rule, baseActor, policyWithBudget, sink);
    expect(status).not.toBeNull();
    expect(status!.currentUsd).toBeCloseTo(0.51, 4);
    expect(status!.remainingUsd).toBeCloseTo(0.49, 4);
    expect(status!.exceeded).toBe(false);
    // files.read shouldn't appear (cost_usd = 0)
    expect(status!.byTool.some((t) => t.tool === 'files.read')).toBe(false);
  });

  it('flags exceeded when currentUsd >= max_usd', async () => {
    // 200 http.request @ $0.01 = $2.00 (over $1.00)
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 200 }]));
    const status = await computeBudgetStatus(rule, baseActor, policyWithBudget, sink);
    expect(status!.exceeded).toBe(true);
    expect(status!.remainingUsd).toBe(0);
  });

  it('returns null when sink has no summarizeUsage', async () => {
    const noAggSink: AuditSink = { name: 'no-agg', async write() {} };
    const status = await computeBudgetStatus(rule, baseActor, policyWithBudget, noAggSink);
    expect(status).toBeNull();
  });

  it('returns null when sink throws (graceful degradation)', async () => {
    const sink = stubSink(new Error('db down'));
    const status = await computeBudgetStatus(rule, baseActor, policyWithBudget, sink);
    expect(status).toBeNull();
  });
});

describe('budget enforceBudget', () => {
  it('permits when projected cost is within budget', async () => {
    // $0.50 already spent + $0.01 next call = $0.51, under $1.00
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 50 }]));
    const result = await enforceBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result).toBeNull();
  });

  it('denies with BUDGET_EXCEEDED when projected exceeds', async () => {
    // $0.99 already spent + $0.01 = $1.00, exactly at max — still permitted
    // $0.995 + $0.01 = $1.005 over → denied
    const sink = stubSink(
      makeSummary([
        { tool: 'http.request', callCount: 99 },
        { tool: 'shell.exec', callCount: 50 },
      ])
    );
    // 99 * 0.01 + 50 * 0.0001 = 0.99 + 0.005 = 0.995; +0.01 = 1.005 → over
    const result = await enforceBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('deny');
    expect(result!.reasonCode).toBe('BUDGET_EXCEEDED');
    expect(result!.humanExplanation).toContain('researcher-daily');
    expect(result!.humanExplanation).toContain('$1.00');
    expect(result!.riskFlags).toContain('budget_exceeded');
  });

  it('bypasses tools with cost_usd = 0', async () => {
    // Even over budget, a free tool call should pass.
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 500 }])); // $5.00 > $1.00
    const result = await enforceBudget('files.read', baseActor, policyWithBudget, sink);
    expect(result).toBeNull();
  });

  it('permits in soft mode even when over budget', async () => {
    const softPolicy: Policy = {
      ...policyWithBudget,
      budgets: [{ ...policyWithBudget.budgets![0], mode: BudgetMode.Soft }],
    };
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 500 }]));
    const result = await enforceBudget('http.request', baseActor, softPolicy, sink);
    expect(result).toBeNull();
  });

  it('returns null when actor does not match any budget rule', async () => {
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 500 }]));
    const adminActor: Actor = { type: 'agent', name: 'admin', role: 'admin' };
    const result = await enforceBudget('http.request', adminActor, policyWithBudget, sink);
    expect(result).toBeNull();
  });
});
