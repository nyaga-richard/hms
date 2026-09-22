import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, getPagination, paged, optionalStr } from '../../core/http';
import { requirePermission } from '../../middleware/auth';
import { NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { hashPassword, validatePasswordStrength } from '../auth/auth.service';
import { PERMISSIONS } from '../../core/permissions';

export const usersRouter = Router();
export const rolesRouter = Router();
export const permissionsRouter = Router();

const userSelect = `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.is_active, u.is_superuser, u.must_change_password, u.last_login_at, u.created_at,
  u.department_id, u.default_property_id, u.employee_id, d.name AS department_name, p.name AS default_property_name,
  COALESCE((SELECT json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name)) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id), '[]') AS roles,
  COALESCE((SELECT json_agg(up.property_id) FROM user_properties up WHERE up.user_id=u.id), '[]') AS property_ids
  FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN properties p ON p.id=u.default_property_id`;

usersRouter.get('/', requirePermission('users.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'created_at');
  const params: any[] = [];
  const where: string[] = [];
  if (p.search) { params.push(`%${p.search}%`); where.push(`(u.username ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (req.query.active !== undefined && req.query.active !== '') { params.push(req.query.active === 'true'); where.push(`u.is_active=$${params.length}`); }
  if (req.query.roleId) { params.push(req.query.roleId); where.push(`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id=$${params.length})`); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = Number((await pool.query(`SELECT COUNT(*) FROM users u${w}`, params)).rows[0].count);
  const sort = ['username', 'full_name', 'email', 'created_at', 'last_login_at'].includes(p.sort!) ? p.sort : 'created_at';
  const rows = (await pool.query(`${userSelect}${w} ORDER BY u.${sort} ${p.order} LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  res.json(paged(rows, total, p));
}));

usersRouter.get('/:id', requirePermission('users.view'), asyncHandler(async (req, res) => {
  const row = (await pool.query(`${userSelect} WHERE u.id=$1`, [req.params.id])).rows[0];
  if (!row) throw new NotFound('User not found');
  const perms = (await pool.query(`SELECT p.code, up.effect FROM user_permissions up JOIN permissions p ON p.id=up.permission_id WHERE up.user_id=$1`, [req.params.id])).rows;
  const limits = (await pool.query(`SELECT limit_code, limit_value FROM authority_limits WHERE subject_type='USER' AND subject_id=$1`, [req.params.id])).rows;
  const scopes = (await pool.query(`SELECT scope_type, scope_id FROM user_scopes WHERE user_id=$1`, [req.params.id])).rows;
  const history = (await pool.query(`SELECT success, reason, ip_address, user_agent, created_at FROM login_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.params.id])).rows;
  res.json({ ...row, permission_overrides: perms, limits, scopes, login_history: history });
}));

const userSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
  email: optionalStr, full_name: z.string().min(2), phone: optionalStr,
  password: z.string().optional(),
  department_id: z.string().uuid().nullable().optional(), default_property_id: z.string().uuid().nullable().optional(), employee_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(), is_superuser: z.boolean().optional(), must_change_password: z.boolean().optional(),
  role_ids: z.array(z.string().uuid()).optional(), property_ids: z.array(z.string().uuid()).optional(),
  permission_overrides: z.array(z.object({ code: z.string(), effect: z.enum(['ALLOW', 'DENY']) })).optional(),
  limits: z.array(z.object({ limit_code: z.string(), limit_value: z.coerce.number() })).optional(),
  scopes: z.array(z.object({ scope_type: z.string(), scope_id: z.string().uuid() })).optional(),
});

async function syncUserRelations(client: any, userId: string, b: Partial<z.infer<typeof userSchema>>) {
  if (b.role_ids) {
    await client.query(`DELETE FROM user_roles WHERE user_id=$1`, [userId]);
    if (b.role_ids.length) await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::uuid[])`, [userId, b.role_ids]);
  }
  if (b.property_ids) {
    await client.query(`DELETE FROM user_properties WHERE user_id=$1`, [userId]);
    if (b.property_ids.length) await client.query(`INSERT INTO user_properties (user_id, property_id) SELECT $1, unnest($2::uuid[])`, [userId, b.property_ids]);
  }
  if (b.permission_overrides) {
    await client.query(`DELETE FROM user_permissions WHERE user_id=$1`, [userId]);
    for (const po of b.permission_overrides) {
      await client.query(`INSERT INTO user_permissions (user_id, permission_id, effect) SELECT $1, id, $3 FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING`, [userId, po.code, po.effect]);
    }
  }
  if (b.limits) {
    await client.query(`DELETE FROM authority_limits WHERE subject_type='USER' AND subject_id=$1`, [userId]);
    for (const l of b.limits) await client.query(`INSERT INTO authority_limits (subject_type, subject_id, limit_code, limit_value) VALUES ('USER',$1,$2,$3)`, [userId, l.limit_code, l.limit_value]);
  }
  if (b.scopes) {
    await client.query(`DELETE FROM user_scopes WHERE user_id=$1`, [userId]);
    for (const s of b.scopes) await client.query(`INSERT INTO user_scopes (user_id, scope_type, scope_id) VALUES ($1,$2,$3)`, [userId, s.scope_type, s.scope_id]);
  }
}

usersRouter.post('/', requirePermission('users.create'), asyncHandler(async (req, res) => {
  const b = validate(userSchema, req.body);
  if (!b.password) throw new BadRequest('Password is required');
  validatePasswordStrength(b.password);
  if (b.is_superuser && !req.user!.is_superuser) throw new Forbidden('Only a superuser can create superusers');
  const id = await withTransaction(async (client) => {
    const row = (await client.query(
      `INSERT INTO users (username, email, full_name, phone, password_hash, department_id, default_property_id, employee_id, is_active, is_superuser, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.username, b.email, b.full_name, b.phone, await hashPassword(b.password!), b.department_id ?? null, b.default_property_id ?? req.propertyId ?? null, b.employee_id ?? null, b.is_active ?? true, b.is_superuser ?? false, b.must_change_password ?? true])).rows[0];
    await syncUserRelations(client, row.id, b);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'user', entityId: row.id, newValue: { ...b, password: undefined } }, client);
    return row.id;
  });
  res.status(201).json((await pool.query(`${userSelect} WHERE u.id=$1`, [id])).rows[0]);
}));

usersRouter.put('/:id', requirePermission('users.edit'), asyncHandler(async (req, res) => {
  const b = validate(userSchema.partial(), req.body);
  const existing = (await pool.query(`SELECT * FROM users WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) throw new NotFound('User not found');
  if (b.is_superuser !== undefined && !req.user!.is_superuser) throw new Forbidden('Only a superuser can change superuser status');
  await withTransaction(async (client) => {
    const sets: string[] = []; const vals: any[] = [req.params.id];
    const push = (col: string, v: any) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    for (const k of ['username', 'email', 'full_name', 'phone', 'department_id', 'default_property_id', 'employee_id', 'is_active', 'is_superuser', 'must_change_password'] as const) {
      if (b[k] !== undefined) push(k, b[k]);
    }
    if (b.password) { validatePasswordStrength(b.password); push('password_hash', await hashPassword(b.password)); push('password_changed_at', new Date()); }
    if (sets.length) await client.query(`UPDATE users SET ${sets.join(',')} WHERE id=$1`, vals);
    await syncUserRelations(client, req.params.id, b as any);
    if (b.is_active === false) await client.query(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [req.params.id]);
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'user', entityId: req.params.id, oldValue: { ...existing, password_hash: undefined }, newValue: { ...b, password: undefined } }, client);
  });
  res.json((await pool.query(`${userSelect} WHERE u.id=$1`, [req.params.id])).rows[0]);
}));

usersRouter.post('/:id/toggle-active', requirePermission('users.disable'), asyncHandler(async (req, res) => {
  if (req.params.id === req.user!.id) throw new BadRequest('You cannot disable your own account');
  const row = (await pool.query(`UPDATE users SET is_active = NOT is_active WHERE id=$1 RETURNING id, is_active`, [req.params.id])).rows[0];
  if (!row) throw new NotFound('User not found');
  if (!row.is_active) await pool.query(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [req.params.id]);
  await audit({ ...auditCtx(req), action: row.is_active ? 'ACTIVATE' : 'DEACTIVATE', entityType: 'user', entityId: req.params.id, reason: req.body?.reason });
  res.json(row);
}));

usersRouter.post('/:id/reset-password', requirePermission('users.reset_password'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ newPassword: z.string() }), req.body);
  validatePasswordStrength(b.newPassword);
  await pool.query(`UPDATE users SET password_hash=$2, must_change_password=true, failed_login_count=0, locked_until=NULL WHERE id=$1`, [req.params.id, await hashPassword(b.newPassword)]);
  await pool.query(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [req.params.id]);
  await audit({ ...auditCtx(req), action: 'RESET_PASSWORD', entityType: 'user', entityId: req.params.id });
  res.json({ ok: true });
}));

