/**
 * Runestone Gatekeeper TypeScript Client - Type Definitions
 */

export interface GatekeeperConfig {
  /** Base URL of the Gatekeeper server */
  baseUrl: string;
  /** Name of the agent making requests (used in audit logs) */
  agentName?: string;
  /** Optional run ID for correlation */
  runId?: string;
}

export interface Actor {
  type: 'agent' | 'user';
  name: string;
  runId?: string;
}

export interface RequestContext {
  conversationId?: string;
  traceId?: string;
}

export type Decision = 'allow' | 'approve' | 'deny';

export interface GatekeeperResult<T = unknown> {
  decision: Decision;
  requestId: string;
  reason?: string;
  /** Present when decision is 'allow' */
  result?: T;
  success?: boolean;
  /** Present when decision is 'approve' */
  approvalId?: string;
  expiresAt?: string;
  /** Present when decision is 'deny' */
  error?: string;
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
