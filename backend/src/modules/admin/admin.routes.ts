import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { asyncHandler, validate, getPagination, paged, optionalStr, sendExport , isExport } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { crudRouter } from '../../core/crud';
import { getSetting, setSetting } from '../../core/settings';
import { audit, auditCtx } from '../../core/audit';
import { NotFound, Forbidden } from '../../core/errors';
import { actOnApproval, pendingApprovalsFor } from '../workflow/workflow.service';

// ---------- Properties ----------
export const propertiesRouter = crudRouter({
  table: 'properties', entity: 'property', permissions: { view: 'properties.view', create: 'properties.create', edit: 'properties.edit' },
  searchColumns: ['name', 'code', 'city'], defaultSort: 'name',
  selectSql: `SELECT t.*, c.name AS company_name FROM properties t JOIN companies c ON c.id=t.company_id`,
  createSchema: z.object({ company_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), type: z.string().default('HOTEL'), address: optionalStr, city: optionalStr, country: optionalStr,
    phone: optionalStr, email: optionalStr, website: optionalStr, tax_number: optionalStr, currency: z.string().length(3).default('KES'), timezone: z.string().default('Africa/Nairobi'),
    check_in_time: z.string().default('14:00'), check_out_time: z.string().default('11:00'), service_charge_percent: z.coerce.number().default(0), is_active: z.boolean().default(true), settings: z.record(z.any()).optional() }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), type: z.string(), address: optionalStr, city: optionalStr, country: optionalStr, phone: optionalStr, email: optionalStr, website: optionalStr,
    tax_number: optionalStr, currency: z.string().length(3), timezone: z.string(), check_in_time: z.string(), check_out_time: z.string(), late_checkout_grace_minutes: z.coerce.number().int(),
    service_charge_percent: z.coerce.number(), is_active: z.boolean(), settings: z.record(z.any()), logo_url: optionalStr }).partial(),
  beforeCreate: async (data) => { if (!data.company_id) data.company_id = (await pool.query(`SELECT id FROM companies ORDER BY created_at LIMIT 1`)).rows[0]?.id; return data; },
});

export const companiesRouter = crudRouter({
  table: 'companies', entity: 'company', permissions: { view: 'properties.view', edit: 'properties.edit' }, defaultSort: 'name',
  createSchema: z.object({}), updateSchema: z.object({ name: z.string(), legal_name: optionalStr, tax_number: optionalStr, base_currency: z.string().length(3), address: optionalStr, phone: optionalStr, email: optionalStr, website: optionalStr, logo_url: optionalStr }).partial(),
});

export const departmentsRouter = crudRouter({
  table: 'departments', entity: 'department', permissions: { view: 'departments.view', create: 'departments.manage', edit: 'departments.manage', delete: 'departments.manage' },
  propertyScoped: true, searchColumns: ['name', 'code'], defaultSort: 'name', softDelete: true, filters: { active: 'is_active' },
  selectSql: `SELECT t.*, u.full_name AS manager_name, pd.name AS parent_name FROM departments t LEFT JOIN users u ON u.id=t.manager_user_id LEFT JOIN departments pd ON pd.id=t.parent_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), parent_id: z.string().uuid().nullable().optional(), manager_user_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), parent_id: z.string().uuid().nullable(), manager_user_id: z.string().uuid().nullable(), is_active: z.boolean() }).partial(),
});

export const employeesRouter = crudRouter({
  table: 'employees', entity: 'employee', permissions: { view: 'employees.view', create: 'employees.manage', edit: 'employees.manage' },
  propertyScoped: true, searchColumns: ['first_name', 'last_name', 'employee_no', 'position', 'phone'], defaultSort: 'first_name', filters: { department_id: 'department_id', status: 'status' },
  selectSql: `SELECT t.*, t.first_name || ' ' || t.last_name AS full_name, d.name AS department_name, (SELECT u.username FROM users u WHERE u.employee_id=t.id LIMIT 1) AS username FROM employees t LEFT JOIN departments d ON d.id=t.department_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), department_id: z.string().uuid().nullable().optional(), employee_no: z.string().min(1), first_name: z.string().min(1), last_name: z.string().min(1), position: optionalStr, phone: optionalStr, email: optionalStr, national_id: optionalStr, hire_date: z.string().nullable().optional(), status: z.string().default('ACTIVE'), external_payroll_ref: optionalStr, notes: optionalStr }),
  updateSchema: z.object({ department_id: z.string().uuid().nullable(), employee_no: z.string().min(1), first_name: z.string().min(1), last_name: z.string().min(1), position: optionalStr, phone: optionalStr, email: optionalStr, national_id: optionalStr, hire_date: z.string().nullable(), status: z.string(), external_payroll_ref: optionalStr, notes: optionalStr }).partial(),
});

