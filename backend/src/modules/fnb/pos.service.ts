import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { nextNumber } from '../../core/numbering';
import { Errors, NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit } from '../../core/audit';
import { notify } from '../../core/notify';
import { AuthUser } from '../auth/auth.types';
import { postJournal, splitTax, getTax, currentBusinessDate, r2, reverseJournal } from '../finance/accounting.service';
import { resolvePaymentMethodId, recordPayment } from '../finance/payments.service';
import { postCharge } from '../pms/folio.service';
import { consumeForMenuItem, postCogs } from '../inventory/stock.service';
import { LIMIT_CODES } from '../../core/permissions';

// ---------- Cashier shifts ----------
export async function openShift(user: AuthUser, propertyId: string, opts: { outletId?: string | null; terminalId?: string | null; openingFloat: number; notes?: string | null }) {
  return withTransaction(async (client) => {
    const existing = await client.query(`SELECT id, number FROM cashier_shifts WHERE user_id=$1 AND status='OPEN'`, [user.id]);
    if (existing.rows[0]) throw new BadRequest(`You already have an open shift (${existing.rows[0].number}). Close it first.`, undefined, 'SHIFT_ALREADY_OPEN');
    const number = await nextNumber(client, 'SHIFT', propertyId);
    const bd = await currentBusinessDate(client, propertyId, user.id);
    const row = (await client.query(`INSERT INTO cashier_shifts (property_id, number, outlet_id, terminal_id, user_id, business_date, opening_float, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [propertyId, number, opts.outletId ?? null, opts.terminalId ?? null, user.id, bd, opts.openingFloat, opts.notes ?? null])).rows[0];
    await audit({ userId: user.id, username: user.username, propertyId, action: 'OPEN_SHIFT', entityType: 'cashier_shift', entityId: row.id, newValue: row }, client);
    return row;
  });
}

export async function shiftSummary(db: PoolClient | typeof pool, shiftId: string) {
  const shift = (await db.query(`SELECT s.*, u.full_name AS cashier_name, o.name AS outlet_name FROM cashier_shifts s JOIN users u ON u.id=s.user_id LEFT JOIN outlets o ON o.id=s.outlet_id WHERE s.id=$1`, [shiftId])).rows[0];
  if (!shift) throw new NotFound('Shift not found');
  const byMethod = (await db.query(
    `SELECT pm.name AS method, pm.type, pm.is_cash_drawer, p.direction, COUNT(*)::int AS count, SUM(p.amount) AS amount
       FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.cashier_shift_id=$1 AND p.status='COMPLETED' GROUP BY pm.name, pm.type, pm.is_cash_drawer, p.direction ORDER BY pm.name`, [shiftId])).rows;
  const cashIn = byMethod.filter((m) => m.is_cash_drawer && m.direction === 'IN').reduce((s, m) => s + Number(m.amount), 0);
  const cashOut = byMethod.filter((m) => m.is_cash_drawer && m.direction === 'OUT').reduce((s, m) => s + Number(m.amount), 0);
  const orders = (await db.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount_total),0) AS discounts FROM orders WHERE cashier_shift_id=$1 AND status IN ('CLOSED')`, [shiftId])).rows[0];
  const voids = (await db.query(`SELECT COUNT(*)::int AS count FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.cashier_shift_id=$1 AND oi.voided`, [shiftId])).rows[0];
  const refunds = (await db.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS total FROM payments WHERE cashier_shift_id=$1 AND kind='REFUND'`, [shiftId])).rows[0];
  const expectedCash = r2(Number(shift.opening_float) + cashIn - cashOut);
  return { shift, by_method: byMethod, cash_in: r2(cashIn), cash_out: r2(cashOut), expected_cash: expectedCash, orders, voids: voids.count, refunds };
}

export async function closeShift(shiftId: string, user: AuthUser, actualCash: number, varianceReason?: string | null, notes?: string | null) {
  return withTransaction(async (client) => {
    const shift = (await client.query(`SELECT * FROM cashier_shifts WHERE id=$1 FOR UPDATE`, [shiftId])).rows[0];
    if (!shift) throw new NotFound('Shift not found');
    if (shift.status === 'CLOSED') throw Errors.invalidStatus('shift', 'CLOSED', 'close');
    if (shift.user_id !== user.id && !user.permissions.has('pos.approve_variance') && !user.is_superuser) throw new Forbidden('Only the shift owner or a supervisor can close this shift');
    const open = await client.query(`SELECT COUNT(*) FROM orders WHERE cashier_shift_id=$1 AND status IN ('OPEN','BILLED')`, [shiftId]);
    if (Number(open.rows[0].count) > 0) throw new BadRequest(`There are ${open.rows[0].count} unclosed orders on this shift. Close or transfer them first.`, undefined, 'OPEN_ORDERS');
    const summary = await shiftSummary(client, shiftId);
    const variance = r2(actualCash - summary.expected_cash);
    const limit = user.is_superuser ? Number.MAX_SAFE_INTEGER : (user.limits[LIMIT_CODES.CASH_VARIANCE] ?? 0);
    let status = 'CLOSED';
    let approvedBy: string | null = null;
    if (Math.abs(variance) > 0.005) {
      if (!varianceReason) throw new BadRequest(`Cash variance of ${variance.toFixed(2)} requires a reason`);
      if (Math.abs(variance) > limit) {
        if (user.permissions.has('pos.approve_variance') || user.is_superuser) approvedBy = user.id;
        else status = 'PENDING_APPROVAL';
      }
    }
    const row = (await client.query(`UPDATE cashier_shifts SET status=$2, expected_cash=$3, actual_cash=$4, variance=$5, variance_reason=$6, variance_approved_by=$7, totals_by_method=$8, closed_at=now(), closed_by=$9, notes=COALESCE($10, notes) WHERE id=$1 RETURNING *`,
      [shiftId, status, summary.expected_cash, actualCash, variance, varianceReason ?? null, approvedBy, JSON.stringify(summary.by_method), user.id, notes ?? null])).rows[0];
    if (Math.abs(variance) > 0.005 && status === 'CLOSED') {
      // Post cash over/short: DR/CR Cash vs Cash Over/Short expense
      await postJournal(client, { propertyId: shift.property_id, description: `Cash ${variance > 0 ? 'over' : 'short'} shift ${shift.number}`, sourceType: 'SHIFT', sourceId: shift.id, businessDate: shift.business_date, userId: user.id,
        lines: variance > 0 ? [{ mappingKey: 'CASH', debit: variance }, { mappingKey: 'CASH_OVER_SHORT', credit: variance }] : [{ mappingKey: 'CASH_OVER_SHORT', debit: -variance }, { mappingKey: 'CASH', credit: -variance }] });
    }
    if (status === 'PENDING_APPROVAL') await notify({ permission: 'pos.approve_variance', propertyId: shift.property_id, type: 'CASH_VARIANCE', title: `Cash variance ${variance.toFixed(2)} on shift ${shift.number} needs approval`, body: varianceReason ?? undefined, entityType: 'cashier_shift', entityId: shift.id, link: '/finance/cashiers', severity: 'WARNING' }, client);
    await audit({ userId: user.id, username: user.username, propertyId: shift.property_id, action: 'CLOSE_SHIFT', entityType: 'cashier_shift', entityId: shift.id, newValue: { expected: summary.expected_cash, actual: actualCash, variance, status }, reason: varianceReason }, client);
    return { ...row, summary };
  });
}

export async function approveVariance(shiftId: string, user: AuthUser, comment?: string) {
  return withTransaction(async (client) => {
    const shift = (await client.query(`SELECT * FROM cashier_shifts WHERE id=$1 FOR UPDATE`, [shiftId])).rows[0];
    if (!shift || shift.status !== 'PENDING_APPROVAL') throw new BadRequest('Shift is not pending variance approval');
    const variance = Number(shift.variance);
    await postJournal(client, { propertyId: shift.property_id, description: `Cash ${variance > 0 ? 'over' : 'short'} shift ${shift.number} (approved)`, sourceType: 'SHIFT', sourceId: shift.id, businessDate: shift.business_date, userId: user.id,
      lines: variance > 0 ? [{ mappingKey: 'CASH', debit: variance }, { mappingKey: 'CASH_OVER_SHORT', credit: variance }] : [{ mappingKey: 'CASH_OVER_SHORT', debit: -variance }, { mappingKey: 'CASH', credit: -variance }] });
    const row = (await client.query(`UPDATE cashier_shifts SET status='CLOSED', variance_approved_by=$2 WHERE id=$1 RETURNING *`, [shiftId, user.id])).rows[0];
    await audit({ userId: user.id, username: user.username, propertyId: shift.property_id, action: 'APPROVE', entityType: 'cashier_shift', entityId: shift.id, reason: comment }, client);
    return row;
  });
}

export async function requireOpenShift(client: PoolClient, userId: string, outletId?: string | null): Promise<any> {
  const r = await client.query(`SELECT * FROM cashier_shifts WHERE user_id=$1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1`, [userId]);
  if (!r.rows[0]) throw Errors.closedShift();
  return r.rows[0];
}

// ---------- Orders ----------
async function outletCtx(client: PoolClient, outletId: string) {
  const o = (await client.query(`SELECT o.*, p.service_charge_percent AS property_sc FROM outlets o JOIN properties p ON p.id=o.property_id WHERE o.id=$1 AND o.is_active`, [outletId])).rows[0];
  if (!o) throw new NotFound('Outlet not found or inactive');
  return o;
}

export async function recalcOrder(client: PoolClient, orderId: string) {
  const order = (await client.query(`SELECT o.*, ol.service_charge_percent AS outlet_sc, p.service_charge_percent AS property_sc FROM orders o JOIN outlets ol ON ol.id=o.outlet_id JOIN properties p ON p.id=o.property_id WHERE o.id=$1`, [orderId])).rows[0];
  const items = (await client.query(`SELECT oi.*, mi.is_service_charge_applicable FROM order_items oi JOIN menu_items mi ON mi.id=oi.menu_item_id WHERE oi.order_id=$1 AND NOT oi.voided`, [orderId])).rows;
  let subtotal = 0, tax = 0, scBase = 0, discount = 0;
  for (const it of items) {
    const gross = Number(it.line_total);
    subtotal += gross - Number(it.tax_amount); tax += Number(it.tax_amount); discount += Number(it.discount);
    if (it.is_service_charge_applicable && !it.is_complimentary) scBase += gross;
  }
  const scPct = order.outlet_sc !== null ? Number(order.outlet_sc) : Number(order.property_sc);
  const sc = r2(scBase * scPct / 100);
  const total = r2(subtotal + tax + sc);
  await client.query(`UPDATE orders SET subtotal=$2, tax_total=$3, service_charge=$4, discount_total=$5, total=$6 WHERE id=$1`, [orderId, r2(subtotal), r2(tax), sc, r2(discount), total]);
  return { subtotal: r2(subtotal), tax: r2(tax), service_charge: sc, discount: r2(discount), total };
}

export async function createOrder(user: AuthUser, propertyId: string, input: { outlet_id: string; type: string; table_id?: string | null; covers?: number; stay_id?: string | null; guest_id?: string | null; customer_id?: string | null; event_id?: string | null; notes?: string | null; delivery_address?: string | null; idempotency_key?: string | null; items?: any[] }) {
  return withTransaction(async (client) => {
    if (input.idempotency_key) {
      const dup = await client.query(`SELECT id FROM orders WHERE idempotency_key=$1`, [input.idempotency_key]);
      if (dup.rows[0]) return orderDetail(dup.rows[0].id, client);
    }
    const outlet = await outletCtx(client, input.outlet_id);
    const shift = await requireOpenShift(client, user.id, input.outlet_id);
    if (input.table_id) {
      const t = (await client.query(`SELECT * FROM outlet_tables WHERE id=$1 FOR UPDATE`, [input.table_id])).rows[0];
      if (!t) throw new NotFound('Table not found');
      if (t.status === 'BLOCKED') throw new BadRequest(`Table ${t.number} is blocked`);
      await client.query(`UPDATE outlet_tables SET status='OCCUPIED' WHERE id=$1`, [input.table_id]);
    }
    if (input.stay_id) {
      const s = (await client.query(`SELECT id, guest_id FROM stays WHERE id=$1 AND status='IN_HOUSE'`, [input.stay_id])).rows[0];
      if (!s) throw new BadRequest('Guest is not in-house');
      input.guest_id = s.guest_id;
    }
    const number = await nextNumber(client, 'ORDER', propertyId);
    const bd = await currentBusinessDate(client, propertyId, user.id);
    const order = (await client.query(
      `INSERT INTO orders (property_id, outlet_id, number, type, table_id, covers, waiter_id, cashier_shift_id, stay_id, guest_id, customer_id, event_id, business_date, notes, delivery_address, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$7) RETURNING *`,
      [propertyId, outlet.id, number, input.type, input.table_id ?? null, input.covers ?? 1, user.id, shift.id, input.stay_id ?? null, input.guest_id ?? null, input.customer_id ?? null, input.event_id ?? null, bd, input.notes ?? null, input.delivery_address ?? null, input.idempotency_key ?? null])).rows[0];
    if (input.items?.length) await addItemsInternal(client, order.id, input.items, user);
    await audit({ userId: user.id, username: user.username, propertyId, action: 'CREATE', entityType: 'order', entityId: order.id, newValue: { number, outlet: outlet.name, table: input.table_id } }, client);
    return orderDetail(order.id, client);
  });
}

async function addItemsInternal(client: PoolClient, orderId: string, items: { menu_item_id: string; quantity: number; modifiers?: { id?: string; name: string; price_delta?: number; product_id?: string; product_qty?: number }[]; special_instructions?: string | null; seat_no?: number | null; course?: number | null; is_complimentary?: boolean }[], user: AuthUser) {
  const order = (await client.query(`SELECT o.*, ol.default_kitchen_id, ol.tax_id AS outlet_tax_id, ol.property_id FROM orders o JOIN outlets ol ON ol.id=o.outlet_id WHERE o.id=$1 FOR UPDATE`, [orderId])).rows[0];
  if (!order) throw new NotFound('Order not found');
  if (order.status !== 'OPEN') throw Errors.invalidStatus('order', order.status, 'add items');
  const created: any[] = [];
  for (const it of items) {
    const mi = (await client.query(`SELECT mi.*, mc.kitchen_id AS category_kitchen_id, mc.type AS category_type FROM menu_items mi JOIN menu_categories mc ON mc.id=mi.category_id WHERE mi.id=$1 AND mi.is_active`, [it.menu_item_id])).rows[0];
    if (!mi) throw new NotFound('Menu item not found');
    if (!mi.is_available) throw new BadRequest(`${mi.name} is currently unavailable`);
    if (it.is_complimentary && !user.permissions.has('pos.discount') && !user.is_superuser) throw new Forbidden('Complimentary items require discount permission');
    const modifiers = (it.modifiers ?? []).map((m) => ({ id: m.id ?? null, name: m.name, price_delta: Number(m.price_delta ?? 0), product_id: m.product_id ?? null, product_qty: Number(m.product_qty ?? 0) }));
    const modsTotal = r2(modifiers.reduce((s, m) => s + m.price_delta, 0));
    const unit = Number(mi.price) + modsTotal;
    const gross = it.is_complimentary ? 0 : r2(unit * it.quantity);
    const taxId = mi.tax_id ?? order.outlet_tax_id ?? null;
    const tax = taxId ? await getTax(client, taxId) : null;
    const split = tax ? splitTax(gross, Number(tax.rate), tax.is_inclusive) : { net: gross, tax: 0, gross };
    const kitchenId = mi.kitchen_id ?? mi.category_kitchen_id ?? order.default_kitchen_id ?? null;
    const row = (await client.query(
      `INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, modifiers, modifiers_total, tax_id, tax_amount, line_total, is_complimentary, special_instructions, kitchen_id, seat_no, course, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [orderId, mi.id, mi.name, it.quantity, mi.price, JSON.stringify(modifiers), modsTotal, taxId, split.tax, split.gross, !!it.is_complimentary, it.special_instructions ?? null, kitchenId, it.seat_no ?? null, it.course ?? null, user.id])).rows[0];
    created.push(row);
  }
  await recalcOrder(client, orderId);
  return created;
}

