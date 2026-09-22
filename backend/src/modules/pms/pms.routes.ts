import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, getPagination, paged, optionalStr, dateStr, sendExport, ymd, addDays , isExport } from '../../core/http';
import { requirePermission, hasPermission, getLimit } from '../../middleware/auth';
import { crudRouter } from '../../core/crud';
import { NotFound, BadRequest, Forbidden, Errors } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { nextNumber } from '../../core/numbering';
import * as resSvc from './reservations.service';
import * as staySvc from './stay.service';
import * as folioSvc from './folio.service';
import { resolvePaymentMethodId } from '../finance/payments.service';
import { LIMIT_CODES } from '../../core/permissions';

// ---------------- Guests ----------------
export const guestsRouter = crudRouter({
  table: 'guests', entity: 'guest', permissions: { view: 'guests.view', create: 'guests.create', edit: 'guests.edit' },
  searchColumns: ['first_name', 'last_name', 'phone', 'email', 'id_number', 'guest_no', 'company_name'], defaultSort: 'created_at', filters: { type: 'type', vip: 'vip_level', customer_id: 'customer_id' },
  selectSql: `SELECT t.*, t.first_name || ' ' || t.last_name AS full_name, c.name AS customer_name,
    (SELECT COUNT(*) FROM stays s WHERE s.guest_id=t.id)::int AS stay_count,
    (SELECT MAX(check_out_at) FROM stays s WHERE s.guest_id=t.id) AS last_stay,
    (SELECT COALESCE(SUM(fi.amount),0) FROM folios f JOIN folio_items fi ON fi.folio_id=f.id WHERE f.guest_id=t.id AND f.status='OPEN' AND NOT fi.is_reversed AND fi.reverses_id IS NULL) AS open_balance
    FROM guests t LEFT JOIN customers c ON c.id=t.customer_id`,
  createSchema: z.object({ type: z.enum(['INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'GROUP', 'GOVERNMENT']).default('INDIVIDUAL'), title: optionalStr, first_name: z.string().min(1), last_name: z.string().default(''), gender: optionalStr, date_of_birth: z.string().nullable().optional(),
    nationality: optionalStr, id_type: optionalStr, id_number: optionalStr, phone: optionalStr, email: optionalStr, address: optionalStr, city: optionalStr, country: optionalStr, company_name: optionalStr, customer_id: z.string().uuid().nullable().optional(),
    vip_level: z.coerce.number().int().min(0).max(5).default(0), loyalty_number: optionalStr, preferences: z.record(z.any()).optional(), notes: optionalStr, is_blacklisted: z.boolean().optional() }),
  updateSchema: z.object({ type: z.enum(['INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'GROUP', 'GOVERNMENT']), title: optionalStr, first_name: z.string().min(1), last_name: z.string(), gender: optionalStr, date_of_birth: z.string().nullable(), nationality: optionalStr, id_type: optionalStr, id_number: optionalStr,
    phone: optionalStr, email: optionalStr, address: optionalStr, city: optionalStr, country: optionalStr, company_name: optionalStr, customer_id: z.string().uuid().nullable(), vip_level: z.coerce.number().int().min(0).max(5), loyalty_number: optionalStr, preferences: z.record(z.any()), notes: optionalStr, is_blacklisted: z.boolean() }).partial(),
  beforeCreate: async (data) => { const c = await pool.connect(); try { await c.query('BEGIN'); data.guest_no = await nextNumber(c, 'GUEST', null); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } return data; },
  extraRoutes: (r) => {
    r.get('/:id/history', requirePermission('guests.view'), asyncHandler(async (req, res) => {
      const stays = (await pool.query(`SELECT s.*, r.number AS room_number, rt.name AS room_type_name, res.number AS reservation_number, p.name AS property_name,
          (SELECT COALESCE(SUM(fi.amount),0) FROM folios f JOIN folio_items fi ON fi.folio_id=f.id WHERE f.stay_id=s.id AND fi.item_type IN ('CHARGE','TRANSFER_IN') AND NOT fi.is_reversed) AS total_spend
        FROM stays s JOIN rooms r ON r.id=s.room_id JOIN room_types rt ON rt.id=r.room_type_id JOIN reservations res ON res.id=s.reservation_id JOIN properties p ON p.id=s.property_id WHERE s.guest_id=$1 ORDER BY s.check_in_at DESC`, [req.params.id])).rows;
      const reservations = (await pool.query(`SELECT r.*, rt.name AS room_type_name, rm.number AS room_number FROM reservations r JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.guest_id=$1 ORDER BY r.arrival_date DESC LIMIT 50`, [req.params.id])).rows;
      const payments = (await pool.query(`SELECT p.*, pm.name AS method_name FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.party_type='GUEST' AND p.party_id=$1 ORDER BY p.created_at DESC LIMIT 50`, [req.params.id])).rows;
      const invoices = (await pool.query(`SELECT id, number, invoice_date, total, paid_total, balance, status FROM invoices WHERE guest_id=$1 ORDER BY invoice_date DESC`, [req.params.id])).rows;
      const docs = (await pool.query(`SELECT * FROM guest_documents WHERE guest_id=$1`, [req.params.id])).rows;
      res.json({ stays, reservations, payments, invoices, documents: docs });
    }));
    r.post('/:id/documents', requirePermission('guests.edit'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ doc_type: z.string(), doc_number: optionalStr, issuing_country: optionalStr, expiry_date: z.string().nullable().optional(), attachment_id: z.string().uuid().nullable().optional() }), req.body);
      const row = (await pool.query(`INSERT INTO guest_documents (guest_id, doc_type, doc_number, issuing_country, expiry_date, attachment_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.params.id, b.doc_type, b.doc_number, b.issuing_country, b.expiry_date ?? null, b.attachment_id ?? null])).rows[0];
      res.status(201).json(row);
    }));
    r.post('/:id/merge', requirePermission('guests.merge'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ duplicate_id: z.string().uuid() }), req.body);
      await withTransaction(async (c) => {
        for (const t of ['reservations', 'stays', 'folios', 'invoices', 'reservation_guests', 'guest_documents']) await c.query(`UPDATE ${t} SET guest_id=$1 WHERE guest_id=$2`, [req.params.id, b.duplicate_id]);
        await c.query(`UPDATE payments SET party_id=$1 WHERE party_type='GUEST' AND party_id=$2`, [req.params.id, b.duplicate_id]);
        await c.query(`UPDATE guests SET is_blacklisted=true, notes=COALESCE(notes,'') || ' [MERGED INTO ' || $1 || ']' WHERE id=$2`, [req.params.id, b.duplicate_id]);
        await audit({ ...auditCtx(req), action: 'MERGE', entityType: 'guest', entityId: req.params.id, newValue: { merged: b.duplicate_id } }, c);
      });
      res.json({ ok: true });
    }));
  },
});

// ---------------- Room types ----------------
export const roomTypesRouter = crudRouter({
  table: 'room_types', entity: 'room_type', permissions: { view: 'room_types.view', create: 'room_types.manage', edit: 'room_types.manage', delete: 'room_types.manage' }, propertyScoped: true, softDelete: true,
  searchColumns: ['name', 'code'], defaultSort: 'sort_order', filters: { active: 'is_active' },
  selectSql: `SELECT t.*, (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id=t.id AND r.is_active)::int AS room_count FROM room_types t`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), description: optionalStr, max_adults: z.coerce.number().int().default(2), max_children: z.coerce.number().int().default(1), max_occupancy: z.coerce.number().int().default(3), bed_configuration: optionalStr,
    base_rate: z.coerce.number().default(0), extra_adult_rate: z.coerce.number().default(0), extra_child_rate: z.coerce.number().default(0), amenities: z.array(z.string()).default([]), images: z.array(z.string()).default([]), size_sqm: z.coerce.number().nullable().optional(), sort_order: z.coerce.number().int().default(0), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), description: optionalStr, max_adults: z.coerce.number().int(), max_children: z.coerce.number().int(), max_occupancy: z.coerce.number().int(), bed_configuration: optionalStr, base_rate: z.coerce.number(), extra_adult_rate: z.coerce.number(), extra_child_rate: z.coerce.number(),
    amenities: z.array(z.string()), images: z.array(z.string()), size_sqm: z.coerce.number().nullable(), sort_order: z.coerce.number().int(), is_active: z.boolean() }).partial(),
});

// ---------------- Rate plans ----------------
export const ratePlansRouter = crudRouter({
  table: 'rate_plans', entity: 'rate_plan', permissions: { view: 'room_types.view', create: 'room_types.manage', edit: 'room_types.manage', delete: 'room_types.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['name', 'code'], defaultSort: 'name', filters: { type: 'type', active: 'is_active' },
  selectSql: `SELECT t.*, c.name AS customer_name,
    COALESCE((SELECT json_agg(json_build_object('id', p.id, 'room_type_id', p.room_type_id, 'room_type_name', rt.name, 'date_from', p.date_from, 'date_to', p.date_to, 'days_of_week', p.days_of_week, 'price', p.price, 'extra_adult', p.extra_adult, 'extra_child', p.extra_child, 'priority', p.priority) ORDER BY rt.name, p.date_from) FROM rate_plan_prices p JOIN room_types rt ON rt.id=p.room_type_id WHERE p.rate_plan_id=t.id), '[]') AS prices,
    COALESCE((SELECT json_agg(json_build_object('id', x.id, 'description', x.description, 'charge_category', x.charge_category, 'amount', x.amount, 'frequency', x.frequency, 'revenue_account_id', x.revenue_account_id, 'tax_id', x.tax_id)) FROM rate_plan_components x WHERE x.rate_plan_id=t.id), '[]') AS components
    FROM rate_plans t LEFT JOIN customers c ON c.id=t.customer_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), type: z.string().default('STANDARD'), meal_plan: z.string().default('ROOM_ONLY'), pricing_basis: z.string().default('PER_ROOM'), currency: z.string().length(3).default('KES'), customer_id: z.string().uuid().nullable().optional(), min_nights: z.coerce.number().int().default(1), is_active: z.boolean().default(true), description: optionalStr }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), type: z.string(), meal_plan: z.string(), pricing_basis: z.string(), currency: z.string().length(3), customer_id: z.string().uuid().nullable(), min_nights: z.coerce.number().int(), is_active: z.boolean(), description: optionalStr }).partial(),
  extraRoutes: (r) => {
    r.put('/:id/prices', requirePermission('room_types.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ prices: z.array(z.object({ room_type_id: z.string().uuid(), date_from: z.string().nullable().optional(), date_to: z.string().nullable().optional(), days_of_week: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]), price: z.coerce.number(), extra_adult: z.coerce.number().default(0), extra_child: z.coerce.number().default(0), priority: z.coerce.number().int().default(0) })) }), req.body);
      await withTransaction(async (c) => {
        await c.query(`DELETE FROM rate_plan_prices WHERE rate_plan_id=$1`, [req.params.id]);
        for (const p of b.prices) await c.query(`INSERT INTO rate_plan_prices (rate_plan_id, room_type_id, date_from, date_to, days_of_week, price, extra_adult, extra_child, priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [req.params.id, p.room_type_id, p.date_from ?? null, p.date_to ?? null, p.days_of_week, p.price, p.extra_adult, p.extra_child, p.priority]);
        await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'rate_plan_prices', entityId: req.params.id, newValue: b }, c);
      });
      res.json({ ok: true });
    }));
    r.put('/:id/components', requirePermission('room_types.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ components: z.array(z.object({ description: z.string(), charge_category: z.string(), amount: z.coerce.number(), frequency: z.string().default('PER_STAY'), revenue_account_id: z.string().uuid().nullable().optional(), tax_id: z.string().uuid().nullable().optional() })) }), req.body);
      await withTransaction(async (c) => {
        await c.query(`DELETE FROM rate_plan_components WHERE rate_plan_id=$1`, [req.params.id]);
        for (const x of b.components) await c.query(`INSERT INTO rate_plan_components (rate_plan_id, description, charge_category, amount, frequency, revenue_account_id, tax_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [req.params.id, x.description, x.charge_category, x.amount, x.frequency, x.revenue_account_id ?? null, x.tax_id ?? null]);
      });
      res.json({ ok: true });
    }));
  },
});

// ---------------- Rooms ----------------
export const roomsRouter = crudRouter({
  table: 'rooms', entity: 'room', permissions: { view: 'rooms.view', create: 'rooms.create', edit: 'rooms.edit', delete: 'rooms.edit' }, propertyScoped: true, softDelete: true,
  searchColumns: ['number', 'floor', 'building'], defaultSort: 'number', filters: { room_type_id: 'room_type_id', status: 'status', housekeeping_status: 'housekeeping_status', floor: 'floor', building: 'building', active: 'is_active' },
  selectSql: `SELECT t.*, rt.name AS room_type_name, rt.code AS room_type_code, rt.base_rate, rt.max_occupancy,
      s.id AS stay_id, s.expected_check_out, g.first_name || ' ' || g.last_name AS guest_name, g.vip_level, res.number AS reservation_number,
      (SELECT json_build_object('id', nr.id, 'number', nr.number, 'arrival_date', nr.arrival_date, 'guest', ng.first_name || ' ' || ng.last_name) FROM reservations nr JOIN guests ng ON ng.id=nr.guest_id WHERE nr.room_id=t.id AND nr.status IN ('CONFIRMED','DEPOSIT_PAID') AND nr.arrival_date >= CURRENT_DATE ORDER BY nr.arrival_date LIMIT 1) AS next_reservation,
      (SELECT COUNT(*) FROM maintenance_requests m WHERE m.room_id=t.id AND m.status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED'))::int AS open_maintenance
    FROM rooms t JOIN room_types rt ON rt.id=t.room_type_id
    LEFT JOIN stays s ON s.room_id=t.id AND s.status='IN_HOUSE' LEFT JOIN guests g ON g.id=s.guest_id LEFT JOIN reservations res ON res.id=s.reservation_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), room_type_id: z.string().uuid(), number: z.string().min(1), floor: optionalStr, building: optionalStr, rate_override: z.coerce.number().nullable().optional(), amenities: z.array(z.string()).default([]), features: z.array(z.string()).default([]), phone_extension: optionalStr, notes: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ room_type_id: z.string().uuid(), number: z.string().min(1), floor: optionalStr, building: optionalStr, rate_override: z.coerce.number().nullable(), amenities: z.array(z.string()), features: z.array(z.string()), phone_extension: optionalStr, notes: optionalStr, is_active: z.boolean() }).partial(),
  extraRoutes: (r) => {
    r.post('/:id/block', requirePermission('rooms.block'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ block_type: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE', 'BLOCKED']), start_date: dateStr, end_date: dateStr, reason: z.string().min(2), maintenance_request_id: z.string().uuid().nullable().optional() }), req.body);
      const out = await withTransaction(async (c) => {
        const room = (await c.query(`SELECT * FROM rooms WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!room) throw new NotFound('Room not found');
        if (room.status === 'OCCUPIED') throw new BadRequest('Cannot block an occupied room; move the guest first');
        const conflict = await c.query(`SELECT number FROM reservations WHERE room_id=$1 AND status IN ('CONFIRMED','DEPOSIT_PAID') AND arrival_date <= $3::date AND departure_date > $2::date`, [req.params.id, b.start_date, b.end_date]);
        if (conflict.rows[0]) throw new BadRequest(`Room has reservation ${conflict.rows[0].number} in this period; reassign it first`);
        const block = (await c.query(`INSERT INTO room_blocks (room_id, block_type, start_date, end_date, reason, maintenance_request_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.params.id, b.block_type, b.start_date, b.end_date, b.reason, b.maintenance_request_id ?? null, req.user!.id])).rows[0];
        if (b.start_date <= new Date().toISOString().slice(0, 10)) await c.query(`UPDATE rooms SET status=$2, housekeeping_status=CASE WHEN $2='OUT_OF_ORDER' THEN 'OUT_OF_ORDER' ELSE housekeeping_status END WHERE id=$1`, [req.params.id, b.block_type]);
        await audit({ ...auditCtx(req), action: 'BLOCK', entityType: 'room', entityId: req.params.id, newValue: block, reason: b.reason }, c);
        return block;
      });
      res.status(201).json(out);
    }));
    r.post('/:id/unblock', requirePermission('rooms.block'), asyncHandler(async (req, res) => {
      await withTransaction(async (c) => {
        await c.query(`UPDATE room_blocks SET released_at=now() WHERE room_id=$1 AND released_at IS NULL`, [req.params.id]);
        await c.query(`UPDATE rooms SET status='AVAILABLE', housekeeping_status=CASE WHEN housekeeping_status='OUT_OF_ORDER' THEN 'DIRTY' ELSE housekeeping_status END WHERE id=$1 AND status IN ('OUT_OF_ORDER','OUT_OF_SERVICE','BLOCKED')`, [req.params.id]);
        await audit({ ...auditCtx(req), action: 'UNBLOCK', entityType: 'room', entityId: req.params.id, reason: req.body?.reason }, c);
      });
      res.json({ ok: true });
    }));
    r.get('/:id/blocks', requirePermission('rooms.view'), asyncHandler(async (req, res) => {
      res.json({ data: (await pool.query(`SELECT b.*, u.full_name AS created_by_name FROM room_blocks b LEFT JOIN users u ON u.id=b.created_by WHERE b.room_id=$1 ORDER BY b.start_date DESC`, [req.params.id])).rows });
    }));
    r.post('/:id/housekeeping-status', requirePermission('housekeeping.update'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ status: z.enum(['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER']), notes: optionalStr }), req.body);
      if (b.status === 'INSPECTED' && !hasPermission(req, 'housekeeping.inspect')) throw new Forbidden('Inspection permission required');
      const old = (await pool.query(`SELECT housekeeping_status FROM rooms WHERE id=$1`, [req.params.id])).rows[0];
      const row = (await pool.query(`UPDATE rooms SET housekeeping_status=$2 WHERE id=$1 RETURNING *`, [req.params.id, b.status])).rows[0];
      await audit({ ...auditCtx(req), action: 'HOUSEKEEPING_STATUS', entityType: 'room', entityId: req.params.id, oldValue: old, newValue: { housekeeping_status: b.status }, reason: b.notes });
      res.json(row);
    }));
    r.get('/board/status', requirePermission('rooms.view'), asyncHandler(async (req, res) => {
      const rows = (await pool.query(`SELECT status, housekeeping_status, COUNT(*)::int AS count FROM rooms WHERE property_id=$1 AND is_active GROUP BY status, housekeeping_status`, [req.propertyId])).rows;
      res.json({ data: rows });
    }));
  },
});

// ---------------- Reservations ----------------
export const reservationsRouter = Router();
const resSelect = `SELECT r.*, g.first_name || ' ' || g.last_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email, g.vip_level, rt.name AS room_type_name, rm.number AS room_number, c.name AS customer_name, rp.name AS rate_plan_name, u.full_name AS created_by_name,
  (r.departure_date - r.arrival_date) AS nights, s.id AS stay_id,
  (SELECT COALESCE(SUM(fi.amount),0) FROM folios f JOIN folio_items fi ON fi.folio_id=f.id WHERE f.reservation_id=r.id AND NOT fi.is_reversed AND fi.reverses_id IS NULL) AS folio_balance
  FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id LEFT JOIN users u ON u.id=r.created_by LEFT JOIN stays s ON s.reservation_id=r.id AND s.status='IN_HOUSE'`;

reservationsRouter.get('/', requirePermission('reservations.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'arrival_date');
  const where: string[] = ['r.property_id=$1']; const params: any[] = [req.propertyId];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  if (req.query.status) add(`r.status = ANY(string_to_array($P, ','))`, req.query.status);
  if (req.query.from) add('r.departure_date > $P', req.query.from);
  if (req.query.to) add('r.arrival_date <= $P', req.query.to);
  if (req.query.arrival) add('r.arrival_date = $P', req.query.arrival);
  if (req.query.departure) add('r.departure_date = $P', req.query.departure);
  if (req.query.guest_id) add('r.guest_id = $P', req.query.guest_id);
  if (req.query.room_id) add('r.room_id = $P', req.query.room_id);
  if (req.query.source) add('r.source = $P', req.query.source);
  if (p.search) add(`(r.number ILIKE $P OR g.first_name ILIKE $P OR g.last_name ILIKE $P OR g.phone ILIKE $P OR rm.number ILIKE $P OR c.name ILIKE $P)`, `%${p.search}%`);
  const w = ' WHERE ' + where.join(' AND ');
  const sort = ['arrival_date', 'departure_date', 'created_at', 'status', 'number'].includes(p.sort!) ? `r.${p.sort}` : 'r.arrival_date';
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${resSelect}${w}) x`, params)).rows[0].count);
  const rows = (await pool.query(`${resSelect}${w} ORDER BY ${sort} ${p.order}, r.created_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  if (isExport(req)) { if (!hasPermission(req, 'reports.export')) throw new Forbidden(); return sendExport(res, req, rows, 'reservations'); }
  res.json(paged(rows, total, p));
}));

reservationsRouter.get('/availability', requirePermission('reservations.view'), asyncHandler(async (req, res) => {
  const q = validate(z.object({ arrival: dateStr, departure: dateStr, room_type_id: z.string().uuid().optional(), exclude: z.string().uuid().optional() }), req.query);
  const summary = await resSvc.availabilitySummary(req.propertyId!, q.arrival, q.departure);
  const client = await pool.connect();
  try {
    const rooms = await resSvc.availableRooms(client, req.propertyId!, q.room_type_id ?? null, q.arrival, q.departure, q.exclude);
    res.json({ summary, rooms });
  } finally { client.release(); }
}));

reservationsRouter.get('/quote', requirePermission('reservations.view'), asyncHandler(async (req, res) => {
  const q = validate(z.object({ room_type_id: z.string().uuid(), rate_plan_id: z.string().uuid().optional(), arrival: dateStr, departure: dateStr, adults: z.coerce.number().int().default(1), children: z.coerce.number().int().default(0) }), req.query);
  const client = await pool.connect();
  try { res.json(await resSvc.quoteStay(client, q.room_type_id, q.rate_plan_id ?? null, q.arrival, q.departure, q.adults, q.children)); } finally { client.release(); }
}));

reservationsRouter.get('/calendar', requirePermission('reservations.view'), asyncHandler(async (req, res) => {
  const q = validate(z.object({ from: dateStr, to: dateStr, room_type_id: z.string().uuid().optional(), building: z.string().optional() }), req.query);
  const rooms = (await pool.query(`SELECT r.id, r.number, r.floor, r.building, r.status, r.housekeeping_status, rt.name AS room_type_name, rt.id AS room_type_id FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id WHERE r.property_id=$1 AND r.is_active AND ($2::uuid IS NULL OR r.room_type_id=$2) AND ($3::text IS NULL OR r.building=$3) ORDER BY r.building, r.floor, r.number`, [req.propertyId, q.room_type_id ?? null, q.building ?? null])).rows;
  const reservations = (await pool.query(`SELECT r.id, r.number, r.room_id, r.room_type_id, r.arrival_date, r.departure_date, r.status, r.adults, r.children, r.rate, g.first_name || ' ' || g.last_name AS guest_name, g.vip_level, rt.name AS room_type_name
      FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id WHERE r.property_id=$1 AND r.status IN ('TENTATIVE','CONFIRMED','DEPOSIT_PAID','CHECKED_IN') AND r.arrival_date < $3::date AND r.departure_date > $2::date`, [req.propertyId, q.from, q.to])).rows;
  const blocks = (await pool.query(`SELECT b.* FROM room_blocks b JOIN rooms r ON r.id=b.room_id WHERE r.property_id=$1 AND b.released_at IS NULL AND b.start_date <= $3::date AND b.end_date >= $2::date`, [req.propertyId, q.from, q.to])).rows;
  res.json({ rooms, reservations, blocks });
}));

reservationsRouter.get('/:id', requirePermission('reservations.view'), asyncHandler(async (req, res) => {
  const row = (await pool.query(`${resSelect} WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!row) throw new NotFound('Reservation not found');
  const guests = (await pool.query(`SELECT g.id, g.first_name || ' ' || g.last_name AS name, g.id_type, g.id_number, g.nationality, rg.is_primary FROM reservation_guests rg JOIN guests g ON g.id=rg.guest_id WHERE rg.reservation_id=$1 ORDER BY rg.is_primary DESC`, [req.params.id])).rows;
  const history = (await pool.query(`SELECT h.*, u.full_name AS user_name FROM reservation_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.reservation_id=$1 ORDER BY h.created_at`, [req.params.id])).rows;
  const folios = (await pool.query(`SELECT id, number, type, status FROM folios WHERE reservation_id=$1`, [req.params.id])).rows;
  const payments = (await pool.query(`SELECT p.*, pm.name AS method_name FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.source_type='RESERVATION' AND p.source_id=$1 ORDER BY p.created_at`, [req.params.id])).rows;
  res.json({ ...row, guests, history, folios, payments });
}));

