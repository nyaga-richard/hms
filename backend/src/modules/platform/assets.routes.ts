import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr } from '../../core/http';
import { requirePermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { nextNumber } from '../../core/numbering';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';

/** Fixed asset register: categories, assets with barcode, movements (location/department/room), status lifecycle, maintenance link. */
export const assetCategoriesRouter = crudRouter({ table: 'asset_categories', entity: 'asset_category', permissions: { view: 'assets.view', create: 'assets.manage', edit: 'assets.manage', delete: 'assets.manage' }, searchColumns: ['name'], defaultSort: 'name',
  selectSql: `SELECT t.*, a.code AS account_code, a.name AS account_name, (SELECT COUNT(*) FROM assets x WHERE x.category_id=t.id)::int AS asset_count FROM asset_categories t LEFT JOIN accounts a ON a.id=t.account_id`,
  createSchema: z.object({ name: z.string().min(1), depreciation_rate: z.coerce.number().min(0).max(100).default(0), account_id: z.string().uuid().nullable().optional() }),
  updateSchema: z.object({ name: z.string().min(1), depreciation_rate: z.coerce.number().min(0).max(100), account_id: z.string().uuid().nullable() }).partial() });

export const assetsRouter = Router();
const aSelect = `SELECT a.*, c.name AS category_name, c.depreciation_rate, r.number AS room_number, d.name AS department_name, s.name AS supplier_name, u.full_name AS responsible_name,
  CASE WHEN c.depreciation_rate > 0 AND a.purchase_date IS NOT NULL THEN GREATEST(0, a.cost - a.cost * c.depreciation_rate / 100 * ((CURRENT_DATE - a.purchase_date)::numeric / 365.25)) ELSE a.cost END AS book_value,
  (SELECT COUNT(*) FROM maintenance_requests m WHERE m.asset_id=a.id)::int AS maintenance_count
  FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN suppliers s ON s.id=a.supplier_id LEFT JOIN users u ON u.id=a.responsible_user_id`;
assetsRouter.get('/', requirePermission('assets.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: aSelect, where: ['a.property_id=$1'], params: [req.propertyId], searchColumns: ['a.asset_number', 'a.name', 'a.serial_number', 'a.barcode', 'a.location', 'a.model'], defaultSort: 'a.asset_number', filters: { status: 'a.status', category_id: 'a.category_id', department_id: 'a.department_id', room_id: 'a.room_id' }, dateFilters: { purchase_date: 'a.purchase_date' }, exportName: 'assets' });
}));
assetsRouter.get('/summary', requirePermission('assets.view'), asyncHandler(async (req, res) => {
  const byStatus = (await pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(cost),0) AS cost FROM assets WHERE property_id=$1 GROUP BY status`, [req.propertyId])).rows;
  const byCategory = (await pool.query(`SELECT c.name, COUNT(a.id)::int AS count, COALESCE(SUM(a.cost),0) AS cost FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id WHERE a.property_id=$1 GROUP BY c.name ORDER BY cost DESC`, [req.propertyId])).rows;
  const warranty = (await pool.query(`SELECT asset_number, name, warranty_expiry FROM assets WHERE property_id=$1 AND warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 60 ORDER BY warranty_expiry`, [req.propertyId])).rows;
  res.json({ by_status: byStatus, by_category: byCategory, warranty_expiring: warranty });
}));
assetsRouter.get('/lookup/:code', requirePermission('assets.view'), asyncHandler(async (req, res) => {
  const a = (await pool.query(`${aSelect} WHERE a.property_id=$1 AND (a.barcode=$2 OR a.asset_number=$2 OR a.serial_number=$2)`, [req.propertyId, req.params.code])).rows[0];
  if (!a) throw new NotFound('Asset not found');
  res.json(a);
}));
const assetSchema = z.object({ name: z.string().min(1), category_id: z.string().uuid().nullable().optional(), serial_number: optionalStr, model: optionalStr, location: optionalStr, room_id: z.string().uuid().nullable().optional(), department_id: z.string().uuid().nullable().optional(), supplier_id: z.string().uuid().nullable().optional(), purchase_date: dateStr.nullable().optional(), cost: z.coerce.number().min(0).default(0), warranty_expiry: dateStr.nullable().optional(), status: z.enum(['IN_USE', 'IN_STORE', 'UNDER_MAINTENANCE', 'DAMAGED', 'DISPOSED', 'LOST']).default('IN_USE'), responsible_user_id: z.string().uuid().nullable().optional(), barcode: optionalStr, notes: optionalStr });
assetsRouter.post('/', requirePermission('assets.manage'), asyncHandler(async (req, res) => {
  const b = validate(assetSchema, req.body);
  const out = await withTransaction(async (c) => {
    const number = await nextNumber(c, 'ASSET', null); // enterprise-wide asset register numbering (matches seeded sequence)
    const a = (await c.query(`INSERT INTO assets (property_id, asset_number, name, category_id, serial_number, model, location, room_id, department_id, supplier_id, purchase_date, cost, warranty_expiry, status, responsible_user_id, barcode, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [req.propertyId, number, b.name, b.category_id ?? null, b.serial_number ?? null, b.model ?? null, b.location ?? null, b.room_id ?? null, b.department_id ?? null, b.supplier_id ?? null, b.purchase_date ?? null, b.cost, b.warranty_expiry ?? null, b.status, b.responsible_user_id ?? null, b.barcode ?? number, b.notes ?? null])).rows[0];
    await c.query(`INSERT INTO asset_movements (asset_id, to_location, to_department_id, to_room_id, status_after, reason, user_id) VALUES ($1,$2,$3,$4,$5,'Registered',$6)`, [a.id, b.location ?? null, b.department_id ?? null, b.room_id ?? null, b.status, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'asset', entityId: a.id, newValue: a }, c);
    return (await c.query(`${aSelect} WHERE a.id=$1`, [a.id])).rows[0];
  });
  res.status(201).json(out);
}));
assetsRouter.get('/:id', requirePermission('assets.view'), asyncHandler(async (req, res) => {
  const a = (await pool.query(`${aSelect} WHERE a.id=$1`, [req.params.id])).rows[0];
  if (!a) throw new NotFound('Asset not found');
  a.movements = (await pool.query(`SELECT m.*, u.full_name AS user_name, fr.number AS from_room, tr.number AS to_room, fd.name AS from_department, td.name AS to_department FROM asset_movements m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN rooms fr ON fr.id=m.from_room_id LEFT JOIN rooms tr ON tr.id=m.to_room_id LEFT JOIN departments fd ON fd.id=m.from_department_id LEFT JOIN departments td ON td.id=m.to_department_id WHERE m.asset_id=$1 ORDER BY m.created_at DESC`, [a.id])).rows;
  a.maintenance = (await pool.query(`SELECT id, number, title, status, priority, created_at, total_cost FROM maintenance_requests WHERE asset_id=$1 ORDER BY created_at DESC LIMIT 20`, [a.id])).rows;
  a.attachments = (await pool.query(`SELECT id, file_name, mime_type, size_bytes, created_at FROM attachments WHERE entity_type='asset' AND entity_id=$1::text ORDER BY created_at`, [a.id])).rows;
  res.json(a);
}));
assetsRouter.put('/:id', requirePermission('assets.manage'), asyncHandler(async (req, res) => {
  const b = validate(assetSchema.partial(), req.body);
  const out = await withTransaction(async (c) => {
    const a = (await c.query(`SELECT * FROM assets WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!a) throw new NotFound('Asset not found');
    if (a.status === 'DISPOSED') throw Errors.invalidStatus('asset', a.status, 'edit');
    const r = (await c.query(`UPDATE assets SET name=COALESCE($2,name), category_id=COALESCE($3,category_id), serial_number=COALESCE($4,serial_number), model=COALESCE($5,model), supplier_id=COALESCE($6,supplier_id), purchase_date=COALESCE($7,purchase_date), cost=COALESCE($8,cost), warranty_expiry=COALESCE($9,warranty_expiry), responsible_user_id=COALESCE($10,responsible_user_id), barcode=COALESCE($11,barcode), notes=COALESCE($12,notes), updated_at=now() WHERE id=$1 RETURNING *`,
      [a.id, b.name ?? null, b.category_id ?? null, b.serial_number ?? null, b.model ?? null, b.supplier_id ?? null, b.purchase_date ?? null, b.cost ?? null, b.warranty_expiry ?? null, b.responsible_user_id ?? null, b.barcode ?? null, b.notes ?? null])).rows[0];
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'asset', entityId: a.id, oldValue: a, newValue: r }, c);
    return r;
  });
  res.json(out);
}));
/** Move an asset (location / department / room) and/or change its status — always recorded as a movement. */
assetsRouter.post('/:id/move', requirePermission('assets.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ location: optionalStr, department_id: z.string().uuid().nullable().optional(), room_id: z.string().uuid().nullable().optional(), status: z.enum(['IN_USE', 'IN_STORE', 'UNDER_MAINTENANCE', 'DAMAGED', 'DISPOSED', 'LOST']).optional(), reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const a = (await c.query(`SELECT * FROM assets WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!a) throw new NotFound('Asset not found');
    if (a.status === 'DISPOSED') throw Errors.invalidStatus('asset', a.status, 'move');
    const status = b.status ?? a.status;
    const r = (await c.query(`UPDATE assets SET location=COALESCE($2,location), department_id=CASE WHEN $3::uuid IS NULL AND $6::boolean THEN department_id ELSE $3 END, room_id=CASE WHEN $4::uuid IS NULL AND $7::boolean THEN room_id ELSE $4 END, status=$5, updated_at=now() WHERE id=$1 RETURNING *`, [a.id, b.location ?? null, b.department_id ?? null, b.room_id ?? null, status, b.department_id === undefined, b.room_id === undefined])).rows[0];
    await c.query(`INSERT INTO asset_movements (asset_id, from_location, to_location, from_department_id, to_department_id, from_room_id, to_room_id, status_after, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [a.id, a.location, r.location, a.department_id, r.department_id, a.room_id, r.room_id, status, b.reason, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'MOVE', entityType: 'asset', entityId: a.id, oldValue: { location: a.location, status: a.status }, newValue: { location: r.location, status }, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));