export async function addItems(orderId: string, items: any[], user: AuthUser) {
  return withTransaction(async (client) => { await addItemsInternal(client, orderId, items, user); return orderDetail(orderId, client); });
}

/** Send NEW items to their kitchens: creates kitchen tickets grouped per kitchen and marks items SENT. */
export async function sendToKitchen(orderId: string, user: AuthUser, itemIds?: string[]) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new NotFound('Order not found');
    if (order.status !== 'OPEN') throw Errors.invalidStatus('order', order.status, 'send to kitchen');
    const items = (await client.query(`SELECT * FROM order_items WHERE order_id=$1 AND kitchen_status='NEW' AND NOT voided AND ($2::uuid[] IS NULL OR id = ANY($2))`, [orderId, itemIds ?? null])).rows;
    const byKitchen: Record<string, any[]> = {};
    for (const it of items) { if (it.kitchen_id) (byKitchen[it.kitchen_id] ??= []).push(it); else await client.query(`UPDATE order_items SET kitchen_status='SERVED', sent_at=now(), served_at=now() WHERE id=$1`, [it.id]); }
    const tickets = [];
    for (const [kitchenId, its] of Object.entries(byKitchen)) {
      const no = Number((await client.query(`SELECT COALESCE(MAX(ticket_no),0)+1 AS n FROM kitchen_tickets WHERE kitchen_id=$1 AND sent_at::date=CURRENT_DATE`, [kitchenId])).rows[0].n);
      const t = (await client.query(`INSERT INTO kitchen_tickets (order_id, kitchen_id, ticket_no, item_ids, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [orderId, kitchenId, no, its.map((i) => i.id), order.notes])).rows[0];
      await client.query(`UPDATE order_items SET kitchen_status='SENT', sent_at=now() WHERE id = ANY($1)`, [its.map((i) => i.id)]);
      tickets.push(t);
    }
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'SEND_TO_KITCHEN', entityType: 'order', entityId: orderId, newValue: { tickets: tickets.length, items: items.length } }, client);
    return orderDetail(orderId, client);
  });
}

export async function updateKitchenStatus(ticketId: string, status: 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED', user: AuthUser) {
  return withTransaction(async (client) => {
    const t = (await client.query(`SELECT * FROM kitchen_tickets WHERE id=$1 FOR UPDATE`, [ticketId])).rows[0];
    if (!t) throw new NotFound('Ticket not found');
    const col = { ACCEPTED: 'accepted_at', PREPARING: 'accepted_at', READY: 'ready_at', SERVED: 'served_at', CANCELLED: 'served_at' }[status];
    await client.query(`UPDATE kitchen_tickets SET status=$2, ${col}=COALESCE(${col}, now()) WHERE id=$1`, [ticketId, status]);
    await client.query(`UPDATE order_items SET kitchen_status=$2, ${col}=COALESCE(${col}, now()) WHERE id = ANY($1) AND NOT voided`, [t.item_ids, status]);
    if (status === 'READY') {
      const o = (await client.query(`SELECT waiter_id, number, table_id FROM orders WHERE id=$1`, [t.order_id])).rows[0];
      if (o?.waiter_id) await notify({ userIds: [o.waiter_id], type: 'ORDER_READY', title: `Order ${o.number} ready for pickup`, entityType: 'order', entityId: t.order_id, link: `/pos`, severity: 'SUCCESS' }, client);
    }
    return (await client.query(`SELECT * FROM kitchen_tickets WHERE id=$1`, [ticketId])).rows[0];
  });
}

export async function voidItem(orderId: string, itemId: string, reason: string, user: AuthUser) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order || order.status !== 'OPEN') throw new BadRequest('Only open orders can be modified');
    const item = (await client.query(`SELECT * FROM order_items WHERE id=$1 AND order_id=$2`, [itemId, orderId])).rows[0];
    if (!item) throw new NotFound('Item not found');
    if (item.voided) throw new BadRequest('Item already voided');
    if (item.kitchen_status !== 'NEW' && !user.permissions.has('pos.void_item') && !user.is_superuser) throw new Forbidden('Voiding items already sent to the kitchen requires void permission');
    await client.query(`UPDATE order_items SET voided=true, void_reason=$2, voided_by=$3, kitchen_status=CASE WHEN kitchen_status='NEW' THEN 'CANCELLED' ELSE kitchen_status END WHERE id=$1`, [itemId, reason, user.id]);
    if (item.kitchen_status !== 'NEW' && item.kitchen_status !== 'SERVED') {
      const kt = (await client.query(`SELECT id FROM kitchen_tickets WHERE order_id=$1 AND $2 = ANY(item_ids)`, [orderId, itemId])).rows[0];
      if (kt) await client.query(`UPDATE kitchen_tickets SET notes=COALESCE(notes,'') || ' VOID: ' || $2 WHERE id=$1`, [kt.id, item.name]);
      await client.query(`UPDATE order_items SET kitchen_status='CANCELLED' WHERE id=$1`, [itemId]);
    }
    await recalcOrder(client, orderId);
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'VOID', entityType: 'order_item', entityId: itemId, oldValue: item, reason }, client);
    return orderDetail(orderId, client);
  });
}

export async function applyDiscount(orderId: string, user: AuthUser, opts: { type: 'PERCENT' | 'FIXED'; value: number; reason: string; item_id?: string | null }) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order || order.status !== 'OPEN') throw new BadRequest('Only open orders can be discounted');
    if (!user.permissions.has('pos.discount') && !user.is_superuser) throw new Forbidden('Discount permission required');
    const items = (await client.query(`SELECT oi.* FROM order_items oi WHERE oi.order_id=$1 AND NOT oi.voided AND NOT oi.is_complimentary AND ($2::uuid IS NULL OR oi.id=$2)`, [orderId, opts.item_id ?? null])).rows;
    const base = items.reduce((s, i) => s + r2(Number(i.unit_price) + Number(i.modifiers_total)) * Number(i.quantity), 0);
    const totalDiscount = opts.type === 'PERCENT' ? r2(base * opts.value / 100) : r2(opts.value);
    const pct = base > 0 ? (totalDiscount / base) * 100 : 0;
    const limit = user.is_superuser ? 100 : (user.limits[LIMIT_CODES.DISCOUNT_PERCENT] ?? 0);
    if (pct > limit + 0.0001) throw Errors.unauthorizedDiscount(limit);
    // distribute proportionally and recompute tax per line
    for (const it of items) {
      const lineBase = r2((Number(it.unit_price) + Number(it.modifiers_total)) * Number(it.quantity));
      const d = base > 0 ? r2(totalDiscount * lineBase / base) : 0;
      const gross = r2(lineBase - d);
      const tax = it.tax_id ? await getTax(client, it.tax_id) : null;
      const split = tax ? splitTax(gross, Number(tax.rate), tax.is_inclusive) : { net: gross, tax: 0, gross };
      await client.query(`UPDATE order_items SET discount=$2, tax_amount=$3, line_total=$4 WHERE id=$1`, [it.id, d, split.tax, split.gross]);
    }
    await client.query(`UPDATE orders SET discount_reason=$2, discount_approved_by=$3 WHERE id=$1`, [orderId, opts.reason, user.id]);
    await recalcOrder(client, orderId);
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'DISCOUNT', entityType: 'order', entityId: orderId, newValue: { ...opts, amount: totalDiscount, original: base }, reason: opts.reason }, client);
    return orderDetail(orderId, client);
  });
}

export async function billOrder(orderId: string, user: AuthUser) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new NotFound('Order not found');
    if (order.status !== 'OPEN') throw Errors.invalidStatus('order', order.status, 'bill');
    const cnt = await client.query(`SELECT COUNT(*) FROM order_items WHERE order_id=$1 AND NOT voided`, [orderId]);
    if (Number(cnt.rows[0].count) === 0) throw new BadRequest('Order has no items');
    await recalcOrder(client, orderId);
    await client.query(`UPDATE orders SET status='BILLED', billed_at=now() WHERE id=$1`, [orderId]);
    return orderDetail(orderId, client);
  });
}

export interface SettleInput {
  payments: { payment_method_id?: string; payment_method_code?: string; method: 'PAYMENT' | 'ROOM_CHARGE' | 'CORPORATE' | 'COMPLIMENTARY'; amount: number; reference?: string | null; tip?: number; stay_id?: string | null; customer_id?: string | null }[];
  idempotency_key?: string | null;
}

/**
 * Settle & close an order. Atomically: payments/room charge/corporate posting → revenue journal → inventory consumption → COGS journal → table release.
 */
export async function settleOrder(orderId: string, user: AuthUser, input: SettleInput) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT o.*, ol.store_id, ol.name AS outlet_name, ol.revenue_account_id, ol.cogs_account_id, ol.allows_room_charge, ol.type AS outlet_type FROM orders o JOIN outlets ol ON ol.id=o.outlet_id WHERE o.id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new NotFound('Order not found');
    if (!['OPEN', 'BILLED'].includes(order.status)) throw Errors.invalidStatus('order', order.status, 'settle');
    if (input.idempotency_key) {
      const dup = await client.query(`SELECT 1 FROM payments WHERE idempotency_key LIKE $1`, [`${input.idempotency_key}%`]);
      if (dup.rows[0]) throw Errors.duplicate('This settlement was already processed');
    }
    const shift = await requireOpenShift(client, user.id, order.outlet_id);
    const totals = await recalcOrder(client, orderId);
    const items = (await client.query(`SELECT * FROM order_items WHERE order_id=$1 AND NOT voided`, [orderId])).rows;
    if (!items.length) throw new BadRequest('Order has no items');
    // Convenience: a single payment line with no amount settles the full bill (e.g. room charge / corporate).
    if (input.payments.length === 1 && !Number(input.payments[0].amount)) input.payments[0].amount = totals.total;
    const paySum = r2(input.payments.reduce((s, p) => s + Number(p.amount), 0));
    if (Math.abs(paySum - totals.total) > 0.01) throw Errors.invalidPayment(`Payments (${paySum.toFixed(2)}) must equal the order total (${totals.total.toFixed(2)})`);
    const bd = order.business_date ? String(order.business_date).slice(0, 10) : await currentBusinessDate(client, order.property_id, user.id);
    const revenueKey = order.outlet_type === 'BAR' ? 'BAR_REVENUE' : order.outlet_type === 'CLUB' ? 'CLUB_REVENUE' : 'RESTAURANT_REVENUE';
    const folioCategory = order.outlet_type === 'BAR' ? 'BAR' : order.outlet_type === 'CLUB' ? 'CLUB' : order.type === 'ROOM_SERVICE' ? 'ROOM_SERVICE' : 'RESTAURANT';

    // 1. Revenue journal: DR (clearing per settlement) / CR revenue, tax, service charge
    const taxByAccount: Record<string, number> = {};
    for (const it of items) {
      if (Number(it.tax_amount) === 0) continue;
      const tax = await getTax(client, it.tax_id);
      const key = tax?.account_id ?? 'TAX_PAYABLE';
      taxByAccount[key] = r2((taxByAccount[key] ?? 0) + Number(it.tax_amount));
    }
    const lines: any[] = [];
    let settlementType = input.payments.length > 1 ? 'MIXED' : input.payments[0].method;
    let folioItemId: string | null = null;
    for (const p of input.payments) {
      const amt = r2(Number(p.amount));
      if (amt <= 0) continue;
      if (p.method === 'ROOM_CHARGE') {
        if (!order.allows_room_charge) throw new BadRequest('This outlet does not allow room charges');
        if (!user.permissions.has('pos.room_charge') && !user.is_superuser) throw new Forbidden('Room charge permission required');
        const stayId = p.stay_id ?? order.stay_id;
        if (!stayId) throw new BadRequest('Select the guest room to charge');
        const folio = (await client.query(`SELECT f.id, s.status FROM folios f JOIN stays s ON s.id=f.stay_id WHERE f.stay_id=$1 AND f.status='OPEN' AND f.type='GUEST' ORDER BY f.created_at LIMIT 1`, [stayId])).rows[0];
        if (!folio || folio.status !== 'IN_HOUSE') throw new BadRequest('Guest has no open folio (not in-house)');
        // revenue is journaled here with AR_GUEST as the debit; folio charge posted with skipJournal
        const fi = await postCharge(client, { folioId: folio.id, category: folioCategory, description: `${order.outlet_name} order ${order.number}`, quantity: 1, unitPrice: amt, outletId: order.outlet_id, sourceType: 'ORDER', sourceId: order.id, userId: user.id, skipJournal: true, businessDate: bd });
        folioItemId = fi.id;
        await client.query(`UPDATE orders SET stay_id=$2 WHERE id=$1`, [orderId, stayId]);
        lines.push({ mappingKey: 'AR_GUEST', debit: amt, partyType: 'GUEST', partyId: order.guest_id, outletId: order.outlet_id, description: `Room charge ${order.number}` });
        await client.query(`INSERT INTO order_payments (order_id, method, amount) VALUES ($1,'ROOM_CHARGE',$2)`, [orderId, amt]);
        settlementType = input.payments.length > 1 ? 'MIXED' : 'ROOM_CHARGE';
      } else if (p.method === 'CORPORATE') {
        const customerId = p.customer_id ?? order.customer_id;
        if (!customerId) throw new BadRequest('Select the corporate account');
        const cust = (await client.query(`SELECT * FROM customers WHERE id=$1 AND is_active`, [customerId])).rows[0];
        if (!cust) throw new NotFound('Corporate account not found');
        const exposure = Number((await client.query(`SELECT COALESCE(SUM(debit-credit),0) AS b FROM party_ledger WHERE party_type='CUSTOMER' AND party_id=$1`, [customerId])).rows[0].b);
        if (Number(cust.credit_limit) > 0 && exposure + amt > Number(cust.credit_limit)) throw Errors.invalidPayment(`Credit limit exceeded for ${cust.name}`);
        lines.push({ mappingKey: 'AR', debit: amt, partyType: 'CUSTOMER', partyId: customerId, outletId: order.outlet_id, description: `Corporate charge ${order.number}` });
        await client.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, created_by) VALUES ('CUSTOMER',$1,$2,$3,'INVOICE',$4,$5,$6,0,'ORDER',$7,$8)`,
          [customerId, order.property_id, bd, order.number, `${order.outlet_name} order ${order.number}`, amt, orderId, user.id]);
        await client.query(`INSERT INTO order_payments (order_id, method, amount) VALUES ($1,'CORPORATE',$2)`, [orderId, amt]);
        await client.query(`UPDATE orders SET customer_id=$2 WHERE id=$1`, [orderId, customerId]);
      } else if (p.method === 'COMPLIMENTARY') {
        if (!user.permissions.has('pos.discount') && !user.is_superuser) throw new Forbidden('Complimentary settlement requires discount permission');
        lines.push({ mappingKey: 'COMPLIMENTARY_EXPENSE', debit: amt, outletId: order.outlet_id, description: `Complimentary ${order.number}` });
        await client.query(`INSERT INTO order_payments (order_id, method, amount) VALUES ($1,'COMPLIMENTARY',$2)`, [orderId, amt]);
      } else {
        if (!p.payment_method_id) p.payment_method_id = await resolvePaymentMethodId(null, p.payment_method_code, client);
        const { payment } = await recordPayment(client, { propertyId: order.property_id, direction: 'IN', kind: 'PAYMENT', paymentMethodId: p.payment_method_id, amount: amt + Number(p.tip ?? 0), reference: p.reference, partyType: order.guest_id ? 'GUEST' : null, partyId: order.guest_id,
          sourceType: 'ORDER', sourceId: orderId, cashierShiftId: shift.id, outletId: order.outlet_id, userId: user.id, idempotencyKey: input.idempotency_key ? `${input.idempotency_key}:${p.payment_method_id}` : null,
          offset: { mappingKey: 'POS_CLEARING' }, description: `${order.outlet_name} ${order.number}` });
        if (Number(p.tip ?? 0) > 0) {
          await postJournal(client, { propertyId: order.property_id, description: `Tips ${order.number}`, sourceType: 'ORDER', sourceId: orderId, businessDate: bd, userId: user.id, lines: [{ mappingKey: 'POS_CLEARING', debit: Number(p.tip) }, { mappingKey: 'TIPS_PAYABLE', credit: Number(p.tip) }] });
        }
        lines.push({ mappingKey: 'POS_CLEARING', debit: amt, outletId: order.outlet_id, description: `Settlement ${order.number}` });
        await client.query(`INSERT INTO order_payments (order_id, payment_id, method, amount, tip) VALUES ($1,$2,$3,$4,$5)`, [orderId, payment.id, 'PAYMENT', amt, p.tip ?? 0]);
      }
    }
    lines.push({ accountId: order.revenue_account_id ?? undefined, mappingKey: order.revenue_account_id ? undefined : revenueKey, credit: totals.subtotal, outletId: order.outlet_id, description: `Sales ${order.number}` });
    for (const [k, v] of Object.entries(taxByAccount)) lines.push(k === 'TAX_PAYABLE' ? { mappingKey: 'TAX_PAYABLE', credit: v, description: `Tax ${order.number}` } : { accountId: k, credit: v, description: `Tax ${order.number}` });
    if (totals.service_charge > 0) lines.push({ mappingKey: 'SERVICE_CHARGE_PAYABLE', credit: totals.service_charge, outletId: order.outlet_id, description: `Service charge ${order.number}` });
    const je = await postJournal(client, { propertyId: order.property_id, description: `${order.outlet_name} sale ${order.number}`, sourceType: 'ORDER', sourceId: orderId, businessDate: bd, userId: user.id, lines });

    // 2. Inventory consumption + COGS
    let cogs = 0;
    for (const it of items) {
      const r = await consumeForMenuItem(client, { propertyId: order.property_id, storeId: order.store_id, menuItemId: it.menu_item_id, quantity: Number(it.quantity), orderId, orderNumber: order.number, outletId: order.outlet_id, businessDate: bd, userId: user.id, modifiers: it.modifiers });
      cogs += r.cogs;
    }
    cogs = r2(cogs);
    if (cogs > 0) await postCogs(client, { propertyId: order.property_id, amount: cogs, description: `COGS ${order.outlet_name} ${order.number}`, sourceType: 'ORDER', sourceId: orderId, outletId: order.outlet_id, businessDate: bd, userId: user.id, cogsAccountId: order.cogs_account_id, cogsKey: order.outlet_type === 'BAR' || order.outlet_type === 'CLUB' ? 'COGS_BEVERAGE' : 'COGS_FOOD' });

    // 3. Close order & release table
    await client.query(`UPDATE orders SET status='CLOSED', paid_total=$2, settlement_type=$3, folio_item_id=$4, cogs_total=$5, journal_entry_id=$6, closed_at=now(), closed_by=$7 WHERE id=$1`, [orderId, totals.total, settlementType, folioItemId, cogs, je.id, user.id]);
    if (order.table_id) {
      const others = await client.query(`SELECT 1 FROM orders WHERE table_id=$1 AND status IN ('OPEN','BILLED') AND id<>$2`, [order.table_id, orderId]);
      if (!others.rows[0]) await client.query(`UPDATE outlet_tables SET status='CLEANING' WHERE id=$1`, [order.table_id]);
    }
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'SETTLE', entityType: 'order', entityId: orderId, newValue: { total: totals.total, settlement: settlementType, cogs, journal: je.number } }, client);
    return orderDetail(orderId, client);
  });
}

