import { DB, pool } from '../db/pool';

export interface AuditInput {
  userId?: string | null;
  username?: string | null;
  propertyId?: string | null;
  action: string; // CREATE UPDATE DELETE APPROVE REJECT CANCEL VOID REFUND DISCOUNT LOGIN LOGOUT PAYMENT STOCK_ADJUSTMENT JOURNAL_POST JOURNAL_REVERSE CHECKIN CHECKOUT ...
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function audit(input: AuditInput, db: DB = pool): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (user_id, username, property_id, action, entity_type, entity_id, old_value, new_value, reason, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.userId ?? null, input.username ?? null, input.propertyId ?? null, input.action, input.entityType,
      input.entityId ?? null, input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
      input.newValue === undefined ? null : JSON.stringify(input.newValue), input.reason ?? null, input.ip ?? null, input.userAgent ?? null,
    ],
  );
}

/** Build an audit context from an authenticated request */
export function auditCtx(req: any) {
  return {
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    propertyId: req.propertyId ?? req.user?.default_property_id ?? null,
    ip: (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? null,
    userAgent: (req.headers?.['user-agent'] as string) ?? null,
  };
}
