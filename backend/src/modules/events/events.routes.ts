import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { nextNumber } from '../../core/numbering';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { openFolio, postCharge, postFolioPayment, folioBalance, reverseFolioItem } from '../pms/folio.service';
import { currentBusinessDate, r2, getTax, splitTax } from '../finance/accounting.service';
import { recordPayment, resolvePaymentMethodId } from '../finance/payments.service';

/**
 * Advanced operations: events & banquets (venues, quotations → confirmation → event folio → invoice),
 * services (spa, transfers, activities: catalogue, resources, bookings charged to folio or paid directly),
 * clubs (club nights, ticket types, ticket sales with QR, door check-in, guest lists).
 */

// ---------------- Venues ----------------
export const venuesRouter = crudRouter({ table: 'venues', entity: 'venue', permissions: { view: 'events.view', create: 'events.manage', edit: 'events.manage', delete: 'events.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['code', 'name', 'type'], defaultSort: 'name', filters: { type: 'type', active: 'is_active' },
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), type: z.string().default('HALL'), capacity_theatre: z.coerce.number().int().min(0).default(0), capacity_banquet: z.coerce.number().int().min(0).default(0), capacity_classroom: z.coerce.number().int().min(0).default(0), capacity_cocktail: z.coerce.number().int().min(0).default(0), hourly_rate: z.coerce.number().min(0).default(0), half_day_rate: z.coerce.number().min(0).default(0), full_day_rate: z.coerce.number().min(0).default(0), amenities: z.array(z.string()).default([]), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), type: z.string(), capacity_theatre: z.coerce.number().int().min(0), capacity_banquet: z.coerce.number().int().min(0), capacity_classroom: z.coerce.number().int().min(0), capacity_cocktail: z.coerce.number().int().min(0), hourly_rate: z.coerce.number().min(0), half_day_rate: z.coerce.number().min(0), full_day_rate: z.coerce.number().min(0), amenities: z.array(z.string()), is_active: z.boolean() }).partial(),
  extraRoutes: (r) => {
    r.get('/availability', requirePermission('events.view'), asyncHandler(async (req, res) => {
      const from = String(req.query.from ?? new Date().toISOString().slice(0, 10)), to = String(req.query.to ?? from);
      const rows = (await pool.query(`SELECT v.id, v.name, v.capacity_banquet, COALESCE(json_agg(json_build_object('event_id', e.id, 'number', e.number, 'name', e.name, 'start_at', e.start_at, 'end_at', e.end_at, 'status', e.status)) FILTER (WHERE e.id IS NOT NULL), '[]') AS bookings FROM venues v LEFT JOIN events e ON e.venue_id=v.id AND e.status NOT IN ('CANCELLED') AND e.start_at < ($3::date + 1) AND e.end_at > $2::date WHERE v.property_id=$1 AND v.is_active GROUP BY v.id ORDER BY v.name`, [req.propertyId, from, to])).rows;
      res.json(rows);
    }));
  } });

// ---------------- Events & banquets ----------------
export const eventsRouter = Router();
const evSelect = `SELECT e.*, v.name AS venue_name, c.name AS customer_name, g.first_name || ' ' || g.last_name AS guest_name, u.full_name AS created_by_name, f.number AS folio_number, i.number AS invoice_number,
    (SELECT COALESCE(SUM(amount),0) FROM event_items ei WHERE ei.event_id=e.id) AS items_total,
    (SELECT COALESCE(SUM(fi.amount),0) FROM folio_items fi WHERE fi.folio_id=e.folio_id AND NOT fi.is_reversed) AS folio_balance
  FROM events e LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN customers c ON c.id=e.customer_id LEFT JOIN guests g ON g.id=e.guest_id LEFT JOIN users u ON u.id=e.created_by LEFT JOIN folios f ON f.id=e.folio_id LEFT JOIN invoices i ON i.id=e.invoice_id`;