export async function cancelOrder(orderId: string, reason: string, user: AuthUser) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new NotFound('Order not found');
    if (!['OPEN', 'BILLED'].includes(order.status)) throw Errors.invalidStatus('order', order.status, 'cancel');
    const sent = await client.query(`SELECT COUNT(*) FROM order_items WHERE order_id=$1 AND kitchen_status NOT IN ('NEW','CANCELLED') AND NOT voided`, [orderId]);
    if (Number(sent.rows[0].count) > 0 && !user.permissions.has('pos.cancel_order') && !user.is_superuser) throw new Forbidden('Cancelling orders with items already sent to the kitchen requires cancel permission');
    await client.query(`UPDATE orders SET status='CANCELLED', cancelled_reason=$2, closed_at=now(), closed_by=$3 WHERE id=$1`, [orderId, reason, user.id]);
    await client.query(`UPDATE order_items SET kitchen_status='CANCELLED' WHERE order_id=$1 AND kitchen_status NOT IN ('SERVED')`, [orderId]);
    await client.query(`UPDATE kitchen_tickets SET status='CANCELLED' WHERE order_id=$1 AND status NOT IN ('SERVED')`, [orderId]);
    if (order.table_id) await client.query(`UPDATE outlet_tables SET status='AVAILABLE' WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM orders WHERE table_id=$1 AND status IN ('OPEN','BILLED'))`, [order.table_id]);
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'CANCEL', entityType: 'order', entityId: orderId, reason }, client);
    return orderDetail(orderId, client);
  });
}