export const shiftTemplatesRouter = crudRouter({
  table: 'shift_templates', entity: 'shift_template', permissions: { view: 'employees.view', create: 'employees.manage', edit: 'employees.manage', delete: 'employees.manage' },
  propertyScoped: true, defaultSort: 'name', selectSql: `SELECT t.*, d.name AS department_name FROM shift_templates t LEFT JOIN departments d ON d.id=t.department_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), department_id: z.string().uuid().nullable().optional(), name: z.string(), start_time: z.string(), end_time: z.string(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ department_id: z.string().uuid().nullable(), name: z.string(), start_time: z.string(), end_time: z.string(), is_active: z.boolean() }).partial(),
  extraRoutes: (r) => {
    r.get('/assignments/list', requirePermission('employees.view'), asyncHandler(async (req, res) => {
      const rows = (await pool.query(`SELECT a.*, st.name AS shift_name, st.start_time, st.end_time, e.first_name || ' ' || e.last_name AS employee_name, d.name AS department_name
        FROM staff_shift_assignments a JOIN shift_templates st ON st.id=a.shift_template_id JOIN employees e ON e.id=a.employee_id LEFT JOIN departments d ON d.id=st.department_id
        WHERE ($1::date IS NULL OR a.shift_date=$1) AND ($2::uuid IS NULL OR st.property_id=$2) ORDER BY a.shift_date DESC, st.start_time LIMIT 500`, [req.query.date || null, req.propertyId])).rows;
      res.json({ data: rows });
    }));
    r.post('/assignments', requirePermission('employees.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ shift_template_id: z.string().uuid(), employee_id: z.string().uuid(), shift_date: z.string(), outlet_id: z.string().uuid().nullable().optional(), supervisor_user_id: z.string().uuid().nullable().optional() }), req.body);
      const row = (await pool.query(`INSERT INTO staff_shift_assignments (shift_template_id, employee_id, shift_date, outlet_id, supervisor_user_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (shift_template_id, employee_id, shift_date) DO UPDATE SET outlet_id=EXCLUDED.outlet_id RETURNING *`,
        [b.shift_template_id, b.employee_id, b.shift_date, b.outlet_id ?? null, b.supervisor_user_id ?? null])).rows[0];
      res.status(201).json(row);
    }));
    r.post('/assignments/:id/clock', requirePermission('employees.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ action: z.enum(['IN', 'OUT']) }), req.body);
      const row = (await pool.query(b.action === 'IN' ? `UPDATE staff_shift_assignments SET clock_in=now() WHERE id=$1 RETURNING *` : `UPDATE staff_shift_assignments SET clock_out=now() WHERE id=$1 RETURNING *`, [req.params.id])).rows[0];
      res.json(row);
    }));
  },
});

// ---------- Settings ----------
export const settingsRouter = Router();
settingsRouter.get('/', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT key, value, property_id, updated_at FROM settings WHERE property_id IS NULL OR property_id=$1 ORDER BY property_id NULLS FIRST, key`, [req.propertyId ?? null])).rows;
  const merged: Record<string, any> = {};
  rows.forEach((r) => { merged[r.key] = r.value; });
  res.json({ settings: merged, rows });
}));
settingsRouter.put('/', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ key: z.string(), value: z.any(), scope: z.enum(['GLOBAL', 'PROPERTY']).default('PROPERTY') }), req.body);
  const propertyId = b.scope === 'PROPERTY' ? req.propertyId ?? null : null;
  const old = await getSetting(b.key, propertyId);
  await setSetting(b.key, b.value, propertyId, req.user!.id);
  await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'setting', entityId: b.key, oldValue: old, newValue: b.value });
  res.json({ ok: true });
}));
settingsRouter.get('/numbering', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  res.json({ data: (await pool.query(`SELECT * FROM number_sequences WHERE property_id IS NULL OR property_id=$1 ORDER BY doc_type`, [req.propertyId ?? null])).rows });
}));
settingsRouter.put('/numbering', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ doc_type: z.string(), prefix: z.string(), padding: z.coerce.number().int().min(1).max(12), next_value: z.coerce.number().int().min(1), reset_yearly: z.boolean().default(false) }), req.body);
  const row = (await pool.query(`INSERT INTO number_sequences (property_id, doc_type, prefix, padding, next_value, reset_yearly, current_year) VALUES ($1,$2,$3,$4,$5,$6, EXTRACT(YEAR FROM now())::int)
    ON CONFLICT (property_id, doc_type) DO UPDATE SET prefix=EXCLUDED.prefix, padding=EXCLUDED.padding, next_value=GREATEST(number_sequences.next_value, EXCLUDED.next_value), reset_yearly=EXCLUDED.reset_yearly RETURNING *`,
    [req.propertyId ?? null, b.doc_type, b.prefix, b.padding, b.next_value, b.reset_yearly])).rows[0];
  await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'number_sequence', entityId: b.doc_type, newValue: row });
  res.json(row);
}));
settingsRouter.get('/currencies', asyncHandler(async (_req, res) => {
  res.json({ data: (await pool.query(`SELECT * FROM currencies ORDER BY code`)).rows });
}));
settingsRouter.post('/currencies', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ code: z.string().length(3), name: z.string(), symbol: optionalStr, decimals: z.coerce.number().int().default(2), is_active: z.boolean().default(true) }), req.body);
  const row = (await pool.query(`INSERT INTO currencies (code, name, symbol, decimals, is_active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, symbol=EXCLUDED.symbol, decimals=EXCLUDED.decimals, is_active=EXCLUDED.is_active RETURNING *`, [b.code.toUpperCase(), b.name, b.symbol, b.decimals, b.is_active])).rows[0];
  res.json(row);
}));
settingsRouter.get('/exchange-rates', asyncHandler(async (_req, res) => {
  res.json({ data: (await pool.query(`SELECT * FROM exchange_rates ORDER BY effective_date DESC, from_currency LIMIT 500`)).rows });
}));
settingsRouter.post('/exchange-rates', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ from_currency: z.string().length(3), to_currency: z.string().length(3), rate: z.coerce.number().positive(), effective_date: z.string() }), req.body);
  const row = (await pool.query(`INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [b.from_currency, b.to_currency, b.rate, b.effective_date, req.user!.id])).rows[0];
  await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'exchange_rate', entityId: row.id, newValue: row });
  res.status(201).json(row);
}));

// ---------- Workflow definitions ----------
export const workflowsRouter = Router();
workflowsRouter.get('/', requirePermission('settings.workflows', 'approvals.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT d.*, COALESCE((SELECT json_agg(json_build_object('id', s.id, 'step_order', s.step_order, 'name', s.name, 'approver_role_id', s.approver_role_id, 'approver_user_id', s.approver_user_id, 'required_permission', s.required_permission, 'min_amount', s.min_amount, 'role_name', r.name, 'user_name', u.full_name) ORDER BY s.step_order)
      FROM workflow_steps s LEFT JOIN roles r ON r.id=s.approver_role_id LEFT JOIN users u ON u.id=s.approver_user_id WHERE s.definition_id=d.id), '[]') AS steps
    FROM workflow_definitions d WHERE d.property_id IS NULL OR d.property_id=$1 ORDER BY d.transaction_type, d.min_amount`, [req.propertyId ?? null])).rows;
  res.json({ data: rows });
}));
const wfSchema = z.object({ transaction_type: z.string(), name: z.string(), min_amount: z.coerce.number().default(0), max_amount: z.coerce.number().nullable().optional(), is_active: z.boolean().default(true), required_documents: z.array(z.string()).default([]), escalation_hours: z.coerce.number().int().nullable().optional(),
  steps: z.array(z.object({ step_order: z.coerce.number().int(), name: z.string(), approver_role_id: z.string().uuid().nullable().optional(), approver_user_id: z.string().uuid().nullable().optional(), required_permission: optionalStr, min_amount: z.coerce.number().default(0) })).min(1), scope: z.enum(['GLOBAL', 'PROPERTY']).default('PROPERTY') });
