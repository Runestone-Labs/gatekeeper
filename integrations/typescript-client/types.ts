/**
 * Runestone Gatekeeper TypeScript Client - Type Definitions
 */

export interface GatekeeperConfig {
  /** Base URL of the Gatekeeper server */
  baseUrl: string;
  /** Name of the agent making requests (used in audit logs) */
  agentName?: string;
  /** Role used for policy enforcement (required unless GATEKEEPER_ROLE is set) */
  agentRole?: string;
  /** Optional run ID for correlation */
  runId?: string;
}

export interface Actor {
  type: 'agent' | 'user';
  name: string;
  role: string;
  runId?: string;
}

export interface RequestContext {
  conversationId?: string;
  traceId?: string;
}

export type Decision = 'allow' | 'approve' | 'deny';

export type Origin = 'user_direct' | 'model_inferred' | 'external_content' | 'background_job';

export interface ContextRef {
  type: 'message' | 'url' | 'document' | 'memory_entity';
  id: string;
  taint?: string[];
}

export interface ExecutionReceipt {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  resourcesUsed?: Record<string, unknown>;
}

export interface ApprovalRequestDetails {
  approvalId: string;
  expiresAt: string;
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
  approveUrl?: string;
  denyUrl?: string;
}

export interface DenialDetails {
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
}

export interface GatekeeperResult<T = unknown> {
  decision: Decision;
  requestId: string;
  reasonCode?: string;
  humanExplanation?: string;
  remediation?: string;
  policyVersion?: string;
  idempotencyKey?: string;
  /** Present when decision is 'allow' */
  result?: T;
  success?: boolean;
  executionReceipt?: ExecutionReceipt;
  /** Present when decision is 'approve' */
  approvalId?: string;
  expiresAt?: string;
  approvalRequest?: ApprovalRequestDetails;
  /** Present when decision is 'deny' */
  error?: string;
  denial?: DenialDetails;
}

// Tool-specific argument types

export interface ShellExecArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  truncated: boolean;
  command?: string;
}

export interface FilesWriteArgs {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface FilesWriteResult {
  path: string;
  bytesWritten: number;
}

export interface HttpRequestArgs {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpRequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}