/** Refund a closed order (full): reverses revenue & COGS journals, returns stock, records refund payment(s). */
export async function refundOrder(orderId: string, user: AuthUser, opts: { payment_method_id: string; amount: number; reason: string; reference?: string | null }) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT o.*, ol.store_id, ol.name AS outlet_name FROM orders o JOIN outlets ol ON ol.id=o.outlet_id WHERE o.id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new NotFound('Order not found');
    if (order.status !== 'CLOSED') throw Errors.invalidStatus('order', order.status, 'refund');
    if (!user.permissions.has('pos.refund') && !user.is_superuser) throw Errors.unauthorizedRefund();
    const limit = user.is_superuser ? Number.MAX_SAFE_INTEGER : (user.limits[LIMIT_CODES.REFUND_AMOUNT] ?? Number.MAX_SAFE_INTEGER);
    if (opts.amount > limit) throw new Forbidden(`Refund exceeds your authority limit of ${limit}`);
    if (opts.amount > Number(order.total) + 0.005) throw new BadRequest('Refund cannot exceed the order total');
    if (order.settlement_type === 'ROOM_CHARGE' || order.folio_item_id) throw new BadRequest('Room-charged orders must be reversed on the guest folio');
    const shift = await requireOpenShift(client, user.id, order.outlet_id);
    const full = Math.abs(opts.amount - Number(order.total)) < 0.005;
    const bd = await currentBusinessDate(client, order.property_id, user.id);
    const { payment } = await recordPayment(client, { propertyId: order.property_id, direction: 'OUT', kind: 'REFUND', paymentMethodId: opts.payment_method_id, amount: opts.amount, reference: opts.reference, partyType: order.guest_id ? 'GUEST' : null, partyId: order.guest_id,
      sourceType: 'ORDER', sourceId: orderId, cashierShiftId: shift.id, outletId: order.outlet_id, userId: user.id, offset: { mappingKey: 'POS_CLEARING' }, description: `Refund ${order.outlet_name} ${order.number}` });
    if (full) {
      if (order.journal_entry_id) await reverseJournal(client, order.journal_entry_id, user.id, `Refund: ${opts.reason}`);
      const cogsJe = (await client.query(`SELECT id FROM journal_entries WHERE source_type='ORDER' AND source_id=$1 AND description LIKE 'COGS%' AND status='POSTED'`, [orderId])).rows;
      for (const j of cogsJe) await reverseJournal(client, j.id, user.id, `Refund: ${opts.reason}`);
      const movements = (await client.query(`SELECT * FROM stock_movements WHERE reference_type='ORDER' AND reference_id=$1 AND movement_type='SALE'`, [orderId])).rows;
      const { moveStock } = await import('../inventory/stock.service');
      for (const m of movements) await moveStock(client, { propertyId: m.property_id, storeId: m.store_id, productId: m.product_id, type: 'RETURN_TO_STORE', quantity: -Number(m.quantity), unitCost: Number(m.unit_cost), referenceType: 'ORDER_REFUND', referenceId: orderId, referenceNumber: order.number, outletId: order.outlet_id, businessDate: bd, userId: user.id, notes: opts.reason });
      await client.query(`UPDATE orders SET status='REFUNDED' WHERE id=$1`, [orderId]);
    } else {
      // partial refund: DR Revenue (contra) / CR POS clearing (handled by payment offset)
      await postJournal(client, { propertyId: order.property_id, description: `Partial refund ${order.number}: ${opts.reason}`, sourceType: 'ORDER', sourceId: orderId, businessDate: bd, userId: user.id,
        lines: [{ mappingKey: 'SALES_RETURNS', debit: opts.amount, outletId: order.outlet_id }, { mappingKey: 'POS_CLEARING', credit: opts.amount, outletId: order.outlet_id }] });
    }
    await client.query(`INSERT INTO order_payments (order_id, payment_id, method, amount) VALUES ($1,$2,'REFUND',$3)`, [orderId, payment.id, -opts.amount]);
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'REFUND', entityType: 'order', entityId: orderId, newValue: { amount: opts.amount, full }, reason: opts.reason }, client);
    return orderDetail(orderId, client);
  });
}

