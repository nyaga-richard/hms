import { Router } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, addDays } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { runList } from '../../core/listing';
import { currentBusinessDate, r2 } from './accounting.service';
import { postRoomCharge } from '../pms/stay.service';
import { cancelReservation } from '../pms/reservations.service';

/**
 * Business date & night audit.
 * The business date is independent of the calendar date. Night audit: pre-checks (open shifts, unsettled POS orders, pending
 * departures), posts room & package charges for all in-house stays, marks unarrived reservations as no-show, computes the
 * daily statistics (occupancy, ADR, RevPAR, revenue by category, payments by method, ledger balances), closes the day and opens the next.
 */
export const businessDaysRouter = Router();

async function dayChecks(c: PoolClient, propertyId: string, bd: string) {
  const openShifts = (await c.query(`SELECT s.id, s.number, u.full_name AS cashier, o.name AS outlet, s.opened_at FROM cashier_shifts s JOIN users u ON u.id=s.user_id LEFT JOIN outlets o ON o.id=s.outlet_id WHERE s.property_id=$1 AND s.status='OPEN'`, [propertyId])).rows;
  const openOrders = (await c.query(`SELECT o.id, o.number, o.status, o.total, ot.name AS outlet FROM orders o JOIN outlets ot ON ot.id=o.outlet_id WHERE o.property_id=$1 AND o.status IN ('OPEN','SENT','READY','SERVED','BILLED') AND o.business_date <= $2`, [propertyId, bd])).rows;
  const dueOuts = (await c.query(`SELECT s.id, r.number AS room, g.first_name || ' ' || g.last_name AS guest, s.expected_check_out FROM stays s JOIN rooms r ON r.id=s.room_id JOIN guests g ON g.id=s.guest_id WHERE s.property_id=$1 AND s.status='IN_HOUSE' AND s.expected_check_out <= $2`, [propertyId, bd])).rows;
  const unarrived = (await c.query(`SELECT r.id, r.number, r.arrival_date, g.first_name || ' ' || g.last_name AS guest, r.status FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.property_id=$1 AND r.arrival_date <= $2 AND r.status IN ('TENTATIVE','CONFIRMED','DEPOSIT_PAID','INQUIRY')`, [propertyId, bd])).rows;
  const toPost = (await c.query(`SELECT s.id, r.number AS room, s.rate, g.first_name || ' ' || g.last_name AS guest FROM stays s JOIN rooms r ON r.id=s.room_id JOIN guests g ON g.id=s.guest_id WHERE s.property_id=$1 AND s.status='IN_HOUSE' AND (s.last_room_charge_date IS NULL OR s.last_room_charge_date < $2)`, [propertyId, bd])).rows;
  const pendingVariance = (await c.query(`SELECT id, number, variance FROM cashier_shifts WHERE property_id=$1 AND status='PENDING_APPROVAL'`, [propertyId])).rows;
  const highBalances = (await c.query(`SELECT f.id, f.number, r.number AS room, g.first_name || ' ' || g.last_name AS guest, COALESCE(SUM(fi.amount),0) AS balance FROM folios f JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id JOIN guests g ON g.id=f.guest_id LEFT JOIN folio_items fi ON fi.folio_id=f.id AND NOT fi.is_reversed WHERE f.property_id=$1 AND f.status='OPEN' AND s.status='IN_HOUSE' GROUP BY f.id, r.number, g.first_name, g.last_name HAVING COALESCE(SUM(fi.amount),0) > COALESCE((SELECT (value #>> '{}')::numeric FROM settings WHERE key='pms.high_balance_threshold' AND (property_id=$1 OR property_id IS NULL) ORDER BY property_id NULLS LAST LIMIT 1), 50000)`, [propertyId])).rows;
  const blocking = [
    ...(openShifts.length ? [{ code: 'OPEN_SHIFTS', message: `${openShifts.length} cashier shift(s) still open`, count: openShifts.length }] : []),
    ...(openOrders.length ? [{ code: 'OPEN_ORDERS', message: `${openOrders.length} POS order(s) not settled`, count: openOrders.length }] : []),
  ];
  const warnings = [
    ...(dueOuts.length ? [{ code: 'DUE_OUT', message: `${dueOuts.length} guest(s) due out but still in house (will be charged another night)`, count: dueOuts.length }] : []),
    ...(unarrived.length ? [{ code: 'NO_SHOWS', message: `${unarrived.length} reservation(s) did not arrive (will be marked no-show)`, count: unarrived.length }] : []),
    ...(pendingVariance.length ? [{ code: 'CASH_VARIANCE', message: `${pendingVariance.length} shift(s) awaiting variance approval`, count: pendingVariance.length }] : []),
    ...(highBalances.length ? [{ code: 'HIGH_BALANCE', message: `${highBalances.length} folio(s) above the high-balance threshold`, count: highBalances.length }] : []),
  ];
  return { business_date: bd, blocking, warnings, open_shifts: openShifts, open_orders: openOrders, due_outs: dueOuts, unarrived, room_charges_to_post: toPost, pending_variance: pendingVariance, high_balances: highBalances, ready: blocking.length === 0 };
}

