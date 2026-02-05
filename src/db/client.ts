import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { config } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Initialize database connection pool with AGE extension support.
 *
 * CRITICAL: Uses pool.on('connect') to initialize EVERY connection with AGE.
 * This ensures both Drizzle SQL queries and Cypher queries use AGE-ready connections.
 * See: https://age.apache.org/age-manual/master/intro/setup.html
 */
export function initDb(): void {
  if (!config.databaseUrl) {
    console.log('DATABASE_URL not set - memory tools will be disabled');
    return;
  }

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // CRITICAL: Initialize EVERY connection with AGE extension
  // AGE requires LOAD 'age' and search_path to be set per-connection
  // This fires when a new physical connection is created in the pool
  //
  // IMPORTANT: search_path order matters!
  // - 'public' must come FIRST so Drizzle finds public.entities, not ag_catalog.entities
  // - 'ag_catalog' is needed for AGE Cypher functions
  pool.on('connect', (client) => {
    client
      .query("LOAD 'age'")
      .then(() => client.query('SET search_path = public, ag_catalog, "$user"'))
      .catch((err) => {
        console.error('Failed to initialize AGE on connection:', err);
      });
  });

  db = drizzle(pool, { schema });
  console.log('Database pool initialized with AGE extension');
}

/**
 * Get the Drizzle database client
 */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first or set DATABASE_URL.');
  }
  return db;
}

/**
 * Check if database is available
 */
export function isDbAvailable(): boolean {
  return db !== null;
}

/**
 * Execute a Cypher query against the AGE graph.
 *
 * Always runs LOAD 'age' and sets search_path before executing Cypher queries.
 * While pool.on('connect') also does this, it's async and may not complete
 * before the connection is first used. This ensures AGE is always ready.
 */
export async function ageQuery<T = unknown>(cypher: string): Promise<T[]> {
  if (!pool) {
    throw new Error('Database not initialized');
  }

  const client = await pool.connect();
  try {
    // Always ensure AGE is loaded for this connection
    await client.query("LOAD 'age'");
    await client.query('SET search_path = public, ag_catalog, "$user"');

    const result = await client.query(`
      SELECT * FROM cypher('memory_graph', $$
        ${cypher}
      $$) AS (result agtype)
    `);

    // Parse AGE results (agtype is JSON-like)
    return result.rows.map((row) => {
      try {
        const value = row.result;
        if (typeof value === 'string') {
          return JSON.parse(value);
        }
        return value;
      } catch {
        return row.result;
      }
    });
  } finally {
    client.release();
  }
}

/**
 * Execute a raw SQL query (for complex operations)
 */
export async function rawQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) {
    throw new Error('Database not initialized');
  }

  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Close database connections
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    console.log('Database connections closed');
  }
}

/**
 * Health check for database
 */
export async function checkDbHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!pool) {
    return { ok: false, error: 'Database not initialized' };
  }

  const start = Date.now();
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