export async function transferOrder(orderId: string, user: AuthUser, opts: { table_id?: string | null; waiter_id?: string | null; reason?: string }) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order || order.status !== 'OPEN') throw new BadRequest('Only open orders can be transferred');
    if (opts.table_id !== undefined && opts.table_id !== order.table_id) {
      if (opts.table_id) await client.query(`UPDATE outlet_tables SET status='OCCUPIED' WHERE id=$1`, [opts.table_id]);
      if (order.table_id) await client.query(`UPDATE outlet_tables SET status='AVAILABLE' WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM orders WHERE table_id=$1 AND status IN ('OPEN','BILLED') AND id<>$2)`, [order.table_id, orderId]);
      await client.query(`UPDATE orders SET table_id=$2 WHERE id=$1`, [orderId, opts.table_id]);
    }
    if (opts.waiter_id) await client.query(`UPDATE orders SET waiter_id=$2 WHERE id=$1`, [orderId, opts.waiter_id]);
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'TRANSFER', entityType: 'order', entityId: orderId, oldValue: { table_id: order.table_id, waiter_id: order.waiter_id }, newValue: opts, reason: opts.reason }, client);
    return orderDetail(orderId, client);
  });
}

export async function mergeOrders(targetId: string, sourceId: string, user: AuthUser) {
  return withTransaction(async (client) => {
    const a = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [targetId])).rows[0];
    const b = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [sourceId])).rows[0];
    if (!a || !b || a.status !== 'OPEN' || b.status !== 'OPEN') throw new BadRequest('Both orders must be open');
    if (a.outlet_id !== b.outlet_id) throw new BadRequest('Orders must belong to the same outlet');
    await client.query(`UPDATE order_items SET order_id=$1 WHERE order_id=$2`, [targetId, sourceId]);
    await client.query(`UPDATE kitchen_tickets SET order_id=$1 WHERE order_id=$2`, [targetId, sourceId]);
    await client.query(`UPDATE orders SET status='CANCELLED', cancelled_reason=$2, closed_at=now(), closed_by=$3 WHERE id=$1`, [sourceId, `Merged into ${a.number}`, user.id]);
    if (b.table_id && b.table_id !== a.table_id) await client.query(`UPDATE outlet_tables SET status='AVAILABLE' WHERE id=$1`, [b.table_id]);
    await recalcOrder(client, targetId);
    await audit({ userId: user.id, username: user.username, propertyId: a.property_id, action: 'MERGE', entityType: 'order', entityId: targetId, newValue: { merged: b.number } }, client);
    return orderDetail(targetId, client);
  });
}

