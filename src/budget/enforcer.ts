/**
 * Budget enforcement.
 *
 * Computes spend within a scope (a matched actor, or a single agentic RUN) by
 * aggregating the audit sink's usage summary. Each usage row contributes either
 * its REAL summed cost (e.g. proxied model calls metered per token) or, when no
 * real cost was recorded, a nominal flat `cost_usd × call count`. Rejects tool
 * calls that would push the scope over its USD / token / call ceiling.
 *
 * The authoritative state is the audit log, so budgets are eventually
 * consistent — a flurry of concurrent calls could all pass the pre-check and
 * collectively exceed the cap. For a self-hosted deployment this is fine; a
 * hosted multi-tenant tier should add a short in-memory reservation cache.
 *
 * Per-RUN scope is the unit where agentic burn actually compounds: a single run
 * can recursively spend many multiples of a sibling run. Capping per run (keyed
 * on actor.runId) at the action boundary — with the existing allow / approve /
 * deny + signed-approval machinery — is what per-key/per-month gateways can't do.
 */

import { BudgetMode } from '../types.js';
import type {
  Actor,
  BudgetRule,
  BudgetScope,
  Policy,
  PolicyEvaluation,
  UsageFilter,
  UsageSummary,
} from '../types.js';
import { BudgetWindow } from '../types.js';
import type { AuditSink } from '../providers/types.js';

