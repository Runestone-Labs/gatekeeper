-- Add model-call metering columns to audit_logs (Anthropic proxy real-cost).
-- NOTE: drizzle-kit 0.21.4 emitted a full CREATE TABLE here because the repo's
-- 0001/0002 meta snapshots are absent, so it diffed against 0000 (pre-audit_logs).
-- The correct delta from the post-0002 state is the ALTER below; the 0003
-- snapshot already reflects the full 23-column schema, so subsequent generates
-- diff cleanly. Idempotent (IF NOT EXISTS) so it is safe on fresh and existing DBs.
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "model" varchar(100);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "usage" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "cost_usd" double precision;
