import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool, withTransaction, DB } from '../../db/pool';
import { env } from '../../config/env';
import { Unauthorized, BadRequest, Forbidden } from '../../core/errors';
import { audit } from '../../core/audit';
import { AuthUser } from './auth.types';

const hashToken = (t: string) => crypto.createHash('sha256').update(t + env.jwtSecret).digest('hex');

export async function hashPassword(pw: string) { return bcrypt.hash(pw, env.bcryptRounds); }

export function validatePasswordStrength(pw: string) {
  if (pw.length < 8) throw new BadRequest('Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new BadRequest('Password must contain letters and numbers');
}

export async function loadAuthUser(userId: string, sessionId: string, db: DB = pool): Promise<AuthUser | null> {
  const u = (await db.query(`SELECT * FROM users WHERE id=$1`, [userId])).rows[0];
  if (!u || !u.is_active) return null;
  const roles = (await db.query(
    `SELECT r.id, r.code, r.name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1 ORDER BY r.name`, [userId])).rows;
  const perms = new Set<string>();
  if (u.is_superuser) {
    (await db.query(`SELECT code FROM permissions`)).rows.forEach((r) => perms.add(r.code));
  } else {
    const rp = await db.query(
      `SELECT DISTINCT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=$1`, [userId]);
    rp.rows.forEach((r) => perms.add(r.code));
    const up = await db.query(`SELECT p.code, up.effect FROM user_permissions up JOIN permissions p ON p.id=up.permission_id WHERE up.user_id=$1`, [userId]);
    for (const r of up.rows) { if (r.effect === 'ALLOW') perms.add(r.code); else perms.delete(r.code); }
  }
  const props = (await db.query(`SELECT property_id FROM user_properties WHERE user_id=$1`, [userId])).rows.map((r) => r.property_id);
  const limitRows = (await db.query(
    `SELECT limit_code, MAX(limit_value) AS v FROM authority_limits
      WHERE (subject_type='USER' AND subject_id=$1) OR (subject_type='ROLE' AND subject_id IN (SELECT role_id FROM user_roles WHERE user_id=$1))
      GROUP BY limit_code`, [userId])).rows;
  const limits: Record<string, number> = {};
  limitRows.forEach((r) => { limits[r.limit_code] = Number(r.v); });
  // user-level limit overrides role-level if present
  const userLimits = (await db.query(`SELECT limit_code, limit_value FROM authority_limits WHERE subject_type='USER' AND subject_id=$1`, [userId])).rows;
  userLimits.forEach((r) => { limits[r.limit_code] = Number(r.limit_value); });
  return {
    id: u.id, username: u.username, full_name: u.full_name, email: u.email, is_superuser: u.is_superuser,
    default_property_id: u.default_property_id, department_id: u.department_id, employee_id: u.employee_id,
    must_change_password: u.must_change_password, permissions: perms, roles, propertyIds: props, limits, sessionId,
  };
}

export async function login(username: string, password: string, meta: { ip?: string; userAgent?: string; deviceName?: string }) {
  const u = (await pool.query(`SELECT * FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)`, [username])).rows[0];
  const fail = async (reason: string, userId?: string) => {
    await pool.query(`INSERT INTO login_history (user_id, username_attempted, success, reason, ip_address, user_agent) VALUES ($1,$2,false,$3,$4,$5)`,
      [userId ?? null, username, reason, meta.ip ?? null, meta.userAgent ?? null]);
    if (userId) {
      await pool.query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
          locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END WHERE id=$1`,
        [userId, env.maxFailedLogins, String(env.lockoutMinutes)]);
    }
    throw new Unauthorized('Invalid username or password', 'INVALID_CREDENTIALS');
  };
  if (!u) return fail('USER_NOT_FOUND');
  if (!u.is_active) { await fail('USER_INACTIVE', u.id); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    await pool.query(`INSERT INTO login_history (user_id, username_attempted, success, reason, ip_address, user_agent) VALUES ($1,$2,false,'LOCKED',$3,$4)`, [u.id, username, meta.ip ?? null, meta.userAgent ?? null]);
    throw new Forbidden(`Account locked due to repeated failed logins. Try again after ${env.lockoutMinutes} minutes.`, 'ACCOUNT_LOCKED');
  }
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return fail('BAD_PASSWORD', u.id);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + env.sessionTtlMinutes * 60_000);
  const session = await withTransaction(async (client) => {
    const s = (await client.query(
      `INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, device_name, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [u.id, hashToken(token), meta.ip ?? null, meta.userAgent ?? null, meta.deviceName ?? null, expires])).rows[0];
    await client.query(`UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
    await client.query(`INSERT INTO login_history (user_id, username_attempted, success, ip_address, user_agent) VALUES ($1,$2,true,$3,$4)`, [u.id, username, meta.ip ?? null, meta.userAgent ?? null]);
    await audit({ userId: u.id, username: u.username, action: 'LOGIN', entityType: 'user', entityId: u.id, ip: meta.ip, userAgent: meta.userAgent }, client);
    return s;
  });
  const user = await loadAuthUser(u.id, session.id);
  return { token, expiresAt: expires, user: user! };
}

export async function authenticateToken(token: string): Promise<AuthUser | null> {
  const s = (await pool.query(
    `SELECT id, user_id, expires_at FROM user_sessions WHERE token_hash=$1 AND revoked_at IS NULL`, [hashToken(token)])).rows[0];
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) return null;
  // sliding expiry & last seen (throttled to at most once a minute)
  pool.query(`UPDATE user_sessions SET last_seen_at=now(), expires_at=GREATEST(expires_at, now() + ($2 || ' minutes')::interval) WHERE id=$1 AND last_seen_at < now() - interval '1 minute'`,
    [s.id, String(env.sessionTtlMinutes)]).catch(() => undefined);
  return loadAuthUser(s.user_id, s.id);
}

export async function logout(sessionId: string, user: AuthUser, meta: { ip?: string; userAgent?: string }) {
  await pool.query(`UPDATE user_sessions SET revoked_at=now() WHERE id=$1`, [sessionId]);
  await audit({ userId: user.id, username: user.username, action: 'LOGOUT', entityType: 'user', entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
}

export async function changePassword(userId: string, current: string, next: string) {
  const u = (await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [userId])).rows[0];
  if (!u || !(await bcrypt.compare(current, u.password_hash))) throw new BadRequest('Current password is incorrect');
  validatePasswordStrength(next);
  await pool.query(`UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now() WHERE id=$1`, [userId, await hashPassword(next)]);
}

export async function createPasswordReset(identifier: string): Promise<string | null> {
  const u = (await pool.query(`SELECT id FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)`, [identifier])).rows[0];
  if (!u) return null;
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [u.id, hashToken(token)]);
  return token; // in production this is emailed, never returned in the API response
}

export async function completePasswordReset(token: string, newPassword: string) {
  validatePasswordStrength(newPassword);
  const r = (await pool.query(`SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`, [hashToken(token)])).rows[0];
  if (!r) throw new BadRequest('Reset link is invalid or has expired');
  await withTransaction(async (c) => {
    await c.query(`UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), failed_login_count=0, locked_until=NULL WHERE id=$1`, [r.user_id, await hashPassword(newPassword)]);
    await c.query(`UPDATE password_resets SET used_at=now() WHERE id=$1`, [r.id]);
    await c.query(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [r.user_id]);
  });
}
