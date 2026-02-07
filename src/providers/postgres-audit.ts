import { AuditEntry } from '../types.js';
import { AuditSink } from './types.js';
import { getDb, isDbAvailable } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

/**
 * PostgreSQL audit sink - writes audit entries to the audit_logs table.
 * Entries are append-only and never mutated.
 */
export class PostgresAuditSink implements AuditSink {
  name = 'postgres';

  async write(entry: AuditEntry): Promise<void> {
    if (!isDbAvailable()) {
      console.error('PostgresAuditSink: database not available, dropping audit entry');
      return;
    }

    try {
      const db = getDb();
      await db.insert(auditLogs).values({
        timestamp: new Date(entry.timestamp),
        requestId: entry.requestId,
        tool: entry.tool,
        decision: entry.decision,
        actor: entry.actor,
        argsSummary: typeof entry.argsSummary === 'string'
          ? entry.argsSummary
          : JSON.stringify(entry.argsSummary),
        argsHash: entry.argsHash,
        resultSummary: entry.resultSummary != null
          ? (typeof entry.resultSummary === 'string'
            ? entry.resultSummary
            : JSON.stringify(entry.resultSummary))
          : null,
        executionReceipt: entry.executionReceipt ?? null,
        riskFlags: entry.riskFlags ?? [],
        reasonCode: entry.reasonCode,
        humanExplanation: entry.humanExplanation,
        remediation: entry.remediation,
        policyHash: entry.policyHash,
        gatekeeperVersion: entry.gatekeeperVersion,
        approvalId: entry.approvalId,
        origin: entry.origin,
        taint: entry.taint ?? [],
        contextRefs: entry.contextRefs ?? [],
      });
    } catch (err) {
      console.error('Failed to write audit log to postgres:', err);
    }
  }

  async flush(): Promise<void> {
    // No buffering in the postgres implementation
  }
}
