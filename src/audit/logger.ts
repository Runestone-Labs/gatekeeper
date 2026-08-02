import { config } from '../config.js';
import {
  AuditEntry,
  Origin,
  ContextRef,
  ExecutionReceipt,
  ModelCallUsage,
  ToolResult,
} from '../types.js';
import { getAuditSink, getPolicySource } from '../providers/index.js';

/**
 * Rows returned by a tool execution, for the audit row's executionReceipt.
 * Generic across tools: counts a top-level array output, or an `output.data`
 * array/row (the shape every memory.query branch returns). Returns null where
 * "rows" doesn't apply (writes, failures, scalar outputs).
 */
export function countResultRows(result: ToolResult): number | null {
  if (!result.success) {
    return null;
  }
  const output = result.output;
  if (Array.isArray(output)) {
    return output.length;
  }
  if (output && typeof output === 'object' && 'data' in output) {
    const data = (output as { data: unknown }).data;
    if (Array.isArray(data)) {
      return data.length;
    }
    return data == null ? 0 : 1;
  }
  return null;
}

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
  // Model-call metering (Anthropic proxy). Optional; omitted for non-model tools.
  model?: string;
  usage?: ModelCallUsage;
  costUsd?: number | null;
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
    model: params.model,
    usage: params.usage,
    costUsd: params.costUsd,
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
