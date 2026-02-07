import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Audit logs: Policy decisions and tool executions
 */
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  requestId: varchar('request_id', { length: 255 }).notNull(),
  tool: varchar('tool', { length: 100 }).notNull(),
  decision: varchar('decision', { length: 50 }).notNull(),
  actor: jsonb('actor').notNull(),
  argsSummary: text('args_summary'),
  argsHash: varchar('args_hash', { length: 64 }),
  resultSummary: text('result_summary'),
  executionReceipt: jsonb('execution_receipt'),
  riskFlags: jsonb('risk_flags').default([]),
  reasonCode: varchar('reason_code', { length: 100 }),
  humanExplanation: text('human_explanation'),
  remediation: text('remediation'),
  policyHash: varchar('policy_hash', { length: 100 }),
  gatekeeperVersion: varchar('gatekeeper_version', { length: 50 }),
  approvalId: varchar('approval_id', { length: 255 }),
  origin: varchar('origin', { length: 50 }),
  taint: jsonb('taint').default([]),
  contextRefs: jsonb('context_refs').default([]),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
