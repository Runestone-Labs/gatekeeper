import {
  PolicyEvaluation,
  RiskLevel,
  SensitiveBoundaryRule,
  BoundaryEffect,
  Decision,
} from '../types.js';
import { canonicalize, resolvePath } from '../utils.js';

/**
 * Evaluate a tool request against the configured sensitive-boundary rules.
 *
 * Returns a PolicyEvaluation when a `deny` or `require_approval` rule matches,
 * or `null` to fall through to the rest of the policy pipeline (regular
 * deny_patterns, principal restrictions, default tool decision).
 *
 * A boundary rule with `effect: 'allow'` is treated as a whitelist: if it
 * matches, the function returns `null` and skips lower-risk rules. This is
 * how YAML overrides silence a default for known-safe paths.
 *
 * Rules are evaluated in risk order (critical → high → medium → low) so the
 * strongest applicable rule wins when several would match.
 */
export function evaluateSensitiveBoundaries(
  toolName: string,
  args: Record<string, unknown>,
  rules: SensitiveBoundaryRule[]
): PolicyEvaluation | null {
  const applicable = rules
    .filter((r) => r.tools.includes(toolName))
    .sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk]);

  if (applicable.length === 0) return null;

  const command = typeof args.command === 'string' ? args.command : undefined;
  const path = typeof args.path === 'string' ? args.path : undefined;
  const canonicalArgs = canonicalize(args);

  // Strings each rule's regexes will be tested against. We test against multiple
  // surfaces because paths frequently appear inside shell commands (e.g.
  // `cat ~/.ssh/id_rsa` is a shell command that touches a private key path).
  const commandSurfaces: string[] = [];
  if (command !== undefined) commandSurfaces.push(command);
  // For non-shell tools that have no `command`, fall back to canonicalized args
  // so a future tool that embeds a binary like `gh auth token` in an args field
  // still gets caught.
  if (commandSurfaces.length === 0) commandSurfaces.push(canonicalArgs);

  const pathSurfaces: string[] = [];
  if (path !== undefined) {
    pathSurfaces.push(path);
    try {
      pathSurfaces.push(resolvePath(path));
    } catch {
      // resolvePath should never throw, but if it does, the literal is enough.
    }
  }
  // Paths embedded in shell commands also need path-regex coverage.
  if (command !== undefined) pathSurfaces.push(command);

  for (const rule of applicable) {
    if (!ruleMatches(rule, commandSurfaces, pathSurfaces)) continue;

    if (rule.effect === 'allow') {
      // Explicit whitelist override — short-circuit boundary evaluation and
      // let the rest of the policy pipeline run.
      return null;
    }

    return buildEvaluation(rule);
  }

  return null;
}

const RISK_ORDER: Record<RiskLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const EFFECT_TO_DECISION: Record<Exclude<BoundaryEffect, 'allow'>, Decision> = {
  require_approval: 'approve',
  deny: 'deny',
};

function ruleMatches(
  rule: SensitiveBoundaryRule,
  commandSurfaces: string[],
  pathSurfaces: string[]
): boolean {
  const { command_regex, path_regex } = rule.match;

  if (command_regex) {
    const re = compile(command_regex);
    if (re && commandSurfaces.some((s) => re.test(s))) return true;
  }

  if (path_regex) {
    const re = compile(path_regex);
    if (re && pathSurfaces.some((s) => re.test(s))) return true;
  }

  return false;
}

function buildEvaluation(rule: SensitiveBoundaryRule): PolicyEvaluation {
  const decision = EFFECT_TO_DECISION[rule.effect as 'require_approval' | 'deny'];
  const reasonCode = decision === 'deny' ? 'BOUNDARY_DENIED' : 'BOUNDARY_REQUIRES_APPROVAL';

  const remediationParts: string[] = [];
  if (rule.safer_alternative) remediationParts.push(rule.safer_alternative);
  if (decision === 'approve') {
    remediationParts.push('If this is intentional, request human approval to proceed.');
  } else {
    remediationParts.push(
      'If you genuinely need this, the user must run it manually outside the agent.'
    );
  }

  return {
    decision,
    reason: `Sensitive boundary: ${rule.id} (${rule.category})`,
    reasonCode,
    humanExplanation: rule.message,
    remediation: remediationParts.join(' '),
    riskFlags: [
      `boundary:${rule.id}`,
      `category:${rule.category}`,
      `resource:${rule.resource_class}`,
      `risk:${rule.risk}`,
    ],
    category: rule.category,
    resourceClass: rule.resource_class,
    risk: rule.risk,
    saferAlternative: rule.safer_alternative,
  };
}

/**
 * Cache compiled regexes per source string. Boundary rules are evaluated on
 * every tool call, so recompiling on each request would be wasteful — but the
 * cache is keyed on the literal pattern so YAML hot-reloads still pick up
 * changes after the cache is cleared by tests.
 */
const REGEX_CACHE = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (REGEX_CACHE.has(pattern)) return REGEX_CACHE.get(pattern)!;
  try {
    const re = new RegExp(pattern, 'i');
    REGEX_CACHE.set(pattern, re);
    return re;
  } catch {
    REGEX_CACHE.set(pattern, null);
    return null;
  }
}

/** Test-only: clear the regex cache so re-loaded rules are re-compiled. */
export function _clearBoundaryRegexCache(): void {
  REGEX_CACHE.clear();
}
