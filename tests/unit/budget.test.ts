import { describe, it, expect } from 'vitest';
import {
  checkBudget,
  enforceBudget,
  matchBudgetRule,
  matchBudgetRules,
  computeBudgetStatus,
  windowStartISO,
} from '../../src/budget/enforcer.js';
import type { AuditSink } from '../../src/providers/types.js';
import { BudgetMode, BudgetWindow } from '../../src/types.js';
import type { Policy, UsageRow, UsageSummary, UsageFilter, Actor } from '../../src/types.js';

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
      decisions: { executed: r.callCount },
    })),
    totalCalls: rows.reduce((s, r) => s + r.callCount, 0),
    distinctActors: 1,
    distinctTools: rows.length,
    filter: {},
    generatedAt: new Date().toISOString(),
  };
}

/** Summary builder that supports real per-row cost + tokens (model calls). */
function makeRichSummary(
  rows: Array<{
    tool: string;
    callCount: number;
    totalCostUsd?: number | null;
    totalTokens?: number | null;
    actorName?: string;
    actorRole?: string;
    runId?: string;
  }>
): UsageSummary {
  const usageRows: UsageRow[] = rows.map((r) => ({
    actorName: r.actorName ?? 'openclaw',
    actorRole: r.actorRole ?? 'openclaw',
    tool: r.tool,
    day: '2026-04-19',
    callCount: r.callCount,
    totalDurationMs: null,
    decisions: { executed: r.callCount },
    totalCostUsd: r.totalCostUsd ?? null,
    totalTokens: r.totalTokens ?? null,
  }));
  return {
    rows: usageRows,
    totalCalls: rows.reduce((s, r) => s + r.callCount, 0),
    distinctActors: 1,
    distinctTools: rows.length,
    filter: {},
    generatedAt: new Date().toISOString(),
  };
}

const baseActor: Actor = { type: 'agent', name: 'agent', role: 'researcher' };

const runActor: Actor = { type: 'agent', name: 'openclaw', role: 'openclaw', runId: 'run-1' };

// Per-run budget: caps a single agentic run (keyed on runId), with USD + token +
// call ceilings. anthropic.proxy has no flat cost_usd — real cost lands on the
// audit row post-call, so run-scope must enforce on accrued spend.
const runPolicy: Policy = {
  tools: { 'anthropic.proxy': { decision: 'allow' } },
  budgets: [
    {
      name: 'per-run',
      match: { actor_role: 'openclaw' },
      scope: 'run',
      window: BudgetWindow.Day,
      max_usd: 5,
      max_tokens: 1_000_000,
      max_calls: 200,
    },
  ],
};

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

  it('emits an 80% warning without blocking the action', async () => {
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 79 }]));
    const result = await checkBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result.denial).toBeNull();
    expect(result.riskFlags).toContain('budget_threshold:80');
    expect(result.riskFlags).not.toContain('budget_threshold:100');
  });

  it('emits a 100% warning at the exact ceiling before hard overage', async () => {
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 99 }]));
    const result = await checkBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result.denial).toBeNull();
    expect(result.riskFlags).toContain('budget_threshold:100');
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

describe('budget — real per-token cost (model calls)', () => {
  const rule = runPolicy.budgets![0];

  it('uses real summed cost + tokens when present (overrides flat cost_usd)', async () => {
    // anthropic.proxy has no flat cost_usd; the audit row's real costUsd carries it.
    const sink = stubSink(
      makeRichSummary([
        { tool: 'anthropic.proxy', callCount: 3, totalCostUsd: 0.42, totalTokens: 120_000 },
      ])
    );
    const status = await computeBudgetStatus(rule, runActor, runPolicy, sink, {
      runId: runActor.runId,
    });
    expect(status!.currentUsd).toBeCloseTo(0.42, 6);
    expect(status!.currentTokens).toBe(120_000);
    expect(status!.currentCalls).toBe(3);
    expect(status!.byTool[0]).toEqual({ tool: 'anthropic.proxy', callCount: 3, costUsd: 0.42 });
  });

  it('charges flat cost per EXECUTION, not per paired request-log row', async () => {
    // One allowed http.request call logs BOTH an 'allow' and an 'executed' row
    // (callCount 2) but executed once — it must be charged once, not twice.
    const sink = stubSink({
      rows: [
        {
          actorName: 'agent',
          actorRole: 'researcher',
          tool: 'http.request',
          day: '2026-04-19',
          callCount: 2,
          totalDurationMs: null,
          decisions: { allow: 1, executed: 1 },
          totalCostUsd: null,
          totalTokens: null,
        },
      ],
      totalCalls: 2,
      distinctActors: 1,
      distinctTools: 1,
      filter: {},
      generatedAt: new Date().toISOString(),
    });
    const status = await computeBudgetStatus(
      policyWithBudget.budgets![0],
      baseActor,
      policyWithBudget,
      sink
    );
    expect(status!.currentUsd).toBeCloseTo(0.01, 6); // 1 execution × $0.01, not $0.02
    expect(status!.currentCalls).toBe(1);
  });
});

