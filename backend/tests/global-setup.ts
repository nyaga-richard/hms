/**
 * Vitest global setup: rebuilds the TEST database from scratch (migrations + permission
 * bootstrap + demo seed) so every run starts from a known state.
 *
 * Safety: refuses to run against any database whose name does not contain "test".
 */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  const { env } = await import('../src/config/env');
  const dbName = new URL(env.databaseUrl).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to reset non-test database "${dbName}". Point DATABASE_URL_TEST at a database whose name contains "test".`);
  }
  const { pool } = await import('../src/db/pool');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  const { seed } = await import('../src/db/seed');
  await seed(() => undefined); // runs migrations + bootstrapPermissions + demo data
  await pool.end();
}
