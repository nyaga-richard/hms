import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr } from '../../core/http';
import { requirePermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { nextNumber } from '../../core/numbering';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { postCharge, reverseFolioItem } from '../pms/folio.service';
import { defaultTaxFor } from '../finance/accounting.service';

/**
 * Laundry: guest laundry (charged to folio when collected), hotel linen and staff uniforms (internal, no charge).
 * Status flow: COLLECTED → SORTING → WASHING → DRYING → IRONING → QUALITY_CHECK → READY → DELIVERED (guest) / RETURNED_TO_STORE (linen/uniform).
 */
const FLOW = ['COLLECTED', 'SORTING', 'WASHING', 'DRYING', 'IRONING', 'QUALITY_CHECK', 'READY', 'DELIVERED', 'RETURNED_TO_STORE'];

export const laundryServicesRouter = crudRouter({ table: 'laundry_services', entity: 'laundry_service', permissions: { view: 'laundry.view', create: 'laundry.manage', edit: 'laundry.manage', delete: 'laundry.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['name', 'category'], defaultSort: 'name', filters: { category: 'category' },
  createSchema: z.object({ property_id: z.string().uuid().optional(), name: z.string().min(1), category: z.enum(['GARMENT', 'LINEN', 'UNIFORM', 'DRY_CLEAN', 'PRESSING', 'OTHER']).default('GARMENT'), price: z.coerce.number().min(0).default(0), express_multiplier: z.coerce.number().min(1).default(1.5), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), category: z.enum(['GARMENT', 'LINEN', 'UNIFORM', 'DRY_CLEAN', 'PRESSING', 'OTHER']), price: z.coerce.number().min(0), express_multiplier: z.coerce.number().min(1), is_active: z.boolean() }).partial() });

export const laundryRouter = Router();

const select = `SELECT l.*, r.number AS room_number, g.first_name || ' ' || g.last_name AS guest_name, d.name AS department_name, u.full_name AS created_by_name,
    (SELECT COUNT(*) FROM laundry_order_items i WHERE i.order_id=l.id)::int AS item_count, (SELECT COALESCE(SUM(quantity),0) FROM laundry_order_items i WHERE i.order_id=l.id)::int AS pieces
  FROM laundry_orders l LEFT JOIN rooms r ON r.id=l.room_id LEFT JOIN guests g ON g.id=l.guest_id LEFT JOIN departments d ON d.id=l.department_id LEFT JOIN users u ON u.id=l.created_by`;

laundryRouter.get('/', requirePermission('laundry.view'), asyncHandler(async (req, res) => {
  const where = ['l.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.open === 'true') where.push(`l.status NOT IN ('DELIVERED','RETURNED_TO_STORE','CANCELLED')`);
  await runList(req, res, { select, where, params, searchColumns: ['l.number', 'r.number', 'g.first_name', 'g.last_name', 'd.name'], defaultSort: 'l.created_at', filters: { status: 'l.status', type: 'l.type', stay_id: 'l.stay_id', room_id: 'l.room_id', express: 'l.express' }, dateFilters: { date: 'l.created_at::date' }, exportName: 'laundry_orders' });
}));

laundryRouter.get('/board', requirePermission('laundry.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`${select} WHERE l.property_id=$1 AND l.status NOT IN ('DELIVERED','RETURNED_TO_STORE','CANCELLED') ORDER BY l.express DESC, l.created_at`, [req.propertyId])).rows;
  const columns = FLOW.filter((s) => !['DELIVERED', 'RETURNED_TO_STORE'].includes(s)).map((s) => ({ status: s, orders: rows.filter((r) => r.status === s) }));
  res.json({ columns, total: rows.length, express: rows.filter((r) => r.express).length });
}));

laundryRouter.post('/', requirePermission('laundry.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ type: z.enum(['GUEST', 'HOTEL_LINEN', 'UNIFORM']).default('GUEST'), stay_id: z.string().uuid().nullable().optional(), room_id: z.string().uuid().nullable().optional(), department_id: z.string().uuid().nullable().optional(), express: z.boolean().default(false), notes: optionalStr,
    items: z.array(z.object({ service_id: z.string().uuid().nullable().optional(), description: optionalStr, quantity: z.coerce.number().int().min(1).default(1), unit_price: z.coerce.number().min(0).optional() })).min(1), charge_now: z.boolean().default(true) }), req.body);
  const out = await withTransaction(async (c) => {
    let stay: any = null;
    if (b.type === 'GUEST') {
      if (!b.stay_id && !b.room_id) throw new BadRequest('Guest laundry needs stay_id or room_id');
      stay = (await c.query(b.stay_id ? `SELECT * FROM stays WHERE id=$1 AND status='IN_HOUSE'` : `SELECT * FROM stays WHERE room_id=$1 AND status='IN_HOUSE'`, [b.stay_id ?? b.room_id])).rows[0];
      if (!stay) throw new BadRequest('No in-house guest found for this room/stay');
    }
    const number = await nextNumber(c, 'LAUNDRY', req.propertyId);
    const o = (await c.query(`INSERT INTO laundry_orders (property_id, number, type, stay_id, guest_id, room_id, department_id, status, express, notes, created_by, collected_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'COLLECTED',$8,$9,$10,now()) RETURNING *`,
      [req.propertyId, number, b.type, stay?.id ?? null, stay?.guest_id ?? null, stay?.room_id ?? b.room_id ?? null, b.department_id ?? null, b.express, b.notes ?? null, req.user!.id])).rows[0];
    let total = 0;
    for (const it of b.items) {
      const svc = it.service_id ? (await c.query(`SELECT * FROM laundry_services WHERE id=$1`, [it.service_id])).rows[0] : null;
      if (it.service_id && !svc) throw new NotFound('Laundry service not found');
      const price = b.type === 'GUEST' ? (it.unit_price ?? Number(svc?.price ?? 0)) * (b.express ? Number(svc?.express_multiplier ?? 1.5) : 1) : 0;
      const amount = Math.round(price * it.quantity * 100) / 100;
      total += amount;
      await c.query(`INSERT INTO laundry_order_items (order_id, service_id, description, quantity, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)`, [o.id, it.service_id ?? null, it.description ?? svc?.name ?? 'Item', it.quantity, Math.round(price * 100) / 100, amount]);
    }
    total = Math.round(total * 100) / 100;
    let folioItemId: string | null = null;
    if (b.type === 'GUEST' && total > 0 && b.charge_now) {
      const folio = (await c.query(`SELECT id FROM folios WHERE stay_id=$1 AND status='OPEN' ORDER BY (type='GUEST') DESC LIMIT 1`, [stay.id])).rows[0];
      if (!folio) throw new BadRequest('Guest has no open folio');
      const tax = await defaultTaxFor(c, req.propertyId!, 'SERVICE');
      const fi = await postCharge(c, { folioId: folio.id, category: 'LAUNDRY', description: `Laundry ${number}${b.express ? ' (express)' : ''}`, unitPrice: total, taxId: tax?.id ?? null, sourceType: 'LAUNDRY', sourceId: o.id, userId: req.user!.id });
      folioItemId = fi.id;
    }
    const upd = (await c.query(`UPDATE laundry_orders SET total=$2, folio_item_id=$3 WHERE id=$1 RETURNING *`, [o.id, total, folioItemId])).rows[0];
    await c.query(`INSERT INTO laundry_status_history (order_id, status, user_id) VALUES ($1,'COLLECTED',$2)`, [o.id, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'laundry_order', entityId: o.id, newValue: { ...upd, items: b.items } }, c);
    return upd;
  });
  res.status(201).json(out);
}));

