import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Policy, ToolPolicy, BudgetRule, BudgetWindow, BudgetMode } from '../types.js';
import { computeHash } from '../utils.js';

let cachedPolicy: Policy | null = null;
let cachedPolicyHash: string | null = null;

/**
 * Load and parse the YAML policy file.
 * Caches the result for subsequent calls.
 */
export function loadPolicy(policyPath: string): Policy {
  if (cachedPolicy) {
    return cachedPolicy;
  }

  const content = readFileSync(policyPath, 'utf-8');
  const raw = yaml.load(content) as { tools?: Record<string, unknown> };

  if (!raw || typeof raw !== 'object' || !raw.tools) {
    throw new Error('Invalid policy file: missing "tools" section');
  }

  // Validate and normalize policy
  const tools: Record<string, ToolPolicy> = {};

  for (const [toolName, toolConfig] of Object.entries(raw.tools)) {
    if (!toolConfig || typeof toolConfig !== 'object') {
      throw new Error(`Invalid policy for tool: ${toolName}`);
    }

    const config = toolConfig as Record<string, unknown>;

    if (!config.decision || !['allow', 'approve', 'deny'].includes(config.decision as string)) {
      throw new Error(`Invalid decision for tool ${toolName}: must be allow, approve, or deny`);
    }

    tools[toolName] = {
      decision: config.decision as 'allow' | 'approve' | 'deny',
      deny_patterns: normalizeStringArray(config.deny_patterns),
      allowed_commands: normalizeStringArray(config.allowed_commands),
      allowed_cwd_prefixes: normalizeStringArray(config.allowed_cwd_prefixes),
      max_output_bytes: normalizeNumber(config.max_output_bytes),
      max_timeout_ms: normalizeNumber(config.max_timeout_ms),
      allowed_paths: normalizeStringArray(config.allowed_paths),
      deny_extensions: normalizeStringArray(config.deny_extensions),
      max_size_bytes: normalizeNumber(config.max_size_bytes),
      allowed_methods: normalizeStringArray(config.allowed_methods),
      allowed_domains: normalizeStringArray(config.allowed_domains),
      deny_domains: normalizeStringArray(config.deny_domains),
      deny_ip_ranges: normalizeStringArray(config.deny_ip_ranges),
      timeout_ms: normalizeNumber(config.timeout_ms),
      max_body_bytes: normalizeNumber(config.max_body_bytes),
      max_redirects: normalizeNumber(config.max_redirects),
      sandbox_command_prefix: normalizeStringArray(config.sandbox_command_prefix),
      run_as_uid: normalizeNumber(config.run_as_uid),
      run_as_gid: normalizeNumber(config.run_as_gid),
      env_allowlist: normalizeStringArray(config.env_allowlist),
      env_overrides:
        config.env_overrides && typeof config.env_overrides === 'object'
          ? (config.env_overrides as Record<string, string>)
          : undefined,
      cost_usd: normalizeNumber(config.cost_usd),
    };
  }

  const budgets = normalizeBudgets((raw as { budgets?: unknown }).budgets);

  cachedPolicy = { tools, budgets };
  cachedPolicyHash = 'sha256:' + computeHash(content);

  return cachedPolicy;
}

/** Parse the optional top-level `budgets:` array into BudgetRule entries. */
function normalizeBudgets(value: unknown): BudgetRule[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: BudgetRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : undefined;
    const windowValues = Object.values(BudgetWindow) as string[];
    const window =
      typeof r.window === 'string' && windowValues.includes(r.window)
        ? (r.window as BudgetWindow)
        : undefined;
    const max_usd = typeof r.max_usd === 'number' ? r.max_usd : undefined;
    const match =
      r.match && typeof r.match === 'object' ? (r.match as Record<string, unknown>) : null;
    if (!name || !window || max_usd == null || !match) {
      throw new Error(
        `Invalid budget rule: requires name, window (${windowValues.join('|')}), max_usd, and match{actor_name|actor_role}`
      );
    }
    const actor_name = typeof match.actor_name === 'string' ? match.actor_name : undefined;
    const actor_role = typeof match.actor_role === 'string' ? match.actor_role : undefined;
    if (!actor_name && !actor_role) {
      throw new Error(`Budget rule "${name}" must specify match.actor_name or match.actor_role`);
    }
    const mode = r.mode === BudgetMode.Soft ? BudgetMode.Soft : BudgetMode.Hard;
    out.push({ name, window, max_usd, match: { actor_name, actor_role }, mode });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Get the hash of the loaded policy file.
 * Used for audit logging and health checks.
 */
export function getPolicyHash(): string {
  if (!cachedPolicyHash) {
    throw new Error('Policy not loaded yet');
  }
  return cachedPolicyHash;
}

/**
 * Clear the cached policy (for testing or hot reload).
 */
export function clearPolicyCache(): void {
  cachedPolicy = null;
  cachedPolicyHash = null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && !isNaN(value)) {
    return value;
  }
  return undefined;
}
