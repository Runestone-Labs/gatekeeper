import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateTestDb } from '../helpers/migrate-test-db.js';
import { BudgetMode, BudgetWindow } from '../../src/types.js';
import type { Actor, Policy } from '../../src/types.js';

/**
 * Postgres twin of budget-completeness.test.ts: the SQL summary must return
 * every (actor × role × tool × day) group when asked with `limit: null`, flag
 * capped results as truncated, and so keep hard budget ceilings binding past
 * 1,000 groups.
 *
 * Gated on TEST_DATABASE_URL — point it ONLY at a disposable database.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('budget enforcement counts every usage group (postgres sink)', () => {
  let pool: pg.Pool;
  // Unique role isolates this run's rows; cleanup deletes only them.
  const role = `budget-probe-${randomUUID().slice(0, 8)}`;
  const policy: Policy = {
    tools: { 'files.write': { decision: 'allow', cost_usd: 1 } },
    budgets: [
      {
        name: 'probe-cap',
        match: { actor_role: role },
        window: BudgetWindow.Day,
        mode: BudgetMode.Hard,
        max_usd: 10_000,
        max_calls: 1201,
      },
    ],
  };
  const nextCaller: Actor = { type: 'agent', name: 'agent-0', role };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await migrateTestDb(pool);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { initDb } = await import('../../src/db/client.js');
    initDb();

    // 1,201 completed calls, one per distinct actor name → 1,201 groups.
    await pool.query(
      `INSERT INTO audit_logs (timestamp, request_id, tool, decision, actor)
       SELECT now() - interval '1 minute', 'req-' || i, 'files.write', 'executed',
              jsonb_build_object('type', 'agent', 'name', 'agent-' || i, 'role', $1::text)
       FROM generate_series(0, 1200) AS i`,
      [role]
    );
  }, 60000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM audit_logs WHERE actor->>'role' = $1`, [role]);
    const { closeDb } = await import('../../src/db/client.js');
    await closeDb();
    await pool.end();
  });

  it('caps reporting queries and flags them truncated; limit: null returns every group', async () => {
    const { PostgresAuditSink } = await import('../../src/providers/postgres-audit.js');
    const sink = new PostgresAuditSink();
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 1000).toISOString();

    const capped = await sink.summarizeUsage({ since, until, actorRole: role, limit: 1000 });
    expect(capped.rows).toHaveLength(1000);
    expect(capped.truncated).toBe(true);

    const all = await sink.summarizeUsage({ since, until, actorRole: role, limit: null });
    expect(all.rows).toHaveLength(1201);
    expect(all.truncated).toBe(false);
  });

  it('denies call max_calls+1 when completed calls span more than 1,000 groups', async () => {
    const { PostgresAuditSink } = await import('../../src/providers/postgres-audit.js');
    const { checkBudget, computeBudgetStatus } = await import('../../src/budget/enforcer.js');
    const sink = new PostgresAuditSink();

    const status = await computeBudgetStatus(policy.budgets![0], nextCaller, policy, sink);
    expect(status?.currentCalls).toBe(1201);
    expect(status?.complete).toBe(true);

    const { denial } = await checkBudget('files.write', nextCaller, policy, sink);
    expect(denial?.reasonCode).toBe('BUDGET_EXCEEDED');
  });
});
