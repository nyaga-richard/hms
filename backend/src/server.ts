import { createApp } from './app';
import { env } from './config/env';
import { runMigrations } from './db/migrate';
import { pool } from './db/pool';
import { bootstrapPermissions } from './db/bootstrap';
import fs from 'fs';

async function main() {
  await runMigrations();
  await bootstrapPermissions();
  fs.mkdirSync(env.storagePath, { recursive: true });
  fs.mkdirSync(env.backupPath, { recursive: true });
  const app = createApp();
  const server = app.listen(env.port, '0.0.0.0', () => console.log(`HMS backend listening on :${env.port} (${env.nodeEnv})`));
  const shutdown = () => { server.close(() => pool.end().then(() => process.exit(0))); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