describe('budget — per-run scope', () => {
  it('matchBudgetRules returns every matching rule; matchBudgetRule returns the first', () => {
    const policy: Policy = {
      tools: {},
      budgets: [
        { name: 'daily', match: { actor_role: 'openclaw' }, window: BudgetWindow.Day, max_usd: 50 },
        runPolicy.budgets![0],
      ],
    };
    expect(matchBudgetRules(runActor, policy).map((r) => r.name)).toEqual(['daily', 'per-run']);
    expect(matchBudgetRule(runActor, policy)?.name).toBe('daily');
  });

  it('denies the model call when the run USD cap is exceeded', async () => {
    const sink = stubSink(
      makeRichSummary([
        { tool: 'anthropic.proxy', callCount: 10, totalCostUsd: 5.5, totalTokens: 400_000 },
      ])
    );
    const res = await enforceBudget('anthropic.proxy', runActor, runPolicy, sink);
    expect(res).not.toBeNull();
    expect(res!.reasonCode).toBe('RUN_BUDGET_EXCEEDED');
    expect(res!.humanExplanation).toContain('run-1');
    expect(res!.humanExplanation).toContain('$5.00');
    expect(res!.riskFlags).toContain('run_budget_exceeded');
  });

  it('denies on the token ceiling (USD + calls still under)', async () => {
    const sink = stubSink(
      makeRichSummary([
        { tool: 'anthropic.proxy', callCount: 5, totalCostUsd: 0.1, totalTokens: 1_000_000 },
      ])
    );
    const res = await enforceBudget('anthropic.proxy', runActor, runPolicy, sink);
    expect(res!.reasonCode).toBe('RUN_BUDGET_EXCEEDED');
    expect(res!.humanExplanation).toContain('token');
  });

  it('denies on the call-count ceiling (USD + tokens still under)', async () => {
    const sink = stubSink(
      makeRichSummary([
        { tool: 'anthropic.proxy', callCount: 200, totalCostUsd: 0.1, totalTokens: 50_000 },
      ])
    );
    const res = await enforceBudget('anthropic.proxy', runActor, runPolicy, sink);
    expect(res!.reasonCode).toBe('RUN_BUDGET_EXCEEDED');
    expect(res!.humanExplanation).toContain('call');
  });

  it('permits when the run is under every ceiling', async () => {
    const sink = stubSink(
      makeRichSummary([
        { tool: 'anthropic.proxy', callCount: 5, totalCostUsd: 1.2, totalTokens: 300_000 },
      ])
    );
    expect(await enforceBudget('anthropic.proxy', runActor, runPolicy, sink)).toBeNull();
  });

  it('skips per-run enforcement when the actor carries no runId', async () => {
    const noRun: Actor = { type: 'agent', name: 'openclaw', role: 'openclaw' };
    const sink = stubSink(
      makeRichSummary([{ tool: 'anthropic.proxy', callCount: 10, totalCostUsd: 999 }])
    );
    expect(await enforceBudget('anthropic.proxy', noRun, runPolicy, sink)).toBeNull();
  });

  it('soft mode observes without blocking even when the run is over', async () => {
    const softPolicy: Policy = {
      ...runPolicy,
      budgets: [{ ...runPolicy.budgets![0], mode: BudgetMode.Soft }],
    };
    const sink = stubSink(
      makeRichSummary([{ tool: 'anthropic.proxy', callCount: 10, totalCostUsd: 99 }])
    );
    expect(await enforceBudget('anthropic.proxy', runActor, softPolicy, sink)).toBeNull();
  });
});

