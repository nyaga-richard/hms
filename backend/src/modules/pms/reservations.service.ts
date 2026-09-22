import { ymd } from '../../core/http';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { nextNumber } from '../../core/numbering';
import { Errors, NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit } from '../../core/audit';
import { notify } from '../../core/notify';
import { AuthUser } from '../auth/auth.types';

const ACTIVE = `('TENTATIVE','CONFIRMED','DEPOSIT_PAID','CHECKED_IN')`;

/** Rooms of a type that are free for [arrival, departure) considering reservations, stays and blocks */
export async function availableRooms(client: PoolClient, propertyId: string, roomTypeId: string | null, arrival: string, departure: string, excludeReservationId?: string | null) {
  const r = await client.query(
    `SELECT r.id, r.number, r.floor, r.building, r.status, r.housekeeping_status, r.room_type_id, rt.name AS room_type_name, rt.base_rate
       FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id
      WHERE r.property_id=$1 AND r.is_active AND ($2::uuid IS NULL OR r.room_type_id=$2)
        AND r.status NOT IN ('OUT_OF_ORDER','OUT_OF_SERVICE')
        AND NOT EXISTS (SELECT 1 FROM reservations x WHERE x.room_id=r.id AND x.status IN ${ACTIVE} AND x.id IS DISTINCT FROM $5
                          AND x.arrival_date < $4::date AND x.departure_date > $3::date)
        AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id=r.id AND s.status='IN_HOUSE' AND s.expected_check_out > $3::date AND $3::date >= CURRENT_DATE - 365 AND s.check_in_at::date < $4::date)
        AND NOT EXISTS (SELECT 1 FROM room_blocks b WHERE b.room_id=r.id AND b.released_at IS NULL AND b.start_date < $4::date AND b.end_date >= $3::date)
      ORDER BY r.number`,
    [propertyId, roomTypeId, arrival, departure, excludeReservationId ?? null]);
  return r.rows;
}

/** Availability summary per room type for a date range (total, booked, available) */
export async function availabilitySummary(propertyId: string, arrival: string, departure: string) {
  const r = await pool.query(
    `SELECT rt.id, rt.code, rt.name, rt.base_rate, rt.max_adults, rt.max_children,
       (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id=rt.id AND r.is_active AND r.status NOT IN ('OUT_OF_ORDER','OUT_OF_SERVICE'))::int AS total_rooms,
       (SELECT COUNT(*) FROM reservations x WHERE x.room_type_id=rt.id AND x.status IN ${ACTIVE} AND x.arrival_date < $3::date AND x.departure_date > $2::date)::int AS booked,
       (SELECT COUNT(*) FROM room_blocks b JOIN rooms r ON r.id=b.room_id WHERE r.room_type_id=rt.id AND b.released_at IS NULL AND b.start_date < $3::date AND b.end_date >= $2::date)::int AS blocked
     FROM room_types rt WHERE rt.property_id=$1 AND rt.is_active ORDER BY rt.sort_order, rt.name`,
    [propertyId, arrival, departure]);
  return r.rows.map((x) => ({ ...x, available: Math.max(0, x.total_rooms - x.booked - x.blocked) }));
}

/** Resolve nightly rate for a room type / rate plan / date */
export async function rateFor(client: PoolClient, roomTypeId: string, ratePlanId: string | null, date: string, adults = 1, children = 0): Promise<{ price: number; extra: number }> {
  const rt = (await client.query(`SELECT * FROM room_types WHERE id=$1`, [roomTypeId])).rows[0];
  if (!rt) throw new NotFound('Room type not found');
  let price = Number(rt.base_rate);
  let extraAdultRate = Number(rt.extra_adult_rate), extraChildRate = Number(rt.extra_child_rate);
  let basis = 'PER_ROOM';
  if (ratePlanId) {
    const plan = (await client.query(`SELECT * FROM rate_plans WHERE id=$1 AND is_active`, [ratePlanId])).rows[0];
    if (plan) {
      basis = plan.pricing_basis;
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      const p = (await client.query(
        `SELECT * FROM rate_plan_prices WHERE rate_plan_id=$1 AND room_type_id=$2
           AND (date_from IS NULL OR date_from <= $3::date) AND (date_to IS NULL OR date_to >= $3::date) AND $4 = ANY(days_of_week)
         ORDER BY priority DESC, date_from DESC NULLS LAST LIMIT 1`, [ratePlanId, roomTypeId, date, dow])).rows[0];
      if (p) { price = Number(p.price); extraAdultRate = Number(p.extra_adult); extraChildRate = Number(p.extra_child); }
    }
  }
  const includedAdults = basis === 'PER_PERSON' ? 0 : 2;
  const extra = Math.max(0, adults - includedAdults) * (basis === 'PER_PERSON' ? price : extraAdultRate) + children * extraChildRate;
  return { price: basis === 'PER_PERSON' ? price * Math.min(adults, includedAdults || adults) : price, extra };
}