usersRouter.get('/:id/sessions', requirePermission('users.sessions'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT id, ip_address, user_agent, device_name, created_at, last_seen_at, expires_at, revoked_at FROM user_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id])).rows;
  res.json({ data: rows });
}));

usersRouter.delete('/:id/sessions', requirePermission('users.sessions'), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [req.params.id]);
  await audit({ ...auditCtx(req), action: 'REVOKE_SESSIONS', entityType: 'user', entityId: req.params.id });
  res.json({ ok: true });
}));

// ---------------- Roles ----------------
const roleSelect = `SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id=r.id)::int AS user_count,
  COALESCE((SELECT json_agg(p.code ORDER BY p.code) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id), '[]') AS permissions,
  COALESCE((SELECT json_agg(json_build_object('limit_code', l.limit_code, 'limit_value', l.limit_value)) FROM authority_limits l WHERE l.subject_type='ROLE' AND l.subject_id=r.id), '[]') AS limits
  FROM roles r`;

rolesRouter.get('/', requirePermission('roles.view', 'users.view'), asyncHandler(async (_req, res) => {
  res.json({ data: (await pool.query(`${roleSelect} ORDER BY r.name`)).rows });
}));
rolesRouter.get('/:id', requirePermission('roles.view'), asyncHandler(async (req, res) => {
  const row = (await pool.query(`${roleSelect} WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!row) throw new NotFound('Role not found');
  res.json(row);
}));
const roleSchema = z.object({ code: z.string().min(2).regex(/^[A-Z0-9_]+$/, 'Use UPPER_SNAKE_CASE'), name: z.string().min(2), description: optionalStr,
  permissions: z.array(z.string()).optional(), limits: z.array(z.object({ limit_code: z.string(), limit_value: z.coerce.number() })).optional() });

async function syncRole(client: any, roleId: string, b: Partial<z.infer<typeof roleSchema>>) {
  if (b.permissions) {
    await client.query(`DELETE FROM role_permissions WHERE role_id=$1`, [roleId]);
    if (b.permissions.length) await client.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2)`, [roleId, b.permissions]);
  }
  if (b.limits) {
    await client.query(`DELETE FROM authority_limits WHERE subject_type='ROLE' AND subject_id=$1`, [roleId]);
    for (const l of b.limits) await client.query(`INSERT INTO authority_limits (subject_type, subject_id, limit_code, limit_value) VALUES ('ROLE',$1,$2,$3)`, [roleId, l.limit_code, l.limit_value]);
  }
}
rolesRouter.post('/', requirePermission('roles.create'), asyncHandler(async (req, res) => {
  const b = validate(roleSchema, req.body);
  const id = await withTransaction(async (client) => {
    const row = (await client.query(`INSERT INTO roles (code, name, description) VALUES ($1,$2,$3) RETURNING id`, [b.code, b.name, b.description])).rows[0];
    await syncRole(client, row.id, b);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'role', entityId: row.id, newValue: b }, client);
    return row.id;
  });
  res.status(201).json((await pool.query(`${roleSelect} WHERE r.id=$1`, [id])).rows[0]);
}));
rolesRouter.put('/:id', requirePermission('roles.edit'), asyncHandler(async (req, res) => {
  const b = validate(roleSchema.partial(), req.body);
  const existing = (await pool.query(`${roleSelect} WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!existing) throw new NotFound('Role not found');
  await withTransaction(async (client) => {
    await client.query(`UPDATE roles SET code=COALESCE($2,code), name=COALESCE($3,name), description=COALESCE($4,description) WHERE id=$1`, [req.params.id, b.code ?? null, b.name ?? null, b.description ?? null]);
    await syncRole(client, req.params.id, b);
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'role', entityId: req.params.id, oldValue: existing, newValue: b }, client);
  });
  res.json((await pool.query(`${roleSelect} WHERE r.id=$1`, [req.params.id])).rows[0]);
}));
rolesRouter.delete('/:id', requirePermission('roles.delete'), asyncHandler(async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM roles WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) throw new NotFound('Role not found');
  if (existing.is_system) throw new BadRequest('System roles cannot be deleted');
  await pool.query(`DELETE FROM roles WHERE id=$1`, [req.params.id]);
  await audit({ ...auditCtx(req), action: 'DELETE', entityType: 'role', entityId: req.params.id, oldValue: existing });
  res.json({ ok: true });
}));

permissionsRouter.get('/', requirePermission('roles.view', 'users.view'), asyncHandler(async (_req, res) => {
  const modules: Record<string, { code: string; description: string }[]> = {};
  for (const p of PERMISSIONS) (modules[p.module] ??= []).push({ code: p.code, description: p.description });
  res.json({ data: PERMISSIONS, modules });
}));
