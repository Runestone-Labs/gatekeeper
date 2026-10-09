import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateTestDb } from '../helpers/migrate-test-db.js';

/**
 * Applies the full drizzle/ migration set to a REAL database and verifies the
 * phase-1 memory indexes plus true transaction rollback semantics.
 *
 * Gated on TEST_DATABASE_URL — point it ONLY at a disposable database
 * (CI service container or a throwaway local one), never at a live one.
 * Skipped when unset, so the default `vitest run` needs no database.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('migrations + transactions on a real database', () => {
  let pool: pg.Pool;
  // Provenance marker so cleanup only touches rows this run created.
  const marker = `phase1-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    // Same mechanism as scripts/migrate.ts, serialized across test files.
    await migrateTestDb(pool);

    // Boot the app's own db client against the test database so the memory
    // tools run their production code path.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { initDb } = await import('../../src/db/client.js');
    initDb();
  }, 60000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM episodes WHERE provenance = $1', [marker]);
    await pool.query('DELETE FROM entities WHERE provenance = $1', [marker]);
    const { closeDb } = await import('../../src/db/client.js');
    await closeDb();
    await pool.end();
  });

  it('applies every journal migration', async () => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('creates the phase-1 indexes with the right definitions', async () => {
    const { rows } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename IN ('entities', 'episodes')`
    );
    const defs = new Map<string, string>(
      rows.map((r: { indexname: string; indexdef: string }) => [r.indexname, r.indexdef])
    );

    expect(defs.get('entities_type_idx')).toContain('(type)');
    expect(defs.get('entities_type_lower_name_idx')).toContain('lower(btrim((name)::text))');
    expect(defs.get('entities_type_lower_name_idx')).not.toContain('UNIQUE');
    expect(defs.get('episodes_occurred_at_idx')).toContain('occurred_at DESC');
    expect(defs.get('episodes_type_occurred_at_idx')).toContain('occurred_at DESC');
    expect(defs.get('episodes_provenance_idx')).toContain('(provenance)');
    expect(defs.get('episodes_details_gin_idx')).toContain('USING gin (details)');
    expect(defs.get('episodes_search_idx')).toContain('USING gin (search_vector)');
  });

  it('adds episodes.search_vector as a stored generated tsvector', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_generated FROM information_schema.columns
       WHERE table_name = 'episodes' AND column_name = 'search_vector'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('tsvector');
    expect(rows[0].is_generated).toBe('ALWAYS');
  });

  it('rolls back the episode insert when a link violates the entity FK', async () => {
    const { executeMemoryEpisode } = await import('../../src/tools/memory/episode.js');

    const summary = `rollback probe ${marker}`;
    const result = await executeMemoryEpisode({
      type: 'decision',
      summary,
      provenance: marker,
      entityIds: [randomUUID()], // does not exist -> episode_entities FK violation
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/foreign key/i);

    // Second path: assert via a raw connection that no orphaned episode row
    // survived the failed link insert.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM episodes WHERE summary = $1',
      [summary]
    );
    expect(rows[0].n).toBe(0);
  });

  it('commits episode + link together and populates search_vector', async () => {
    const { executeMemoryUpsert } = await import('../../src/tools/memory/upsert.js');
    const { executeMemoryEpisode } = await import('../../src/tools/memory/episode.js');

    const upserted = await executeMemoryUpsert({
      type: 'project',
      name: `Phase1 Probe ${marker}`,
      provenance: marker,
    });
    expect(upserted.success).toBe(true);
    const entity = (upserted.output as { entity: { id: string } }).entity;

    const summary = `commit probe ${marker}`;
    const result = await executeMemoryEpisode({
      type: 'event',
      summary,
      provenance: marker,
      entityIds: [entity.id],
    });

    expect(result.success).toBe(true);
    const output = result.output as { episode: { id: string }; linkedEntities: number };
    expect(output.linkedEntities).toBe(1);

    const episodeRow = await pool.query(
      'SELECT search_vector IS NOT NULL AS has_vector FROM episodes WHERE id = $1',
      [output.episode.id]
    );
    expect(episodeRow.rows[0].has_vector).toBe(true);

    const linkRow = await pool.query(
      'SELECT count(*)::int AS n FROM episode_entities WHERE episode_id = $1 AND entity_id = $2',
      [output.episode.id, entity.id]
    );
    expect(linkRow.rows[0].n).toBe(1);
  });
});
