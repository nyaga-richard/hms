import { DB, pool } from '../db/pool';

export interface NotifyInput {
  userIds?: string[];
  permission?: string; // notify all active users holding this permission (optionally within property)
  roleCodes?: string[];
  propertyId?: string | null;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  link?: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL' | 'SUCCESS';
}

/** Create in-app notifications (email/push dispatch hooks can be layered on the notifications table). */
export async function notify(input: NotifyInput, db: DB = pool): Promise<number> {
  const targets = new Set<string>(input.userIds ?? []);
  if (input.permission) {
    const r = await db.query(
      `SELECT DISTINCT u.id FROM users u
        WHERE u.is_active AND (
          u.is_superuser OR EXISTS (
            SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id
            WHERE ur.user_id=u.id AND p.code=$1)
          OR EXISTS (SELECT 1 FROM user_permissions up JOIN permissions p ON p.id=up.permission_id WHERE up.user_id=u.id AND p.code=$1 AND up.effect='ALLOW'))
        AND ($2::uuid IS NULL OR u.is_superuser OR EXISTS (SELECT 1 FROM user_properties upr WHERE upr.user_id=u.id AND upr.property_id=$2) OR NOT EXISTS (SELECT 1 FROM user_properties upr WHERE upr.user_id=u.id))`,
      [input.permission, input.propertyId ?? null],
    );
    r.rows.forEach((x) => targets.add(x.id));
  }
  if (input.roleCodes?.length) {
    const r = await db.query(
      `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE r.code = ANY($1) AND u.is_active`,
      [input.roleCodes],
    );
    r.rows.forEach((x) => targets.add(x.user_id));
  }
  if (!targets.size) return 0;
  const ids = [...targets];
  await db.query(
    `INSERT INTO notifications (user_id, property_id, type, title, body, entity_type, entity_id, link, severity)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5, $6, $7, $8, $9`,
    [ids, input.propertyId ?? null, input.type, input.title, input.body ?? null, input.entityType ?? null, input.entityId ?? null, input.link ?? null, input.severity ?? 'INFO'],
  );
  return ids.length;
}
