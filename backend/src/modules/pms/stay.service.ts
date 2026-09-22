import { ymd, addDays } from '../../core/http';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { nextNumber } from '../../core/numbering';
import { Errors, NotFound, BadRequest } from '../../core/errors';
import { audit } from '../../core/audit';
import { notify } from '../../core/notify';
import { AuthUser } from '../auth/auth.types';
import { openFolio, postCharge, postFolioPayment, folioBalance } from './folio.service';
import { rateFor, availableRooms } from './reservations.service';
import { currentBusinessDate, r2 } from '../finance/accounting.service';

/** Create a housekeeping task (used on checkout, room moves, and manual requests) */
export async function createHousekeepingTask(client: PoolClient, opts: { propertyId: string; roomId: string; type: string; priority?: number; notes?: string | null; assignedTo?: string | null; createdBy?: string | null; stayId?: string | null }) {
  const existing = await client.query(`SELECT id FROM housekeeping_tasks WHERE room_id=$1 AND status IN ('PENDING','IN_PROGRESS') AND task_type=$2`, [opts.roomId, opts.type]);
  if (existing.rows[0]) return existing.rows[0];
  return (await client.query(
    `INSERT INTO housekeeping_tasks (property_id, room_id, task_type, priority, notes, assigned_to, created_by, stay_id, business_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE) RETURNING *`,
    [opts.propertyId, opts.roomId, opts.type, opts.priority ?? 3, opts.notes ?? null, opts.assignedTo ?? null, opts.createdBy ?? null, opts.stayId ?? null])).rows[0];
}

export interface CheckInInput {
  reservationId?: string; // reservation check-in
  walkIn?: { guest_id: string; room_type_id: string; departure_date: string; adults: number; children: number; rate?: number; rate_plan_id?: string | null; meal_plan?: string; source?: string; customer_id?: string | null };
  roomId: string;
  adults?: number; children?: number; rate?: number;
  registration?: Record<string, any>; // ID/passport details, signature ref, vehicle, etc.
  deposit?: { paymentMethodId: string; amount: number; reference?: string | null; cashierShiftId?: string | null } | null;
  extraBeds?: number;
  additionalGuestIds?: string[];
  notes?: string | null;
}

