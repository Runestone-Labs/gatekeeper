import { basename, extname } from 'node:path';
import { Policy, PolicyEvaluation, ToolPolicy, Origin, ContextRef, Actor } from '../types.js';
import { canonicalize, isPathWithin, resolvePath } from '../utils.js';

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
      reasonCode: 'UNKNOWN_TOOL',
      humanExplanation: `The tool "${toolName}" is not registered in the policy.`,
      remediation: 'Check the tool name or update policy.yaml to include it.',
      riskFlags: ['unknown_tool'],
    };
  }

  const taint = collectTaint(envelope);

  // v1: Check taint-based restrictions FIRST (before regular policy)
  if (taint.length > 0) {
    const taintViolation = checkTaintRestrictions(toolName, args, taint);
    if (taintViolation) {
      return taintViolation;
    }
  }

  // v1: Check principal/role restrictions
  if (policy.principals) {
    if (!envelope?.actor?.role) {
      return {
        decision: 'deny',
        reason: 'Missing actor role for principal policy evaluation',
        reasonCode: 'MISSING_ACTOR_ROLE',
        humanExplanation:
          'This request is missing actor.role, which is required to apply principal policies.',
        remediation: 'Provide actor.role in the tool request.',
        riskFlags: ['missing_actor_role'],
      };
    }

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

  // Check for global deny patterns
  const globalPatternViolation = checkGlobalDenyPatterns(args, policy);
  if (globalPatternViolation) {
    return {
      decision: 'deny',
      reason: globalPatternViolation.reason,
      reasonCode: globalPatternViolation.reasonCode,
      humanExplanation: globalPatternViolation.humanExplanation,
      remediation: globalPatternViolation.remediation,
      riskFlags: globalPatternViolation.flags,
    };
  }

  // Check for tool-specific deny patterns
  const patternViolation = checkDenyPatterns(args, toolPolicy);
  if (patternViolation) {
    return {
      decision: 'deny',
      reason: patternViolation.reason,
      reasonCode: patternViolation.reasonCode,
      humanExplanation: patternViolation.humanExplanation,
      remediation: patternViolation.remediation,
      riskFlags: patternViolation.flags,
    };
  }

  // Tool-specific validation
  const toolValidation = validateToolArgs(toolName, args, toolPolicy);
  if (toolValidation) {
    return {
      decision: 'deny',
      reason: toolValidation.reason,
      reasonCode: toolValidation.reasonCode,
      humanExplanation: toolValidation.humanExplanation,
      remediation: toolValidation.remediation,
      riskFlags: toolValidation.flags,
    };
  }

  // Return the configured decision
  return {
    decision: toolPolicy.decision,
    reason:
      toolPolicy.decision === 'approve' ? 'Requires human approval' : `Policy allows ${toolName}`,
    reasonCode:
      toolPolicy.decision === 'approve' ? 'POLICY_APPROVAL_REQUIRED' : 'POLICY_ALLOW',
    humanExplanation:
      toolPolicy.decision === 'approve'
        ? `Policy requires human approval before running "${toolName}".`
        : `Policy allows "${toolName}".`,
    remediation:
      toolPolicy.decision === 'approve'
        ? 'Request approval from the user to proceed.'
        : undefined,
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
      reasonCode: 'TAINTED_EXEC_REQUIRES_APPROVAL',
      humanExplanation:
        'This request is tainted by external content, so shell commands require explicit approval.',
      remediation: 'Ask the user to approve this command.',
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
        reasonCode: 'TAINTED_WRITE_SYSTEM_PATH',
        humanExplanation:
          'Tainted requests cannot write to system paths like /etc or /usr without manual review.',
        remediation: 'Write to a safe, user-owned directory or request approval.',
        riskFlags: ['tainted_write', 'system_path', 'external_content'],
      };
    }
    // Non-system paths still require approval for external content
    return {
      decision: 'approve',
      reason: 'File write from external/untrusted content requires human approval',
      reasonCode: 'TAINTED_WRITE_REQUIRES_APPROVAL',
      humanExplanation:
        'This write originates from external content and needs user approval before proceeding.',
      remediation: 'Ask the user to approve this write.',
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
            reasonCode: 'TAINTED_REQUEST_INTERNAL',
            humanExplanation:
              'External content cannot access internal hosts or localhost to prevent SSRF.',
            remediation: 'Use a public endpoint or remove the tainted source.',
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
            reasonCode: 'PRINCIPAL_PATTERN_DENIED',
            humanExplanation: `Role "${role}" is blocked by a deny pattern.`,
            remediation: 'Remove the risky pattern or use an allowed role.',
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
      reasonCode: 'PRINCIPAL_APPROVAL_REQUIRED',
      humanExplanation: `Role "${role}" requires approval to run "${toolName}".`,
      remediation: 'Request approval from the user.',
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
      reasonCode: 'PRINCIPAL_TOOL_DENIED',
      humanExplanation: `Role "${role}" is not permitted to run "${toolName}".`,
      remediation: 'Use an allowed role or update the principal policy.',
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
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
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
          reasonCode: 'TOOL_DENY_PATTERN',
          humanExplanation: 'Request matches a deny pattern configured for this tool.',
          remediation: 'Remove the flagged content or request a policy change.',
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
 * Check args against global deny patterns.
 * SECURITY: Regex patterns are evaluated against the full canonicalized args.
 */
function checkGlobalDenyPatterns(args: Record<string, unknown>, policy: Policy): Violation | null {
  if (!policy.global_deny_patterns || policy.global_deny_patterns.length === 0) {
    return null;
  }

  const argsString = canonicalize(args);

  for (const pattern of policy.global_deny_patterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(argsString)) {
        return {
          reason: `Denied: matches global deny pattern "${pattern}"`,
          reasonCode: 'GLOBAL_DENY_PATTERN',
          humanExplanation: 'Request matches a global deny pattern in policy.',
          remediation: 'Remove the flagged content or update global policy.',
          flags: [`global_pattern_match:${pattern}`],
        };
      }
    } catch {
      console.warn(`Invalid global deny pattern: ${pattern}`);
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
  const command = args.command as string | undefined;

  if (policy.allowed_commands && policy.allowed_commands.length > 0) {
    if (!command) {
      return {
        reason: 'Denied: missing command argument',
        reasonCode: 'MISSING_COMMAND',
        humanExplanation: 'A command is required to execute shell.exec.',
        remediation: 'Provide a command string.',
        flags: ['missing_command'],
      };
    }

    const normalized = command.trim();

    if (!isSimpleCommand(normalized)) {
      return {
        reason: 'Denied: command must be a single allowed executable',
        reasonCode: 'COMMAND_NOT_SIMPLE',
        humanExplanation:
          'This policy only allows simple commands without shell operators or chaining.',
        remediation: 'Use a single command or request approval for a complex command.',
        flags: ['command_not_simple'],
      };
    }

    const base = extractCommandName(normalized);
    const allowed = policy.allowed_commands.some((allowedCommand) =>
      commandMatchesAllowlist(base, allowedCommand)
    );
    if (!allowed) {
      return {
        reason: `Denied: command "${base}" is not in allowed commands`,
        reasonCode: 'COMMAND_NOT_ALLOWED',
        humanExplanation: `The command "${base}" is not allowlisted in policy.`,
        remediation: 'Use an allowed command or update policy.allowed_commands.',
        flags: ['command_not_allowed'],
      };
    }
  }

  // Validate cwd against allowed prefixes
  if (cwd && policy.allowed_cwd_prefixes && policy.allowed_cwd_prefixes.length > 0) {
    const resolvedCwd = resolvePath(cwd);
    const allowed = policy.allowed_cwd_prefixes.some((prefix) => {
      const resolvedPrefix = resolvePath(prefix);
      return isPathWithin(resolvedCwd, resolvedPrefix);
    });
    if (!allowed) {
      return {
        reason: `Denied: cwd "${cwd}" not in allowed prefixes`,
        reasonCode: 'CWD_NOT_ALLOWED',
        humanExplanation: 'The working directory is outside the allowed prefixes.',
        remediation: 'Use a permitted working directory or update policy.',
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
        reasonCode: 'TIMEOUT_EXCEEDED',
        humanExplanation: 'Requested timeout exceeds the maximum allowed by policy.',
        remediation: 'Reduce the timeout or update policy.max_timeout_ms.',
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
      reasonCode: 'MISSING_PATH',
      humanExplanation: 'A file path is required for files.write.',
      remediation: 'Provide a valid file path.',
      flags: ['missing_path'],
    };
  }

  const resolvedPath = resolvePath(path);

  // Validate path against allowed paths
  if (policy.allowed_paths && policy.allowed_paths.length > 0) {
    const allowed = policy.allowed_paths.some((prefix) => {
      const resolvedPrefix = resolvePath(prefix);
      return isPathWithin(resolvedPath, resolvedPrefix);
    });
    if (!allowed) {
      return {
        reason: `Denied: path "${path}" not in allowed paths`,
        reasonCode: 'PATH_NOT_ALLOWED',
        humanExplanation: 'The target path is outside the allowed paths in policy.',
        remediation: 'Write to an allowed path or update policy.allowed_paths.',
        flags: ['path_not_allowed'],
      };
    }
  }

  // Validate extension
  if (policy.deny_extensions && policy.deny_extensions.length > 0) {
    const ext = extname(resolvedPath) || (basename(resolvedPath).startsWith('.') ? basename(resolvedPath) : '');
    if (policy.deny_extensions.includes(ext)) {
      return {
        reason: `Denied: extension "${ext}" is not allowed`,
        reasonCode: 'EXTENSION_DENIED',
        humanExplanation: 'This file extension is blocked by policy.',
        remediation: 'Use a permitted extension or update policy.deny_extensions.',
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
        reasonCode: 'SIZE_EXCEEDED',
        humanExplanation: 'The file content exceeds the maximum size allowed.',
        remediation: 'Reduce content size or update policy.max_size_bytes.',
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
      reasonCode: 'MISSING_URL',
      humanExplanation: 'A URL is required for http.request.',
      remediation: 'Provide a valid URL.',
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
      reasonCode: 'INVALID_URL',
      humanExplanation: 'The URL is not valid or could not be parsed.',
      remediation: 'Provide a valid, fully qualified URL.',
      flags: ['invalid_url'],
    };
  }

  // Validate method
  if (method && policy.allowed_methods && policy.allowed_methods.length > 0) {
    if (!policy.allowed_methods.includes(method.toUpperCase())) {
      return {
        reason: `Denied: method "${method}" not allowed`,
        reasonCode: 'METHOD_NOT_ALLOWED',
        humanExplanation: 'This HTTP method is not allowed by policy.',
        remediation: 'Use an allowed method or update policy.allowed_methods.',
        flags: ['method_not_allowed'],
      };
    }
  }

  // Validate allowlist for domains
  if (policy.allowed_domains && policy.allowed_domains.length > 0) {
    const allowed = policy.allowed_domains.some((domain) => matchesDomain(hostname, domain));
    if (!allowed) {
      return {
        reason: `Denied: domain "${hostname}" not in allowlist`,
        reasonCode: 'DOMAIN_NOT_ALLOWED',
        humanExplanation: 'The target domain is not in the allowlist.',
        remediation: 'Use an allowed domain or update policy.allowed_domains.',
        flags: ['domain_not_allowed'],
      };
    }
  }

  // Validate domain
  if (policy.deny_domains && policy.deny_domains.length > 0) {
    if (policy.deny_domains.some((domain) => matchesDomain(hostname, domain))) {
      return {
        reason: `Denied: domain "${hostname}" is blocked`,
        reasonCode: 'DOMAIN_DENIED',
        humanExplanation: 'The target domain is blocked by policy.',
        remediation: 'Use a different domain or update policy.deny_domains.',
        flags: ['domain_denied'],
      };
    }
  }

  // Note: IP range validation happens at execution time after DNS resolution

  return null;
}

function collectTaint(envelope?: EvaluationEnvelope): string[] {
  if (!envelope) return [];

  const taint = new Set<string>();

  if (envelope.taint) {
    for (const entry of envelope.taint) {
      taint.add(entry);
    }
  }

  if (envelope.contextRefs) {
    for (const ref of envelope.contextRefs) {
      if (ref.taint) {
        for (const entry of ref.taint) {
          taint.add(entry);
        }
      }
      if (ref.type === 'url') {
        taint.add('external');
      }
    }
  }

  if (envelope.origin === 'external_content') {
    taint.add('external');
  }

  return Array.from(taint);
}

function isSimpleCommand(command: string): boolean {
  // Disallow common shell operators and command chaining when allowlist is enforced.
  if (/[;&|`]/.test(command)) {
    return false;
  }
  if (command.includes('&&') || command.includes('||') || command.includes('$(')) {
    return false;
  }
  return true;
}

function extractCommandName(command: string): string {
  const match = command.trim().match(/^([A-Za-z0-9_./-]+)/);
  return match ? match[1] : command.trim();
}

function commandMatchesAllowlist(command: string, allowed: string): boolean {
  const normalizedCommand = command.toLowerCase();
  const normalizedAllowed = allowed.toLowerCase();

  if (normalizedCommand === normalizedAllowed) return true;
  if (normalizedCommand.endsWith(`/${normalizedAllowed}`)) return true;

  return false;
}

function matchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();

  if (normalizedDomain.startsWith('*.')) {
    const suffix = normalizedDomain.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost !== normalizedDomain.slice(2);
  }

  if (normalizedDomain.startsWith('.')) {
    const suffix = normalizedDomain;
    return normalizedHost === normalizedDomain.slice(1) || normalizedHost.endsWith(suffix);
  }

  return normalizedHost === normalizedDomain;
}
