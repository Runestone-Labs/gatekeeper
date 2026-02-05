import { Policy, PolicyEvaluation, ToolPolicy, Origin, ContextRef, Actor } from '../types.js';
import { canonicalize } from '../utils.js';

/**
 * v1 envelope subset for evaluation.
 * All new fields are optional for backwards compatibility.
 */
export interface EvaluationEnvelope {
  requestId: string;
  actor: Actor;
  args: Record<string, unknown>;
  origin?: Origin;
  taint?: string[];
  contextRefs?: ContextRef[];
}

/**
 * Evaluate a tool request against policy.
 * Returns the decision and a human-readable reason.
 *
 * SECURITY: This is the core enforcement point. All decisions must be auditable.
 *
 * v1: Added envelope parameter for taint-aware evaluation.
 */
export function evaluateTool(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy,
  envelope?: EvaluationEnvelope
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

  // v1: Check taint-based restrictions FIRST (before regular policy)
  if (envelope?.taint && envelope.taint.length > 0) {
    const taintViolation = checkTaintRestrictions(toolName, args, envelope.taint);
    if (taintViolation) {
      return taintViolation;
    }
  }

  // v1: Check principal/role restrictions
  if (envelope?.actor?.role && policy.principals) {
    const principalViolation = checkPrincipalRestrictions(
      toolName,
      args,
      envelope.actor.role,
      policy.principals
    );
    if (principalViolation) {
      return principalViolation;
    }
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
    reason:
      toolPolicy.decision === 'approve' ? 'Requires human approval' : `Policy allows ${toolName}`,
    riskFlags: [],
  };
}

/**
 * v1: Check taint-based restrictions.
 * External/untrusted content has stricter rules.
 *
 * SECURITY: Taint tracking prevents prompt injection attacks from
 * triggering dangerous operations via model inference.
 */
function checkTaintRestrictions(
  toolName: string,
  args: Record<string, unknown>,
  taint: string[]
): PolicyEvaluation | null {
  const isExternal = taint.includes('external') || taint.includes('untrusted');

  if (!isExternal) {
    return null;
  }

  // External content cannot execute shell commands without approval
  if (toolName === 'shell.exec') {
    return {
      decision: 'approve',
      reason: 'Shell execution from external/untrusted content requires human approval',
      riskFlags: ['tainted_exec', 'external_content'],
    };
  }

  // External content cannot write to system paths
  if (toolName === 'files.write') {
    const path = args.path as string | undefined;
    if (path && isSystemPath(path)) {
      return {
        decision: 'deny',
        reason: `External content cannot write to system path: ${path}`,
        riskFlags: ['tainted_write', 'system_path', 'external_content'],
      };
    }
    // Non-system paths still require approval for external content
    return {
      decision: 'approve',
      reason: 'File write from external/untrusted content requires human approval',
      riskFlags: ['tainted_write', 'external_content'],
    };
  }

  // External content HTTP requests to internal IPs require approval
  if (toolName === 'http.request') {
    const url = args.url as string | undefined;
    if (url) {
      try {
        const parsed = new URL(url);
        if (isInternalHost(parsed.hostname)) {
          return {
            decision: 'deny',
            reason: `External content cannot access internal host: ${parsed.hostname}`,
            riskFlags: ['tainted_request', 'internal_host', 'external_content'],
          };
        }
      } catch {
        // Invalid URL - will be caught by regular validation
      }
    }
  }

  return null;
}

/**
 * v1: Check principal/role restrictions.
 * Different roles have different allowed tools and approval requirements.
 *
 * Evaluation order:
 * 1. Check deny patterns (always checked first)
 * 2. Check if tool requires approval for this principal
 * 3. Check if tool is in allowedTools (empty = all allowed)
 */
function checkPrincipalRestrictions(
  toolName: string,
  args: Record<string, unknown>,
  role: string,
  principals: Record<string, import('../types.js').PrincipalPolicy>
): PolicyEvaluation | null {
  const principalPolicy = principals[role];

  // Unknown role - use default behavior
  if (!principalPolicy) {
    return null;
  }

  // 1. Check principal-specific deny patterns FIRST
  if (principalPolicy.denyPatterns && principalPolicy.denyPatterns.length > 0) {
    const argsString = canonicalize(args);
    for (const pattern of principalPolicy.denyPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(argsString)) {
          return {
            decision: 'deny',
            reason: `Denied for role ${role}: matches pattern "${pattern}"`,
            riskFlags: ['principal_pattern_match', `role:${role}`],
          };
        }
      } catch {
        // Invalid regex - skip
      }
    }
  }

  // 2. Check if tool requires approval for this principal
  // This takes precedence over allowedTools check
  if (principalPolicy.requireApproval && principalPolicy.requireApproval.includes(toolName)) {
    return {
      decision: 'approve',
      reason: `Tool ${toolName} requires approval for role ${role}`,
      riskFlags: ['principal_approval', `role:${role}`],
    };
  }

  // 3. Check if tool is allowed for this principal
  // Empty allowedTools means all tools are allowed (uses tool-level policy)
  if (
    principalPolicy.allowedTools &&
    principalPolicy.allowedTools.length > 0 &&
    !principalPolicy.allowedTools.includes(toolName)
  ) {
    return {
      decision: 'deny',
      reason: `Tool ${toolName} is not allowed for role ${role}`,
      riskFlags: ['principal_denied', `role:${role}`],
    };
  }

  return null;
}

/**
 * Check if a path is a system path.
 */
function isSystemPath(path: string): boolean {
  const systemPrefixes = [
    '/etc/',
    '/usr/',
    '/bin/',
    '/sbin/',
    '/lib/',
    '/var/',
    '/root/',
    '/boot/',
    '/sys/',
    '/proc/',
    '/dev/',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\System32',
  ];
  return systemPrefixes.some((prefix) => path.startsWith(prefix) || path.toLowerCase().startsWith(prefix.toLowerCase()));
}

/**
 * Check if a hostname is internal/private.
 */
function isInternalHost(hostname: string): boolean {
  const internalPatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^169\.254\./, // Link-local / AWS metadata
    /^::1$/,
    /^fe80:/i,
    /\.local$/i,
    /\.internal$/i,
  ];
  return internalPatterns.some((pattern) => pattern.test(hostname));
}

interface Violation {
  reason: string;
  flags: string[];
}

/**
 * Check args against deny patterns.
 * SECURITY: Regex patterns are evaluated against the full canonicalized args.
 */
function checkDenyPatterns(args: Record<string, unknown>, policy: ToolPolicy): Violation | null {
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

function validateShellExec(args: Record<string, unknown>, policy: ToolPolicy): Violation | null {
  const cwd = args.cwd as string | undefined;

  // Validate cwd against allowed prefixes
  if (cwd && policy.allowed_cwd_prefixes && policy.allowed_cwd_prefixes.length > 0) {
    const allowed = policy.allowed_cwd_prefixes.some((prefix) => cwd.startsWith(prefix));
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

function validateFilesWrite(args: Record<string, unknown>, policy: ToolPolicy): Violation | null {
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
    const allowed = policy.allowed_paths.some((prefix) => path.startsWith(prefix));
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

function validateHttpRequest(args: Record<string, unknown>, policy: ToolPolicy): Violation | null {
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
