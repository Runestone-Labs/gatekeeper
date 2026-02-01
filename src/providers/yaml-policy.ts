import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import yaml from 'js-yaml';
import { Policy, ToolPolicy } from '../types.js';
import { computeHash } from '../utils.js';
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

    const content = readFileSync(this.policyPath, 'utf-8');
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
        allowed_cwd_prefixes: normalizeStringArray(config.allowed_cwd_prefixes),
        max_output_bytes: normalizeNumber(config.max_output_bytes),
        max_timeout_ms: normalizeNumber(config.max_timeout_ms),
        allowed_paths: normalizeStringArray(config.allowed_paths),
        deny_extensions: normalizeStringArray(config.deny_extensions),
        max_size_bytes: normalizeNumber(config.max_size_bytes),
        allowed_methods: normalizeStringArray(config.allowed_methods),
        deny_domains: normalizeStringArray(config.deny_domains),
        deny_ip_ranges: normalizeStringArray(config.deny_ip_ranges),
        timeout_ms: normalizeNumber(config.timeout_ms),
        max_body_bytes: normalizeNumber(config.max_body_bytes),
      };
    }

    this.cachedPolicy = { tools };
    this.cachedPolicyHash = 'sha256:' + computeHash(content);

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
