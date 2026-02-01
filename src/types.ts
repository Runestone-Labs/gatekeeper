// Actor represents who is making the tool request
export interface Actor {
  type: 'agent' | 'user';
  name: string;
  runId?: string;
}

// Request context for tracing
export interface RequestContext {
  conversationId?: string;
  traceId?: string;
}

// Tool request body
export interface ToolRequest {
  requestId: string;
  actor: Actor;
  args: Record<string, unknown>;
  context?: RequestContext;
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
  resultSummary?: string;
  riskFlags: string[];
  policyHash: string;
  gatekeeperVersion: string;
  approvalId?: string;
}

// Tool policy configuration
export interface ToolPolicy {
  decision: Decision;
  deny_patterns?: string[];
  allowed_cwd_prefixes?: string[];
  max_output_bytes?: number;
  max_timeout_ms?: number;
  allowed_paths?: string[];
  deny_extensions?: string[];
  max_size_bytes?: number;
  allowed_methods?: string[];
  deny_domains?: string[];
  deny_ip_ranges?: string[];
  timeout_ms?: number;
  max_body_bytes?: number;
}

// Full policy structure
export interface Policy {
  tools: Record<string, ToolPolicy>;
}
