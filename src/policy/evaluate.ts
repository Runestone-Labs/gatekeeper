import { Policy, PolicyEvaluation, ToolPolicy } from '../types.js';
import { canonicalize } from '../utils.js';

/**
 * Evaluate a tool request against policy.
 * Returns the decision and a human-readable reason.
 *
 * SECURITY: This is the core enforcement point. All decisions must be auditable.
 */
export function evaluateTool(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy
): PolicyEvaluation {
  const toolPolicy = policy.tools[toolName];

  // Unknown tool - deny by default
  if (!toolPolicy) {
    return {
      decision: 'deny',
      reason: `Unknown tool: ${toolName}`,
      riskFlags: ['unknown_tool'],
    };
  }

  // Check for deny patterns
  const patternViolation = checkDenyPatterns(args, toolPolicy);
  if (patternViolation) {
    return {
      decision: 'deny',
      reason: patternViolation.reason,
      riskFlags: patternViolation.flags,
    };
  }

  // Tool-specific validation
  const toolValidation = validateToolArgs(toolName, args, toolPolicy);
  if (toolValidation) {
    return {
      decision: 'deny',
      reason: toolValidation.reason,
      riskFlags: toolValidation.flags,
    };
  }

  // Return the configured decision
  return {
    decision: toolPolicy.decision,
    reason: toolPolicy.decision === 'approve'
      ? 'Requires human approval'
      : `Policy allows ${toolName}`,
    riskFlags: [],
  };
}

interface Violation {
  reason: string;
  flags: string[];
}

/**
 * Check args against deny patterns.
 * SECURITY: Regex patterns are evaluated against the full canonicalized args.
 */
function checkDenyPatterns(
  args: Record<string, unknown>,
  policy: ToolPolicy
): Violation | null {
  if (!policy.deny_patterns || policy.deny_patterns.length === 0) {
    return null;
  }

  const argsString = canonicalize(args);

  for (const pattern of policy.deny_patterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(argsString)) {
        return {
          reason: `Denied: matches deny pattern "${pattern}"`,
          flags: [`pattern_match:${pattern}`],
        };
      }
    } catch {
      // Invalid regex - skip (log in production)
      console.warn(`Invalid deny pattern: ${pattern}`);
    }
  }

  return null;
}

/**
 * Tool-specific argument validation.
 * SECURITY: Validates allowlists and constraints before execution.
 */
function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  policy: ToolPolicy
): Violation | null {
  switch (toolName) {
    case 'shell.exec':
      return validateShellExec(args, policy);
    case 'files.write':
      return validateFilesWrite(args, policy);
    case 'http.request':
      return validateHttpRequest(args, policy);
    default:
      return null;
  }
}

function validateShellExec(
  args: Record<string, unknown>,
  policy: ToolPolicy
): Violation | null {
  const cwd = args.cwd as string | undefined;

  // Validate cwd against allowed prefixes
  if (cwd && policy.allowed_cwd_prefixes && policy.allowed_cwd_prefixes.length > 0) {
    const allowed = policy.allowed_cwd_prefixes.some(prefix =>
      cwd.startsWith(prefix)
    );
    if (!allowed) {
      return {
        reason: `Denied: cwd "${cwd}" not in allowed prefixes`,
        flags: ['cwd_not_allowed'],
      };
    }
  }

  // Validate timeout
  const timeoutMs = args.timeoutMs as number | undefined;
  if (timeoutMs !== undefined && policy.max_timeout_ms !== undefined) {
    if (timeoutMs > policy.max_timeout_ms) {
      return {
        reason: `Denied: timeout ${timeoutMs}ms exceeds max ${policy.max_timeout_ms}ms`,
        flags: ['timeout_exceeded'],
      };
    }
  }

  return null;
}

function validateFilesWrite(
  args: Record<string, unknown>,
  policy: ToolPolicy
): Violation | null {
  const path = args.path as string | undefined;
  const content = args.content as string | undefined;

  if (!path) {
    return {
      reason: 'Denied: missing path argument',
      flags: ['missing_path'],
    };
  }

  // Validate path against allowed paths
  if (policy.allowed_paths && policy.allowed_paths.length > 0) {
    const allowed = policy.allowed_paths.some(prefix =>
      path.startsWith(prefix)
    );
    if (!allowed) {
      return {
        reason: `Denied: path "${path}" not in allowed paths`,
        flags: ['path_not_allowed'],
      };
    }
  }

  // Validate extension
  if (policy.deny_extensions && policy.deny_extensions.length > 0) {
    const ext = path.substring(path.lastIndexOf('.'));
    if (policy.deny_extensions.includes(ext)) {
      return {
        reason: `Denied: extension "${ext}" is not allowed`,
        flags: ['extension_denied'],
      };
    }
  }

  // Validate content size
  if (content && policy.max_size_bytes !== undefined) {
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > policy.max_size_bytes) {
      return {
        reason: `Denied: content size ${size} bytes exceeds max ${policy.max_size_bytes}`,
        flags: ['size_exceeded'],
      };
    }
  }

  return null;
}

function validateHttpRequest(
  args: Record<string, unknown>,
  policy: ToolPolicy
): Violation | null {
  const url = args.url as string | undefined;
  const method = args.method as string | undefined;

  if (!url) {
    return {
      reason: 'Denied: missing url argument',
      flags: ['missing_url'],
    };
  }

  // Parse URL and extract hostname
  let hostname: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
  } catch {
    return {
      reason: `Denied: invalid URL "${url}"`,
      flags: ['invalid_url'],
    };
  }

  // Validate method
  if (method && policy.allowed_methods && policy.allowed_methods.length > 0) {
    if (!policy.allowed_methods.includes(method.toUpperCase())) {
      return {
        reason: `Denied: method "${method}" not allowed`,
        flags: ['method_not_allowed'],
      };
    }
  }

  // Validate domain
  if (policy.deny_domains && policy.deny_domains.length > 0) {
    if (policy.deny_domains.includes(hostname)) {
      return {
        reason: `Denied: domain "${hostname}" is blocked`,
        flags: ['domain_denied'],
      };
    }
  }

  // Note: IP range validation happens at execution time after DNS resolution

  return null;
}
