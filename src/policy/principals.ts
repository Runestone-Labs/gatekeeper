/**
 * Principal/Role Framework
 *
 * This module provides the framework for role-based access control.
 * The actual principal definitions are loaded from policy configuration
 * (typically YAML files in the private repo).
 *
 * SECURITY: Principal policies are evaluated AFTER taint checks but
 * BEFORE regular tool policies, allowing role-specific restrictions.
 */

import { PrincipalPolicy, AlertBudget } from '../types.js';

/**
 * In-memory tracking of alert budgets per principal.
 * Resets hourly.
 */
interface AlertTracker {
  count: number;
  windowStart: number;
}

const alertTrackers: Map<string, AlertTracker> = new Map();

/**
 * Check if a principal has exceeded their alert budget.
 * Returns true if the alert should be suppressed.
 */
export function checkAlertBudget(
  principalName: string,
  severity: 'low' | 'medium' | 'high',
  budget?: AlertBudget
): { allowed: boolean; reason?: string } {
  if (!budget) {
    return { allowed: true };
  }

  // Check severity threshold
  const severityOrder = { low: 0, medium: 1, high: 2 };
  if (severityOrder[severity] < severityOrder[budget.severityThreshold]) {
    return {
      allowed: false,
      reason: `Alert severity ${severity} below threshold ${budget.severityThreshold}`,
    };
  }

  // Check rate limit
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  let tracker = alertTrackers.get(principalName);

  if (!tracker || now - tracker.windowStart > hourMs) {
    // New window
    tracker = { count: 0, windowStart: now };
    alertTrackers.set(principalName, tracker);
  }

  if (tracker.count >= budget.maxPerHour) {
    return {
      allowed: false,
      reason: `Alert budget exhausted: ${tracker.count}/${budget.maxPerHour} this hour`,
    };
  }

  // Increment counter
  tracker.count++;
  return { allowed: true };
}

/**
 * Get the effective role for a request.
 * Falls back to actor name if no explicit role is set.
 */
export function getEffectiveRole(actor: { name: string; role?: string }): string {
  return actor.role || actor.name;
}

/**
 * Merge principal policies, allowing inheritance.
 * Child policies override parent policies.
 */
export function mergePrincipalPolicies(
  base: PrincipalPolicy,
  override: Partial<PrincipalPolicy>
): PrincipalPolicy {
  return {
    allowedTools: override.allowedTools ?? base.allowedTools,
    denyPatterns: [...(base.denyPatterns ?? []), ...(override.denyPatterns ?? [])],
    requireApproval: override.requireApproval ?? base.requireApproval,
    alertBudget: override.alertBudget ?? base.alertBudget,
  };
}

/**
 * Create a default principal policy.
 * Used when no specific policy exists for a principal.
 */
export function createDefaultPrincipalPolicy(): PrincipalPolicy {
  return {
    allowedTools: [], // Empty = all tools allowed (uses tool-level policy)
    denyPatterns: [],
    requireApproval: [],
    alertBudget: undefined,
  };
}

/**
 * Validate a principal policy configuration.
 * Returns validation errors if any.
 */
export function validatePrincipalPolicy(
  name: string,
  policy: unknown
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof policy !== 'object' || policy === null) {
    return { valid: false, errors: [`${name}: policy must be an object`] };
  }

  const p = policy as Record<string, unknown>;

  // Validate allowedTools
  if (p.allowedTools !== undefined) {
    if (!Array.isArray(p.allowedTools)) {
      errors.push(`${name}: allowedTools must be an array`);
    } else if (!p.allowedTools.every((t) => typeof t === 'string')) {
      errors.push(`${name}: allowedTools must contain only strings`);
    }
  }

  // Validate denyPatterns
  if (p.denyPatterns !== undefined) {
    if (!Array.isArray(p.denyPatterns)) {
      errors.push(`${name}: denyPatterns must be an array`);
    } else {
      for (const pattern of p.denyPatterns as unknown[]) {
        if (typeof pattern !== 'string') {
          errors.push(`${name}: denyPatterns must contain only strings`);
          break;
        }
        try {
          new RegExp(pattern);
        } catch {
          errors.push(`${name}: invalid regex pattern "${pattern}"`);
        }
      }
    }
  }

  // Validate requireApproval
  if (p.requireApproval !== undefined) {
    if (!Array.isArray(p.requireApproval)) {
      errors.push(`${name}: requireApproval must be an array`);
    } else if (!p.requireApproval.every((t) => typeof t === 'string')) {
      errors.push(`${name}: requireApproval must contain only strings`);
    }
  }

  // Validate alertBudget
  if (p.alertBudget !== undefined) {
    const budget = p.alertBudget as Record<string, unknown>;
    if (typeof budget !== 'object' || budget === null) {
      errors.push(`${name}: alertBudget must be an object`);
    } else {
      if (typeof budget.maxPerHour !== 'number' || budget.maxPerHour < 0) {
        errors.push(`${name}: alertBudget.maxPerHour must be a non-negative number`);
      }
      const validThresholds = ['low', 'medium', 'high'];
      if (!validThresholds.includes(budget.severityThreshold as string)) {
        errors.push(`${name}: alertBudget.severityThreshold must be one of: ${validThresholds.join(', ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Reset alert trackers (for testing).
 */
export function resetAlertTrackers(): void {
  alertTrackers.clear();
}
