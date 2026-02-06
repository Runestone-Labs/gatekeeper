import { config } from '../config.js';
import { AuditEntry, Origin, ContextRef, ExecutionReceipt } from '../types.js';
import { getAuditSink, getPolicySource } from '../providers/index.js';

/**
 * Write an audit entry via the configured audit sink.
 * SECURITY: Append-only, never mutate existing entries.
 */
export function writeAuditLog(entry: Omit<AuditEntry, 'policyHash' | 'gatekeeperVersion'>): void {
  const policySource = getPolicySource();
  const auditSink = getAuditSink();

  // Build the full entry
  const fullEntry: AuditEntry = {
    ...entry,
    policyHash: policySource.getHash(),
    gatekeeperVersion: config.version,
  };

  // Write via the audit sink (async but fire-and-forget)
  auditSink.write(fullEntry).catch((err) => {
    console.error('Failed to write audit log:', err);
    console.error('Entry:', fullEntry);
  });
}

/**
 * Log a tool request (initial request, before execution).
 * v1: Added origin, taint, contextRefs for envelope tracking.
 */
export function logToolRequest(params: {
  requestId: string;
  tool: string;
  decision: 'allow' | 'approve' | 'deny';
  actor: AuditEntry['actor'];
  argsSummary: string;
  argsHash?: string;
  riskFlags: string[];
  approvalId?: string;
  reasonCode?: string;
  humanExplanation?: string;
  remediation?: string;
  // v1 envelope fields
  origin?: Origin;
  taint?: string[];
  contextRefs?: ContextRef[];
}): void {
  writeAuditLog({
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    tool: params.tool,
    decision: params.decision,
    actor: params.actor,
    argsSummary: params.argsSummary,
    argsHash: params.argsHash,
    riskFlags: params.riskFlags,
    approvalId: params.approvalId,
    reasonCode: params.reasonCode,
    humanExplanation: params.humanExplanation,
    remediation: params.remediation,
    // v1 envelope fields
    origin: params.origin,
    taint: params.taint,
    contextRefs: params.contextRefs,
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
  argsHash?: string;
  resultSummary: string;
  executionReceipt?: ExecutionReceipt;
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
    argsHash: params.argsHash,
    resultSummary: params.resultSummary,
    executionReceipt: params.executionReceipt,
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
  argsHash?: string;
  approvalId: string;
  action: 'approved' | 'denied';
  resultSummary?: string;
  reasonCode?: string;
  humanExplanation?: string;
  remediation?: string;
}): void {
  writeAuditLog({
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    tool: params.tool,
    decision: 'approval_consumed',
    actor: params.actor,
    argsSummary: params.argsSummary,
    argsHash: params.argsHash,
    resultSummary: params.resultSummary || `Approval ${params.action}`,
    riskFlags: [`action:${params.action}`],
    approvalId: params.approvalId,
    reasonCode: params.reasonCode,
    humanExplanation: params.humanExplanation,
    remediation: params.remediation,
  });
}
