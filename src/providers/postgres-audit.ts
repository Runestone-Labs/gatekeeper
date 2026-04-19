import { sql } from 'drizzle-orm';
import { AuditEntry, UsageFilter, UsageRow, UsageSummary } from '../types.js';
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
        argsSummary:
          typeof entry.argsSummary === 'string'
            ? entry.argsSummary
            : JSON.stringify(entry.argsSummary),
        argsHash: entry.argsHash,
        resultSummary:
          entry.resultSummary != null
            ? typeof entry.resultSummary === 'string'
              ? entry.resultSummary
              : JSON.stringify(entry.resultSummary)
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

  /**
   * Aggregate call counts and duration sums grouped by (actor, tool, day).
   * Runs as a single SQL query with JSONB accessors for the actor fields.
   */
  async summarizeUsage(filter: UsageFilter): Promise<UsageSummary> {
    if (!isDbAvailable()) {
      throw new Error('database not available');
    }

    const db = getDb();
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));

    // Build WHERE fragments. Use bound parameters via drizzle's sql template.
    const wheres = [];
    if (filter.since) wheres.push(sql`${auditLogs.timestamp} >= ${new Date(filter.since)}`);
    if (filter.until) wheres.push(sql`${auditLogs.timestamp} < ${new Date(filter.until)}`);
    if (filter.tool) wheres.push(sql`${auditLogs.tool} = ${filter.tool}`);
    if (filter.actorName) wheres.push(sql`${auditLogs.actor}->>'name' = ${filter.actorName}`);
    if (filter.actorRole) wheres.push(sql`${auditLogs.actor}->>'role' = ${filter.actorRole}`);

    // drizzle's sql.join uses a separator; build clause manually
    let whereClause = sql``;
    if (wheres.length > 0) {
      whereClause = sql`WHERE ${wheres[0]}`;
      for (let i = 1; i < wheres.length; i++) {
        whereClause = sql`${whereClause} AND ${wheres[i]}`;
      }
    }

    type UsageQueryRow = {
      actor_name: string | null;
      actor_role: string | null;
      tool: string;
      day: string;
      call_count: string; // COUNT(*) returns bigint → string in pg driver
      total_duration_ms: string | null;
      decisions: Array<{ decision: string; n: string }>;
    };
    const queryResult = await db.execute<UsageQueryRow>(sql`
      SELECT
        ${auditLogs.actor}->>'name' AS actor_name,
        ${auditLogs.actor}->>'role' AS actor_role,
        ${auditLogs.tool} AS tool,
        TO_CHAR(${auditLogs.timestamp} AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COUNT(*) AS call_count,
        SUM(
          COALESCE(
            CAST(NULLIF(${auditLogs.executionReceipt}->>'durationMs', '') AS BIGINT),
            0
          )
        ) AS total_duration_ms,
        jsonb_agg(jsonb_build_object('decision', ${auditLogs.decision}, 'n', 1)) AS decisions
      FROM ${auditLogs}
      ${whereClause}
      GROUP BY actor_name, actor_role, ${auditLogs.tool}, day
      ORDER BY call_count DESC, day DESC
      LIMIT ${limit}
    `);

    // Drizzle returns pg QueryResult; rows live on .rows
    const resultRows: UsageQueryRow[] = queryResult.rows;

    const out: UsageRow[] = resultRows.map((r) => {
      const decisionCounts: Record<string, number> = {};
      for (const d of r.decisions ?? []) {
        decisionCounts[d.decision] = (decisionCounts[d.decision] ?? 0) + Number(d.n);
      }
      return {
        actorName: r.actor_name,
        actorRole: r.actor_role,
        tool: r.tool,
        day: r.day,
        callCount: Number(r.call_count),
        totalDurationMs: r.total_duration_ms == null ? null : Number(r.total_duration_ms),
        decisions: decisionCounts,
      };
    });

    const distinctActors = new Set(out.map((r) => `${r.actorName ?? ''}:${r.actorRole ?? ''}`))
      .size;
    const distinctTools = new Set(out.map((r) => r.tool)).size;
    const totalCalls = out.reduce((sum, r) => sum + r.callCount, 0);

    return {
      rows: out,
      totalCalls,
      distinctActors,
      distinctTools,
      filter,
      generatedAt: new Date().toISOString(),
    };
  }
}
