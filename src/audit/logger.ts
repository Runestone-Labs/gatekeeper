import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { AuditEntry } from '../types.js';
import { getPolicyHash } from '../policy/loadPolicy.js';

/**
 * Write an audit entry to the daily log file.
 * SECURITY: Append-only, never mutate existing entries.
 */
export function writeAuditLog(entry: Omit<AuditEntry, 'policyHash' | 'gatekeeperVersion'>): void {
  // Ensure audit directory exists
  if (!existsSync(config.auditDir)) {
    mkdirSync(config.auditDir, { recursive: true });
  }

  // Get today's date for the filename
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const logFile = join(config.auditDir, `${today}.jsonl`);

  // Build the full entry
  const fullEntry: AuditEntry = {
    ...entry,
    policyHash: getPolicyHash(),
    gatekeeperVersion: config.version,
  };

  // Append to log file (JSONL format)
  const line = JSON.stringify(fullEntry) + '\n';

  try {
    appendFileSync(logFile, line, 'utf-8');
  } catch (err) {
    // Log to stderr if we can't write to the audit log
    console.error('Failed to write audit log:', err);
    console.error('Entry:', fullEntry);
  }
}

/**
 * Log a tool request (initial request, before execution).
 */
export function logToolRequest(params: {
  requestId: string;
  tool: string;
  decision: 'allow' | 'approve' | 'deny';
  actor: AuditEntry['actor'];
  argsSummary: string;
  riskFlags: string[];
  approvalId?: string;
}): void {
  writeAuditLog({
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    tool: params.tool,
    decision: params.decision,
    actor: params.actor,
    argsSummary: params.argsSummary,
    riskFlags: params.riskFlags,
    approvalId: params.approvalId,
  });
}

/**
 * Log tool execution result (after tool runs).
 */
export function logToolExecution(params: {
  requestId: string;
  tool: string;
  actor: AuditEntry['actor'];
  argsSummary: string;
  resultSummary: string;
  riskFlags: string[];
  approvalId?: string;
}): void {
  writeAuditLog({
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    tool: params.tool,
    decision: 'executed',
    actor: params.actor,
    argsSummary: params.argsSummary,
    resultSummary: params.resultSummary,
    riskFlags: params.riskFlags,
    approvalId: params.approvalId,
  });
}

/**
 * Log approval consumption (approve or deny action).
 */
export function logApprovalConsumed(params: {
  requestId: string;
  tool: string;
  actor: AuditEntry['actor'];
  argsSummary: string;
  approvalId: string;
  action: 'approved' | 'denied';
  resultSummary?: string;
}): void {
  writeAuditLog({
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    tool: params.tool,
    decision: 'approval_consumed',
    actor: params.actor,
    argsSummary: params.argsSummary,
    resultSummary: params.resultSummary || `Approval ${params.action}`,
    riskFlags: [`action:${params.action}`],
    approvalId: params.approvalId,
  });
}