eventsRouter.get('/', requirePermission('events.view'), asyncHandler(async (req, res) => {
  const where = ['e.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.upcoming === 'true') where.push(`e.end_at >= now() AND e.status NOT IN ('CANCELLED','COMPLETED','INVOICED')`);
  await runList(req, res, { select: evSelect, where, params, searchColumns: ['e.number', 'e.name', 'e.contact_name', 'c.name', 'v.name'], defaultSort: 'e.start_at', filters: { status: 'e.status', venue_id: 'e.venue_id', customer_id: 'e.customer_id', type: 'e.type' }, dateFilters: { date: 'e.start_at::date' }, exportName: 'events' });
}));
eventsRouter.get('/calendar', requirePermission('events.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 8) + '01'), to = String(req.query.to ?? new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10));
  res.json((await pool.query(`SELECT e.id, e.number, e.name, e.type, e.status, e.start_at, e.end_at, e.expected_guests, v.name AS venue_name, v.id AS venue_id FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE e.property_id=$1 AND e.status <> 'CANCELLED' AND e.start_at < ($3::date + 1) AND e.end_at > $2::date ORDER BY e.start_at`, [req.propertyId, from, to])).rows);
}));
const evItem = z.object({ item_type: z.enum(['VENUE', 'MENU', 'BEVERAGE', 'EQUIPMENT', 'STAFF', 'ACCOMMODATION', 'SERVICE', 'OTHER']).default('OTHER'), description: z.string().min(1), quantity: z.coerce.number().positive().default(1), unit_price: z.coerce.number().min(0), tax_id: z.string().uuid().nullable().optional(), menu_item_id: z.string().uuid().nullable().optional() });
const evSchema = z.object({ name: z.string().min(2), type: z.string().default('BANQUET'), customer_id: z.string().uuid().nullable().optional(), guest_id: z.string().uuid().nullable().optional(), contact_name: optionalStr, contact_phone: optionalStr, contact_email: optionalStr, venue_id: z.string().uuid().nullable().optional(), start_at: z.string().min(10), end_at: z.string().min(10), expected_guests: z.coerce.number().int().min(0).default(0), setup_style: optionalStr, deposit_required: z.coerce.number().min(0).default(0), menu_notes: optionalStr, equipment_notes: optionalStr, staff_notes: optionalStr, notes: optionalStr, items: z.array(evItem).default([]) });
async function assertVenueFree(c: any, venueId: string | null | undefined, start: string, end: string, excludeId?: string) {
  if (!venueId) return;
  const clash = (await c.query(`SELECT number, name FROM events WHERE venue_id=$1 AND status IN ('TENTATIVE','QUOTED','CONFIRMED','IN_PROGRESS') AND start_at < $3 AND end_at > $2 AND ($4::uuid IS NULL OR id <> $4)`, [venueId, start, end, excludeId ?? null])).rows[0];
  if (clash) throw new BadRequest(`Venue is already booked by ${clash.number} (${clash.name}) in that time window`, clash, 'VENUE_CONFLICT');
}
async function recalcEvent(c: any, id: string) {
  const t = (await c.query(`SELECT COALESCE(SUM(amount),0) AS v FROM event_items WHERE event_id=$1`, [id])).rows[0].v;
  await c.query(`UPDATE events SET quotation_total=$2, updated_at=now() WHERE id=$1`, [id, t]);
  return Number(t);
}
async function insertItems(c: any, eventId: string, items: z.infer<typeof evItem>[]) {
  for (const it of items) {
    const p = it.menu_item_id ? (await c.query(`SELECT name, price, tax_id FROM menu_items WHERE id=$1`, [it.menu_item_id])).rows[0] : null;
    const amount = r2(it.quantity * (it.unit_price || Number(p?.price ?? 0)));
    await c.query(`INSERT INTO event_items (event_id, item_type, description, quantity, unit_price, amount, tax_id, menu_item_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId, it.item_type, it.description || p?.name, it.quantity, it.unit_price || Number(p?.price ?? 0), amount, it.tax_id ?? p?.tax_id ?? null, it.menu_item_id ?? null]);
  }
}
eventsRouter.post('/', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const b = validate(evSchema, req.body);
  const out = await withTransaction(async (c) => {
    await assertVenueFree(c, b.venue_id, b.start_at, b.end_at);
    const number = await nextNumber(c, 'EVENT', req.propertyId);
    const e = (await c.query(`INSERT INTO events (property_id, number, name, type, customer_id, guest_id, contact_name, contact_phone, contact_email, venue_id, start_at, end_at, expected_guests, setup_style, status, deposit_required, menu_notes, equipment_notes, staff_notes, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'INQUIRY',$15,$16,$17,$18,$19,$20) RETURNING *`,
      [req.propertyId, number, b.name, b.type, b.customer_id ?? null, b.guest_id ?? null, b.contact_name ?? null, b.contact_phone ?? null, b.contact_email ?? null, b.venue_id ?? null, b.start_at, b.end_at, b.expected_guests, b.setup_style ?? null, b.deposit_required, b.menu_notes ?? null, b.equipment_notes ?? null, b.staff_notes ?? null, b.notes ?? null, req.user!.id])).rows[0];
    if (b.venue_id && !b.items.length) { const v = (await c.query(`SELECT * FROM venues WHERE id=$1`, [b.venue_id])).rows[0]; const hours = (new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 3600000; const price = hours >= 8 ? Number(v.full_day_rate) : hours >= 4 ? Number(v.half_day_rate) : r2(hours * Number(v.hourly_rate)); if (price > 0) b.items.push({ item_type: 'VENUE', description: `${v.name} hire (${r2(hours)}h)`, quantity: 1, unit_price: price }); }
    await insertItems(c, e.id, b.items);
    await recalcEvent(c, e.id);
    await c.query(`INSERT INTO event_status_history (event_id, status, notes, user_id) VALUES ($1,'INQUIRY','Created',$2)`, [e.id, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'event', entityId: e.id, newValue: { ...b, number } }, c);
    return (await c.query(`${evSelect} WHERE e.id=$1`, [e.id])).rows[0];
  });
  res.status(201).json(out);
}));
eventsRouter.get('/:id', requirePermission('events.view'), asyncHandler(async (req, res) => {
  const e = (await pool.query(`${evSelect} WHERE e.id=$1`, [req.params.id])).rows[0];
  if (!e) throw new NotFound('Event not found');
  e.items = (await pool.query(`SELECT ei.*, t.name AS tax_name, t.rate AS tax_rate FROM event_items ei LEFT JOIN taxes t ON t.id=ei.tax_id WHERE ei.event_id=$1 ORDER BY ei.item_type, ei.description`, [e.id])).rows;
  e.history = (await pool.query(`SELECT h.*, u.full_name AS user_name FROM event_status_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.event_id=$1 ORDER BY h.created_at`, [e.id])).rows;
  if (e.folio_id) e.folio_items = (await pool.query(`SELECT id, item_type, description, amount, business_date, is_reversed FROM folio_items WHERE folio_id=$1 ORDER BY line_no`, [e.folio_id])).rows;
  res.json(e);
}));
eventsRouter.put('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const b = validate(evSchema.partial(), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Event not found');
    if (['COMPLETED', 'INVOICED', 'CANCELLED'].includes(e.status)) throw Errors.invalidStatus('event', e.status, 'edit');
    const start = b.start_at ?? new Date(e.start_at).toISOString(), end = b.end_at ?? new Date(e.end_at).toISOString(); const venue = b.venue_id === undefined ? e.venue_id : b.venue_id;
    await assertVenueFree(c, venue, start, end, e.id);
    await c.query(`UPDATE events SET name=COALESCE($2,name), type=COALESCE($3,type), customer_id=COALESCE($4,customer_id), guest_id=COALESCE($5,guest_id), contact_name=COALESCE($6,contact_name), contact_phone=COALESCE($7,contact_phone), contact_email=COALESCE($8,contact_email), venue_id=$9, start_at=$10, end_at=$11, expected_guests=COALESCE($12,expected_guests), setup_style=COALESCE($13,setup_style), deposit_required=COALESCE($14,deposit_required), menu_notes=COALESCE($15,menu_notes), equipment_notes=COALESCE($16,equipment_notes), staff_notes=COALESCE($17,staff_notes), notes=COALESCE($18,notes), updated_at=now() WHERE id=$1`,
      [e.id, b.name ?? null, b.type ?? null, b.customer_id ?? null, b.guest_id ?? null, b.contact_name ?? null, b.contact_phone ?? null, b.contact_email ?? null, venue, start, end, b.expected_guests ?? null, b.setup_style ?? null, b.deposit_required ?? null, b.menu_notes ?? null, b.equipment_notes ?? null, b.staff_notes ?? null, b.notes ?? null]);
    if (b.items) { if (e.status === 'CONFIRMED' && !hasPermission(req, 'events.manage')) throw new Forbidden('Confirmed event items require manager rights'); await c.query(`DELETE FROM event_items WHERE event_id=$1 AND posted_folio_item_id IS NULL`, [e.id]); await insertItems(c, e.id, b.items); }
    await recalcEvent(c, e.id);
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'event', entityId: e.id, oldValue: e, newValue: b }, c);
    return (await c.query(`${evSelect} WHERE e.id=$1`, [e.id])).rows[0];
  });
  res.json(out);
}));
const transitions: Record<string, string[]> = { INQUIRY: ['TENTATIVE', 'QUOTED', 'CANCELLED'], TENTATIVE: ['QUOTED', 'CONFIRMED', 'CANCELLED'], QUOTED: ['CONFIRMED', 'TENTATIVE', 'CANCELLED'], CONFIRMED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED'], COMPLETED: ['INVOICED'] };
eventsRouter.post('/:id/status', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ status: z.enum(['TENTATIVE', 'QUOTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Event not found');
    if (!(transitions[e.status] ?? []).includes(b.status)) throw Errors.invalidStatus('event', e.status, `move to ${b.status}`);
    let folioId = e.folio_id;
    if (b.status === 'CONFIRMED') {
      await assertVenueFree(c, e.venue_id, new Date(e.start_at).toISOString(), new Date(e.end_at).toISOString(), e.id);
      if (Number(e.deposit_required) > 0 && Number(e.deposit_paid) < Number(e.deposit_required) && !hasPermission(req, 'dashboard.management')) throw new BadRequest(`Deposit of ${e.deposit_required} required before confirmation (paid ${e.deposit_paid})`, undefined, 'DEPOSIT_REQUIRED');
      if (!folioId) folioId = (await openFolio(c, { propertyId: e.property_id, type: 'EVENT', guestId: e.guest_id, customerId: e.customer_id, eventId: e.id })).id;
      // Block venue + create prep tasks
      await notify({ permission: 'kitchen.view', propertyId: e.property_id, type: 'EVENT_CONFIRMED', title: `Event ${e.name} confirmed for ${new Date(e.start_at).toLocaleDateString()} (${e.expected_guests} pax)`, entityType: 'event', entityId: e.id, link: `/events/${e.id}` }, c);
      await notify({ permission: 'housekeeping.assign', propertyId: e.property_id, type: 'EVENT_CONFIRMED', title: `Venue setup needed: ${e.name}`, entityType: 'event', entityId: e.id, link: `/events/${e.id}` }, c);
    }
    if (b.status === 'IN_PROGRESS' && folioId) {
      // Post all quotation items to the event folio (revenue recognised when the event runs)
      const bd = await currentBusinessDate(c, e.property_id, req.user!.id);
      for (const it of (await c.query(`SELECT * FROM event_items WHERE event_id=$1 AND posted_folio_item_id IS NULL`, [e.id])).rows) {
        const cat = it.item_type === 'VENUE' ? 'EVENT' : it.item_type === 'MENU' ? 'FOOD' : it.item_type === 'BEVERAGE' ? 'BEVERAGE' : it.item_type === 'ACCOMMODATION' ? 'ROOM' : 'EVENT';
        const fi = await postCharge(c, { folioId, category: cat, description: `${e.name}: ${it.description}`, quantity: Number(it.quantity), unitPrice: Number(it.unit_price), taxId: it.tax_id, sourceType: 'EVENT', sourceId: e.id, userId: req.user!.id, businessDate: bd });
        await c.query(`UPDATE event_items SET posted_folio_item_id=$2 WHERE id=$1`, [it.id, fi.id]);
      }
    }
    if (b.status === 'COMPLETED' && e.venue_id) await notify({ permission: 'housekeeping.assign', propertyId: e.property_id, type: 'EVENT_COMPLETED', title: `Venue clean-up needed after ${e.name}`, entityType: 'event', entityId: e.id, link: `/events/${e.id}` }, c);
    if (b.status === 'CANCELLED' && folioId) {
      const bal = await folioBalance(c, folioId);
      if (Math.abs(bal.balance) >= 0.005) throw new BadRequest(`Event folio has a balance of ${bal.balance}; refund or settle before cancelling`, bal, 'FOLIO_BALANCE');
      await c.query(`UPDATE folios SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE id=$1`, [folioId, req.user!.id]);
    }
    const r = (await c.query(`UPDATE events SET status=$2, folio_id=$3, updated_at=now() WHERE id=$1 RETURNING *`, [e.id, b.status, folioId])).rows[0];
    await c.query(`INSERT INTO event_status_history (event_id, status, notes, user_id) VALUES ($1,$2,$3,$4)`, [e.id, b.status, b.notes ?? null, req.user!.id]);
    await audit({ ...auditCtx(req), action: b.status, entityType: 'event', entityId: e.id, reason: b.notes }, c);
    return r;
  });
  res.json(out);
}));
/** Deposit or payment towards an event (pre-confirmation deposits open the event folio early). */
eventsRouter.post('/:id/payments', requirePermission('events.manage', 'payments.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ amount: z.coerce.number().positive(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), reference: optionalStr, kind: z.enum(['DEPOSIT', 'PAYMENT', 'REFUND']).default('DEPOSIT'), cashier_shift_id: z.string().uuid().nullable().optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Event not found');
    if (['CANCELLED', 'INVOICED'].includes(e.status)) throw Errors.invalidStatus('event', e.status, 'take payment');
    if (b.kind === 'REFUND' && !hasPermission(req, 'payments.refund')) throw Errors.unauthorizedRefund();
    let folioId = e.folio_id;
    if (!folioId) { folioId = (await openFolio(c, { propertyId: e.property_id, type: 'EVENT', guestId: e.guest_id, customerId: e.customer_id, eventId: e.id })).id; await c.query(`UPDATE events SET folio_id=$2 WHERE id=$1`, [e.id, folioId]); }
    const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
    const item = await postFolioPayment(c, { folioId, paymentMethodId: methodId, amount: b.amount, reference: b.reference, kind: b.kind, cashierShiftId: b.cashier_shift_id ?? null, userId: req.user!.id, idempotencyKey: (req.headers['idempotency-key'] as string) ?? null });
    if (b.kind !== 'REFUND') await c.query(`UPDATE events SET deposit_paid = deposit_paid + $2, updated_at=now() WHERE id=$1`, [e.id, b.amount]);
    else await c.query(`UPDATE events SET deposit_paid = GREATEST(0, deposit_paid - $2), updated_at=now() WHERE id=$1`, [e.id, b.amount]);
    return item;
  });
  res.status(201).json(out);
}));
/** Post an extra (ad-hoc) charge during the event, e.g. extra bar consumption. */
eventsRouter.post('/:id/charges', requirePermission('events.manage', 'folios.post'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ description: z.string().min(1), quantity: z.coerce.number().positive().default(1), unit_price: z.coerce.number().min(0), category: z.string().default('EVENT'), tax_id: z.string().uuid().nullable().optional(), item_type: z.enum(['VENUE', 'MENU', 'BEVERAGE', 'EQUIPMENT', 'STAFF', 'ACCOMMODATION', 'SERVICE', 'OTHER']).default('OTHER') }), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Event not found');
    if (!['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(e.status) || !e.folio_id) throw new BadRequest('Charges can only be posted to confirmed/running events');
    const fi = await postCharge(c, { folioId: e.folio_id, category: b.category, description: `${e.name}: ${b.description}`, quantity: b.quantity, unitPrice: b.unit_price, taxId: b.tax_id, sourceType: 'EVENT', sourceId: e.id, userId: req.user!.id });
    await c.query(`INSERT INTO event_items (event_id, item_type, description, quantity, unit_price, amount, tax_id, posted_folio_item_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [e.id, b.item_type, b.description, b.quantity, b.unit_price, r2(b.quantity * b.unit_price), b.tax_id ?? null, fi.id]);
    await recalcEvent(c, e.id);
    return fi;
  });
  res.status(201).json(out);
}));
eventsRouter.post('/:id/charges/:itemId/reverse', requirePermission('folios.reverse'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => { const r = await reverseFolioItem(c, req.params.itemId, b.reason, req.user!); await c.query(`DELETE FROM event_items WHERE event_id=$1 AND posted_folio_item_id=$2`, [req.params.id, req.params.itemId]); await recalcEvent(c, req.params.id); return r; });
  res.json(out);
}));
/** Close & invoice: settle folio (payments or city ledger), create invoice, mark INVOICED. */
eventsRouter.post('/:id/invoice', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ payments: z.array(z.object({ payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), amount: z.coerce.number().positive(), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional() })).default([]), allow_balance: z.boolean().default(false), notes: optionalStr }), req.body ?? {});
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM events WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Event not found');
    if (!['COMPLETED', 'IN_PROGRESS'].includes(e.status)) throw Errors.invalidStatus('event', e.status, 'invoice');
    if (!e.folio_id) throw new BadRequest('Event has no folio');
    if (e.status === 'IN_PROGRESS') { const bd = await currentBusinessDate(c, e.property_id, req.user!.id); for (const it of (await c.query(`SELECT * FROM event_items WHERE event_id=$1 AND posted_folio_item_id IS NULL`, [e.id])).rows) { const fi = await postCharge(c, { folioId: e.folio_id, category: 'EVENT', description: `${e.name}: ${it.description}`, quantity: Number(it.quantity), unitPrice: Number(it.unit_price), taxId: it.tax_id, sourceType: 'EVENT', sourceId: e.id, userId: req.user!.id, businessDate: bd }); await c.query(`UPDATE event_items SET posted_folio_item_id=$2 WHERE id=$1`, [it.id, fi.id]); } }
    for (const p of b.payments) { const methodId = await resolvePaymentMethodId(p.payment_method_id, p.payment_method_code, c); await postFolioPayment(c, { folioId: e.folio_id, paymentMethodId: methodId, amount: p.amount, reference: p.reference, kind: 'PAYMENT', cashierShiftId: p.cashier_shift_id ?? null, userId: req.user!.id }); }
    const bal = await folioBalance(c, e.folio_id);
    if (bal.balance > 0.005) {
      if (!b.allow_balance || !e.customer_id) throw new BadRequest(`Outstanding balance ${bal.balance}. Collect payment or bill to a corporate account (allow_balance with customer).`, bal, 'BALANCE_OUTSTANDING');
      const corp = await resolvePaymentMethodId(undefined, 'CORP', c);
      await postFolioPayment(c, { folioId: e.folio_id, paymentMethodId: corp, amount: bal.balance, kind: 'PAYMENT', userId: req.user!.id, reference: `Event ${e.number} to account` });
    }
    const items = (await c.query(`SELECT * FROM folio_items WHERE folio_id=$1 AND NOT is_reversed ORDER BY line_no`, [e.folio_id])).rows;
    const charges = items.filter((i) => i.item_type === 'CHARGE');
    const total = r2(charges.reduce((s, i) => s + Number(i.amount), 0)), tax = r2(charges.reduce((s, i) => s + Number(i.tax_amount), 0)), sc = r2(charges.reduce((s, i) => s + Number(i.service_charge), 0));
    const paid = r2(items.filter((i) => ['PAYMENT', 'DEPOSIT', 'REFUND'].includes(i.item_type)).reduce((s, i) => s - Number(i.amount), 0));
    const invNo = await nextNumber(c, 'INVOICE', e.property_id);
    const inv = (await c.query(`INSERT INTO invoices (property_id, number, folio_id, guest_id, customer_id, event_id, invoice_date, due_date, subtotal, tax_total, service_charge_total, total, paid_total, balance, status, type, currency, lines, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE + COALESCE((SELECT payment_terms_days FROM customers WHERE id=$5),0),$7,$8,$9,$10,$11,$12,$13,'EVENT','KES',$14,$15,$16) RETURNING *`,
      [e.property_id, invNo, e.folio_id, e.guest_id, e.customer_id, e.id, r2(total - tax - sc), tax, sc, total, paid, r2(total - paid), Math.abs(total - paid) < 0.005 ? 'PAID' : 'ISSUED', JSON.stringify(charges.map((i) => ({ description: i.description, quantity: i.quantity, unit_price: i.unit_price, tax: i.tax_amount, amount: i.amount }))), b.notes ?? null, req.user!.id])).rows[0];
    await c.query(`UPDATE folios SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE id=$1`, [e.folio_id, req.user!.id]);
    const r = (await c.query(`UPDATE events SET status='INVOICED', invoice_id=$2, updated_at=now() WHERE id=$1 RETURNING *`, [e.id, inv.id])).rows[0];
    await c.query(`INSERT INTO event_status_history (event_id, status, notes, user_id) VALUES ($1,'INVOICED',$2,$3)`, [e.id, `Invoice ${invNo}`, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'INVOICE', entityType: 'event', entityId: e.id, newValue: { invoice: invNo, total, paid } }, c);
    return { event: r, invoice: inv };
  });
  res.status(201).json(out);
}));
/** Banquet event order (BEO) — the operational sheet for kitchen / service / setup. */
eventsRouter.get('/:id/beo', requirePermission('events.view', 'kitchen.view'), asyncHandler(async (req, res) => {
  const e = (await pool.query(`${evSelect} WHERE e.id=$1`, [req.params.id])).rows[0];
  if (!e) throw new NotFound('Event not found');
  const items = (await pool.query(`SELECT item_type, description, quantity, unit_price, amount FROM event_items WHERE event_id=$1 ORDER BY item_type`, [e.id])).rows;
  const grouped: Record<string, any[]> = {}; items.forEach((i) => { (grouped[i.item_type] ??= []).push(i); });
  res.json({ event: e, sections: grouped, timeline: { setup_from: new Date(new Date(e.start_at).getTime() - 2 * 3600000), start_at: e.start_at, end_at: e.end_at } });
}));

