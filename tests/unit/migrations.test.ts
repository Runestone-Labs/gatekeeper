import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static integrity checks on the drizzle/ migration set. These run without a
 * database; actual apply-on-fresh-DB coverage lives in
 * tests/integration/db-migrations.test.ts (gated on TEST_DATABASE_URL).
 */

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

function readJournal(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf-8')) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

describe('migration set integrity', () => {
  it('journal entries and .sql files match one-to-one', () => {
    const entries = readJournal();
    const sqlFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();

    expect(entries.map((e) => e.tag).sort()).toEqual(sqlFiles);
    // idx must be sequential from 0 — the migrator applies in journal order.
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  it('0004 creates every phase-1 memory index and the episodes search_vector column', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0004_add_memory_indexes.sql'), 'utf-8');

    for (const indexName of [
      'entities_type_idx',
      'entities_type_lower_name_idx',
      'episodes_occurred_at_idx',
      'episodes_type_occurred_at_idx',
      'episodes_provenance_idx',
      'episodes_details_gin_idx',
      'episodes_search_idx',
    ]) {
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "${indexName}"`);
    }

    // The canon-name index is expression-based and must stay NON-unique until
    // the Phase-3 dedup lands.
    expect(sql).toContain('lower(btrim("name"))');
    expect(sql).not.toContain('CREATE UNIQUE INDEX');

    // Window-scan indexes are newest-first.
    expect(sql).toMatch(/"episodes_occurred_at_idx" ON "episodes" \("occurred_at" DESC\)/);
    expect(sql).toMatch(
      /"episodes_type_occurred_at_idx" ON "episodes" \("type","occurred_at" DESC\)/
    );

    // JSONB and tsvector indexes must be GIN, not the btree default.
    expect(sql).toMatch(/"episodes_details_gin_idx" ON "episodes" USING gin/);
    expect(sql).toMatch(/"episodes_search_idx" ON "episodes" USING gin/);

    // search_vector mirrors entities (0001): generated, stored, from summary.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "search_vector" tsvector/);
    expect(sql).toMatch(
      /GENERATED ALWAYS AS \(to_tsvector\('english', coalesce\("summary", ''\)\)\) STORED/
    );
  });

  it('0004 is idempotent (safe on both fresh and already-migrated databases)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0004_add_memory_indexes.sql'), 'utf-8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^\s*(--.*\n)*/g, '').trim())
      .filter((s) => s.length > 0);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(CREATE INDEX IF NOT EXISTS|ALTER TABLE .* ADD COLUMN IF NOT EXISTS)/s
      );
    }
  });

  it('every index declared in the drizzle schema exists in migration SQL', () => {
    // Second derivation of the index set: regex over the schema source vs the
    // migration files, sharing no code with drizzle-kit's snapshot diff.
    const schemaSource = readFileSync(join(process.cwd(), 'src/db/schema/memory.ts'), 'utf-8');
    const declared = [...schemaSource.matchAll(/index\('([^']+)'\)/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThanOrEqual(4);

    const allMigrationSql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
      .join('\n');

    for (const indexName of declared) {
      expect(allMigrationSql).toContain(`"${indexName}"`);
    }
  });
});
