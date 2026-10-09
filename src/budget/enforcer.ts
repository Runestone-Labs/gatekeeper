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
 * Hard rules fail CLOSED when usage can't be fully counted (the sink errored
 * or returned a truncated summary): a lower bound can't prove a call is under
 * its ceiling. Soft rules continue. A sink with no summarizeUsage() at all
 * leaves budgets inert, as before.
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
  /**
   * False when the sink returned a truncated summary, so the totals above are a
   * lower bound. Hard rules deny rather than permit on an incomplete count.
   */
  complete: boolean;
  exceeded: boolean;
  byTool: Array<{ tool: string; callCount: number; costUsd: number }>;
}

/**
 * Tools whose USD lands on the audit row AFTER the call (metered per token),
 * so a zero flat `cost_usd` doesn't mean the call is free.
 */
const METERED_TOOLS = new Set(['anthropic.proxy']);

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
 * audit sink can't aggregate or the aggregation failed; evaluateRule tells
 * the two apart (inert vs. fail closed).
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
    // Every group, not a top-N: rows are sorted by call count, so any cap drops
    // the smallest groups and a role/run rule spanning many actor names, tools
    // or days would undercount calls, tokens and USD past a hard ceiling.
    limit: null,
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
    // Attribute cost + calls to EXECUTIONS, not the paired request-log rows: a
    // single allowed tool call logs both an 'allow' and an 'executed' entry, so
    // counting raw rows would double-charge flat-cost tools. A breakdown with no
    // 'executed' key means nothing ran (denials, pending approvals, dry runs);
    // only a summary with NO breakdown falls back to callCount. (Real model cost
    // is already carried only on the executed row, so totalCostUsd is unaffected.)
    const executedCount = row.decisions ? (row.decisions.executed ?? 0) : row.callCount;
    currentCalls += executedCount;
    if (typeof row.totalTokens === 'number') currentTokens += row.totalTokens;

    const realCost = typeof row.totalCostUsd === 'number' ? row.totalCostUsd : null;
    const flatCost = (policy.tools[row.tool]?.cost_usd ?? 0) * executedCount;
    const cost = realCost != null ? realCost : flatCost;
    // Free tool with no real cost contributes nothing to the USD breakdown.
    if (realCost == null && cost <= 0) continue;

    const existing = byToolMap.get(row.tool);
    if (existing) {
      existing.callCount += executedCount;
      existing.costUsd += cost;
    } else {
      byToolMap.set(row.tool, { callCount: executedCount, costUsd: cost });
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
    complete: summary.truncated !== true,
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
  // Call and token ceilings bind every matched call: each call counts toward
  // max_calls, and model tokens land on the audit row only AFTER the call.
  // The USD ceiling binds any call that can add spend (a flat cost_usd or a
  // metered tool). Run scope also enforces already-accrued spend on free tools;
  // actor scope exempts them so free tools stay usable once a USD-only cap is
  // hit (v1 behavior).
  const usdApplies = isRun || thisCallCost > 0 || METERED_TOOLS.has(toolName);
  const hasCountCeiling = rule.max_calls != null || rule.max_tokens != null;
  if (!usdApplies && !hasCountCeiling) return null;

  const status = await computeBudgetStatus(rule, actor, policy, sink, {
    runId: isRun ? actor.runId : undefined,
  });
  if (!status) {
    // No aggregation support at all: budgets are inert for this sink.
    if (!sink.summarizeUsage) return null;
    // The sink can aggregate but failed (e.g. database down): nothing proves
    // this call is under a hard ceiling.
    if (rule.mode === BudgetMode.Soft) return null;
    return buildUnverifiedDenial(rule, actor, isRun, 'unavailable');
  }

  const projectedUsd = status.currentUsd + thisCallCost;
  const overUsd = usdApplies && projectedUsd > rule.max_usd;
  const overTokens = rule.max_tokens != null && status.currentTokens >= rule.max_tokens;
  const overCalls = rule.max_calls != null && status.currentCalls + 1 > rule.max_calls;
  const over = overUsd || overTokens || overCalls;
  if (!over && status.complete) return null;

  if (rule.mode === BudgetMode.Soft) return null; // soft: observe, don't block

  // A truncated summary is a lower bound: "under the ceiling" can't be confirmed.
  if (!over) return buildUnverifiedDenial(rule, actor, isRun, 'incomplete');

  return buildDenial(rule, actor, status, {
    thisCallCost,
    projectedUsd,
    overUsd,
    overTokens,
    overCalls,
    isRun,
  });
}

/**
 * Deny a hard-budget call whose usage history couldn't be fully counted:
 * 'incomplete' = the sink returned a truncated summary, 'unavailable' = the
 * sink's aggregation threw.
 */
function buildUnverifiedDenial(
  rule: BudgetRule,
  actor: Actor,
  isRun: boolean,
  cause: 'incomplete' | 'unavailable'
): PolicyEvaluation {
  const subject = isRun ? `Run ${actor.runId}` : `Actor ${actor.name ?? actor.role ?? 'unknown'}`;
  const what =
    cause === 'incomplete'
      ? `The audit sink returned a truncated usage summary for ${subject}`
      : `The audit sink could not summarize usage for ${subject}`;
  return {
    decision: 'deny',
    reason: `Budget "${rule.name}" could not be verified`,
    reasonCode: cause === 'incomplete' ? 'BUDGET_USAGE_INCOMPLETE' : 'BUDGET_USAGE_UNAVAILABLE',
    humanExplanation: `${what}, so the "${rule.name}" hard budget cannot confirm this call is under its ceiling.`,
    remediation:
      cause === 'incomplete'
        ? 'Use an audit sink whose summarizeUsage() honors `limit: null` (returns every group), or switch the rule to soft mode.'
        : 'Restore the audit sink (check the database connection and server logs), or switch the rule to soft mode.',
    riskFlags: [`budget_usage_${cause}`],
  };
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
      (ctx.thisCallCost > 0
        ? `. This call would cost $${ctx.thisCallCost.toFixed(decimals)}, ` +
          `pushing the total to $${ctx.projectedUsd.toFixed(decimals)}.`
        : '.');
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