// ---------------- Services (spa, transfers, activities) ----------------
export const servicesRouter = crudRouter({ table: 'services', entity: 'service', permissions: { view: 'services.view', create: 'services.manage', edit: 'services.manage', delete: 'services.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['code', 'name', 'category'], defaultSort: 'name', filters: { category: 'category', active: 'is_active', outlet_id: 'outlet_id' },
  selectSql: `SELECT t.*, tx.name AS tax_name, o.name AS outlet_name FROM services t LEFT JOIN taxes tx ON tx.id=t.tax_id LEFT JOIN outlets o ON o.id=t.outlet_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), category: z.string().default('SPA'), description: optionalStr, price: z.coerce.number().min(0), duration_minutes: z.coerce.number().int().min(0).default(60), tax_id: z.string().uuid().nullable().optional(), revenue_account_id: z.string().uuid().nullable().optional(), folio_category: z.string().default('SPA'), requires_staff: z.boolean().default(true), capacity: z.coerce.number().int().min(1).default(1), outlet_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), category: z.string(), description: optionalStr, price: z.coerce.number().min(0), duration_minutes: z.coerce.number().int().min(0), tax_id: z.string().uuid().nullable(), revenue_account_id: z.string().uuid().nullable(), folio_category: z.string(), requires_staff: z.boolean(), capacity: z.coerce.number().int().min(1), outlet_id: z.string().uuid().nullable(), is_active: z.boolean() }).partial() });
export const serviceResourcesRouter = crudRouter({ table: 'service_resources', entity: 'service_resource', permissions: { view: 'services.view', create: 'services.manage', edit: 'services.manage', delete: 'services.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['name', 'type'], defaultSort: 'name', filters: { type: 'type', active: 'is_active' },
  selectSql: `SELECT t.*, e.first_name || ' ' || e.last_name AS employee_name FROM service_resources t LEFT JOIN employees e ON e.id=t.employee_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), name: z.string().min(1), type: z.string().default('ROOM'), employee_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), type: z.string(), employee_id: z.string().uuid().nullable(), is_active: z.boolean() }).partial() });