export async function quoteStay(client: PoolClient, roomTypeId: string, ratePlanId: string | null, arrival: string, departure: string, adults: number, children: number) {
  const nights: { date: string; rate: number }[] = [];
  let d = new Date(arrival + 'T00:00:00Z');
  const end = new Date(departure + 'T00:00:00Z');
  while (d < end) {
    const ds = d.toISOString().slice(0, 10);
    const { price, extra } = await rateFor(client, roomTypeId, ratePlanId, ds, adults, children);
    nights.push({ date: ds, rate: Math.round((price + extra) * 100) / 100 });
    d = new Date(d.getTime() + 86400000);
  }
  const total = nights.reduce((s, n) => s + n.rate, 0);
  return { nights, total: Math.round(total * 100) / 100, avg: nights.length ? Math.round((total / nights.length) * 100) / 100 : 0 };
}

async function assertRoomFree(client: PoolClient, roomId: string, arrival: string, departure: string, excludeReservationId: string | null, allowOverbook: boolean) {
  await client.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, [roomId]); // serialize concurrent bookings of the same room
  const room = (await client.query(`SELECT number, status FROM rooms WHERE id=$1`, [roomId])).rows[0];
  if (!room) throw new NotFound('Room not found');
  if (['OUT_OF_ORDER', 'OUT_OF_SERVICE'].includes(room.status)) throw Errors.roomUnavailable(room.number);
  const conflict = await client.query(
    `SELECT number FROM reservations WHERE room_id=$1 AND status IN ${ACTIVE} AND id IS DISTINCT FROM $4 AND arrival_date < $3::date AND departure_date > $2::date LIMIT 1`,
    [roomId, arrival, departure, excludeReservationId]);
  if (conflict.rows[0] && !allowOverbook) throw Errors.reservationConflict(room.number);
  const blocked = await client.query(`SELECT 1 FROM room_blocks WHERE room_id=$1 AND released_at IS NULL AND start_date < $3::date AND end_date >= $2::date`, [roomId, arrival, departure]);
  if (blocked.rows[0]) throw Errors.roomUnavailable(room.number);
  return !!conflict.rows[0];
}

export interface ReservationInput {
  property_id?: string; guest_id: string; customer_id?: string | null; room_type_id: string; room_id?: string | null; rate_plan_id?: string | null;
  arrival_date: string; departure_date: string; adults: number; children: number; rate?: number | null; meal_plan?: string; source?: string;
  status?: string; deposit_required?: number; special_requests?: string | null; notes?: string | null; eta?: string | null; external_ref?: string | null;
  group_id?: string | null; additional_guest_ids?: string[]; allow_overbooking?: boolean;
}

