/**
 * Budget enforcement.
 *
 * Computes per-actor spend within a rolling window by aggregating the
 * audit sink's usage summary and multiplying each row's call count by
 * the corresponding tool's `cost_usd`. Rejects tool calls that would
 * push an actor over their configured budget.
 *
 * The authoritative state is the audit log. That means budgets are
 * eventually consistent — a flurry of concurrent calls could all pass
 * the pre-check and collectively exceed the cap. For a self-hosted
 * single-user deployment this is fine; a hosted multi-tenant tier
 * should add a short in-memory reservation cache.
 */

import { BudgetMode, BudgetWindow } from '../types.js';
import type {
  Actor,
  BudgetRule,
  Policy,
  PolicyEvaluation,
  UsageFilter,
  UsageSummary,
} from '../types.js';
import type { AuditSink } from '../providers/types.js';

export interface BudgetStatus {
  rule: BudgetRule;
  windowStart: string;
  windowEnd: string;
  currentUsd: number;
  remainingUsd: number;
  exceeded: boolean;
  byTool: Array<{ tool: string; callCount: number; costUsd: number }>;
}

/** Turn a window kind into an ISO-8601 start boundary. */
export function windowStartISO(window: BudgetWindow, now: Date = new Date()): string {
  const ms = now.getTime();
  switch (window) {
    case BudgetWindow.Hour:
      return new Date(ms - 60 * 60 * 1000).toISOString();
    case BudgetWindow.Day:
      return new Date(ms - 24 * 60 * 60 * 1000).toISOString();
    case BudgetWindow.Week:
      return new Date(ms - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

/** Find the first budget rule in the policy that matches this actor. */
export function matchBudgetRule(actor: Actor | undefined, policy: Policy): BudgetRule | null {
  if (!actor || !policy.budgets) return null;
  for (const rule of policy.budgets) {
    const { actor_name, actor_role } = rule.match;
    if (actor_name && actor.name !== actor_name) continue;
    if (actor_role && actor.role !== actor_role) continue;
    if (!actor_name && !actor_role) continue; // defensive: must match something
    return rule;
  }
  return null;
}

/**
 * Compute current spend and remaining budget for an actor under a rule.
 * Returns null if the audit sink can't aggregate (e.g. runestone-cloud
 * sink without summarizeUsage) — callers should treat that as "enforcement
 * disabled" rather than denying every call.
 */
export async function computeBudgetStatus(
  rule: BudgetRule,
  actor: Actor,
  policy: Policy,
  sink: AuditSink,
  now: Date = new Date()
): Promise<BudgetStatus | null> {
  if (!sink.summarizeUsage) return null;

  const filter: UsageFilter = {
    since: windowStartISO(rule.window, now),
    until: now.toISOString(),
    limit: 1000,
  };
  if (rule.match.actor_name) filter.actorName = rule.match.actor_name;
  if (rule.match.actor_role) filter.actorRole = rule.match.actor_role;

  let summary: UsageSummary;
  try {
    summary = await sink.summarizeUsage(filter);
  } catch {
    return null;
  }

  // Multiply each usage row by its tool's cost_usd.
  const byToolMap = new Map<string, { callCount: number; costUsd: number }>();
  for (const row of summary.rows) {
    const toolCost = policy.tools[row.tool]?.cost_usd ?? 0;
    if (toolCost <= 0) continue;
    const cost = row.callCount * toolCost;
    const existing = byToolMap.get(row.tool);
    if (existing) {
      existing.callCount += row.callCount;
      existing.costUsd += cost;
    } else {
      byToolMap.set(row.tool, { callCount: row.callCount, costUsd: cost });
    }
  }

  const byTool = [...byToolMap.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const currentUsd = byTool.reduce((sum, t) => sum + t.costUsd, 0);
  const remainingUsd = Math.max(0, rule.max_usd - currentUsd);

  return {
    rule,
    windowStart: filter.since!,
    windowEnd: filter.until!,
    currentUsd,
    remainingUsd,
    exceeded: currentUsd >= rule.max_usd,
    byTool,
  };
}

/**
 * Pre-execution budget check. Returns a denial PolicyEvaluation if the
 * actor has already exceeded their budget OR if this call's estimated
 * cost would push them over. Returns null to permit the call.
 */
export async function enforceBudget(
  toolName: string,
  actor: Actor | undefined,
  policy: Policy,
  sink: AuditSink
): Promise<PolicyEvaluation | null> {
  const rule = matchBudgetRule(actor, policy);
  if (!rule || !actor) return null;

  const thisCallCost = policy.tools[toolName]?.cost_usd ?? 0;
  // Zero-cost tools bypass budget enforcement (no contribution, no impact).
  if (thisCallCost <= 0) return null;

  const status = await computeBudgetStatus(rule, actor, policy, sink);
  if (!status) return null; // sink doesn't support aggregation — skip

  const projected = status.currentUsd + thisCallCost;
  if (projected <= rule.max_usd) return null;

  if (rule.mode === BudgetMode.Soft) {
    // Soft mode: log a risk flag but permit the call.
    return null;
  }

  const decimals = thisCallCost < 0.01 ? 4 : 2;
  return {
    decision: 'deny',
    reason: `Budget "${rule.name}" exceeded`,
    reasonCode: 'BUDGET_EXCEEDED',
    humanExplanation:
      `Actor ${actor.name ?? actor.role ?? 'unknown'} has spent $${status.currentUsd.toFixed(decimals)} ` +
      `of the $${rule.max_usd.toFixed(2)} "${rule.name}" budget within the current ${rule.window} window. ` +
      `This call would cost $${thisCallCost.toFixed(decimals)}, pushing the total to $${projected.toFixed(decimals)}.`,
    remediation:
      `Wait for the rolling ${rule.window} window to reset, raise max_usd in policy.budgets, ` +
      `or configure this tool with a lower cost_usd.`,
    riskFlags: ['budget_exceeded'],
  };
}