/** Split selected items into a new order on the same table (for split bills) */
export async function splitOrder(orderId: string, itemIds: string[], user: AuthUser) {
  return withTransaction(async (client) => {
    const order = (await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order || order.status !== 'OPEN') throw new BadRequest('Only open orders can be split');
    const number = await nextNumber(client, 'ORDER', order.property_id);
    const n = (await client.query(`INSERT INTO orders (property_id, outlet_id, number, type, table_id, covers, waiter_id, cashier_shift_id, stay_id, guest_id, customer_id, business_date, notes, created_by)
      SELECT property_id, outlet_id, $2, type, table_id, 1, waiter_id, cashier_shift_id, stay_id, guest_id, customer_id, business_date, 'Split from ' || number, $3 FROM orders WHERE id=$1 RETURNING *`, [orderId, number, user.id])).rows[0];
    await client.query(`UPDATE order_items SET order_id=$1 WHERE order_id=$2 AND id = ANY($3)`, [n.id, orderId, itemIds]);
    await recalcOrder(client, orderId); await recalcOrder(client, n.id);
    await audit({ userId: user.id, username: user.username, propertyId: order.property_id, action: 'SPLIT', entityType: 'order', entityId: orderId, newValue: { new_order: number, items: itemIds } }, client);
    return { original: await orderDetail(orderId, client), split: await orderDetail(n.id, client) };
  });
}

