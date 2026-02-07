-- Add audit_logs table for PostgreSQL-backed audit storage
-- Stores policy decisions and tool execution records

CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"request_id" varchar(255) NOT NULL,
	"tool" varchar(100) NOT NULL,
	"decision" varchar(50) NOT NULL,
	"actor" jsonb NOT NULL,
	"args_summary" text,
	"args_hash" varchar(64),
	"result_summary" text,
	"execution_receipt" jsonb,
	"risk_flags" jsonb DEFAULT '[]'::jsonb,
	"reason_code" varchar(100),
	"human_explanation" text,
	"remediation" text,
	"policy_hash" varchar(100),
	"gatekeeper_version" varchar(50),
	"approval_id" varchar(255),
	"origin" varchar(50),
	"taint" jsonb DEFAULT '[]'::jsonb,
	"context_refs" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_timestamp_idx" ON "audit_logs"("timestamp" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_request_id_idx" ON "audit_logs"("request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_tool_idx" ON "audit_logs"("tool");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_decision_idx" ON "audit_logs"("decision");