export const serviceBookingsRouter = Router();
const sbSelect = `SELECT sb.*, s.name AS service_name, s.category, s.duration_minutes, g.first_name || ' ' || g.last_name AS guest_name, r.name AS resource_name, e.first_name || ' ' || e.last_name AS staff_name, rm.number AS room_number, u.full_name AS created_by_name
  FROM service_bookings sb JOIN services s ON s.id=sb.service_id LEFT JOIN guests g ON g.id=sb.guest_id LEFT JOIN service_resources r ON r.id=sb.resource_id LEFT JOIN employees e ON e.id=sb.staff_employee_id LEFT JOIN stays st ON st.id=sb.stay_id LEFT JOIN rooms rm ON rm.id=st.room_id LEFT JOIN users u ON u.id=sb.created_by`;
serviceBookingsRouter.get('/', requirePermission('services.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: sbSelect, where: ['sb.property_id=$1'], params: [req.propertyId], searchColumns: ['sb.number', 's.name', 'g.first_name', 'g.last_name', 'sb.customer_name'], defaultSort: 'sb.start_at', filters: { status: 'sb.status', service_id: 'sb.service_id', resource_id: 'sb.resource_id', staff_employee_id: 'sb.staff_employee_id', stay_id: 'sb.stay_id', guest_id: 'sb.guest_id' }, dateFilters: { date: 'sb.start_at::date' }, exportName: 'service_bookings' });
}));
serviceBookingsRouter.get('/schedule', requirePermission('services.view'), asyncHandler(async (req, res) => {
  const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
  const rows = (await pool.query(`${sbSelect} WHERE sb.property_id=$1 AND sb.start_at::date=$2 AND sb.status NOT IN ('CANCELLED') ORDER BY sb.start_at`, [req.propertyId, date])).rows;
  const resources = (await pool.query(`SELECT id, name, type FROM service_resources WHERE property_id=$1 AND is_active ORDER BY name`, [req.propertyId])).rows;
  res.json({ date, resources, bookings: rows });
}));
serviceBookingsRouter.post('/', requirePermission('services.book'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ service_id: z.string().uuid(), guest_id: z.string().uuid().nullable().optional(), stay_id: z.string().uuid().nullable().optional(), customer_name: optionalStr, resource_id: z.string().uuid().nullable().optional(), staff_employee_id: z.string().uuid().nullable().optional(), start_at: z.string().min(10), quantity: z.coerce.number().int().positive().default(1), discount: z.coerce.number().min(0).default(0), settlement: z.enum(['ROOM', 'PAY_NOW', 'COMPLIMENTARY', 'LATER']).default('LATER'), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const s = (await c.query(`SELECT * FROM services WHERE id=$1 AND is_active`, [b.service_id])).rows[0];
    if (!s) throw new NotFound('Service not found');
    if (b.settlement === 'ROOM' && !b.stay_id) throw new BadRequest('Room settlement requires an in-house stay');
    if (b.stay_id) { const st = (await c.query(`SELECT status, guest_id FROM stays WHERE id=$1`, [b.stay_id])).rows[0]; if (!st || st.status !== 'IN_HOUSE') throw new BadRequest('Stay is not in house'); b.guest_id ??= st.guest_id; }
    const start = new Date(b.start_at); const end = new Date(start.getTime() + Number(s.duration_minutes) * 60000);
    if (b.resource_id) { const clash = (await c.query(`SELECT number FROM service_bookings WHERE resource_id=$1 AND status NOT IN ('CANCELLED','NO_SHOW','COMPLETED') AND start_at < $3 AND end_at > $2`, [b.resource_id, start, end])).rows[0]; if (clash) throw new BadRequest(`Resource already booked (${clash.number}) in that slot`, undefined, 'RESOURCE_CONFLICT'); }
    if (b.staff_employee_id) { const clash = (await c.query(`SELECT number FROM service_bookings WHERE staff_employee_id=$1 AND status NOT IN ('CANCELLED','NO_SHOW','COMPLETED') AND start_at < $3 AND end_at > $2`, [b.staff_employee_id, start, end])).rows[0]; if (clash) throw new BadRequest(`Therapist/staff already booked (${clash.number}) in that slot`, undefined, 'STAFF_CONFLICT'); }
    if (b.discount > 0 && !hasPermission(req, 'folios.discount') && !hasPermission(req, 'pos.discount')) throw new Forbidden('Discounts require folios.discount');
    const total = r2(b.quantity * Number(s.price) - b.discount);
    const number = await nextNumber(c, 'SERVICE_BOOKING', req.propertyId);
    const row = (await c.query(`INSERT INTO service_bookings (property_id, number, service_id, guest_id, stay_id, customer_name, resource_id, staff_employee_id, start_at, end_at, quantity, price, discount, total, status, settlement, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'BOOKED',$15,$16,$17) RETURNING *`, [req.propertyId, number, s.id, b.guest_id ?? null, b.stay_id ?? null, b.customer_name ?? null, b.resource_id ?? null, b.staff_employee_id ?? null, start, end, b.quantity, s.price, b.discount, total, b.settlement, b.notes ?? null, req.user!.id])).rows[0];
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'service_booking', entityId: row.id, newValue: row }, c);
    return (await c.query(`${sbSelect} WHERE sb.id=$1`, [row.id])).rows[0];
  });
  res.status(201).json(out);
}));
serviceBookingsRouter.get('/:id', requirePermission('services.view'), asyncHandler(async (req, res) => {
  const r = (await pool.query(`${sbSelect} WHERE sb.id=$1`, [req.params.id])).rows[0];
  if (!r) throw new NotFound('Booking not found');
  res.json(r);
}));
serviceBookingsRouter.post('/:id/status', requirePermission('services.book'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ status: z.enum(['CONFIRMED', 'IN_PROGRESS', 'NO_SHOW', 'CANCELLED']), reason: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const sb = (await c.query(`SELECT * FROM service_bookings WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!sb) throw new NotFound('Booking not found');
    if (['COMPLETED', 'CANCELLED'].includes(sb.status)) throw Errors.invalidStatus('booking', sb.status, b.status.toLowerCase());
    const r = (await c.query(`UPDATE service_bookings SET status=$2, notes=CASE WHEN $3::text IS NULL THEN notes ELSE COALESCE(notes,'') || ' [' || $3 || ']' END WHERE id=$1 RETURNING *`, [sb.id, b.status, b.reason ?? null])).rows[0];
    await audit({ ...auditCtx(req), action: b.status, entityType: 'service_booking', entityId: sb.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));
/** Complete the service and settle: charge the room folio, take direct payment, or mark complimentary (needs pos.discount/folios.discount). */
serviceBookingsRouter.post('/:id/complete', requirePermission('services.book'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ settlement: z.enum(['ROOM', 'PAY_NOW', 'COMPLIMENTARY']).optional(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional(), tip: z.coerce.number().min(0).default(0) }), req.body ?? {});
  const out = await withTransaction(async (c) => {
    const sb = (await c.query(`SELECT sb.*, s.name AS service_name, s.tax_id, s.revenue_account_id, s.folio_category, s.outlet_id FROM service_bookings sb JOIN services s ON s.id=sb.service_id WHERE sb.id=$1 FOR UPDATE OF sb`, [req.params.id])).rows[0];
    if (!sb) throw new NotFound('Booking not found');
    if (!['BOOKED', 'CONFIRMED', 'IN_PROGRESS'].includes(sb.status)) throw Errors.invalidStatus('booking', sb.status, 'complete');
    const settlement = b.settlement ?? (sb.settlement === 'LATER' ? 'PAY_NOW' : sb.settlement);
    const bd = await currentBusinessDate(c, sb.property_id, req.user!.id);
    let folioItemId: string | null = null, paymentId: string | null = null;
    if (settlement === 'ROOM') {
      if (!sb.stay_id) throw new BadRequest('No stay linked; choose PAY_NOW');
      const folio = (await c.query(`SELECT id FROM folios WHERE stay_id=$1 AND status='OPEN' AND type='GUEST' ORDER BY created_at LIMIT 1`, [sb.stay_id])).rows[0];
      if (!folio) throw new BadRequest('Guest folio is not open');
      const fi = await postCharge(c, { folioId: folio.id, category: sb.folio_category ?? 'SPA', description: `${sb.service_name} (${sb.number})`, quantity: Number(sb.quantity), unitPrice: Number(sb.price), discount: Number(sb.discount), taxId: sb.tax_id, outletId: sb.outlet_id, sourceType: 'SERVICE_BOOKING', sourceId: sb.id, userId: req.user!.id, revenueAccountId: sb.revenue_account_id, businessDate: bd });
      folioItemId = fi.id;
    } else if (settlement === 'PAY_NOW') {
      const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
      const tax = await getTax(c, sb.tax_id); const t = tax ? splitTax(Number(sb.total), Number(tax.rate), !!tax.is_inclusive) : { net: Number(sb.total), tax: 0, gross: Number(sb.total) };
      const revenue = sb.revenue_account_id ? { accountId: sb.revenue_account_id } : { mappingKey: 'SPA_REVENUE' };
      const { payment } = await recordPayment(c, { propertyId: sb.property_id, direction: 'IN', kind: 'PAYMENT', paymentMethodId: methodId, amount: r2(t.gross + b.tip), reference: b.reference, partyType: sb.guest_id ? 'GUEST' : null, partyId: sb.guest_id, sourceType: 'SERVICE_BOOKING', sourceId: sb.id, cashierShiftId: b.cashier_shift_id ?? null, outletId: sb.outlet_id, userId: req.user!.id, offset: { mappingKey: 'POS_CLEARING' }, description: `${sb.service_name} ${sb.number}`, idempotencyKey: (req.headers['idempotency-key'] as string) ?? null });
      // Revenue recognition: clear the receipt against revenue + tax (+ tips payable)
      const { postJournal } = await import('../finance/accounting.service');
      const lines: any[] = [{ mappingKey: 'POS_CLEARING', debit: r2(t.gross + b.tip) }, { ...revenue, credit: t.net, outletId: sb.outlet_id }];
      if (t.tax > 0) lines.push({ accountId: tax.account_id, credit: t.tax });
      if (b.tip > 0) lines.push({ mappingKey: 'TIPS_PAYABLE', credit: b.tip });
      await postJournal(c, { propertyId: sb.property_id, businessDate: bd, description: `Service revenue ${sb.number} ${sb.service_name}`, sourceType: 'SERVICE_BOOKING', sourceId: sb.id, userId: req.user!.id, lines });
      paymentId = payment.id;
    } else {
      if (!hasPermission(req, 'folios.discount') && !hasPermission(req, 'pos.discount')) throw new Forbidden('Complimentary services require a discount permission');
      const { postJournal } = await import('../finance/accounting.service');
      const revenue = sb.revenue_account_id ? { accountId: sb.revenue_account_id } : { mappingKey: 'SPA_REVENUE' };
      if (Number(sb.total) > 0) await postJournal(c, { propertyId: sb.property_id, businessDate: bd, description: `Complimentary ${sb.service_name} ${sb.number}`, sourceType: 'SERVICE_BOOKING', sourceId: sb.id, userId: req.user!.id, lines: [{ mappingKey: 'COMPLIMENTARY_EXPENSE', debit: Number(sb.total) }, { ...revenue, credit: Number(sb.total) }] });
    }
    const r = (await c.query(`UPDATE service_bookings SET status='COMPLETED', settlement=$2, folio_item_id=$3, payment_id=$4 WHERE id=$1 RETURNING *`, [sb.id, settlement, folioItemId, paymentId])).rows[0];
    await audit({ ...auditCtx(req), action: 'COMPLETE', entityType: 'service_booking', entityId: sb.id, newValue: { settlement, folioItemId, paymentId } }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- Clubs: nights, tickets, door ----------------
export const clubEventsRouter = Router();
const ceSelect = `SELECT ce.*, o.name AS outlet_name, o.property_id, (SELECT COALESCE(SUM(quantity_sold),0) FROM club_ticket_types tt WHERE tt.event_id=ce.id)::int AS tickets_sold, (SELECT COALESCE(SUM(t.amount),0) FROM club_tickets t WHERE t.event_id=ce.id AND t.status IN ('SOLD','CHECKED_IN')) AS ticket_revenue, (SELECT COUNT(*) FROM club_tickets t WHERE t.event_id=ce.id AND t.status='CHECKED_IN')::int AS checked_in, (SELECT COUNT(*) FROM club_guest_list gl WHERE gl.event_id=ce.id)::int AS guest_list_count FROM club_events ce JOIN outlets o ON o.id=ce.outlet_id`;
clubEventsRouter.get('/', requirePermission('clubs.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: ceSelect, where: ['o.property_id=$1'], params: [req.propertyId], searchColumns: ['ce.name', 'o.name'], defaultSort: 'ce.event_date', filters: { status: 'ce.status', outlet_id: 'ce.outlet_id' }, dateFilters: { date: 'ce.event_date' }, exportName: 'club_events' });
}));
clubEventsRouter.post('/', requirePermission('clubs.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ outlet_id: z.string().uuid(), name: z.string().min(2), event_date: dateStr, start_time: z.string().default('21:00'), end_time: z.string().default('04:00'), description: optionalStr, capacity: z.coerce.number().int().min(0).default(0), cover_charge: z.coerce.number().min(0).default(0), promotions: z.any().optional(), ticket_types: z.array(z.object({ name: z.string().min(1), price: z.coerce.number().min(0), quantity_available: z.coerce.number().int().min(0).default(0), includes: optionalStr })).default([]) }), req.body);
  const out = await withTransaction(async (c) => {
    const o = (await c.query(`SELECT id FROM outlets WHERE id=$1 AND type='CLUB' AND property_id=$2`, [b.outlet_id, req.propertyId])).rows[0];
    if (!o) throw new NotFound('Club outlet not found');
    const ce = (await c.query(`INSERT INTO club_events (outlet_id, name, event_date, start_time, end_time, description, capacity, cover_charge, status, promotions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SCHEDULED',$9) RETURNING *`, [b.outlet_id, b.name, b.event_date, b.start_time, b.end_time, b.description ?? null, b.capacity, b.cover_charge, JSON.stringify(b.promotions ?? {})])).rows[0];
    const types = b.ticket_types.length ? b.ticket_types : [{ name: 'Regular entry', price: b.cover_charge, quantity_available: b.capacity, includes: null }];
    for (const t of types) await c.query(`INSERT INTO club_ticket_types (event_id, name, price, quantity_available, includes) VALUES ($1,$2,$3,$4,$5)`, [ce.id, t.name, t.price, t.quantity_available, t.includes ?? null]);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'club_event', entityId: ce.id, newValue: b }, c);
    return (await c.query(`${ceSelect} WHERE ce.id=$1`, [ce.id])).rows[0];
  });
  res.status(201).json(out);
}));
clubEventsRouter.get('/:id', requirePermission('clubs.view'), asyncHandler(async (req, res) => {
  const ce = (await pool.query(`${ceSelect} WHERE ce.id=$1`, [req.params.id])).rows[0];
  if (!ce) throw new NotFound('Club event not found');
  ce.ticket_types = (await pool.query(`SELECT * FROM club_ticket_types WHERE event_id=$1 ORDER BY price`, [ce.id])).rows;
  ce.guest_list = (await pool.query(`SELECT gl.*, t.number AS table_number FROM club_guest_list gl LEFT JOIN outlet_tables t ON t.id=gl.table_id WHERE gl.event_id=$1 ORDER BY gl.is_vip DESC, gl.name`, [ce.id])).rows;
  ce.sales_by_type = (await pool.query(`SELECT tt.name, COUNT(t.id)::int AS tickets, COALESCE(SUM(t.quantity),0)::int AS pax, COALESCE(SUM(t.amount),0) AS revenue FROM club_ticket_types tt LEFT JOIN club_tickets t ON t.ticket_type_id=tt.id AND t.status IN ('SOLD','CHECKED_IN') WHERE tt.event_id=$1 GROUP BY tt.name`, [ce.id])).rows;
  res.json(ce);
}));
clubEventsRouter.post('/:id/status', requirePermission('clubs.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ status: z.enum(['SCHEDULED', 'LIVE', 'CLOSED', 'CANCELLED']) }), req.body);
  const ce = (await pool.query(`UPDATE club_events SET status=$2 WHERE id=$1 RETURNING *`, [req.params.id, b.status])).rows[0];
  if (!ce) throw new NotFound('Club event not found');
  await audit({ ...auditCtx(req), action: b.status, entityType: 'club_event', entityId: ce.id });
  res.json(ce);
}));
clubEventsRouter.post('/:id/ticket-types', requirePermission('clubs.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ name: z.string().min(1), price: z.coerce.number().min(0), quantity_available: z.coerce.number().int().min(0).default(0), includes: optionalStr }), req.body);
  res.status(201).json((await pool.query(`INSERT INTO club_ticket_types (event_id, name, price, quantity_available, includes) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [req.params.id, b.name, b.price, b.quantity_available, b.includes ?? null])).rows[0]);
}));
clubEventsRouter.post('/:id/guest-list', requirePermission('clubs.manage', 'clubs.sell_tickets'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ name: z.string().min(1), phone: optionalStr, plus_ones: z.coerce.number().int().min(0).default(0), table_id: z.string().uuid().nullable().optional(), is_vip: z.boolean().default(false), notes: optionalStr }), req.body);
  res.status(201).json((await pool.query(`INSERT INTO club_guest_list (event_id, name, phone, plus_ones, table_id, is_vip, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.params.id, b.name, b.phone ?? null, b.plus_ones, b.table_id ?? null, b.is_vip, b.notes ?? null])).rows[0]);
}));
clubEventsRouter.post('/:id/guest-list/:entryId/arrive', requirePermission('clubs.sell_tickets', 'clubs.manage'), asyncHandler(async (req, res) => {
  const r = (await pool.query(`UPDATE club_guest_list SET arrived_at=now() WHERE id=$1 AND event_id=$2 RETURNING *`, [req.params.entryId, req.params.id])).rows[0];
  if (!r) throw new NotFound('Guest list entry not found');
  res.json(r);
}));
/** Sell tickets: payment → revenue journal (CLUB_REVENUE) → ticket with QR payload. Requires an open cashier shift for drawer methods. */
clubEventsRouter.post('/:id/tickets', requirePermission('clubs.sell_tickets'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ ticket_type_id: z.string().uuid(), quantity: z.coerce.number().int().positive().default(1), holder_name: optionalStr, holder_phone: optionalStr, guest_id: z.string().uuid().nullable().optional(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().default('CASH'), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional(), complimentary: z.boolean().default(false) }), req.body);
  const out = await withTransaction(async (c) => {
    const ce = (await c.query(`SELECT ce.*, o.property_id FROM club_events ce JOIN outlets o ON o.id=ce.outlet_id WHERE ce.id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!ce) throw new NotFound('Club event not found');
    if (!['SCHEDULED', 'LIVE'].includes(ce.status)) throw Errors.invalidStatus('club event', ce.status, 'sell tickets');
    const tt = (await c.query(`SELECT * FROM club_ticket_types WHERE id=$1 AND event_id=$2 FOR UPDATE`, [b.ticket_type_id, ce.id])).rows[0];
    if (!tt) throw new NotFound('Ticket type not found');
    if (Number(tt.quantity_available) > 0 && Number(tt.quantity_sold) + b.quantity > Number(tt.quantity_available)) throw new BadRequest(`Only ${Number(tt.quantity_available) - Number(tt.quantity_sold)} ticket(s) left for ${tt.name}`, undefined, 'SOLD_OUT');
    if (ce.capacity > 0) { const sold = Number((await c.query(`SELECT COALESCE(SUM(quantity),0) AS n FROM club_tickets WHERE event_id=$1 AND status IN ('SOLD','CHECKED_IN')`, [ce.id])).rows[0].n); if (sold + b.quantity > ce.capacity) throw new BadRequest('Event capacity reached', undefined, 'CAPACITY'); }
    const amount = b.complimentary ? 0 : r2(b.quantity * Number(tt.price));
    if (b.complimentary && !hasPermission(req, 'clubs.manage')) throw new Forbidden('Complimentary tickets require clubs.manage');
    const bd = await currentBusinessDate(c, ce.property_id, req.user!.id);
    let paymentId: string | null = null;
    if (amount > 0) {
      const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
      const { postJournal, defaultTaxFor } = await import('../finance/accounting.service');
      const tax = await defaultTaxFor(c, ce.property_id, 'SERVICE'); const t = tax ? splitTax(amount, Number(tax.rate), !!tax.is_inclusive) : { net: amount, tax: 0, gross: amount };
      const { payment } = await recordPayment(c, { propertyId: ce.property_id, direction: 'IN', kind: 'PAYMENT', paymentMethodId: methodId, amount: t.gross, reference: b.reference, partyType: b.guest_id ? 'GUEST' : null, partyId: b.guest_id ?? null, sourceType: 'CLUB_TICKET', cashierShiftId: b.cashier_shift_id ?? null, outletId: ce.outlet_id, userId: req.user!.id, offset: { mappingKey: 'POS_CLEARING' }, description: `${ce.name} tickets x${b.quantity}`, idempotencyKey: (req.headers['idempotency-key'] as string) ?? null });
      const lines: any[] = [{ mappingKey: 'POS_CLEARING', debit: t.gross }, { mappingKey: 'CLUB_REVENUE', credit: t.net, outletId: ce.outlet_id }];
      if (t.tax > 0) lines.push({ accountId: tax.account_id, credit: t.tax });
      await postJournal(c, { propertyId: ce.property_id, businessDate: bd, description: `Club ticket revenue ${ce.name}`, sourceType: 'CLUB_TICKET', userId: req.user!.id, lines });
      paymentId = payment.id;
    }
    const number = await nextNumber(c, 'TICKET', ce.property_id);
    const qr = `HMS-TKT:${number}:${ce.id.slice(0, 8)}:${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const t = (await c.query(`INSERT INTO club_tickets (event_id, ticket_type_id, number, qr_code, holder_name, holder_phone, guest_id, quantity, amount, payment_id, status, sold_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SOLD',$11) RETURNING *`, [ce.id, tt.id, number, qr, b.holder_name ?? null, b.holder_phone ?? null, b.guest_id ?? null, b.quantity, amount, paymentId, req.user!.id])).rows[0];
    await c.query(`UPDATE club_ticket_types SET quantity_sold = quantity_sold + $2 WHERE id=$1`, [tt.id, b.quantity]);
    await audit({ ...auditCtx(req), action: 'SELL_TICKET', entityType: 'club_ticket', entityId: t.id, newValue: { number, amount, quantity: b.quantity } }, c);
    return t;
  });
  res.status(201).json(out);
}));
clubEventsRouter.get('/:id/tickets', requirePermission('clubs.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT t.*, tt.name AS ticket_type, u.full_name AS sold_by_name FROM club_tickets t JOIN club_ticket_types tt ON tt.id=t.ticket_type_id LEFT JOIN users u ON u.id=t.sold_by`, where: ['t.event_id=$1'], params: [req.params.id], searchColumns: ['t.number', 't.holder_name', 't.holder_phone', 't.qr_code'], defaultSort: 't.created_at', filters: { status: 't.status', ticket_type_id: 't.ticket_type_id' }, exportName: 'club_tickets' });
}));
/** Door scan: validates the QR / ticket number and checks the holder in (idempotent per ticket). */
clubEventsRouter.post('/:id/check-in', requirePermission('clubs.sell_tickets', 'clubs.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ code: z.string().min(3) }), req.body);
  const out = await withTransaction(async (c) => {
    const t = (await c.query(`SELECT t.*, tt.name AS ticket_type FROM club_tickets t JOIN club_ticket_types tt ON tt.id=t.ticket_type_id WHERE t.event_id=$1 AND (t.qr_code=$2 OR t.number=$2) FOR UPDATE OF t`, [req.params.id, b.code])).rows[0];
    if (!t) throw new BadRequest('Ticket not found for this event', undefined, 'INVALID_TICKET');
    if (t.status === 'CHECKED_IN') throw new BadRequest(`Ticket ${t.number} was already used at ${new Date(t.checked_in_at).toLocaleTimeString()}`, { ticket: t }, 'ALREADY_USED');
    if (t.status !== 'SOLD') throw Errors.invalidStatus('ticket', t.status, 'check in');
    const r = (await c.query(`UPDATE club_tickets SET status='CHECKED_IN', checked_in_at=now() WHERE id=$1 RETURNING *`, [t.id])).rows[0];
    return { ok: true, ticket: { ...r, ticket_type: t.ticket_type } };
  });
  res.json(out);
}));
clubEventsRouter.post('/:id/tickets/:ticketId/cancel', requirePermission('clubs.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2), refund: z.boolean().default(false), payment_method_code: z.string().optional(), cashier_shift_id: z.string().uuid().nullable().optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const t = (await c.query(`SELECT t.*, o.property_id, ce.outlet_id, ce.name AS event_name FROM club_tickets t JOIN club_events ce ON ce.id=t.event_id JOIN outlets o ON o.id=ce.outlet_id WHERE t.id=$1 AND t.event_id=$2 FOR UPDATE OF t`, [req.params.ticketId, req.params.id])).rows[0];
    if (!t) throw new NotFound('Ticket not found');
    if (t.status !== 'SOLD') throw Errors.invalidStatus('ticket', t.status, 'cancel');
    if (b.refund && Number(t.amount) > 0) {
      if (!hasPermission(req, 'payments.refund')) throw Errors.unauthorizedRefund();
      const methodId = await resolvePaymentMethodId(undefined, b.payment_method_code ?? 'CASH', c);
      const { postJournal } = await import('../finance/accounting.service');
      const bd = await currentBusinessDate(c, t.property_id, req.user!.id);
      await recordPayment(c, { propertyId: t.property_id, direction: 'OUT', kind: 'REFUND', paymentMethodId: methodId, amount: Number(t.amount), sourceType: 'CLUB_TICKET', sourceId: t.id, cashierShiftId: b.cashier_shift_id ?? null, outletId: t.outlet_id, userId: req.user!.id, offset: { mappingKey: 'POS_CLEARING' }, description: `Refund ticket ${t.number}` });
      await postJournal(c, { propertyId: t.property_id, businessDate: bd, description: `Ticket refund ${t.number} ${t.event_name}`, sourceType: 'CLUB_TICKET', sourceId: t.id, userId: req.user!.id, lines: [{ mappingKey: 'SALES_RETURNS', debit: Number(t.amount), outletId: t.outlet_id }, { mappingKey: 'POS_CLEARING', credit: Number(t.amount) }] });
    }
    const r = (await c.query(`UPDATE club_tickets SET status=$2 WHERE id=$1 RETURNING *`, [t.id, b.refund ? 'REFUNDED' : 'CANCELLED'])).rows[0];
    await c.query(`UPDATE club_ticket_types SET quantity_sold = GREATEST(0, quantity_sold - $2) WHERE id=$1`, [t.ticket_type_id, t.quantity]);
    await audit({ ...auditCtx(req), action: b.refund ? 'REFUND' : 'CANCEL', entityType: 'club_ticket', entityId: t.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- Staff scheduling ----------------
export const staffShiftsRouter = Router();
staffShiftsRouter.get('/', requirePermission('employees.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT a.*, t.name AS shift_name, t.start_time, t.end_time, e.first_name || ' ' || e.last_name AS employee_name, e.position, d.name AS department_name, o.name AS outlet_name, u.full_name AS supervisor_name FROM staff_shift_assignments a JOIN shift_templates t ON t.id=a.shift_template_id JOIN employees e ON e.id=a.employee_id LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN outlets o ON o.id=a.outlet_id LEFT JOIN users u ON u.id=a.supervisor_user_id`, where: ['e.property_id=$1'], params: [req.propertyId], searchColumns: ['e.first_name', 'e.last_name', 't.name'], defaultSort: 'a.shift_date', filters: { employee_id: 'a.employee_id', shift_template_id: 'a.shift_template_id', department_id: 'e.department_id', outlet_id: 'a.outlet_id' }, dateFilters: { date: 'a.shift_date' }, exportName: 'staff_shifts' });
}));
staffShiftsRouter.get('/roster', requirePermission('employees.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 10)), to = String(req.query.to ?? new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10));
  const rows = (await pool.query(`SELECT e.id AS employee_id, e.first_name || ' ' || e.last_name AS employee_name, e.position, d.name AS department_name, COALESCE(json_agg(json_build_object('id', a.id, 'date', a.shift_date, 'shift', t.name, 'start', t.start_time, 'end', t.end_time, 'outlet_id', a.outlet_id, 'clock_in', a.clock_in, 'clock_out', a.clock_out) ORDER BY a.shift_date) FILTER (WHERE a.id IS NOT NULL), '[]') AS shifts FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN staff_shift_assignments a ON a.employee_id=e.id AND a.shift_date BETWEEN $2 AND $3 LEFT JOIN shift_templates t ON t.id=a.shift_template_id WHERE e.property_id=$1 AND e.status='ACTIVE' AND ($4::uuid IS NULL OR e.department_id=$4) GROUP BY e.id, d.name ORDER BY d.name, employee_name`, [req.propertyId, from, to, req.query.department_id ?? null])).rows;
  res.json({ from, to, employees: rows });
}));
staffShiftsRouter.post('/', requirePermission('employees.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ assignments: z.array(z.object({ shift_template_id: z.string().uuid(), employee_id: z.string().uuid(), shift_date: dateStr, outlet_id: z.string().uuid().nullable().optional() })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const rows = [];
    for (const a of b.assignments) {
      const clash = (await c.query(`SELECT 1 FROM staff_shift_assignments x JOIN shift_templates t ON t.id=x.shift_template_id JOIN shift_templates n ON n.id=$2 WHERE x.employee_id=$1 AND x.shift_date=$3 AND (t.start_time, t.end_time) OVERLAPS (n.start_time, n.end_time)`, [a.employee_id, a.shift_template_id, a.shift_date])).rows[0];
      if (clash) throw new BadRequest(`Employee already has an overlapping shift on ${a.shift_date}`, a, 'SHIFT_OVERLAP');
      rows.push((await c.query(`INSERT INTO staff_shift_assignments (shift_template_id, employee_id, shift_date, outlet_id, supervisor_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.shift_template_id, a.employee_id, a.shift_date, a.outlet_id ?? null, req.user!.id])).rows[0]);
    }
    await audit({ ...auditCtx(req), action: 'ROSTER', entityType: 'staff_shift_assignment', entityId: null, newValue: b }, c);
    return rows;
  });
  res.status(201).json(out);
}));
staffShiftsRouter.post('/:id/clock', requirePermission('employees.manage', 'employees.view'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ action: z.enum(['IN', 'OUT']), attendance_ref: optionalStr }), req.body);
  const r = (await pool.query(b.action === 'IN' ? `UPDATE staff_shift_assignments SET clock_in=now(), attendance_ref=COALESCE($2,attendance_ref) WHERE id=$1 AND clock_in IS NULL RETURNING *` : `UPDATE staff_shift_assignments SET clock_out=now(), attendance_ref=COALESCE($2,attendance_ref) WHERE id=$1 AND clock_in IS NOT NULL AND clock_out IS NULL RETURNING *`, [req.params.id, b.attendance_ref ?? null])).rows[0];
  if (!r) throw new BadRequest(`Cannot clock ${b.action.toLowerCase()} for this shift`);
  res.json(r);
}));
staffShiftsRouter.delete('/:id', requirePermission('employees.manage'), asyncHandler(async (req, res) => {
  const r = (await pool.query(`DELETE FROM staff_shift_assignments WHERE id=$1 AND clock_in IS NULL RETURNING id`, [req.params.id])).rows[0];
  if (!r) throw new BadRequest('Shift not found or already started');
  res.json({ ok: true });
}));