export async function orderDetail(orderId: string, db: PoolClient | typeof pool = pool) {
  const order = (await db.query(
    `SELECT o.*, ol.name AS outlet_name, ol.type AS outlet_type, t.number AS table_number, u.full_name AS waiter_name, g.first_name || ' ' || g.last_name AS guest_name, r.number AS room_number, c.name AS customer_name, cs.number AS shift_number
       FROM orders o JOIN outlets ol ON ol.id=o.outlet_id LEFT JOIN outlet_tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.waiter_id LEFT JOIN guests g ON g.id=o.guest_id LEFT JOIN stays s ON s.id=o.stay_id LEFT JOIN rooms r ON r.id=s.room_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN cashier_shifts cs ON cs.id=o.cashier_shift_id WHERE o.id=$1`, [orderId])).rows[0];
  if (!order) throw new NotFound('Order not found');
  const items = (await db.query(`SELECT oi.*, k.name AS kitchen_name FROM order_items oi LEFT JOIN kitchens k ON k.id=oi.kitchen_id WHERE oi.order_id=$1 ORDER BY oi.created_at`, [orderId])).rows;
  const payments = (await db.query(`SELECT op.*, pm.name AS method_name, p.number AS payment_number, p.reference FROM order_payments op LEFT JOIN payments p ON p.id=op.payment_id LEFT JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE op.order_id=$1 ORDER BY op.created_at`, [orderId])).rows;
  const tickets = (await db.query(`SELECT kt.*, k.name AS kitchen_name FROM kitchen_tickets kt JOIN kitchens k ON k.id=kt.kitchen_id WHERE kt.order_id=$1 ORDER BY kt.sent_at`, [orderId])).rows;
  return { ...order, items, payments, tickets };
}
