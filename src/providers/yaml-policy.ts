import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { Policy, ToolPolicy, PrincipalPolicy } from '../types.js';
import { canonicalize, computeHash } from '../utils.js';
import { PolicySource } from './types.js';

/**
 * YAML policy source - loads policy from a YAML file.
 * Supports file watching for hot reload.
 */
export class YamlPolicySource implements PolicySource {
  name = 'yaml';

  private policyPath: string;
  private cachedPolicy: Policy | null = null;
  private cachedPolicyHash: string | null = null;
  private changeCallback: (() => void) | null = null;

  constructor(policyPath: string) {
    this.policyPath = policyPath;
  }

  async load(): Promise<Policy> {
    if (this.cachedPolicy) {
      return this.cachedPolicy;
    }

    const raw = loadPolicyFile(this.policyPath, new Set());

    if (!raw || typeof raw !== 'object' || !raw.tools) {
      throw new Error('Invalid policy file: missing "tools" section');
    }

    // Validate and normalize tool policies
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
      };
    }

    // v1: Parse principal policies
    let principals: Record<string, PrincipalPolicy> | undefined;
    if (raw.principals && typeof raw.principals === 'object') {
      principals = {};
      for (const [principalName, principalConfig] of Object.entries(raw.principals)) {
        if (!principalConfig || typeof principalConfig !== 'object') {
          throw new Error(`Invalid policy for principal: ${principalName}`);
        }

        const config = principalConfig as Record<string, unknown>;
        principals[principalName] = {
          allowedTools: normalizeStringArray(config.allowedTools) || [],
          denyPatterns: normalizeStringArray(config.denyPatterns),
          requireApproval: normalizeStringArray(config.requireApproval),
          alertBudget: config.alertBudget as PrincipalPolicy['alertBudget'],
        };
      }
    }

    const globalDenyPatterns = normalizeStringArray(raw.global_deny_patterns);

    const policy: Policy = { tools };

    if (principals) {
      policy.principals = principals;
    }

    if (globalDenyPatterns) {
      policy.global_deny_patterns = globalDenyPatterns;
    }

    this.cachedPolicy = policy;
    this.cachedPolicyHash = 'sha256:' + computeHash(canonicalize(this.cachedPolicy));

    return this.cachedPolicy;
  }

  getHash(): string {
    if (!this.cachedPolicyHash) {
      throw new Error('Policy not loaded yet');
    }
    return this.cachedPolicyHash;
  }

  onChange(callback: () => void): void {
    // Clean up any existing watcher
    if (this.changeCallback) {
      unwatchFile(this.policyPath);
    }

    this.changeCallback = callback;

    // Watch for file changes
    watchFile(this.policyPath, { interval: 1000 }, () => {
      // Clear cache so next load() gets fresh data
      this.cachedPolicy = null;
      this.cachedPolicyHash = null;

      if (this.changeCallback) {
        this.changeCallback();
      }
    });
  }

  /**
   * Clear the cached policy (for testing or manual reload).
   */
  clearCache(): void {
    this.cachedPolicy = null;
    this.cachedPolicyHash = null;
  }

  /**
   * Stop watching for file changes.
   */
  stopWatching(): void {
    unwatchFile(this.policyPath);
    this.changeCallback = null;
  }
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

type RawPolicyData = {
  tools?: Record<string, unknown>;
  principals?: Record<string, unknown>;
  global_deny_patterns?: unknown;
};

type RawPolicyFile = RawPolicyData & {
  extends?: string | string[];
  principals_file?: string;
};

function loadPolicyFile(policyPath: string, visited: Set<string>): RawPolicyData {
  const resolvedPath = resolve(policyPath);
  if (visited.has(resolvedPath)) {
    throw new Error(`Policy include cycle detected: ${resolvedPath}`);
  }
  visited.add(resolvedPath);

  const content = readFileSync(resolvedPath, 'utf-8');
  const raw = yaml.load(content) as RawPolicyFile;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid policy file: ${resolvedPath}`);
  }

  let merged: RawPolicyData = {};

  const extendsList =
    typeof raw.extends === 'string' ? [raw.extends] : normalizeStringArray(raw.extends) ?? [];
  for (const extendPath of extendsList) {
    const resolvedExtend = resolve(dirname(resolvedPath), extendPath);
    merged = mergeRawPolicies(merged, loadPolicyFile(resolvedExtend, visited));
  }

  const { extends: _extends, principals_file: principalsFile, ...rest } = raw;
  merged = mergeRawPolicies(merged, rest);

  if (principalsFile) {
    const resolvedPrincipals = resolve(dirname(resolvedPath), principalsFile);
    const principals = loadPrincipalsFile(resolvedPrincipals);
    merged = mergeRawPolicies(merged, { principals });
  }

  return merged;
}

function loadPrincipalsFile(principalsPath: string): Record<string, unknown> {
  const content = readFileSync(principalsPath, 'utf-8');
  const raw = yaml.load(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid principals file: ${principalsPath}`);
  }

  if ('principals' in raw) {
    const principals = (raw as { principals?: unknown }).principals;
    if (!principals || typeof principals !== 'object') {
      throw new Error(`Invalid principals file: missing "principals" section`);
    }
    return principals as Record<string, unknown>;
  }

  return raw;
}