export async function createReservation(input: ReservationInput, user: AuthUser, propertyId: string) {
  return withTransaction(async (client) => {
    const guest = (await client.query(`SELECT * FROM guests WHERE id=$1`, [input.guest_id])).rows[0];
    if (!guest) throw new NotFound('Guest not found');
    if (guest.is_blacklisted) throw new BadRequest('Guest is blacklisted; reservation requires management override');
    const rt = (await client.query(`SELECT * FROM room_types WHERE id=$1 AND property_id=$2`, [input.room_type_id, propertyId])).rows[0];
    if (!rt) throw new NotFound('Room type not found for this property');
    if (input.adults > rt.max_adults || input.children > rt.max_children || input.adults + input.children > rt.max_occupancy) {
      throw new BadRequest(`Occupancy exceeds ${rt.name} capacity (${rt.max_adults} adults / ${rt.max_children} children)`);
    }
    let overbooked = false;
    if (input.room_id) {
      overbooked = await assertRoomFree(client, input.room_id, input.arrival_date, input.departure_date, null, !!input.allow_overbooking);
    } else {
      // capacity check by room type
      const summary = (await availabilitySummary(propertyId, input.arrival_date, input.departure_date)).find((s) => s.id === input.room_type_id);
      if (summary && summary.available <= 0) {
        if (!input.allow_overbooking) throw Errors.roomUnavailable(rt.name);
        overbooked = true;
      }
    }
    if (overbooked && !user.permissions.has('reservations.overbook') && !user.is_superuser) throw new Forbidden('Overbooking requires authorization (reservations.overbook)');
    const quote = await quoteStay(client, input.room_type_id, input.rate_plan_id ?? null, input.arrival_date, input.departure_date, input.adults, input.children);
    const rate = input.rate ?? quote.avg;
    const mealPlan = input.meal_plan ?? (input.rate_plan_id ? (await client.query(`SELECT meal_plan FROM rate_plans WHERE id=$1`, [input.rate_plan_id])).rows[0]?.meal_plan : null) ?? 'ROOM_ONLY';
    const number = await nextNumber(client, 'RESERVATION', propertyId);
    const prop = (await client.query(`SELECT currency FROM properties WHERE id=$1`, [propertyId])).rows[0];
    const row = (await client.query(
      `INSERT INTO reservations (property_id, number, group_id, guest_id, customer_id, room_type_id, room_id, rate_plan_id, arrival_date, departure_date, adults, children, rate, meal_plan, currency, source, status, deposit_required, special_requests, notes, eta, is_overbooking, external_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [propertyId, number, input.group_id ?? null, input.guest_id, input.customer_id ?? guest.customer_id ?? null, input.room_type_id, input.room_id ?? null, input.rate_plan_id ?? null, input.arrival_date, input.departure_date,
        input.adults, input.children, rate, mealPlan, prop.currency, input.source ?? 'FRONT_DESK', input.status ?? 'CONFIRMED', input.deposit_required ?? 0, input.special_requests ?? null, input.notes ?? null, input.eta ?? null, overbooked, input.external_ref ?? null, user.id])).rows[0];
    await client.query(`INSERT INTO reservation_guests (reservation_id, guest_id, is_primary) VALUES ($1,$2,true)`, [row.id, input.guest_id]);
    for (const g of input.additional_guest_ids ?? []) await client.query(`INSERT INTO reservation_guests (reservation_id, guest_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [row.id, g]);
    if (input.room_id) await client.query(`UPDATE rooms SET status='RESERVED' WHERE id=$1 AND status='AVAILABLE' AND $2::date <= CURRENT_DATE`, [input.room_id, input.arrival_date]);
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'CREATED',$2,$3)`, [row.id, JSON.stringify({ quote }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId, action: 'CREATE', entityType: 'reservation', entityId: row.id, newValue: row }, client);
    await notify({ permission: 'reservations.view', propertyId, type: 'NEW_RESERVATION', title: `New reservation ${number}`, body: `${guest.first_name} ${guest.last_name} · ${rt.name} · ${input.arrival_date} → ${input.departure_date}${guest.vip_level ? ' · VIP' : ''}`, entityType: 'reservation', entityId: row.id, link: `/front-office/reservations/${row.id}`, severity: guest.vip_level ? 'WARNING' : 'INFO' }, client);
    return { ...row, quote };
  });
}

export async function modifyReservation(id: string, changes: Partial<ReservationInput> & { reason?: string }, user: AuthUser) {
  return withTransaction(async (client) => {
    const old = (await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new NotFound('Reservation not found');
    if (['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'].includes(old.status)) throw Errors.invalidStatus('reservation', old.status, 'modify');
    const arrival = changes.arrival_date ?? ymd(old.arrival_date);
    const departure = changes.departure_date ?? ymd(old.departure_date);
    if (departure <= arrival) throw new BadRequest('Departure must be after arrival');
    const roomId = changes.room_id === undefined ? old.room_id : changes.room_id;
    const roomTypeId = changes.room_type_id ?? old.room_type_id;
    if (roomId) {
      const overbooked = await assertRoomFree(client, roomId, arrival, departure, id, !!changes.allow_overbooking);
      if (overbooked && !user.permissions.has('reservations.overbook') && !user.is_superuser) throw new Forbidden('Overbooking requires authorization');
    }
    if (old.status === 'CHECKED_IN') {
      // extension / shortening of in-house stay: update stay expected checkout too
      await client.query(`UPDATE stays SET expected_check_out=$2 WHERE reservation_id=$1 AND status='IN_HOUSE'`, [id, departure]);
      if (roomId && roomId !== old.room_id) throw new BadRequest('Use the room move action for in-house guests');
    }
    const fields: Record<string, any> = { arrival_date: arrival, departure_date: departure, room_id: roomId, room_type_id: roomTypeId };
    for (const k of ['adults', 'children', 'rate', 'meal_plan', 'rate_plan_id', 'special_requests', 'notes', 'eta', 'customer_id', 'source', 'deposit_required', 'external_ref'] as const) {
      if ((changes as any)[k] !== undefined) fields[k] = (changes as any)[k];
    }
    if (changes.status && ['INQUIRY', 'TENTATIVE', 'CONFIRMED', 'DEPOSIT_PAID'].includes(changes.status) && old.status !== 'CHECKED_IN') fields.status = changes.status;
    const keys = Object.keys(fields);
    const row = (await client.query(`UPDATE reservations SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => fields[k])])).rows[0];
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'MODIFIED',$2,$3)`, [id, JSON.stringify({ changes, reason: changes.reason }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId: old.property_id, action: 'UPDATE', entityType: 'reservation', entityId: id, oldValue: old, newValue: row, reason: changes.reason }, client);
    return row;
  });
}

export async function cancelReservation(id: string, reason: string, user: AuthUser, asNoShow = false) {
  return withTransaction(async (client) => {
    const old = (await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new NotFound('Reservation not found');
    if (['CANCELLED', 'NO_SHOW', 'CHECKED_IN', 'CHECKED_OUT'].includes(old.status)) throw Errors.invalidStatus('reservation', old.status, asNoShow ? 'mark as no-show' : 'cancel');
    const status = asNoShow ? 'NO_SHOW' : 'CANCELLED';
    const row = (await client.query(`UPDATE reservations SET status=$2, cancelled_at=now(), cancellation_reason=$3 WHERE id=$1 RETURNING *`, [id, status, reason])).rows[0];
    if (old.room_id) await client.query(`UPDATE rooms SET status='AVAILABLE' WHERE id=$1 AND status='RESERVED'`, [old.room_id]);
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,$2,$3,$4)`, [id, status, JSON.stringify({ reason }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId: old.property_id, action: 'CANCEL', entityType: 'reservation', entityId: id, oldValue: old, newValue: row, reason }, client);
    await notify({ permission: 'reservations.view', propertyId: old.property_id, type: 'RESERVATION_CANCELLED', title: `Reservation ${old.number} ${asNoShow ? 'marked no-show' : 'cancelled'}`, body: reason, entityType: 'reservation', entityId: id, severity: 'WARNING' }, client);
    return row;
  });
}