const reservationSchema = z.object({ guest_id: z.string().uuid(), customer_id: z.string().uuid().nullable().optional(), room_type_id: z.string().uuid(), room_id: z.string().uuid().nullable().optional(), rate_plan_id: z.string().uuid().nullable().optional(),
  arrival_date: dateStr, departure_date: dateStr, adults: z.coerce.number().int().min(1).default(1), children: z.coerce.number().int().min(0).default(0), rate: z.coerce.number().nullable().optional(), meal_plan: z.string().optional(), source: z.string().optional(),
  status: z.enum(['INQUIRY', 'TENTATIVE', 'CONFIRMED']).optional(), deposit_required: z.coerce.number().optional(), special_requests: optionalStr, notes: optionalStr, eta: optionalStr, external_ref: optionalStr, group_id: z.string().uuid().nullable().optional(), additional_guest_ids: z.array(z.string().uuid()).optional(), allow_overbooking: z.boolean().optional() });

reservationsRouter.post('/', requirePermission('reservations.create'), asyncHandler(async (req, res) => {
  const b = validate(reservationSchema, req.body);
  if (b.departure_date <= b.arrival_date) throw new BadRequest('Departure must be after arrival');
  res.status(201).json(await resSvc.createReservation(b, req.user!, req.propertyId!));
}));