export interface BudgetStatus {
  rule: BudgetRule;
  scope: BudgetScope;
  windowStart: string;
  windowEnd: string;
  currentUsd: number;
  remainingUsd: number;
  currentTokens: number;
  currentCalls: number;
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

/** Does this rule's actor matcher apply to the given actor? */
function ruleMatchesActor(rule: BudgetRule, actor: Actor): boolean {
  const { actor_name, actor_role } = rule.match;
  if (actor_name && actor.name !== actor_name) return false;
  if (actor_role && actor.role !== actor_role) return false;
  if (!actor_name && !actor_role) return false; // defensive: must match something
  return true;
}

/** All budget rules in the policy that match this actor (in declaration order). */
export function matchBudgetRules(actor: Actor | undefined, policy: Policy): BudgetRule[] {
  if (!actor || !policy.budgets) return [];
  return policy.budgets.filter((rule) => ruleMatchesActor(rule, actor));
}

/** First matching budget rule, or null. (Back-compat helper.) */
export function matchBudgetRule(actor: Actor | undefined, policy: Policy): BudgetRule | null {
  return matchBudgetRules(actor, policy)[0] ?? null;
}

/**
 * Compute current spend/tokens/calls and remaining budget for a rule. Pass
 * `options.runId` to scope aggregation to a single run. Returns null if the
 * audit sink can't aggregate (callers treat that as "enforcement disabled"
 * rather than denying every call).
 */
export async function computeBudgetStatus(
  rule: BudgetRule,
  actor: Actor,
  policy: Policy,
  sink: AuditSink,
  options: { now?: Date; runId?: string } = {}
): Promise<BudgetStatus | null> {
  if (!sink.summarizeUsage) return null;
  const now = options.now ?? new Date();

  const filter: UsageFilter = {
    since: windowStartISO(rule.window, now),
    until: now.toISOString(),
    limit: 1000,
  };
  if (rule.match.actor_name) filter.actorName = rule.match.actor_name;
  if (rule.match.actor_role) filter.actorRole = rule.match.actor_role;
  if (options.runId) filter.runId = options.runId;

  let summary: UsageSummary;
  try {
    summary = await sink.summarizeUsage(filter);
  } catch {
    return null;
  }

  // Per tool: real summed cost when present, else nominal flat cost × count.
  const byToolMap = new Map<string, { callCount: number; costUsd: number }>();
  let currentTokens = 0;
  let currentCalls = 0;
  for (const row of summary.rows) {
    // Every call (including free tools) counts toward call/token ceilings.
    currentCalls += row.callCount;
    if (typeof row.totalTokens === 'number') currentTokens += row.totalTokens;

    const realCost = typeof row.totalCostUsd === 'number' ? row.totalCostUsd : null;
    const flatCost = (policy.tools[row.tool]?.cost_usd ?? 0) * row.callCount;
    const cost = realCost != null ? realCost : flatCost;
    // Free tool with no real cost contributes nothing to the USD breakdown.
    if (realCost == null && cost <= 0) continue;

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
    scope: rule.scope ?? 'actor',
    windowStart: filter.since!,
    windowEnd: filter.until!,
    currentUsd,
    remainingUsd,
    currentTokens,
    currentCalls,
    exceeded: currentUsd >= rule.max_usd,
    byTool,
  };
}

/**
 * Pre-execution budget check. Evaluates EVERY budget rule matching the actor
 * (an actor may have both an actor-scoped monthly guardrail and a per-run cap)
 * and returns the first denial, or null to permit the call.
 */
export async function enforceBudget(
  toolName: string,
  actor: Actor | undefined,
  policy: Policy,
  sink: AuditSink
): Promise<PolicyEvaluation | null> {
  if (!actor) return null;
  for (const rule of matchBudgetRules(actor, policy)) {
    const denial = await evaluateRule(rule, toolName, actor, policy, sink);
    if (denial) return denial;
  }
  return null;
}

/** Evaluate one budget rule against a pending call. */
async function evaluateRule(
  rule: BudgetRule,
  toolName: string,
  actor: Actor,
  policy: Policy,
  sink: AuditSink
): Promise<PolicyEvaluation | null> {
  const isRun = rule.scope === 'run';
  // A run-scoped rule needs a run to key on; without one there's nothing to cap.
  if (isRun && !actor.runId) return null;

  const thisCallCost = policy.tools[toolName]?.cost_usd ?? 0;
  // Actor scope: zero-cost tools bypass entirely (preserves v1 behavior).
  // Run scope: still enforce token/call ceilings and already-accrued spend even
  // for zero-flat-cost tools, because model cost lands on the audit row only
  // AFTER the proxied call completes.
  if (!isRun && thisCallCost <= 0) return null;

  const status = await computeBudgetStatus(rule, actor, policy, sink, {
    runId: isRun ? actor.runId : undefined,
  });
  if (!status) return null; // sink can't aggregate — skip (don't hard-deny)

  const projectedUsd = status.currentUsd + thisCallCost;
  const overUsd = projectedUsd > rule.max_usd;
  const overTokens = rule.max_tokens != null && status.currentTokens >= rule.max_tokens;
  const overCalls = rule.max_calls != null && status.currentCalls + 1 > rule.max_calls;
  if (!overUsd && !overTokens && !overCalls) return null;

  if (rule.mode === BudgetMode.Soft) return null; // soft: observe, don't block

  return buildDenial(rule, actor, status, {
    thisCallCost,
    projectedUsd,
    overUsd,
    overTokens,
    overCalls,
    isRun,
  });
}

/** Build the denial PolicyEvaluation, leading with the breached dimension. */
function buildDenial(
  rule: BudgetRule,
  actor: Actor,
  status: BudgetStatus,
  ctx: {
    thisCallCost: number;
    projectedUsd: number;
    overUsd: boolean;
    overTokens: boolean;
    overCalls: boolean;
    isRun: boolean;
  }
): PolicyEvaluation {
  const subject = ctx.isRun
    ? `Run ${actor.runId}`
    : `Actor ${actor.name ?? actor.role ?? 'unknown'}`;
  const decimals = ctx.thisCallCost > 0 && ctx.thisCallCost < 0.01 ? 4 : 2;

  let humanExplanation: string;
  if (ctx.overUsd) {
    humanExplanation =
      `${subject} has spent $${status.currentUsd.toFixed(decimals)} ` +
      `of the $${rule.max_usd.toFixed(2)} "${rule.name}" budget` +
      (ctx.isRun ? '' : ` within the current ${rule.window} window`) +
      `. This call would cost $${ctx.thisCallCost.toFixed(decimals)}, ` +
      `pushing the total to $${ctx.projectedUsd.toFixed(decimals)}.`;
  } else if (ctx.overTokens) {
    humanExplanation =
      `${subject} has used ${status.currentTokens.toLocaleString()} tokens, ` +
      `reaching the ${rule.max_tokens!.toLocaleString()}-token "${rule.name}" ceiling.`;
  } else {
    humanExplanation =
      `${subject} has made ${status.currentCalls} tool calls, ` +
      `reaching the ${rule.max_calls}-call "${rule.name}" ceiling.`;
  }

  const remediation = ctx.isRun
    ? `Start a new run, raise the "${rule.name}" ceiling in policy.budgets, or approve continuation.`
    : `Wait for the rolling ${rule.window} window to reset, raise the "${rule.name}" ceiling in policy.budgets, or lower the tool's cost_usd.`;

  return {
    decision: 'deny',
    reason: `Budget "${rule.name}" exceeded`,
    reasonCode: ctx.isRun ? 'RUN_BUDGET_EXCEEDED' : 'BUDGET_EXCEEDED',
    humanExplanation,
    remediation,
    riskFlags: ctx.isRun ? ['budget_exceeded', 'run_budget_exceeded'] : ['budget_exceeded'],
  };
}