describe('budget — incomplete usage history', () => {
  it('asks the sink for every group, not a top-N', async () => {
    let seen: UsageFilter | undefined;
    const sink: AuditSink = {
      ...stubSink(null),
      async summarizeUsage(filter: UsageFilter) {
        seen = filter;
        return { ...makeSummary([]), filter };
      },
    };
    await computeBudgetStatus(policyWithBudget.budgets![0], baseActor, policyWithBudget, sink);
    expect(seen?.limit).toBeNull();
  });

  it('hard rule denies when a truncated summary is still under the ceiling', async () => {
    // $0.10 counted, well under $1.00 — but the sink says groups were cut off.
    const sink = stubSink({
      ...makeSummary([{ tool: 'http.request', callCount: 10 }]),
      truncated: true,
    });
    const status = await computeBudgetStatus(
      policyWithBudget.budgets![0],
      baseActor,
      policyWithBudget,
      sink
    );
    expect(status?.complete).toBe(false);

    const result = await checkBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result.denial?.reasonCode).toBe('BUDGET_USAGE_INCOMPLETE');
    expect(result.riskFlags).toContain('budget_usage_incomplete');
  });

  it('reports BUDGET_EXCEEDED when a truncated summary is already over', async () => {
    const sink = stubSink({
      ...makeSummary([{ tool: 'http.request', callCount: 500 }]),
      truncated: true,
    });
    const denial = await enforceBudget('http.request', baseActor, policyWithBudget, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
  });

  it('soft rule observes a truncated summary without blocking', async () => {
    const softPolicy: Policy = {
      ...policyWithBudget,
      budgets: [{ ...policyWithBudget.budgets![0], mode: BudgetMode.Soft }],
    };
    const sink = stubSink({
      ...makeSummary([{ tool: 'http.request', callCount: 10 }]),
      truncated: true,
    });
    const result = await checkBudget('http.request', baseActor, softPolicy, sink);
    expect(result.denial).toBeNull();
    expect(result.riskFlags).toContain('budget_usage_incomplete');
  });

  it('a complete summary carries no incomplete flag', async () => {
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 10 }]));
    const result = await checkBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result.denial).toBeNull();
    expect(result.riskFlags).not.toContain('budget_usage_incomplete');
  });
});

describe('budget — what counts as a call', () => {
  function row(decisions: Record<string, number> | undefined, callCount: number): UsageRow {
    return {
      actorName: 'agent',
      actorRole: 'researcher',
      tool: 'http.request',
      day: '2026-04-19',
      callCount,
      totalDurationMs: null,
      decisions: decisions as Record<string, number>,
      totalCostUsd: null,
      totalTokens: null,
    };
  }
  function summaryOf(rows: UsageRow[]): UsageSummary {
    return {
      rows,
      totalCalls: rows.reduce((s, r) => s + r.callCount, 0),
      distinctActors: 1,
      distinctTools: 1,
      filter: {},
      generatedAt: new Date().toISOString(),
    };
  }

  it('does not charge a group that only holds denials or pending approvals', async () => {
    // e.g. a day where every call was denied (including BUDGET_EXCEEDED denials)
    const sink = stubSink(summaryOf([row({ deny: 50 }, 50), row({ approve: 7 }, 7)]));
    const status = await computeBudgetStatus(
      policyWithBudget.budgets![0],
      baseActor,
      policyWithBudget,
      sink
    );
    expect(status!.currentCalls).toBe(0);
    expect(status!.currentUsd).toBe(0);
  });

  it('falls back to callCount only when a summary has no decision breakdown', async () => {
    const sink = stubSink(summaryOf([row(undefined, 4)]));
    const status = await computeBudgetStatus(
      policyWithBudget.budgets![0],
      baseActor,
      policyWithBudget,
      sink
    );
    expect(status!.currentCalls).toBe(4);
  });
});

