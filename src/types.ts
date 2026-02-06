// Actor represents who is making the tool request
export interface Actor {
  type: 'agent' | 'user';
  name: string;
  role: string; // v1: explicit role (e.g., 'navigator', 'sentinel')
  runId?: string;
}

// Request context for tracing
export interface RequestContext {
  conversationId?: string;
  traceId?: string;
}

// v1: Origin types - where did this request come from
export type Origin =
  | 'user_direct' // User explicitly requested this
  | 'model_inferred' // Model decided to do this
  | 'external_content' // Triggered by external content (URL, email, etc.)
  | 'background_job'; // Triggered by scheduled/background task

// v1: Context reference - what triggered this call
export interface ContextRef {
  type: 'message' | 'url' | 'document' | 'memory_entity';
  id: string;
  taint?: string[];
}

// Tool request body (v1 envelope)
export interface ToolRequest {
  requestId: string;
  actor: Actor;
  args: Record<string, unknown>;
  context?: RequestContext;

  // v1 envelope fields (all optional for backwards compatibility)
  origin?: Origin;
  taint?: string[]; // e.g., ['external', 'email', 'untrusted']
  contextRefs?: ContextRef[];
  idempotencyKey?: string; // for safe retries
  dryRun?: boolean; // preview without execution
  capabilityToken?: string; // pre-authorized capability
  timestamp?: string; // ISO 8601
}

// Tool execution result
export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

// Policy decision types
export type Decision = 'allow' | 'approve' | 'deny';

// Policy evaluation result
export interface PolicyEvaluation {
  decision: Decision;
  reason: string;
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
  riskFlags: string[];
}

// Pending approval status
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

// Pending approval record
export interface PendingApproval {
  id: string;
  status: ApprovalStatus;
  toolName: string;
  args: Record<string, unknown>;
  canonicalArgs: string;
  actor: Actor;
  context?: RequestContext;
  requestId: string;
  idempotencyKey?: string;
  createdAt: string;
  expiresAt: string;
}

// Audit log entry
export interface AuditEntry {
  timestamp: string;
  requestId: string;
  tool: string;
  decision: Decision | 'executed' | 'approval_consumed';
  actor: Actor;
  argsSummary: string;
  argsHash?: string;
  resultSummary?: string;
  executionReceipt?: ExecutionReceipt;
  riskFlags: string[];
  reasonCode?: string;
  humanExplanation?: string;
  remediation?: string;
  policyHash: string;
  gatekeeperVersion: string;
  approvalId?: string;

  // v1 envelope fields for audit
  origin?: Origin;
  taint?: string[];
  contextRefs?: ContextRef[];
}

// Tool policy configuration
export interface ToolPolicy {
  decision: Decision;
  deny_patterns?: string[];
  allowed_commands?: string[];
  allowed_cwd_prefixes?: string[];
  max_output_bytes?: number;
  max_timeout_ms?: number;
  allowed_paths?: string[];
  deny_extensions?: string[];
  max_size_bytes?: number;
  allowed_methods?: string[];
  allowed_domains?: string[];
  deny_domains?: string[];
  deny_ip_ranges?: string[];
  timeout_ms?: number;
  max_body_bytes?: number;
  max_redirects?: number;
  sandbox_command_prefix?: string[];
  run_as_uid?: number;
  run_as_gid?: number;
  env_allowlist?: string[];
  env_overrides?: Record<string, string>;
}

// Full policy structure
export interface Policy {
  tools: Record<string, ToolPolicy>;
  principals?: Record<string, PrincipalPolicy>; // v1: role-based policies
  global_deny_patterns?: string[];
}

// v1: Alert budget configuration
export interface AlertBudget {
  maxPerHour: number;
  severityThreshold: 'low' | 'medium' | 'high';
  channels?: string[]; // e.g., ['sms', 'discord', 'email']
}

// v1: Principal/role policy configuration
export interface PrincipalPolicy {
  allowedTools: string[];
  denyPatterns?: string[];
  requireApproval?: string[];
  alertBudget?: AlertBudget;
}

// v1: Execution receipt for successful tool calls
export interface ExecutionReceipt {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  resourcesUsed?: Record<string, unknown>;
}

// v1: Approval request details
export interface ApprovalRequestDetails {
  approvalId: string;
  expiresAt: string;
  reasonCode: string;
  humanExplanation: string;
  diffView?: string;
  approveUrl?: string;
  denyUrl?: string;
}

// v1: Denial details
export interface DenialDetails {
  reasonCode: string; // Machine-readable: 'BLOCKED_PATTERN', 'SSRF_DETECTED', 'TAINTED_EXEC'
  humanExplanation: string;
  remediation?: string;
}

// v1: Full tool call response
export interface ToolCallResponse {
  requestId: string;
  decision: Decision;
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;

  // On Allow
  result?: unknown;
  executionReceipt?: ExecutionReceipt;

  // On Approve (pending)
  approvalRequest?: ApprovalRequestDetails;

  // On Deny
  denial?: DenialDetails;

  // Always present
  auditId?: string;
  policyVersion: string;
}
