import { describe, it, expect, beforeEach, vi } from 'vitest';
import { episodes, episodeEntities, evidence, evidenceLinks } from '../../src/db/schema/index.js';

/**
 * memory.episode and memory.evidence each write a parent row plus link rows.
 * These tests pin the transactional wiring: both inserts run on the SAME
 * transaction handle, a link failure rolls the parent insert back, and the
 * response shapes are unchanged. Real Postgres rollback semantics are covered
 * in tests/integration/db-migrations.test.ts.
 */

type Row = Record<string, unknown>;
interface InsertOp {
  table: unknown;
  rows: Row[];
}

const state = {
  committed: [] as InsertOp[],
  rolledBack: false,
  /** Table object whose insert should reject (simulated FK violation). */
  failOnTable: null as unknown,
};

function makeInsertChain(result: Promise<Row[]>): {
  returning: () => Promise<Row[]>;
  then: (
    onFulfilled?: (value: Row[]) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise<unknown>;
} {
  return {
    returning: () => result,
    // Drizzle insert builders are thenables; episode/evidence await the link
    // insert without calling .returning().
    then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected),
  };
}

function makeTx(txOps: InsertOp[]): { insert: (table: unknown) => unknown } {
  return {
    insert(table: unknown) {
      return {
        values(vals: Row | Row[]) {
          const rows = Array.isArray(vals) ? vals : [vals];
          if (table === state.failOnTable) {
            return makeInsertChain(
              Promise.reject(new Error('insert violates foreign key constraint'))
            );
          }
          txOps.push({ table, rows });
          const returned = rows.map((r, i) => ({
            id: `00000000-0000-4000-8000-00000000000${i}`,
            ...r,
          }));
          return makeInsertChain(Promise.resolve(returned));
        },
      };
    },
  };
}

const fakeDb = {
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const txOps: InsertOp[] = [];
    try {
      const out = await fn(makeTx(txOps));
      state.committed.push(...txOps);
      return out;
    } catch (err) {
      state.rolledBack = true;
      throw err;
    }
  },
  insert() {
    // Any write outside db.transaction is a regression of the atomicity fix.
    throw new Error('memory write outside transaction');
  },
};

vi.mock('../../src/db/client.js', () => ({
  isDbAvailable: () => true,
  getDb: () => fakeDb,
}));

const { executeMemoryEpisode } = await import('../../src/tools/memory/episode.js');
const { executeMemoryEvidence } = await import('../../src/tools/memory/evidence.js');

const ENTITY_ID = '550e8400-e29b-41d4-a716-446655440000';

beforeEach(() => {
  state.committed = [];
  state.rolledBack = false;
  state.failOnTable = null;
});

describe('memory.episode transaction', () => {
  it('commits episode and links in one transaction, preserving response shape', async () => {
    const result = await executeMemoryEpisode({
      type: 'decision',
      summary: 'Test decision',
      entityIds: [ENTITY_ID],
      entityRoles: { [ENTITY_ID]: 'subject' },
    });

    expect(result.success).toBe(true);
    const output = result.output as { episode: Row; linkedEntities: number };
    expect(output.episode).toMatchObject({ type: 'decision', summary: 'Test decision' });
    expect(output.linkedEntities).toBe(1);

    expect(state.rolledBack).toBe(false);
    expect(state.committed.map((op) => op.table)).toEqual([episodes, episodeEntities]);
    expect(state.committed[1].rows[0]).toMatchObject({ entityId: ENTITY_ID, role: 'subject' });
  });

  it('rolls back the episode insert when the link insert fails', async () => {
    state.failOnTable = episodeEntities;

    const result = await executeMemoryEpisode({
      type: 'decision',
      summary: 'Doomed decision',
      entityIds: [ENTITY_ID],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('foreign key');
    expect(state.rolledBack).toBe(true);
    // Nothing committed — the episode row must not survive the failed link.
    expect(state.committed).toEqual([]);
  });

  it('commits an episode with no links', async () => {
    const result = await executeMemoryEpisode({ type: 'observation', summary: 'No links' });

    expect(result.success).toBe(true);
    expect((result.output as { linkedEntities: number }).linkedEntities).toBe(0);
    expect(state.committed.map((op) => op.table)).toEqual([episodes]);
  });
});

describe('memory.evidence transaction', () => {
  it('commits evidence and links in one transaction, preserving response shape', async () => {
    const result = await executeMemoryEvidence({
      type: 'url',
      reference: 'https://example.com',
      entityIds: [ENTITY_ID],
      episodeIds: ['550e8400-e29b-41d4-a716-446655440001'],
    });

    expect(result.success).toBe(true);
    const output = result.output as {
      evidence: Row;
      linkedEntities: number;
      linkedEpisodes: number;
    };
    expect(output.evidence).toMatchObject({ type: 'url', reference: 'https://example.com' });
    expect(output.linkedEntities).toBe(1);
    expect(output.linkedEpisodes).toBe(1);

    expect(state.committed.map((op) => op.table)).toEqual([evidence, evidenceLinks]);
    expect(state.committed[1].rows).toHaveLength(2);
  });

  it('rolls back the evidence insert when the link insert fails', async () => {
    state.failOnTable = evidenceLinks;

    const result = await executeMemoryEvidence({
      type: 'url',
      reference: 'https://example.com',
      entityIds: [ENTITY_ID],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('foreign key');
    expect(state.rolledBack).toBe(true);
    expect(state.committed).toEqual([]);
  });
});
