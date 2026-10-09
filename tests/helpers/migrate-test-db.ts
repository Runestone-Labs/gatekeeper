import { join } from 'node:path';
import type pg from 'pg';

/**
 * Apply the drizzle migrations to a disposable test database. Vitest runs test
 * files in parallel, and two files migrating the same fresh database at once
 * collide on CREATE TYPE / CREATE TABLE, so serialize on an advisory lock; the
 * second caller then finds every migration already applied.
 */
export async function migrateTestDb(pool: pg.Pool): Promise<void> {
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    try {
      await migrate(drizzle(client), { migrationsFolder: join(process.cwd(), 'drizzle') });
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)');
    }
  } finally {
    client.release();
  }
}
