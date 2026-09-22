import fs from 'fs';
import path from 'path';
import { pool } from './pool';

/**
 * Simple, robust forward-only SQL migration runner.
 * Migrations live in ./migrations as NNN_name.sql and are applied once, in order,
 * each inside its own transaction. Applied migrations are tracked in schema_migrations.
 */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<string[]> {
  const dir = path.join(__dirname, 'migrations');
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`Applied migration ${file}`);
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      log(`FAILED migration ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

if (require.main === module) {
  runMigrations()
    .then((n) => { console.log(`Migrations complete (${n.length} new)`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