export async function dailyStatistics(c: PoolClient | typeof pool, propertyId: string, bd: string) {
  const rooms = (await c.query(`SELECT COUNT(*) FILTER (WHERE is_active)::int AS total, COUNT(*) FILTER (WHERE is_active AND status IN ('OUT_OF_ORDER'))::int AS ooo FROM rooms WHERE property_id=$1`, [propertyId])).rows[0];
  const occ = (await c.query(`SELECT COUNT(DISTINCT s.room_id)::int AS occupied, COALESCE(SUM(s.adults + s.children),0)::int AS guests FROM stays s WHERE s.property_id=$1 AND s.check_in_at::date <= $2 AND (s.check_out_at IS NULL OR s.check_out_at::date > $2) AND s.status IN ('IN_HOUSE','CHECKED_OUT')`, [propertyId, bd])).rows[0];
  const roomRev = Number((await c.query(`SELECT COALESCE(SUM(fi.amount - fi.tax_amount - fi.service_charge),0) AS v FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.property_id=$1 AND fi.item_type='CHARGE' AND fi.category='ROOM' AND NOT fi.is_reversed AND fi.business_date=$2`, [propertyId, bd])).rows[0].v);
  const revByCat = (await c.query(`SELECT fi.category, COALESCE(SUM(fi.amount - fi.tax_amount - fi.service_charge),0) AS net, COALESCE(SUM(fi.tax_amount),0) AS tax, COALESCE(SUM(fi.amount),0) AS gross FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.property_id=$1 AND fi.item_type='CHARGE' AND NOT fi.is_reversed AND fi.business_date=$2 GROUP BY fi.category ORDER BY gross DESC`, [propertyId, bd])).rows;
  const posRev = (await c.query(`SELECT ot.name AS outlet, ot.type, COUNT(*)::int AS orders, COALESCE(SUM(o.subtotal),0) AS net, COALESCE(SUM(o.tax_total),0) AS tax, COALESCE(SUM(o.total),0) AS gross FROM orders o JOIN outlets ot ON ot.id=o.outlet_id WHERE o.property_id=$1 AND o.status='CLOSED' AND o.business_date=$2 GROUP BY ot.name, ot.type ORDER BY gross DESC`, [propertyId, bd])).rows;
  const payments = (await c.query(`SELECT pm.name AS method, p.direction, COUNT(*)::int AS count, COALESCE(SUM(p.base_amount),0) AS amount FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.property_id=$1 AND p.status='COMPLETED' AND p.business_date=$2 GROUP BY pm.name, p.direction ORDER BY amount DESC`, [propertyId, bd])).rows;
  const movements = (await c.query(`SELECT (SELECT COUNT(*) FROM stays WHERE property_id=$1 AND check_in_at::date=$2)::int AS arrivals, (SELECT COUNT(*) FROM stays WHERE property_id=$1 AND check_out_at::date=$2)::int AS departures, (SELECT COUNT(*) FROM reservations WHERE property_id=$1 AND status='NO_SHOW' AND arrival_date=$2)::int AS no_shows, (SELECT COUNT(*) FROM reservations WHERE property_id=$1 AND cancelled_at::date=$2 AND status='CANCELLED')::int AS cancellations`, [propertyId, bd])).rows[0];
  const ledger = (await c.query(`SELECT COALESCE(SUM(fi.amount),0) AS guest_ledger FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.property_id=$1 AND f.status='OPEN' AND NOT fi.is_reversed`, [propertyId])).rows[0];
  const cityLedger = Number((await c.query(`SELECT COALESCE(SUM(pl.debit - pl.credit),0) AS v FROM party_ledger pl JOIN customers cu ON cu.id=pl.party_id WHERE pl.party_type='CUSTOMER' AND cu.property_id=$1`, [propertyId])).rows[0].v);
  const available = Math.max(0, Number(rooms.total) - Number(rooms.ooo));
  const occupied = Number(occ.occupied);
  const totalRevenue = r2(revByCat.reduce((s, r) => s + Number(r.net), 0) + posRev.reduce((s, r) => s + Number(r.net), 0));
  return {
    business_date: bd, rooms_total: Number(rooms.total), rooms_out_of_order: Number(rooms.ooo), rooms_available: available, rooms_occupied: occupied, guests_in_house: Number(occ.guests),
    occupancy_percent: available ? r2(occupied / available * 100) : 0, room_revenue: r2(roomRev), adr: occupied ? r2(roomRev / occupied) : 0, revpar: available ? r2(roomRev / available) : 0,
    total_revenue: totalRevenue, revenue_by_category: revByCat, pos_by_outlet: posRev, payments_by_method: payments, ...movements, guest_ledger_balance: Number(ledger.guest_ledger), city_ledger_balance: r2(cityLedger),
  };
}