laundryRouter.get('/:id', requirePermission('laundry.view'), asyncHandler(async (req, res) => {
  const o = (await pool.query(`${select} WHERE l.id=$1`, [req.params.id])).rows[0];
  if (!o) throw new NotFound('Laundry order not found');
  o.items = (await pool.query(`SELECT i.*, s.name AS service_name, s.category FROM laundry_order_items i LEFT JOIN laundry_services s ON s.id=i.service_id WHERE i.order_id=$1`, [o.id])).rows;
  o.history = (await pool.query(`SELECT h.*, u.full_name AS user_name FROM laundry_status_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.order_id=$1 ORDER BY h.created_at`, [o.id])).rows;
  res.json(o);
}));

laundryRouter.post('/:id/status', requirePermission('laundry.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ status: z.enum(FLOW as unknown as [string, ...string[]]), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM laundry_orders WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Laundry order not found');
    if (['DELIVERED', 'RETURNED_TO_STORE', 'CANCELLED'].includes(old.status)) throw Errors.invalidStatus('laundry order', old.status, 'update');
    if (b.status === 'DELIVERED' && old.type !== 'GUEST') throw new BadRequest('Hotel linen/uniforms are returned to store, not delivered');
    if (b.status === 'RETURNED_TO_STORE' && old.type === 'GUEST') throw new BadRequest('Guest laundry is delivered to the guest');
    const done = ['DELIVERED', 'RETURNED_TO_STORE'].includes(b.status);
    const o = (await c.query(`UPDATE laundry_orders SET status=$2, delivered_at=CASE WHEN $3 THEN now() ELSE delivered_at END, notes=COALESCE($4, notes) WHERE id=$1 RETURNING *`, [old.id, b.status, done, b.notes ?? null])).rows[0];
    await c.query(`INSERT INTO laundry_status_history (order_id, status, user_id) VALUES ($1,$2,$3)`, [old.id, b.status, req.user!.id]);
    if (b.status === 'READY' && old.type === 'GUEST') await notify({ permission: 'housekeeping.update', propertyId: old.property_id, type: 'LAUNDRY_READY', title: `Laundry ${old.number} ready for delivery`, entityType: 'laundry_order', entityId: old.id, link: `/laundry/${old.id}` }, c);
    return o;
  });
  res.json(out);
}));

laundryRouter.post('/:id/cancel', requirePermission('laundry.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM laundry_orders WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Laundry order not found');
    if (['DELIVERED', 'RETURNED_TO_STORE', 'CANCELLED'].includes(old.status)) throw Errors.invalidStatus('laundry order', old.status, 'cancel');
    if (old.folio_item_id) await reverseFolioItem(c, old.folio_item_id, `Laundry ${old.number} cancelled: ${b.reason}`, req.user!);
    const o = (await c.query(`UPDATE laundry_orders SET status='CANCELLED', notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']' WHERE id=$1 RETURNING *`, [old.id, b.reason])).rows[0];
    await c.query(`INSERT INTO laundry_status_history (order_id, status, user_id) VALUES ($1,'CANCELLED',$2)`, [old.id, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'laundry_order', entityId: old.id, reason: b.reason }, c);
    return o;
  });
  res.json(out);
}));