workflowsRouter.post('/', requirePermission('settings.workflows'), asyncHandler(async (req, res) => {
  const b = validate(wfSchema, req.body);
  const { withTransaction } = await import('../../db/pool');
  const id = await withTransaction(async (c) => {
    const d = (await c.query(`INSERT INTO workflow_definitions (property_id, transaction_type, name, min_amount, max_amount, is_active, required_documents, escalation_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.scope === 'PROPERTY' ? req.propertyId : null, b.transaction_type, b.name, b.min_amount, b.max_amount ?? null, b.is_active, b.required_documents, b.escalation_hours ?? null])).rows[0];
    for (const s of b.steps) await c.query(`INSERT INTO workflow_steps (definition_id, step_order, name, approver_role_id, approver_user_id, required_permission, min_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [d.id, s.step_order, s.name, s.approver_role_id ?? null, s.approver_user_id ?? null, s.required_permission, s.min_amount]);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'workflow_definition', entityId: d.id, newValue: b }, c);
    return d.id;
  });
  res.status(201).json({ id });
}));
workflowsRouter.put('/:id', requirePermission('settings.workflows'), asyncHandler(async (req, res) => {
  const b = validate(wfSchema, req.body);
  const { withTransaction } = await import('../../db/pool');
  await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM workflow_definitions WHERE id=$1`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Workflow not found');
    await c.query(`UPDATE workflow_definitions SET transaction_type=$2, name=$3, min_amount=$4, max_amount=$5, is_active=$6, required_documents=$7, escalation_hours=$8 WHERE id=$1`, [req.params.id, b.transaction_type, b.name, b.min_amount, b.max_amount ?? null, b.is_active, b.required_documents, b.escalation_hours ?? null]);
    await c.query(`DELETE FROM workflow_steps WHERE definition_id=$1`, [req.params.id]);
    for (const s of b.steps) await c.query(`INSERT INTO workflow_steps (definition_id, step_order, name, approver_role_id, approver_user_id, required_permission, min_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [req.params.id, s.step_order, s.name, s.approver_role_id ?? null, s.approver_user_id ?? null, s.required_permission, s.min_amount]);
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'workflow_definition', entityId: req.params.id, oldValue: old, newValue: b }, c);
  });
  res.json({ ok: true });
}));
workflowsRouter.delete('/:id', requirePermission('settings.workflows'), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE workflow_definitions SET is_active=false WHERE id=$1`, [req.params.id]);
  await audit({ ...auditCtx(req), action: 'DEACTIVATE', entityType: 'workflow_definition', entityId: req.params.id });
  res.json({ ok: true });
}));

// ---------- Approvals inbox ----------
export const approvalsRouter = Router();
approvalsRouter.get('/', requirePermission('approvals.view', 'approvals.act'), asyncHandler(async (req, res) => {
  res.json({ data: await pendingApprovalsFor(req.user!, req.propertyId ?? null) });
}));
approvalsRouter.get('/history', requirePermission('approvals.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'requested_at');
  const rows = (await pool.query(`SELECT ar.*, u.full_name AS requested_by_name,
      COALESCE((SELECT json_agg(json_build_object('step_order', a.step_order, 'step_name', a.step_name, 'action', a.action, 'comment', a.comment, 'user', au.full_name, 'at', a.created_at) ORDER BY a.created_at) FROM approval_actions a JOIN users au ON au.id=a.user_id WHERE a.request_id=ar.id), '[]') AS actions
    FROM approval_requests ar LEFT JOIN users u ON u.id=ar.requested_by WHERE ($1::uuid IS NULL OR ar.property_id=$1 OR ar.property_id IS NULL) ORDER BY ar.requested_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, [req.propertyId ?? null])).rows;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM approval_requests WHERE ($1::uuid IS NULL OR property_id=$1 OR property_id IS NULL)`, [req.propertyId ?? null])).rows[0].count);
  res.json(paged(rows, total, p));
}));
approvalsRouter.get('/entity/:type/:id', requirePermission('approvals.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT ar.*, COALESCE((SELECT json_agg(json_build_object('step_order', a.step_order, 'step_name', a.step_name, 'action', a.action, 'comment', a.comment, 'user', au.full_name, 'at', a.created_at) ORDER BY a.created_at) FROM approval_actions a JOIN users au ON au.id=a.user_id WHERE a.request_id=ar.id), '[]') AS actions
    FROM approval_requests ar WHERE ar.entity_type=$1 AND ar.entity_id=$2 ORDER BY ar.requested_at DESC`, [req.params.type, req.params.id])).rows;
  res.json({ data: rows });
}));
approvalsRouter.post('/:id/act', requirePermission('approvals.act'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ action: z.enum(['APPROVE', 'REJECT', 'RETURN']), comment: optionalStr }), req.body);
  res.json(await actOnApproval(req.params.id, req.user!, b.action, b.comment ?? undefined));
}));