businessDaysRouter.get('/current', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { const bd = await currentBusinessDate(c, req.propertyId!, req.user!.id); const row = (await c.query(`SELECT * FROM business_days WHERE property_id=$1 AND business_date=$2`, [req.propertyId, bd])).rows[0]; return { business_date: bd, calendar_date: new Date().toISOString().slice(0, 10), status: row?.status ?? 'OPEN', opened_at: row?.opened_at ?? null }; });
  res.json(out);
}));
businessDaysRouter.get('/', requirePermission('accounting.view', 'accounting.night_audit', 'reports.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT bd.*, u.full_name AS closed_by_name, (bd.night_audit_report->>'occupancy_percent')::numeric AS occupancy_percent, (bd.night_audit_report->>'total_revenue')::numeric AS total_revenue, (bd.night_audit_report->>'adr')::numeric AS adr, (bd.night_audit_report->>'revpar')::numeric AS revpar FROM business_days bd LEFT JOIN users u ON u.id=bd.closed_by`, where: ['bd.property_id=$1'], params: [req.propertyId], searchColumns: [], defaultSort: 'bd.business_date', filters: { status: 'bd.status' }, dateFilters: { date: 'bd.business_date' }, exportName: 'business_days' });
}));
businessDaysRouter.get('/night-audit/preview', requirePermission('accounting.night_audit'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { const bd = await currentBusinessDate(c, req.propertyId!, req.user!.id); return { ...(await dayChecks(c, req.propertyId!, bd)), statistics: await dailyStatistics(c, req.propertyId!, bd) }; });
  res.json(out);
}));
businessDaysRouter.post('/night-audit/run', requirePermission('accounting.night_audit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ force: z.boolean().default(false), mark_no_shows: z.boolean().default(true), post_room_charges: z.boolean().default(true), notes: optionalStr }), req.body ?? {});
  const out = await withTransaction(async (c) => {
    const pid = req.propertyId!;
    const bd = await currentBusinessDate(c, pid, req.user!.id);
    await c.query(`SELECT 1 FROM business_days WHERE property_id=$1 AND business_date=$2 FOR UPDATE`, [pid, bd]);
    const checks = await dayChecks(c, pid, bd);
    if (checks.blocking.length && !(b.force && hasPermission(req, 'accounting.periods'))) throw new BadRequest('Night audit blocked: ' + checks.blocking.map((x) => x.message).join('; '), checks, 'NIGHT_AUDIT_BLOCKED');
    await c.query(`UPDATE business_days SET status='CLOSING' WHERE property_id=$1 AND business_date=$2`, [pid, bd]);
    const log: any = { room_charges_posted: 0, room_charge_total: 0, no_shows: [] as any[], errors: [] as any[] };
    if (b.post_room_charges) {
      for (const s of checks.room_charges_to_post) {
        try { const item = await postRoomCharge(c, s.id, bd, req.user!.id); if (item) { log.room_charges_posted++; log.room_charge_total = r2(log.room_charge_total + Number(item.amount ?? s.rate)); } }
        catch (e: any) { log.errors.push({ stay_id: s.id, room: s.room, error: e.message }); }
      }
    }
    if (b.mark_no_shows) {
      for (const r of checks.unarrived) {
        // Mark as no-show inside this transaction (reservation service uses its own transaction; replicate the essential effect here)
        const row = (await c.query(`UPDATE reservations SET status='NO_SHOW', cancelled_at=now(), cancellation_reason='No-show (night audit)' WHERE id=$1 AND status IN ('TENTATIVE','CONFIRMED','DEPOSIT_PAID','INQUIRY') RETURNING id, number, room_id`, [r.id])).rows[0];
        if (row) { if (row.room_id) await c.query(`UPDATE rooms SET status='AVAILABLE' WHERE id=$1 AND status='RESERVED'`, [row.room_id]); await c.query(`INSERT INTO reservation_history (reservation_id, action, details, user_id) VALUES ($1,'NO_SHOW',$2,$3)`, [row.id, JSON.stringify({ business_date: bd, by: 'night_audit' }), req.user!.id]); log.no_shows.push(row.number); }
      }
    }
    if (log.errors.length && !b.force) throw new BadRequest('Night audit aborted: some room charges failed', log, 'NIGHT_AUDIT_ERRORS');
    const stats = await dailyStatistics(c, pid, bd);
    const report = { ...stats, audit_log: log, checks: { warnings: checks.warnings, blocking: checks.blocking, forced: b.force }, notes: b.notes ?? null, run_by: req.user!.username, run_at: new Date().toISOString() };
    await c.query(`UPDATE business_days SET status='CLOSED', closed_at=now(), closed_by=$3, night_audit_report=$4 WHERE property_id=$1 AND business_date=$2`, [pid, bd, req.user!.id, JSON.stringify(report)]);
    const next = addDays(bd, 1);
    await c.query(`INSERT INTO business_days (property_id, business_date, status, opened_by) VALUES ($1,$2,'OPEN',$3) ON CONFLICT (property_id, business_date) DO UPDATE SET status='OPEN', opened_at=now()`, [pid, next, req.user!.id]);
    await notify({ permission: 'dashboard.management', propertyId: pid, type: 'NIGHT_AUDIT', title: `Night audit completed for ${bd}`, body: `Occupancy ${stats.occupancy_percent}% · ADR ${stats.adr} · Revenue ${stats.total_revenue}`, entityType: 'business_day', entityId: bd, link: `/finance/night-audit?date=${bd}`, severity: 'SUCCESS' }, c);
    await audit({ ...auditCtx(req), action: 'NIGHT_AUDIT', entityType: 'business_day', entityId: null, newValue: { business_date: bd, next, log } }, c);
    return { closed: bd, next_business_date: next, report };
  });
  res.json(out);
}));
businessDaysRouter.get('/:date/report', requirePermission('accounting.view', 'accounting.night_audit', 'reports.view'), asyncHandler(async (req, res) => {
  const row = (await pool.query(`SELECT bd.*, u.full_name AS closed_by_name FROM business_days bd LEFT JOIN users u ON u.id=bd.closed_by WHERE bd.property_id=$1 AND bd.business_date=$2`, [req.propertyId, req.params.date])).rows[0];
  if (!row) throw new NotFound('Business day not found');
  if (!row.night_audit_report) row.night_audit_report = await dailyStatistics(pool, req.propertyId!, req.params.date);
  res.json(row);
}));
/** Emergency reopen of the last closed day (finance manager only): keeps postings, just re-opens the date for late corrections. */
businessDaysRouter.post('/:date/reopen', requirePermission('accounting.periods'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3) }), req.body);
  const out = await withTransaction(async (c) => {
    const last = (await c.query(`SELECT * FROM business_days WHERE property_id=$1 AND status='CLOSED' ORDER BY business_date DESC LIMIT 1`, [req.propertyId])).rows[0];
    if (!last || String(last.business_date).slice(0, 10) !== req.params.date) throw new BadRequest('Only the most recently closed business day can be reopened');
    const open = (await c.query(`SELECT business_date FROM business_days WHERE property_id=$1 AND status='OPEN'`, [req.propertyId])).rows[0];
    if (open) { const hasActivity = (await c.query(`SELECT 1 FROM journal_entries WHERE property_id=$1 AND business_date=$2 LIMIT 1`, [req.propertyId, open.business_date])).rows[0]; if (hasActivity) throw new Forbidden('The next business day already has postings; it cannot be rolled back'); await c.query(`DELETE FROM business_days WHERE property_id=$1 AND business_date=$2 AND status='OPEN'`, [req.propertyId, open.business_date]); }
    const r = (await c.query(`UPDATE business_days SET status='OPEN', closed_at=NULL, closed_by=NULL WHERE id=$1 RETURNING *`, [last.id])).rows[0];
    await audit({ ...auditCtx(req), action: 'REOPEN', entityType: 'business_day', entityId: null, reason: b.reason, newValue: { business_date: req.params.date } }, c);
    return r;
  });
  res.json(out);
}));
// keep import used for type-compat (cancelReservation available for API-level no-show handling)
void cancelReservation;
