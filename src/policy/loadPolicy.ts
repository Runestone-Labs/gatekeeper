import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import {
  Policy,
  ToolPolicy,
  BudgetRule,
  BudgetWindow,
  BudgetMode,
  SensitiveBoundaryRule,
  RiskLevel,
  BoundaryEffect,
} from '../types.js';
import { computeHash } from '../utils.js';
import { DEFAULT_SENSITIVE_BOUNDARIES } from './sensitiveBoundaryDefaults.js';

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

  const sensitive_boundaries = mergeSensitiveBoundaries(
    DEFAULT_SENSITIVE_BOUNDARIES,
    normalizeSensitiveBoundaries((raw as { sensitive_boundaries?: unknown }).sensitive_boundaries)
  );

  cachedPolicy = { tools, budgets, sensitive_boundaries };
  cachedPolicyHash = 'sha256:' + computeHash(content);

  return cachedPolicy;
}

/**
 * Parse the optional top-level `sensitive_boundaries:` list. Returns the
 * caller-supplied overrides (or undefined when nothing was specified). The
 * caller is responsible for merging with `DEFAULT_SENSITIVE_BOUNDARIES`.
 */
function normalizeSensitiveBoundaries(value: unknown): SensitiveBoundaryRule[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Invalid sensitive_boundaries: must be an array');
  }

  const out: SensitiveBoundaryRule[] = [];
  const seenIds = new Set<string>();
  const allowedEffects: BoundaryEffect[] = ['allow', 'require_approval', 'deny'];
  const allowedRisks: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid sensitive_boundaries entry: must be an object');
    }
    const r = raw as Record<string, unknown>;

    const id = typeof r.id === 'string' ? r.id : undefined;
    if (!id) throw new Error('sensitive_boundaries entry missing required "id"');
    if (seenIds.has(id)) {
      throw new Error(`Duplicate sensitive_boundaries id: ${id}`);
    }
    seenIds.add(id);

    const effect = typeof r.effect === 'string' ? (r.effect as BoundaryEffect) : undefined;
    if (!effect || !allowedEffects.includes(effect)) {
      throw new Error(
        `sensitive_boundaries[${id}] invalid effect: must be one of ${allowedEffects.join('|')}`
      );
    }

    const tools = normalizeStringArray(r.tools);
    if (!tools || tools.length === 0) {
      throw new Error(`sensitive_boundaries[${id}] requires non-empty tools[]`);
    }

    const matchRaw =
      r.match && typeof r.match === 'object' ? (r.match as Record<string, unknown>) : null;
    if (!matchRaw) throw new Error(`sensitive_boundaries[${id}] missing match{}`);
    const command_regex =
      typeof matchRaw.command_regex === 'string' ? matchRaw.command_regex : undefined;
    const path_regex = typeof matchRaw.path_regex === 'string' ? matchRaw.path_regex : undefined;
    if (!command_regex && !path_regex) {
      throw new Error(
        `sensitive_boundaries[${id}] requires at least one of match.command_regex or match.path_regex`
      );
    }
    // Fail-fast on invalid regex so the error is caught at boot, not at runtime.
    for (const pattern of [command_regex, path_regex]) {
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        throw new Error(
          `sensitive_boundaries[${id}] invalid regex "${pattern}": ${(e as Error).message}`
        );
      }
    }

    const category = typeof r.category === 'string' ? r.category : undefined;
    if (!category) throw new Error(`sensitive_boundaries[${id}] missing category`);

    const resource_class = typeof r.resource_class === 'string' ? r.resource_class : undefined;
    if (!resource_class) throw new Error(`sensitive_boundaries[${id}] missing resource_class`);

    const risk = typeof r.risk === 'string' ? (r.risk as RiskLevel) : undefined;
    if (!risk || !allowedRisks.includes(risk)) {
      throw new Error(
        `sensitive_boundaries[${id}] invalid risk: must be one of ${allowedRisks.join('|')}`
      );
    }

    const message = typeof r.message === 'string' ? r.message : undefined;
    if (!message) throw new Error(`sensitive_boundaries[${id}] missing message`);

    const safer_alternative =
      typeof r.safer_alternative === 'string' ? r.safer_alternative : undefined;

    out.push({
      id,
      effect,
      tools,
      match: { command_regex, path_regex },
      category,
      resource_class,
      risk,
      message,
      safer_alternative,
    });
  }

  return out;
}

/**
 * Merge user overrides into the built-in defaults. Same id replaces the
 * default; new ids append. Returns a new array — neither input is mutated.
 */
function mergeSensitiveBoundaries(
  defaults: SensitiveBoundaryRule[],
  overrides: SensitiveBoundaryRule[] | undefined
): SensitiveBoundaryRule[] {
  if (!overrides || overrides.length === 0) return [...defaults];

  const byId = new Map<string, SensitiveBoundaryRule>();
  for (const rule of defaults) byId.set(rule.id, rule);
  for (const rule of overrides) byId.set(rule.id, rule);
  return Array.from(byId.values());
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