export async function splitReservation(id: string, splitDate: string, user: AuthUser) {
  return withTransaction(async (client) => {
    const old = (await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new NotFound('Reservation not found');
    const arr = ymd(old.arrival_date), dep = ymd(old.departure_date);
    if (!(splitDate > arr && splitDate < dep)) throw new BadRequest('Split date must fall strictly within the stay');
    const number = await nextNumber(client, 'RESERVATION', old.property_id);
    const second = (await client.query(
      `INSERT INTO reservations (property_id, number, group_id, guest_id, customer_id, room_type_id, room_id, rate_plan_id, arrival_date, departure_date, adults, children, rate, meal_plan, currency, source, status, special_requests, notes, created_by)
       SELECT property_id, $2, COALESCE(group_id, id), guest_id, customer_id, room_type_id, room_id, rate_plan_id, $3, departure_date, adults, children, rate, meal_plan, currency, source, status, special_requests, notes, $4 FROM reservations WHERE id=$1 RETURNING *`,
      [id, number, splitDate, user.id])).rows[0];
    await client.query(`INSERT INTO reservation_guests (reservation_id, guest_id, is_primary) VALUES ($1,$2,true)`, [second.id, old.guest_id]);
    await client.query(`UPDATE reservations SET departure_date=$2, group_id=COALESCE(group_id, id) WHERE id=$1`, [id, splitDate]);
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'SPLIT',$2,$3)`, [id, JSON.stringify({ splitDate, newReservation: second.number }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId: old.property_id, action: 'SPLIT', entityType: 'reservation', entityId: id, newValue: { second: second.id } }, client);
    return second;
  });
}

export async function mergeReservations(keepId: string, mergeId: string, user: AuthUser) {
  return withTransaction(async (client) => {
    const a = (await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [keepId])).rows[0];
    const b = (await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [mergeId])).rows[0];
    if (!a || !b) throw new NotFound('Reservation not found');
    if (a.guest_id !== b.guest_id || a.room_id !== b.room_id) throw new BadRequest('Only consecutive reservations for the same guest and room can be merged');
    const aDep = ymd(a.departure_date), bArr = ymd(b.arrival_date);
    if (aDep !== bArr) throw new BadRequest('Reservations must be consecutive to merge');
    if (!['CONFIRMED', 'DEPOSIT_PAID', 'TENTATIVE'].includes(b.status)) throw Errors.invalidStatus('reservation', b.status, 'merge');
    await client.query(`UPDATE reservations SET departure_date=$2 WHERE id=$1`, [keepId, b.departure_date]);
    await client.query(`UPDATE reservations SET status='CANCELLED', cancelled_at=now(), cancellation_reason=$2 WHERE id=$1`, [mergeId, `Merged into ${a.number}`]);
    if (a.status === 'CHECKED_IN') await client.query(`UPDATE stays SET expected_check_out=$2 WHERE reservation_id=$1 AND status='IN_HOUSE'`, [keepId, b.departure_date]);
    await client.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'MERGED',$2,$3)`, [keepId, JSON.stringify({ merged: b.number }), user.id]);
    await audit({ userId: user.id, username: user.username, propertyId: a.property_id, action: 'MERGE', entityType: 'reservation', entityId: keepId, newValue: { merged: mergeId } }, client);
    return (await client.query(`SELECT * FROM reservations WHERE id=$1`, [keepId])).rows[0];
  });
}
