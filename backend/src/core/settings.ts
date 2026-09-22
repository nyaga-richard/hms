import { DB, pool } from '../db/pool';

const cache = new Map<string, { value: any; at: number }>();
const TTL = 15_000;

export async function getSetting<T = any>(key: string, propertyId?: string | null, fallback?: T, db: DB = pool): Promise<T> {
  const ck = `${propertyId ?? 'global'}:${key}`;
  const c = cache.get(ck);
  if (c && Date.now() - c.at < TTL) return c.value as T;
  const r = await db.query(
    `SELECT value FROM settings WHERE key=$1 AND (property_id=$2 OR property_id IS NULL) ORDER BY property_id NULLS LAST LIMIT 1`,
    [key, propertyId ?? null],
  );
  const value = r.rows[0] ? r.rows[0].value : fallback;
  cache.set(ck, { value, at: Date.now() });
  return value as T;
}

export async function setSetting(key: string, value: any, propertyId: string | null, userId: string | null, db: DB = pool) {
  await db.query(
    `INSERT INTO settings (property_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (property_id, key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [propertyId, key, JSON.stringify(value), userId],
  );
  cache.clear();
}

export function clearSettingsCache() { cache.clear(); }
