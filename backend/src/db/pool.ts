import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';

// DATE columns → 'YYYY-MM-DD' strings (no timezone shifting); NUMERIC → JS numbers for API ergonomics.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT (COUNT(*))
import { env } from '../config/env';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
});

export type DB = Pool | PoolClient;

export async function query<T extends QueryResultRow = any>(
  text: string,
  params: any[] = [],
  db: DB = pool,
): Promise<QueryResult<T>> {
  return db.query<T>(text, params);
}

export async function one<T extends QueryResultRow = any>(text: string, params: any[] = [], db: DB = pool): Promise<T | null> {
  const r = await db.query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function many<T extends QueryResultRow = any>(text: string, params: any[] = [], db: DB = pool): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}

/**
 * Run a function inside a database transaction. Rolls back on any thrown error.
 * All multi-step business operations MUST use this so that partially completed
 * financial/inventory transactions never persist.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
