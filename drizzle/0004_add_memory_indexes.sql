-- Phase-1 memory-v2 indexes. Before this, entities had only its PK + the
-- search_vector GIN (0001) and episodes had ONLY its PK — entity-by-name and
-- episode window scans were seq scans on every memory.query call.
--
-- The first four statements are drizzle-kit generated from the schema (order
-- hand-tightened to DESC — window scans are newest-first; snapshots ignore
-- column order so generate still diffs clean). The rest are hand-authored,
-- following the 0001_add_search_vector precedent, because drizzle-kit 0.21
-- can't express expression indexes, GIN, or generated columns.
CREATE INDEX IF NOT EXISTS "entities_type_idx" ON "entities" ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_occurred_at_idx" ON "episodes" ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_type_occurred_at_idx" ON "episodes" ("type","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_provenance_idx" ON "episodes" ("provenance");--> statement-breakpoint
-- Canonical-name lookup path. Deliberately NON-unique: existing rows may hold
-- duplicates; the unique canon constraint lands in Phase 3 after dedup.
CREATE INDEX IF NOT EXISTS "entities_type_lower_name_idx" ON "entities" ("type", lower(btrim("name")));--> statement-breakpoint
-- JSONB containment (details @> …) used by memory.query detailsContain.
CREATE INDEX IF NOT EXISTS "episodes_details_gin_idx" ON "episodes" USING gin ("details");--> statement-breakpoint
-- Full-text search over episode summaries, mirroring entities.search_vector
-- (0001). Dormant until the Phase-4 retrieval work queries it.
ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("summary", ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_search_idx" ON "episodes" USING gin ("search_vector");