// ---------- Audit logs ----------
export const auditRouter = Router();
auditRouter.get('/', requirePermission('audit.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'created_at');
  const where: string[] = []; const params: any[] = [];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  if (req.query.entityType) add('a.entity_type=$P', req.query.entityType);
  if (req.query.entityId) add('a.entity_id=$P', req.query.entityId);
  if (req.query.action) add('a.action=$P', req.query.action);
  if (req.query.userId) add('a.user_id=$P', req.query.userId);
  if (req.query.from) add('a.created_at >= $P', req.query.from);
  if (req.query.to) add('a.created_at < ($P::date + 1)', req.query.to);
  if (p.search) add('(a.entity_type ILIKE $P OR a.username ILIKE $P OR a.reason ILIKE $P OR a.entity_id ILIKE $P)', `%${p.search}%`);
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = Number((await pool.query(`SELECT COUNT(*) FROM audit_logs a${w}`, params)).rows[0].count);
  const rows = (await pool.query(`SELECT a.* FROM audit_logs a${w} ORDER BY a.created_at ${p.order} LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  if (isExport(req)) { if (!hasPermission(req, 'reports.export')) throw new Forbidden(); return sendExport(res, req, rows, 'audit'); }
  res.json(paged(rows, total, p));
}));

// ---------- Notifications ----------
export const notificationsRouter = Router();
notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user!.id])).rows;
  const unread = rows.filter((r) => !r.read_at).length;
  res.json({ data: rows, unread });
}));
notificationsRouter.post('/read', asyncHandler(async (req, res) => {
  const ids: string[] | undefined = req.body?.ids;
  if (ids?.length) await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2) AND read_at IS NULL`, [req.user!.id, ids]);
  else await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [req.user!.id]);
  res.json({ ok: true });
}));