describe('budget — audit sink failure', () => {
  it('hard rule denies when the sink cannot summarize usage', async () => {
    const sink = stubSink(new Error('db down'));
    const result = await checkBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result.denial?.decision).toBe('deny');
    expect(result.denial?.reasonCode).toBe('BUDGET_USAGE_UNAVAILABLE');
    expect(result.riskFlags).toContain('budget_usage_unavailable');
  });

  it('per-run hard rule also denies when the sink cannot summarize usage', async () => {
    const sink = stubSink(new Error('db down'));
    const denial = await enforceBudget('anthropic.proxy', runActor, runPolicy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_USAGE_UNAVAILABLE');
  });

  it('soft rule flags the failure and continues', async () => {
    const softPolicy: Policy = {
      ...policyWithBudget,
      budgets: [{ ...policyWithBudget.budgets![0], mode: BudgetMode.Soft }],
    };
    const result = await checkBudget(
      'http.request',
      baseActor,
      softPolicy,
      stubSink(new Error('x'))
    );
    expect(result.denial).toBeNull();
    expect(result.riskFlags).toContain('budget_usage_unavailable');
  });

  it('a sink with no aggregation support leaves budgets inert', async () => {
    const sink: AuditSink = { name: 'write-only', async write() {} };
    const result = await checkBudget('http.request', baseActor, policyWithBudget, sink);
    expect(result).toEqual({ denial: null, riskFlags: [] });
  });
});

describe('budget — actor-scope ceilings bind every matched call', () => {
  const actorRule = policyWithBudget.budgets![0];

  it('max_calls caps free tools too (every call counts toward it)', async () => {
    const policy: Policy = { ...policyWithBudget, budgets: [{ ...actorRule, max_calls: 10 }] };
    const sink = stubSink(makeSummary([{ tool: 'files.read', callCount: 10 }]));
    const denial = await enforceBudget('files.read', baseActor, policy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
    expect(denial?.humanExplanation).toContain('10 tool calls');
  });

  it('max_tokens caps proxied model calls', async () => {
    const policy: Policy = {
      tools: { 'anthropic.proxy': { decision: 'allow' } },
      budgets: [
        {
          name: 'openclaw-daily',
          match: { actor_role: 'openclaw' },
          window: BudgetWindow.Day,
          max_usd: 100,
          max_tokens: 1000,
        },
      ],
    };
    const actor: Actor = { type: 'agent', name: 'openclaw', role: 'openclaw' };
    const sink = stubSink(
      makeRichSummary([
        { tool: 'anthropic.proxy', callCount: 3, totalCostUsd: 0.1, totalTokens: 1500 },
      ])
    );
    expect((await enforceBudget('anthropic.proxy', actor, policy, sink))?.reasonCode).toBe(
      'BUDGET_EXCEEDED'
    );
  });

  it('max_usd caps proxied model calls on real accrued spend', async () => {
    const policy: Policy = {
      tools: { 'anthropic.proxy': { decision: 'allow' } },
      budgets: [
        {
          name: 'openclaw-daily',
          match: { actor_role: 'openclaw' },
          window: BudgetWindow.Day,
          max_usd: 5,
        },
      ],
    };
    const actor: Actor = { type: 'agent', name: 'openclaw', role: 'openclaw' };
    const sink = stubSink(
      makeRichSummary([{ tool: 'anthropic.proxy', callCount: 40, totalCostUsd: 6.25 }])
    );
    const denial = await enforceBudget('anthropic.proxy', actor, policy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
    expect(denial?.humanExplanation).toContain('$6.25');
    expect(denial?.humanExplanation).not.toContain('This call would cost');
  });

  it('a USD-only rule still lets free tools run once the cap is hit (v1)', async () => {
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 500 }])); // $5 > $1
    const result = await checkBudget('files.read', baseActor, policyWithBudget, sink);
    expect(result).toEqual({ denial: null, riskFlags: [] });
  });

  it('a USD-only rule still denies a priced tool once the cap is hit', async () => {
    const sink = stubSink(makeSummary([{ tool: 'http.request', callCount: 500 }]));
    const denial = await enforceBudget('http.request', baseActor, policyWithBudget, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
  });
});