function mergeRawPolicies(base: RawPolicyData, override: RawPolicyData): RawPolicyData {
  return {
    tools: mergeToolConfigs(base.tools, override.tools),
    principals: mergePrincipals(base.principals, override.principals),
    global_deny_patterns: mergeStringArrays(base.global_deny_patterns, override.global_deny_patterns),
  };
}

function mergeToolConfigs(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, unknown> = { ...(base ?? {}) };

  if (!override) return merged;

  for (const [toolName, overrideConfig] of Object.entries(override)) {
    const baseConfig = base?.[toolName];
    if (
      baseConfig &&
      typeof baseConfig === 'object' &&
      overrideConfig &&
      typeof overrideConfig === 'object'
    ) {
      merged[toolName] = mergeToolPolicy(
        baseConfig as Record<string, unknown>,
        overrideConfig as Record<string, unknown>
      );
    } else {
      merged[toolName] = overrideConfig;
    }
  }

  return merged;
}

function mergeToolPolicy(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...base,
    ...override,
    deny_patterns: mergeStringArrays(base.deny_patterns, override.deny_patterns),
    deny_extensions: mergeStringArrays(base.deny_extensions, override.deny_extensions),
    deny_domains: mergeStringArrays(base.deny_domains, override.deny_domains),
    deny_ip_ranges: mergeStringArrays(base.deny_ip_ranges, override.deny_ip_ranges),
    allowed_cwd_prefixes:
      override.allowed_cwd_prefixes !== undefined
        ? override.allowed_cwd_prefixes
        : base.allowed_cwd_prefixes,
    allowed_paths:
      override.allowed_paths !== undefined ? override.allowed_paths : base.allowed_paths,
    allowed_methods:
      override.allowed_methods !== undefined ? override.allowed_methods : base.allowed_methods,
    max_output_bytes:
      override.max_output_bytes !== undefined ? override.max_output_bytes : base.max_output_bytes,
    max_timeout_ms:
      override.max_timeout_ms !== undefined ? override.max_timeout_ms : base.max_timeout_ms,
    max_size_bytes:
      override.max_size_bytes !== undefined ? override.max_size_bytes : base.max_size_bytes,
    timeout_ms: override.timeout_ms !== undefined ? override.timeout_ms : base.timeout_ms,
    max_body_bytes:
      override.max_body_bytes !== undefined ? override.max_body_bytes : base.max_body_bytes,
    decision: override.decision !== undefined ? override.decision : base.decision,
  };
}

function mergePrincipals(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, unknown> = { ...(base ?? {}) };

  if (!override) return merged;

  for (const [principalName, overridePolicy] of Object.entries(override)) {
    const basePolicy = base?.[principalName];
    if (
      basePolicy &&
      typeof basePolicy === 'object' &&
      overridePolicy &&
      typeof overridePolicy === 'object'
    ) {
      merged[principalName] = mergePrincipalPolicy(
        basePolicy as Record<string, unknown>,
        overridePolicy as Record<string, unknown>
      );
    } else {
      merged[principalName] = overridePolicy;
    }
  }

  return merged;
}

function mergePrincipalPolicy(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...base,
    ...override,
    denyPatterns: mergeStringArrays(base.denyPatterns, override.denyPatterns),
    allowedTools:
      override.allowedTools !== undefined ? override.allowedTools : base.allowedTools,
    requireApproval:
      override.requireApproval !== undefined ? override.requireApproval : base.requireApproval,
    alertBudget: override.alertBudget !== undefined ? override.alertBudget : base.alertBudget,
  };
}

function mergeStringArrays(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }

  if (Array.isArray(base) && Array.isArray(override)) {
    return [...base, ...override];
  }

  return override;
}