export async function checkIn(input: CheckInInput, user: AuthUser, propertyId: string) {
  return withTransaction(async (client) => {
    let reservation: any;
    if (input.reservationId) {
      reservation = (await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [input.reservationId])).rows[0];
      if (!reservation) throw new NotFound('Reservation not found');
      if (!['CONFIRMED', 'DEPOSIT_PAID', 'TENTATIVE', 'INQUIRY'].includes(reservation.status)) throw Errors.invalidStatus('reservation', reservation.status, 'check in');
      const today = await currentBusinessDate(client, propertyId, user.id);
      if (ymd(reservation.arrival_date) > today) {
        // early check-in: allowed, record it
        await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'EARLY_CHECKIN',$2,$3)`, [reservation.id, JSON.stringify({ businessDate: today }), user.id]);
      }
    } else if (input.walkIn) {
      const { createReservation } = await import('./reservations.service');
      // createReservation manages its own transaction; for walk-in we inline a lightweight creation here to keep atomicity
      const w = input.walkIn;
      const guest = (await client.query(`SELECT * FROM guests WHERE id=$1`, [w.guest_id])).rows[0];
      if (!guest) throw new NotFound('Guest not found');
      const today = await currentBusinessDate(client, propertyId, user.id);
      const free = await availableRooms(client, propertyId, w.room_type_id, today, w.departure_date);
      if (!free.some((r) => r.id === input.roomId)) {
        const room = (await client.query(`SELECT number FROM rooms WHERE id=$1`, [input.roomId])).rows[0];
        throw Errors.roomUnavailable(room?.number ?? '');
      }
      const { price, extra } = await rateFor(client, w.room_type_id, w.rate_plan_id ?? null, today, w.adults, w.children);
      const number = await nextNumber(client, 'RESERVATION', propertyId);
      const prop = (await client.query(`SELECT currency FROM properties WHERE id=$1`, [propertyId])).rows[0];
      reservation = (await client.query(
        `INSERT INTO reservations (property_id, number, guest_id, customer_id, room_type_id, room_id, rate_plan_id, arrival_date, departure_date, adults, children, rate, meal_plan, currency, source, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CONFIRMED',$16) RETURNING *`,
        [propertyId, number, w.guest_id, w.customer_id ?? guest.customer_id ?? null, w.room_type_id, input.roomId, w.rate_plan_id ?? null, today, w.departure_date, w.adults, w.children, w.rate ?? r2(price + extra), w.meal_plan ?? 'ROOM_ONLY', prop.currency, w.source ?? 'WALK_IN', user.id])).rows[0];
      await client.query(`INSERT INTO reservation_guests (reservation_id, guest_id, is_primary) VALUES ($1,$2,true)`, [reservation.id, w.guest_id]);
      void createReservation;
    } else throw new BadRequest('Provide reservationId or walkIn details');

    // Verify room
    const room = (await client.query(`SELECT r.*, rt.name AS room_type_name FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id WHERE r.id=$1 FOR UPDATE`, [input.roomId])).rows[0];
    if (!room) throw new NotFound('Room not found');
    if (room.status === 'OCCUPIED') throw Errors.roomUnavailable(room.number);
    if (['OUT_OF_ORDER', 'OUT_OF_SERVICE'].includes(room.status)) throw Errors.roomUnavailable(room.number);
    const occupied = await client.query(`SELECT 1 FROM stays WHERE room_id=$1 AND status='IN_HOUSE'`, [input.roomId]);
    if (occupied.rows[0]) throw Errors.roomUnavailable(room.number);
    if (room.housekeeping_status === 'DIRTY' && !(input.registration?.accept_dirty_room)) throw new BadRequest(`Room ${room.number} is not yet cleaned. Choose another room or confirm override.`, undefined, 'ROOM_DIRTY');
    // room conflict with other reservations for the period
    const arrival = await currentBusinessDate(client, propertyId, user.id);
    const departure = ymd(reservation.departure_date);
    const conflict = await client.query(`SELECT number FROM reservations WHERE room_id=$1 AND status IN ('CONFIRMED','DEPOSIT_PAID','CHECKED_IN') AND id<>$2 AND arrival_date < $4::date AND departure_date > $3::date`, [input.roomId, reservation.id, arrival, departure]);
    if (conflict.rows[0]) throw Errors.reservationConflict(room.number);
    // upgrade handling: if room type differs
    const upgraded = room.room_type_id !== reservation.room_type_id;
    const rate = input.rate ?? Number(reservation.rate);

    const stay = (await client.query(
      `INSERT INTO stays (property_id, reservation_id, guest_id, room_id, expected_check_out, adults, children, rate, meal_plan, checked_in_by, registration_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [propertyId, reservation.id, reservation.guest_id, input.roomId, departure, input.adults ?? reservation.adults, input.children ?? reservation.children, rate, reservation.meal_plan, user.id,
        JSON.stringify({ ...(input.registration ?? {}), extra_beds: input.extraBeds ?? 0, upgraded_from_room_type: upgraded ? reservation.room_type_id : undefined })])).rows[0];
    await client.query(`INSERT INTO stay_room_history (stay_id, to_room_id, reason, user_id) VALUES ($1,$2,'CHECK_IN',$3)`, [stay.id, input.roomId, user.id]);
    await client.query(`UPDATE reservations SET status='CHECKED_IN', room_id=$2, room_type_id=$3, rate=$4 WHERE id=$1`, [reservation.id, input.roomId, room.room_type_id, rate]);
    await client.query(`UPDATE rooms SET status='OCCUPIED' WHERE id=$1`, [input.roomId]);
    for (const g of input.additionalGuestIds ?? []) await client.query(`INSERT INTO reservation_guests (reservation_id, guest_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [reservation.id, g]);
    const folio = await openFolio(client, { propertyId, stayId: stay.id, reservationId: reservation.id, guestId: reservation.guest_id, customerId: reservation.customer_id, currency: reservation.currency });
    // Package components posted PER_STAY at check-in
    if (reservation.rate_plan_id) {
      const comps = (await client.query(`SELECT * FROM rate_plan_components WHERE rate_plan_id=$1 AND frequency IN ('PER_STAY','PER_PERSON')`, [reservation.rate_plan_id])).rows;
      for (const c of comps) {
        const qty = c.frequency === 'PER_PERSON' ? Number(stay.adults) + Number(stay.children) : 1;
        await postCharge(client, { folioId: folio.id, category: c.charge_category, description: `Package: ${c.description}`, quantity: qty, unitPrice: Number(c.amount), taxId: c.tax_id, revenueAccountId: c.revenue_account_id, sourceType: 'PACKAGE', sourceId: c.id, userId: user.id });
      }
    }
    let depositItem = null;
    if (input.deposit && input.deposit.amount > 0) {
      depositItem = await postFolioPayment(client, { folioId: folio.id, paymentMethodId: input.deposit.paymentMethodId, amount: input.deposit.amount, reference: input.deposit.reference, kind: 'DEPOSIT', cashierShiftId: input.deposit.cashierShiftId, userId: user.id });
      await client.query(`UPDATE reservations SET deposit_paid = deposit_paid + $2 WHERE id=$1`, [reservation.id, input.deposit.amount]);
    }
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'CHECKED_IN',$2,$3)`, [reservation.id, JSON.stringify({ room: room.number, upgraded }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId, action: 'CHECKIN', entityType: 'stay', entityId: stay.id, newValue: { reservation: reservation.number, room: room.number, folio: folio.number } }, client);
    const guest = (await client.query(`SELECT first_name, last_name, vip_level FROM guests WHERE id=$1`, [reservation.guest_id])).rows[0];
    if (guest?.vip_level > 0) await notify({ permission: 'dashboard.management', propertyId, type: 'VIP_ARRIVAL', title: `VIP arrival: ${guest.first_name} ${guest.last_name} in room ${room.number}`, entityType: 'stay', entityId: stay.id, severity: 'WARNING' }, client);
    return { stay, folio, reservation: { ...reservation, status: 'CHECKED_IN', room_id: input.roomId }, depositItem };
  });
}

export async function moveRoom(stayId: string, toRoomId: string, reason: string, user: AuthUser, newRate?: number) {
  return withTransaction(async (client) => {
    const stay = (await client.query(`SELECT * FROM stays WHERE id=$1 FOR UPDATE`, [stayId])).rows[0];
    if (!stay || stay.status !== 'IN_HOUSE') throw new BadRequest('Stay is not in-house');
    const to = (await client.query(`SELECT * FROM rooms WHERE id=$1 FOR UPDATE`, [toRoomId])).rows[0];
    if (!to) throw new NotFound('Target room not found');
    if (to.status !== 'AVAILABLE' && to.status !== 'RESERVED') throw Errors.roomUnavailable(to.number);
    if (to.housekeeping_status === 'DIRTY') throw new BadRequest(`Room ${to.number} is dirty`, undefined, 'ROOM_DIRTY');
    const today = await currentBusinessDate(client, stay.property_id, user.id);
    const conflict = await client.query(`SELECT number FROM reservations WHERE room_id=$1 AND status IN ('CONFIRMED','DEPOSIT_PAID','CHECKED_IN') AND id<>$2 AND arrival_date < $4::date AND departure_date > $3::date`, [toRoomId, stay.reservation_id, today, ymd(stay.expected_check_out)]);
    if (conflict.rows[0]) throw Errors.reservationConflict(to.number);
    await client.query(`UPDATE stays SET room_id=$2, rate=COALESCE($3, rate) WHERE id=$1`, [stayId, toRoomId, newRate ?? null]);
    await client.query(`UPDATE reservations SET room_id=$2, room_type_id=$3, rate=COALESCE($4, rate) WHERE id=$1`, [stay.reservation_id, toRoomId, to.room_type_id, newRate ?? null]);
    await client.query(`UPDATE rooms SET status='OCCUPIED' WHERE id=$1`, [toRoomId]);
    await client.query(`UPDATE rooms SET status='AVAILABLE', housekeeping_status='DIRTY' WHERE id=$1`, [stay.room_id]);
    await createHousekeepingTask(client, { propertyId: stay.property_id, roomId: stay.room_id, type: 'CHECKOUT_CLEAN', priority: 2, notes: `Room move: ${reason}`, createdBy: user.id, stayId });
    await client.query(`INSERT INTO stay_room_history (stay_id, from_room_id, to_room_id, reason, user_id) VALUES ($1,$2,$3,$4,$5)`, [stayId, stay.room_id, toRoomId, reason, user.id]);
    await audit({ userId: user.id, username: user.username, propertyId: stay.property_id, action: 'ROOM_MOVE', entityType: 'stay', entityId: stayId, oldValue: { room_id: stay.room_id }, newValue: { room_id: toRoomId }, reason }, client);
    return (await client.query(`SELECT * FROM stays WHERE id=$1`, [stayId])).rows[0];
  });
}

/** Post nightly room charge for a stay for a given business date (idempotent per date). Used by night audit & checkout. */
export async function postRoomCharge(client: PoolClient, stayId: string, businessDate: string, userId: string | null) {
  const stay = (await client.query(`SELECT s.*, r.number AS room_number, res.rate_plan_id FROM stays s JOIN rooms r ON r.id=s.room_id JOIN reservations res ON res.id=s.reservation_id WHERE s.id=$1 FOR UPDATE`, [stayId])).rows[0];
  if (!stay || stay.status !== 'IN_HOUSE') return null;
  if (stay.last_room_charge_date && ymd(stay.last_room_charge_date) >= businessDate) return null;
  const folio = (await client.query(`SELECT id FROM folios WHERE stay_id=$1 AND status='OPEN' AND type='GUEST' ORDER BY created_at LIMIT 1`, [stayId])).rows[0];
  if (!folio) return null;
  const item = await postCharge(client, { folioId: folio.id, category: 'ROOM', description: `Room ${stay.room_number} accommodation ${businessDate}`, quantity: 1, unitPrice: Number(stay.rate), sourceType: 'ROOM_CHARGE', sourceId: stayId, userId: userId ?? stay.checked_in_by, businessDate });
  if (stay.rate_plan_id) {
    const comps = (await client.query(`SELECT * FROM rate_plan_components WHERE rate_plan_id=$1 AND frequency IN ('PER_NIGHT','PER_PERSON_PER_NIGHT')`, [stay.rate_plan_id])).rows;
    for (const c of comps) {
      const qty = c.frequency === 'PER_PERSON_PER_NIGHT' ? Number(stay.adults) + Number(stay.children) : 1;
      await postCharge(client, { folioId: folio.id, category: c.charge_category, description: `Package: ${c.description} ${businessDate}`, quantity: qty, unitPrice: Number(c.amount), taxId: c.tax_id, revenueAccountId: c.revenue_account_id, sourceType: 'PACKAGE', sourceId: c.id, userId: userId ?? stay.checked_in_by, businessDate });
    }
  }
  await client.query(`UPDATE stays SET last_room_charge_date=$2 WHERE id=$1`, [stayId, businessDate]);
  return item;
}

export interface CheckoutInput {
  stayId: string;
  payments?: { paymentMethodId: string; amount: number; reference?: string | null; cashierShiftId?: string | null }[];
  refund?: { paymentMethodId: string; amount: number; reference?: string | null; cashierShiftId?: string | null } | null;
  lateCheckoutFee?: number;
  allowBalance?: boolean; // transfer remaining balance to city ledger (requires customer)
  notes?: string | null;
  postTonightRoomCharge?: boolean;
}

/** Full checkout: settle folio, generate invoice, close stay, set room DIRTY, create housekeeping task. */
export async function checkOut(input: CheckoutInput, user: AuthUser) {
  return withTransaction(async (client) => {
    const stay = (await client.query(`SELECT s.*, r.number AS room_number FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.id=$1 FOR UPDATE`, [input.stayId])).rows[0];
    if (!stay) throw new NotFound('Stay not found');
    if (stay.status !== 'IN_HOUSE') throw Errors.invalidStatus('stay', stay.status, 'check out');
    const today = await currentBusinessDate(client, stay.property_id, user.id);
    // Unclosed POS orders charged to this room?
    const openOrders = await client.query(`SELECT COUNT(*) FROM orders WHERE stay_id=$1 AND status IN ('OPEN','BILLED')`, [stay.id]);
    if (Number(openOrders.rows[0].count) > 0) throw new BadRequest('Guest has open restaurant/bar orders. Close or settle them before checkout.', undefined, 'OPEN_ORDERS');
    // Ensure all nights are charged (night audit may not have run for today if checking out after midnight)
    let d = new Date((stay.last_room_charge_date ? addDays(ymd(stay.last_room_charge_date), 1) : ymd(new Date(stay.check_in_at))) + 'T00:00:00Z');
    const lastNight = new Date(today + 'T00:00:00Z');
    if (input.postTonightRoomCharge) lastNight.setUTCDate(lastNight.getUTCDate() + 1);
    // charge nights from first uncharged night up to (but excluding) checkout day
    while (d < lastNight) { await postRoomCharge(client, stay.id, d.toISOString().slice(0, 10), user.id); d = new Date(d.getTime() + 86400000); }
    // If checking out same day as check-in with no nights charged, charge one night (day use)
    const folios = (await client.query(`SELECT * FROM folios WHERE stay_id=$1 AND status='OPEN'`, [stay.id])).rows;
    if (!folios.length) throw new BadRequest('No open folio for this stay');
    const folio = folios.find((f) => f.type === 'GUEST') ?? folios[0];
    const charged = await client.query(`SELECT COUNT(*) FROM folio_items WHERE folio_id=$1 AND source_type='ROOM_CHARGE' AND NOT is_reversed`, [folio.id]);
    if (Number(charged.rows[0].count) === 0) await postRoomCharge(client, stay.id, today, user.id);
    if (input.lateCheckoutFee && input.lateCheckoutFee > 0) {
      await postCharge(client, { folioId: folio.id, category: 'ROOM', description: 'Late checkout fee', unitPrice: input.lateCheckoutFee, sourceType: 'MANUAL', userId: user.id });
    }
    for (const p of input.payments ?? []) {
      if (p.amount > 0) await postFolioPayment(client, { folioId: folio.id, paymentMethodId: p.paymentMethodId, amount: p.amount, reference: p.reference, cashierShiftId: p.cashierShiftId, userId: user.id });
    }
    if (input.refund && input.refund.amount > 0) {
      if (!user.permissions.has('payments.refund') && !user.is_superuser) throw Errors.unauthorizedRefund();
      await postFolioPayment(client, { folioId: folio.id, paymentMethodId: input.refund.paymentMethodId, amount: input.refund.amount, reference: input.refund.reference, kind: 'REFUND', cashierShiftId: input.refund.cashierShiftId, userId: user.id });
    }
    const bal = await folioBalance(client, folio.id);
    if (Math.abs(bal.balance) > 0.005 && !input.allowBalance) {
      throw new BadRequest(bal.balance > 0 ? `Outstanding balance of ${bal.balance.toFixed(2)} must be settled before checkout` : `Guest is in credit by ${(-bal.balance).toFixed(2)}; issue a refund before checkout`, { balance: bal.balance }, 'BALANCE_OUTSTANDING');
    }
    // Generate invoice from folio
    const items = (await client.query(`SELECT * FROM folio_items WHERE folio_id=$1 AND NOT is_reversed AND reverses_id IS NULL ORDER BY line_no`, [folio.id])).rows;
    const charges = items.filter((i) => ['CHARGE', 'TRANSFER_IN'].includes(i.item_type));
    const subtotal = r2(charges.reduce((s, i) => s + Number(i.amount) - Number(i.tax_amount) - Number(i.service_charge), 0));
    const tax = r2(charges.reduce((s, i) => s + Number(i.tax_amount), 0));
    const sc = r2(charges.reduce((s, i) => s + Number(i.service_charge), 0));
    const discount = r2(charges.reduce((s, i) => s + Number(i.discount), 0));
    const total = r2(charges.reduce((s, i) => s + Number(i.amount), 0));
    const paid = r2(items.filter((i) => ['PAYMENT', 'DEPOSIT', 'REFUND'].includes(i.item_type)).reduce((s, i) => s - Number(i.amount), 0));
    const taxBreakdown = Object.values(charges.reduce((acc: any, i) => { const k = i.tax_id ?? 'none'; acc[k] ??= { tax_id: i.tax_id, taxable: 0, tax: 0 }; acc[k].taxable += Number(i.amount) - Number(i.tax_amount) - Number(i.service_charge); acc[k].tax += Number(i.tax_amount); return acc; }, {}));
    const invNo = await nextNumber(client, 'INVOICE', stay.property_id);
    const invoice = (await client.query(
      `INSERT INTO invoices (property_id, number, folio_id, guest_id, customer_id, invoice_date, due_date, subtotal, discount_total, tax_total, service_charge_total, total, paid_total, balance, status, type, currency, tax_breakdown, lines, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [stay.property_id, invNo, folio.id, folio.guest_id, folio.customer_id, today, subtotal, discount, tax, sc, total, paid, r2(total - paid), Math.abs(total - paid) < 0.005 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED', folio.customer_id && Math.abs(total - paid) >= 0.005 ? 'CITY_LEDGER' : 'GUEST', folio.currency,
        JSON.stringify(taxBreakdown), JSON.stringify(charges.map((i) => ({ description: i.description, category: i.category, quantity: i.quantity, unit_price: i.unit_price, discount: i.discount, tax: i.tax_amount, service_charge: i.service_charge, amount: i.amount, date: i.business_date }))), input.notes ?? null, user.id])).rows[0];
    // Close folios, stay, reservation; room dirty; housekeeping task
    await client.query(`UPDATE folios SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE stay_id=$1 AND status='OPEN'`, [stay.id, user.id]);
    await client.query(`UPDATE stays SET status='CHECKED_OUT', check_out_at=now(), checked_out_by=$2 WHERE id=$1`, [stay.id, user.id]);
    await client.query(`UPDATE reservations SET status='CHECKED_OUT' WHERE id=$1`, [stay.reservation_id]);
    await client.query(`UPDATE rooms SET status='AVAILABLE', housekeeping_status='DIRTY' WHERE id=$1`, [stay.room_id]);
    const task = await createHousekeepingTask(client, { propertyId: stay.property_id, roomId: stay.room_id, type: 'CHECKOUT_CLEAN', priority: 2, createdBy: user.id, stayId: stay.id });
    // loyalty points: 1 point per 100 of room spend
    await client.query(`UPDATE guests SET loyalty_points = loyalty_points + $2 WHERE id=$1`, [folio.guest_id, Math.floor(total / 100)]);
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'CHECKED_OUT',$2,$3)`, [stay.reservation_id, JSON.stringify({ invoice: invNo, total, paid }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId: stay.property_id, action: 'CHECKOUT', entityType: 'stay', entityId: stay.id, newValue: { invoice: invNo, total, paid, room: stay.room_number } }, client);
    await notify({ permission: 'housekeeping.view', propertyId: stay.property_id, type: 'GUEST_CHECKOUT', title: `Room ${stay.room_number} checked out - needs cleaning`, entityType: 'housekeeping_task', entityId: task.id, link: '/housekeeping', severity: 'INFO' }, client);
    return { invoice, stay: { ...stay, status: 'CHECKED_OUT' }, housekeepingTask: task, balance: r2(total - paid) };
  });
}

export async function stayDetail(stayId: string) {
  const stay = (await pool.query(
    `SELECT s.*, r.number AS room_number, rt.name AS room_type_name, g.first_name || ' ' || g.last_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email, g.vip_level, g.nationality, g.id_type, g.id_number, res.number AS reservation_number, res.source, res.special_requests, c.name AS customer_name,
       (SELECT json_agg(json_build_object('id', f.id, 'number', f.number, 'type', f.type, 'status', f.status)) FROM folios f WHERE f.stay_id=s.id) AS folios,
       (SELECT json_agg(json_build_object('from', fr.number, 'to', tr.number, 'reason', h.reason, 'at', h.created_at) ORDER BY h.created_at) FROM stay_room_history h LEFT JOIN rooms fr ON fr.id=h.from_room_id JOIN rooms tr ON tr.id=h.to_room_id WHERE h.stay_id=s.id) AS room_history
       FROM stays s JOIN rooms r ON r.id=s.room_id JOIN room_types rt ON rt.id=r.room_type_id JOIN guests g ON g.id=s.guest_id JOIN reservations res ON res.id=s.reservation_id LEFT JOIN customers c ON c.id=res.customer_id WHERE s.id=$1`, [stayId])).rows[0];
  if (!stay) throw new NotFound('Stay not found');
  return stay;
}