reservationsRouter.post('/group', requirePermission('reservations.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ rooms: z.array(reservationSchema).min(1), group_name: z.string().optional() }), req.body);
  const created: any[] = [];
  let groupId: string | null = null;
  for (const r of b.rooms) {
    const row = await resSvc.createReservation({ ...r, group_id: groupId }, req.user!, req.propertyId!);
    if (!groupId) { groupId = row.id; await pool.query(`UPDATE reservations SET group_id=id, notes=COALESCE(notes,'') || $2 WHERE id=$1`, [row.id, b.group_name ? ` [Group: ${b.group_name}]` : '']); }
    created.push(row);
  }
  res.status(201).json({ group_id: groupId, reservations: created });
}));

reservationsRouter.put('/:id', requirePermission('reservations.modify'), asyncHandler(async (req, res) => {
  const b = validate(reservationSchema.partial().extend({ reason: optionalStr, status: z.enum(['INQUIRY', 'TENTATIVE', 'CONFIRMED', 'DEPOSIT_PAID']).optional() }), req.body);
  res.json(await resSvc.modifyReservation(req.params.id, b as any, req.user!));
}));
reservationsRouter.post('/:id/cancel', requirePermission('reservations.cancel'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  res.json(await resSvc.cancelReservation(req.params.id, b.reason, req.user!));
}));
reservationsRouter.post('/:id/no-show', requirePermission('reservations.no_show'), asyncHandler(async (req, res) => {
  res.json(await resSvc.cancelReservation(req.params.id, req.body?.reason ?? 'No show', req.user!, true));
}));
reservationsRouter.post('/:id/split', requirePermission('reservations.modify'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ split_date: dateStr }), req.body);
  res.json(await resSvc.splitReservation(req.params.id, b.split_date, req.user!));
}));
reservationsRouter.post('/:id/merge', requirePermission('reservations.modify'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ merge_id: z.string().uuid() }), req.body);
  res.json(await resSvc.mergeReservations(req.params.id, b.merge_id, req.user!));
}));
reservationsRouter.post('/:id/deposit', requirePermission('payments.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), amount: z.coerce.number().positive(), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional() }), req.body);
  const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code);
  const out = await withTransaction(async (c) => {
    const r = (await c.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!r) throw new NotFound('Reservation not found');
    if (['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'].includes(r.status)) throw Errors.invalidStatus('reservation', r.status, 'take deposit');
    // pre-arrival deposit: folio opened against the reservation, converted at check-in
    let folio = (await c.query(`SELECT * FROM folios WHERE reservation_id=$1 AND status='OPEN' LIMIT 1`, [r.id])).rows[0];
    if (!folio) folio = await folioSvc.openFolio(c, { propertyId: r.property_id, reservationId: r.id, guestId: r.guest_id, customerId: r.customer_id, currency: r.currency });
    const item = await folioSvc.postFolioPayment(c, { folioId: folio.id, paymentMethodId: methodId, amount: b.amount, reference: b.reference, kind: 'DEPOSIT', cashierShiftId: b.cashier_shift_id, userId: req.user!.id });
    await c.query(`UPDATE reservations SET deposit_paid = deposit_paid + $2, status = CASE WHEN status IN ('INQUIRY','TENTATIVE','CONFIRMED') THEN 'DEPOSIT_PAID' ELSE status END WHERE id=$1`, [r.id, b.amount]);
    await c.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'DEPOSIT',$2,$3)`, [r.id, JSON.stringify({ amount: b.amount }), req.user!.id]);
    return { folio, item };
  });
  res.status(201).json(out);
}));

// ---------------- Check-in / stays / checkout ----------------
export const checkinsRouter = Router();
checkinsRouter.post('/', requirePermission('checkin.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({
    reservation_id: z.string().uuid().optional(),
    walk_in: z.object({ guest_id: z.string().uuid(), room_type_id: z.string().uuid(), departure_date: dateStr, adults: z.coerce.number().int().min(1), children: z.coerce.number().int().min(0).default(0), rate: z.coerce.number().optional(), rate_plan_id: z.string().uuid().nullable().optional(), meal_plan: z.string().optional(), source: z.string().optional(), customer_id: z.string().uuid().nullable().optional() }).optional(),
    room_id: z.string().uuid(), adults: z.coerce.number().int().optional(), children: z.coerce.number().int().optional(), rate: z.coerce.number().optional(), registration: z.record(z.any()).optional(),
    deposit: z.object({ payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), amount: z.coerce.number().min(0), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional() }).nullable().optional(),
    extra_beds: z.coerce.number().int().optional(), additional_guest_ids: z.array(z.string().uuid()).optional(), notes: optionalStr,
  }), req.body);
  if (!b.reservation_id && !b.walk_in) throw new BadRequest('Either reservation_id or walk_in details are required');
  const depositMethodId = b.deposit ? await resolvePaymentMethodId(b.deposit.payment_method_id, b.deposit.payment_method_code) : null;
  const out = await staySvc.checkIn({ reservationId: b.reservation_id, walkIn: b.walk_in, roomId: b.room_id, adults: b.adults, children: b.children, rate: b.rate, registration: b.registration,
    deposit: b.deposit && b.deposit.amount > 0 ? { paymentMethodId: depositMethodId!, amount: b.deposit.amount, reference: b.deposit.reference, cashierShiftId: b.deposit.cashier_shift_id } : null,
    extraBeds: b.extra_beds, additionalGuestIds: b.additional_guest_ids, notes: b.notes } as any, req.user!, req.propertyId!);
  // Pre-arrival deposits (folio opened against the reservation) are transferred into the stay folio
  if (b.reservation_id) {
    await withTransaction(async (c) => {
      const pre = (await c.query(`SELECT * FROM folios WHERE reservation_id=$1 AND stay_id IS NULL AND status='OPEN'`, [b.reservation_id])).rows;
      for (const f of pre) {
        const items = (await c.query(`SELECT id FROM folio_items WHERE folio_id=$1 AND NOT is_reversed AND reverses_id IS NULL`, [f.id])).rows;
        for (const it of items) await folioSvc.transferFolioItem(c, it.id, out.folio.id, req.user!, 'Pre-arrival deposit applied at check-in');
        await c.query(`UPDATE folios SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE id=$1`, [f.id, req.user!.id]);
      }
    });
  }
  res.status(201).json(out);
}));

export const staysRouter = Router();
staysRouter.get('/', requirePermission('reservations.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'check_in_at');
  const params: any[] = [req.propertyId]; const where = ['s.property_id=$1'];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  add('s.status=$P', req.query.status ?? 'IN_HOUSE');
  if (req.query.departure) add('s.expected_check_out=$P', req.query.departure);
  if (req.query.due) add('s.expected_check_out<=$P', req.query.due);
  if (req.query.guest_id) add('s.guest_id=$P', req.query.guest_id);
  if (req.query.room_id) add('s.room_id=$P', req.query.room_id);
  if (p.search) add(`(r.number ILIKE $P OR g.first_name ILIKE $P OR g.last_name ILIKE $P OR res.number ILIKE $P)`, `%${p.search}%`);
  const sql = `SELECT s.*, r.number AS room_number, rt.name AS room_type_name, g.first_name || ' ' || g.last_name AS guest_name, g.vip_level, g.phone AS guest_phone, res.number AS reservation_number, res.meal_plan, res.customer_id, c.name AS customer_name,
      (SELECT COALESCE(SUM(fi.amount),0) FROM folios f JOIN folio_items fi ON fi.folio_id=f.id WHERE f.stay_id=s.id AND NOT fi.is_reversed AND fi.reverses_id IS NULL) AS balance,
      (SELECT f.id FROM folios f WHERE f.stay_id=s.id AND f.type='GUEST' ORDER BY f.created_at LIMIT 1) AS folio_id
    FROM stays s JOIN rooms r ON r.id=s.room_id JOIN room_types rt ON rt.id=r.room_type_id JOIN guests g ON g.id=s.guest_id JOIN reservations res ON res.id=s.reservation_id LEFT JOIN customers c ON c.id=res.customer_id WHERE ${where.join(' AND ')}`;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${sql}) x`, params)).rows[0].count);
  const rows = (await pool.query(`${sql} ORDER BY r.number LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  res.json(paged(rows, total, p));
}));
staysRouter.get('/:id', requirePermission('reservations.view'), asyncHandler(async (req, res) => res.json(await staySvc.stayDetail(req.params.id))));
staysRouter.get('/:id/folio', requirePermission('folios.view'), asyncHandler(async (req, res) => {
  const f = (await pool.query(`SELECT id FROM folios WHERE stay_id=$1 ORDER BY (type='GUEST') DESC, (status='OPEN') DESC, created_at LIMIT 1`, [req.params.id])).rows[0];
  if (!f) throw new NotFound('No folio for this stay');
  res.json(await folioSvc.folioDetail(f.id));
}));
staysRouter.post('/:id/move-room', requirePermission('reservations.modify'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ to_room_id: z.string().uuid(), reason: z.string().min(2), new_rate: z.coerce.number().optional() }), req.body);
  res.json(await staySvc.moveRoom(req.params.id, b.to_room_id, b.reason, req.user!, b.new_rate));
}));
staysRouter.post('/:id/extend', requirePermission('reservations.modify'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ new_departure: dateStr, reason: optionalStr }), req.body);
  const stay = (await pool.query(`SELECT reservation_id FROM stays WHERE id=$1`, [req.params.id])).rows[0];
  if (!stay) throw new NotFound('Stay not found');
  res.json(await resSvc.modifyReservation(stay.reservation_id, { departure_date: b.new_departure, reason: b.reason ?? 'Stay extended/shortened' }, req.user!));
}));
staysRouter.post('/:id/post-room-charge', requirePermission('folios.post'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ business_date: dateStr }), req.body);
  const item = await withTransaction((c) => staySvc.postRoomCharge(c, req.params.id, b.business_date, req.user!.id));
  res.json(item ?? { skipped: true });
}));

export const checkoutsRouter = Router();
checkoutsRouter.get('/:stayId/preview', requirePermission('checkout.create'), asyncHandler(async (req, res) => {
  const stay = await staySvc.stayDetail(req.params.stayId);
  const folio = (await pool.query(`SELECT id FROM folios WHERE stay_id=$1 AND type='GUEST' ORDER BY created_at LIMIT 1`, [req.params.stayId])).rows[0];
  const detail = folio ? await folioSvc.folioDetail(folio.id) : null;
  const openOrders = (await pool.query(`SELECT o.id, o.number, o.status, o.total, ol.name AS outlet_name FROM orders o JOIN outlets ol ON ol.id=o.outlet_id WHERE o.stay_id=$1 AND o.status IN ('OPEN','BILLED')`, [req.params.stayId])).rows;
  // nights not yet charged
  const client = await pool.connect();
  let pendingNights: string[] = [];
  try {
    const { currentBusinessDate } = await import('../finance/accounting.service');
    const today = await currentBusinessDate(client, stay.property_id, req.user!.id);
    let d = new Date((stay.last_room_charge_date ? addDays(ymd(stay.last_room_charge_date), 1) : ymd(new Date(stay.check_in_at))) + 'T00:00:00Z');
    while (d < new Date(today + 'T00:00:00Z')) { pendingNights.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
    const charged = detail ? detail.items.filter((i: any) => i.source_type === 'ROOM_CHARGE' && !i.is_reversed).length : 0;
    if (!charged && !pendingNights.length) pendingNights.push(today);
  } finally { client.release(); }
  const projected = (detail?.totals.balance ?? 0) + pendingNights.length * Number(stay.rate);
  res.json({ stay, folio: detail, open_orders: openOrders, pending_nights: pendingNights, projected_balance: Math.round(projected * 100) / 100 });
}));
const paymentLine = z.object({ payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), amount: z.coerce.number().min(0), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional() });
checkoutsRouter.post('/', requirePermission('checkout.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ stay_id: z.string().uuid(), payments: z.array(paymentLine).optional(), refund: paymentLine.nullable().optional(), late_checkout_fee: z.coerce.number().min(0).optional(), allow_balance: z.boolean().optional(), notes: optionalStr, post_tonight_room_charge: z.boolean().optional() }), req.body);
  if (b.allow_balance && !hasPermission(req, 'receivables.manage')) throw new Forbidden('Checking out with an outstanding balance requires receivables permission');
  const payments = [] as any[];
  for (const p of b.payments ?? []) if (p.amount > 0) payments.push({ paymentMethodId: await resolvePaymentMethodId(p.payment_method_id, p.payment_method_code), amount: p.amount, reference: p.reference, cashierShiftId: p.cashier_shift_id });
  const refund = b.refund && b.refund.amount > 0 ? { paymentMethodId: await resolvePaymentMethodId(b.refund.payment_method_id, b.refund.payment_method_code), amount: b.refund.amount, reference: b.refund.reference, cashierShiftId: b.refund.cashier_shift_id } : null;
  if (refund && !hasPermission(req, 'payments.refund')) throw Errors.unauthorizedRefund();
  res.status(201).json(await staySvc.checkOut({ stayId: b.stay_id, payments, refund, lateCheckoutFee: b.late_checkout_fee, allowBalance: b.allow_balance, notes: b.notes, postTonightRoomCharge: b.post_tonight_room_charge } as any, req.user!));
}));

// ---------------- Folios ----------------
export const foliosRouter = Router();
foliosRouter.get('/', requirePermission('folios.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'created_at');
  const params: any[] = [req.propertyId]; const where = ['f.property_id=$1'];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  if (req.query.status) add('f.status=$P', req.query.status);
  if (req.query.type) add('f.type=$P', req.query.type);
  if (req.query.guest_id) add('f.guest_id=$P', req.query.guest_id);
  if (p.search) add(`(f.number ILIKE $P OR g.first_name ILIKE $P OR g.last_name ILIKE $P OR r.number ILIKE $P)`, `%${p.search}%`);
  const sql = `SELECT f.*, g.first_name || ' ' || g.last_name AS guest_name, r.number AS room_number, c.name AS customer_name,
      (SELECT COALESCE(SUM(fi.amount),0) FROM folio_items fi WHERE fi.folio_id=f.id AND NOT fi.is_reversed AND fi.reverses_id IS NULL) AS balance,
      (SELECT COALESCE(SUM(fi.amount),0) FROM folio_items fi WHERE fi.folio_id=f.id AND NOT fi.is_reversed AND fi.reverses_id IS NULL AND fi.amount > 0) AS charges,
      (SELECT COALESCE(-SUM(fi.amount),0) FROM folio_items fi WHERE fi.folio_id=f.id AND NOT fi.is_reversed AND fi.reverses_id IS NULL AND fi.amount < 0) AS credits
    FROM folios f LEFT JOIN guests g ON g.id=f.guest_id LEFT JOIN stays s ON s.id=f.stay_id LEFT JOIN rooms r ON r.id=s.room_id LEFT JOIN customers c ON c.id=f.customer_id WHERE ${where.join(' AND ')}`;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${sql}) x`, params)).rows[0].count);
  const rows = (await pool.query(`${sql} ORDER BY f.created_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  res.json(paged(rows, total, p));
}));
foliosRouter.get('/:id', requirePermission('folios.view'), asyncHandler(async (req, res) => res.json(await folioSvc.folioDetail(req.params.id))));
foliosRouter.post('/:id/charges', requirePermission('folios.post'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ category: z.string(), description: z.string().min(1), quantity: z.coerce.number().positive().default(1), unit_price: z.coerce.number(), discount: z.coerce.number().min(0).default(0), tax_id: z.string().uuid().nullable().optional(), apply_service_charge: z.boolean().default(false), outlet_id: z.string().uuid().nullable().optional(), reason: optionalStr }), req.body);
  if (b.discount > 0) {
    if (!hasPermission(req, 'folios.discount')) throw new Forbidden('Discount permission required');
    const pct = (b.discount / (b.quantity * b.unit_price)) * 100;
    const limit = getLimit(req, LIMIT_CODES.DISCOUNT_PERCENT, 0);
    if (pct > limit) throw Errors.unauthorizedDiscount(limit);
  }
  const item = await withTransaction((c) => folioSvc.postCharge(c, { folioId: req.params.id, category: b.category, description: b.description, quantity: b.quantity, unitPrice: b.unit_price, discount: b.discount, taxId: b.tax_id, applyServiceCharge: b.apply_service_charge, outletId: b.outlet_id, userId: req.user!.id, reason: b.reason }));
  await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'folio_item', entityId: item.id, newValue: item, reason: b.reason });
  res.status(201).json(item);
}));
foliosRouter.post('/:id/payments', requirePermission('payments.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), amount: z.coerce.number().positive(), reference: optionalStr, kind: z.enum(['PAYMENT', 'DEPOSIT', 'REFUND']).default('PAYMENT'), cashier_shift_id: z.string().uuid().nullable().optional(), idempotency_key: optionalStr, notes: optionalStr }), req.body);
  b.payment_method_id = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code);
  if (b.kind === 'REFUND' && !hasPermission(req, 'payments.refund')) throw Errors.unauthorizedRefund();
  if (b.kind === 'REFUND' && b.amount > getLimit(req, LIMIT_CODES.REFUND_AMOUNT, Number.MAX_SAFE_INTEGER)) throw new Forbidden('Refund exceeds your authority limit');
  const item = await withTransaction((c) => folioSvc.postFolioPayment(c, { folioId: req.params.id, paymentMethodId: b.payment_method_id!, amount: b.amount, reference: b.reference, kind: b.kind, cashierShiftId: b.cashier_shift_id, userId: req.user!.id, idempotencyKey: b.idempotency_key, notes: b.notes }));
  res.status(201).json(item);
}));
foliosRouter.post('/:id/items/:itemId/reverse', requirePermission('folios.reverse'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3) }), req.body);
  res.json(await withTransaction((c) => folioSvc.reverseFolioItem(c, req.params.itemId, b.reason, req.user!)));
}));
foliosRouter.post('/:id/items/:itemId/transfer', requirePermission('folios.transfer'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ to_folio_id: z.string().uuid(), reason: optionalStr }), req.body);
  res.json(await withTransaction((c) => folioSvc.transferFolioItem(c, req.params.itemId, b.to_folio_id, req.user!, b.reason ?? undefined)));
}));
foliosRouter.post('/:id/split', requirePermission('folios.transfer'), asyncHandler(async (req, res) => {
  // create a secondary folio for the same stay and move selected items
  const b = validate(z.object({ item_ids: z.array(z.string().uuid()).min(1), type: z.enum(['GUEST', 'COMPANY']).default('GUEST'), customer_id: z.string().uuid().nullable().optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const f = (await c.query(`SELECT * FROM folios WHERE id=$1`, [req.params.id])).rows[0];
    if (!f) throw new NotFound('Folio not found');
    const nf = await folioSvc.openFolio(c, { propertyId: f.property_id, type: b.type, stayId: f.stay_id, reservationId: f.reservation_id, guestId: f.guest_id, customerId: b.customer_id ?? f.customer_id, currency: f.currency });
    for (const id of b.item_ids) await folioSvc.transferFolioItem(c, id, nf.id, req.user!, 'Folio split');
    return nf;
  });
  res.status(201).json(out);
}));
foliosRouter.post('/:id/close', requirePermission('folios.post'), asyncHandler(async (req, res) => {
  const bal = await folioSvc.folioBalance(pool, req.params.id);
  if (Math.abs(bal.balance) > 0.005) throw new BadRequest(`Folio balance ${bal.balance.toFixed(2)} must be zero to close`);
  const row = (await pool.query(`UPDATE folios SET status='SETTLED', closed_at=now(), closed_by=$2 WHERE id=$1 AND status='OPEN' RETURNING *`, [req.params.id, req.user!.id])).rows[0];
  res.json(row);
}));

// ---------------- Invoices ----------------
export const invoicesRouter = Router();
invoicesRouter.get('/', requirePermission('folios.view', 'receivables.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'invoice_date');
  const params: any[] = [req.propertyId]; const where = ['i.property_id=$1'];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  if (req.query.status) add('i.status=$P', req.query.status);
  if (req.query.type) add('i.type=$P', req.query.type);
  if (req.query.customer_id) add('i.customer_id=$P', req.query.customer_id);
  if (req.query.from) add('i.invoice_date>=$P', req.query.from);
  if (req.query.to) add('i.invoice_date<=$P', req.query.to);
  if (p.search) add(`(i.number ILIKE $P OR g.first_name ILIKE $P OR g.last_name ILIKE $P OR c.name ILIKE $P)`, `%${p.search}%`);
  const sql = `SELECT i.*, g.first_name || ' ' || g.last_name AS guest_name, c.name AS customer_name, f.number AS folio_number FROM invoices i LEFT JOIN guests g ON g.id=i.guest_id LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN folios f ON f.id=i.folio_id WHERE ${where.join(' AND ')}`;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${sql}) x`, params)).rows[0].count);
  const rows = (await pool.query(`${sql} ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  if (isExport(req)) return sendExport(res, req, rows, 'invoices');
  res.json(paged(rows, total, p));
}));
invoicesRouter.get('/:id', requirePermission('folios.view', 'receivables.view'), asyncHandler(async (req, res) => {
  const row = (await pool.query(`SELECT i.*, g.first_name || ' ' || g.last_name AS guest_name, g.address AS guest_address, g.email AS guest_email, c.name AS customer_name, c.address AS customer_address, c.tax_number AS customer_tax_number, p.name AS property_name, p.address AS property_address, p.phone AS property_phone, p.email AS property_email, p.tax_number AS property_tax_number, p.logo_url,
      f.number AS folio_number, u.full_name AS created_by_name,
      COALESCE((SELECT json_agg(json_build_object('amount', ip.amount, 'number', pm.number, 'method', m.name, 'date', pm.created_at)) FROM invoice_payments ip JOIN payments pm ON pm.id=ip.payment_id JOIN payment_methods m ON m.id=pm.payment_method_id WHERE ip.invoice_id=i.id), '[]') AS payments
    FROM invoices i LEFT JOIN guests g ON g.id=i.guest_id LEFT JOIN customers c ON c.id=i.customer_id JOIN properties p ON p.id=i.property_id LEFT JOIN folios f ON f.id=i.folio_id LEFT JOIN users u ON u.id=i.created_by WHERE i.id=$1`, [req.params.id])).rows[0];
  if (!row) throw new NotFound('Invoice not found');
  if (row.folio_id) row.folio_payments = (await pool.query(`SELECT description, amount, posted_at FROM folio_items WHERE folio_id=$1 AND item_type IN ('PAYMENT','DEPOSIT','REFUND') AND NOT is_reversed ORDER BY line_no`, [row.folio_id])).rows;
  res.json(row);
}));
