import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { pool, withTransaction } from '../../db/pool';
import { env } from '../../config/env';
import { asyncHandler, validate, optionalStr, sendExport, ymd, addDays } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { currentBusinessDate } from '../finance/accounting.service';
import { dailyStatistics } from '../finance/nightaudit.routes';

// =====================================================================================
// Dashboard — permission-aware: every widget is only computed when the caller may see it
// =====================================================================================
export const dashboardRouter = Router();
dashboardRouter.get('/', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const pid = req.propertyId!;
  const bd = await currentBusinessDate(pool as any, pid, req.user!.id);
  const out: Record<string, any> = { business_date: bd, widgets: [] as string[] };
  const can = (p: string) => hasPermission(req, p);
  const tasks: Promise<void>[] = [];
  const add = (name: string, allowed: boolean, fn: () => Promise<any>) => { if (!allowed) return; out.widgets.push(name); tasks.push(fn().then((v) => { out[name] = v; }).catch((e) => { out[name] = { error: e.message }; })); };

  add('front_office', can('reservations.view') || can('rooms.view'), async () => {
    const r = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM reservations WHERE property_id=$1 AND arrival_date=$2 AND status IN ('CONFIRMED','GUARANTEED','TENTATIVE'))::int AS arrivals_expected,
      (SELECT COUNT(*) FROM stays WHERE property_id=$1 AND check_in_at::date=$2)::int AS arrived,
      (SELECT COUNT(*) FROM stays WHERE property_id=$1 AND status='IN_HOUSE' AND expected_check_out=$2)::int AS departures_expected,
      (SELECT COUNT(*) FROM stays WHERE property_id=$1 AND check_out_at::date=$2)::int AS departed,
      (SELECT COUNT(*) FROM stays WHERE property_id=$1 AND status='IN_HOUSE')::int AS in_house,
      (SELECT COALESCE(SUM(adults+children),0) FROM stays WHERE property_id=$1 AND status='IN_HOUSE')::int AS guests_in_house,
      (SELECT COUNT(*) FROM reservations WHERE property_id=$1 AND arrival_date=$2 AND status='NO_SHOW')::int AS no_shows,
      (SELECT COUNT(*) FROM rooms WHERE property_id=$1 AND is_active)::int AS rooms_total,
      (SELECT COUNT(*) FROM rooms WHERE property_id=$1 AND is_active AND status='OUT_OF_ORDER')::int AS rooms_ooo`, [pid, bd])).rows[0];
    const occ = r.rooms_total - r.rooms_ooo > 0 ? Math.round((r.in_house / (r.rooms_total - r.rooms_ooo)) * 10000) / 100 : 0;
    return { ...r, occupancy_percent: occ };
  });
  add('rooms', can('rooms.view') || can('housekeeping.view'), async () => {
    const rows = (await pool.query(`SELECT status, housekeeping_status, COUNT(*)::int AS n FROM rooms WHERE property_id=$1 AND is_active GROUP BY status, housekeeping_status`, [pid])).rows;
    const byStatus: Record<string, number> = {}, byHk: Record<string, number> = {};
    rows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n; byHk[r.housekeeping_status] = (byHk[r.housekeeping_status] ?? 0) + r.n; });
    return { by_status: byStatus, by_housekeeping: byHk };
  });
  add('housekeeping', can('housekeeping.view'), async () => (await pool.query(`SELECT status, COUNT(*)::int AS n FROM housekeeping_tasks WHERE property_id=$1 AND business_date=$2 GROUP BY status`, [pid, bd])).rows.reduce((a: any, r) => ({ ...a, [r.status]: r.n }), {}));
  add('maintenance', can('maintenance.view'), async () => (await pool.query(`SELECT status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE priority='URGENT')::int AS urgent FROM maintenance_requests WHERE property_id=$1 AND status NOT IN ('VERIFIED','CANCELLED','REJECTED') GROUP BY status`, [pid])).rows);
  add('revenue_today', can('dashboard.management') || can('reports.financial'), async () => {
    const stats = await dailyStatistics(pool as any, pid, bd);
    const byDept = (await pool.query(`SELECT COALESCE(a.name,'Other') AS department, SUM(jl.credit - jl.debit) AS revenue FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id WHERE je.property_id=$1 AND je.business_date=$2 AND je.status='POSTED' AND a.type='REVENUE' GROUP BY a.name ORDER BY revenue DESC`, [pid, bd])).rows;
    return { ...stats, by_department: byDept };
  });
  add('revenue_trend', can('dashboard.management') || can('reports.financial'), async () => (await pool.query(`SELECT je.business_date AS date, SUM(CASE WHEN a.type='REVENUE' THEN jl.credit - jl.debit ELSE 0 END) AS revenue FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id WHERE je.property_id=$1 AND je.status='POSTED' AND je.business_date >= $2::date - 13 AND je.business_date <= $2 GROUP BY je.business_date ORDER BY 1`, [pid, bd])).rows);
  add('occupancy_trend', can('dashboard.management') || can('reports.view'), async () => (await pool.query(`SELECT d::date AS date, (SELECT COUNT(DISTINCT s.room_id) FROM stays s WHERE s.property_id=$1 AND s.check_in_at::date <= d AND (s.check_out_at IS NULL OR s.check_out_at::date > d))::int AS occupied, (SELECT COUNT(*) FROM rooms WHERE property_id=$1 AND is_active)::int AS total FROM generate_series($2::date - 13, $2::date, '1 day') d`, [pid, bd])).rows.map((r) => ({ ...r, occupancy_percent: r.total ? Math.round((r.occupied / r.total) * 10000) / 100 : 0 })));
  add('pos', can('pos.view') || can('dashboard.management'), async () => {
    const outlets = (await pool.query(`SELECT ol.id, ol.name, ol.type, COUNT(o.id) FILTER (WHERE o.status='CLOSED')::int AS closed_orders, COUNT(o.id) FILTER (WHERE o.status IN ('OPEN','SENT','READY','SERVED','BILLED'))::int AS open_orders, COALESCE(SUM(o.total) FILTER (WHERE o.status='CLOSED'),0) AS sales, COALESCE(SUM(o.covers) FILTER (WHERE o.status='CLOSED'),0)::int AS covers FROM outlets ol LEFT JOIN orders o ON o.outlet_id=ol.id AND o.business_date=$2 WHERE ol.property_id=$1 AND ol.is_active GROUP BY ol.id ORDER BY sales DESC`, [pid, bd])).rows;
    const top = (await pool.query(`SELECT oi.name, SUM(oi.quantity)::numeric AS qty, SUM(oi.line_total) AS sales FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.property_id=$1 AND o.business_date=$2 AND o.status='CLOSED' AND NOT oi.voided GROUP BY oi.name ORDER BY sales DESC LIMIT 5`, [pid, bd])).rows;
    return { outlets, top_items: top, open_shifts: (await pool.query(`SELECT COUNT(*)::int AS n FROM cashier_shifts WHERE property_id=$1 AND status='OPEN'`, [pid])).rows[0].n };
  });
  add('kitchen', can('kitchen.view'), async () => (await pool.query(`SELECT kt.status, COUNT(*)::int AS n, ROUND(AVG(EXTRACT(EPOCH FROM (now() - COALESCE(kt.sent_at, now()))) / 60))::int AS avg_minutes FROM kitchen_tickets kt JOIN kitchens k ON k.id=kt.kitchen_id WHERE k.property_id=$1 AND kt.status IN ('NEW','ACCEPTED','PREPARING','READY') GROUP BY kt.status`, [pid])).rows);
  add('inventory', can('inventory.view'), async () => {
    const low = (await pool.query(`SELECT p.name, s.code AS store, sb.quantity, p.reorder_level FROM stock_balances sb JOIN products p ON p.id=sb.product_id JOIN stores s ON s.id=sb.store_id WHERE s.property_id=$1 AND p.reorder_level > 0 AND sb.quantity <= p.reorder_level ORDER BY sb.quantity LIMIT 10`, [pid])).rows;
    const value = (await pool.query(`SELECT COALESCE(SUM(sb.quantity*sb.avg_cost),0) AS v FROM stock_balances sb JOIN stores s ON s.id=sb.store_id WHERE s.property_id=$1`, [pid])).rows[0].v;
    const expiring = (await pool.query(`SELECT COUNT(*)::int AS n FROM stock_batches b JOIN stores s ON s.id=b.store_id WHERE s.property_id=$1 AND b.quantity > 0 AND b.expiry_date <= CURRENT_DATE + 14`, [pid])).rows[0].n;
    return { low_stock: low, stock_value: Number(value), expiring_batches: expiring };
  });
  add('procurement', can('purchases.view') || can('payables.view'), async () => (await pool.query(`SELECT
      (SELECT COUNT(*) FROM purchase_requisitions WHERE property_id=$1 AND status='PENDING_APPROVAL')::int AS requisitions_pending,
      (SELECT COUNT(*) FROM purchase_orders WHERE property_id=$1 AND status IN ('SENT','PARTIALLY_RECEIVED'))::int AS po_awaiting_delivery,
      (SELECT COALESCE(SUM(balance),0) FROM supplier_invoices WHERE property_id=$1 AND status IN ('APPROVED','PARTIALLY_PAID'))::numeric AS ap_outstanding,
      (SELECT COALESCE(SUM(balance),0) FROM supplier_invoices WHERE property_id=$1 AND status IN ('APPROVED','PARTIALLY_PAID') AND due_date < CURRENT_DATE)::numeric AS ap_overdue`, [pid])).rows[0]);
  add('finance', can('reports.financial') || can('receivables.view'), async () => (await pool.query(`SELECT
      (SELECT COALESCE(SUM(debit-credit),0) FROM party_ledger WHERE property_id=$1 AND party_type='CUSTOMER')::numeric AS ar_balance,
      (SELECT COALESCE(SUM(fi.amount),0) FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.property_id=$1 AND f.status='OPEN' AND NOT fi.is_reversed)::numeric AS guest_ledger,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE property_id=$1 AND business_date=$2 AND direction='IN' AND status='COMPLETED')::numeric AS receipts_today,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE property_id=$1 AND business_date=$2 AND direction='OUT' AND status='COMPLETED')::numeric AS payments_today,
      (SELECT COUNT(*) FROM expenses WHERE property_id=$1 AND status='PENDING_APPROVAL')::int AS expenses_pending`, [pid, bd])).rows[0]);
  add('approvals', can('approvals.view'), async () => {
    const { pendingApprovalsFor } = await import('../workflow/workflow.service');
    const rows = await pendingApprovalsFor(req.user!, pid);
    return { pending: rows.length, items: rows.slice(0, 8) };
  });
  add('events', can('events.view'), async () => (await pool.query(`SELECT e.id, e.number, e.name, e.start_at, e.status, e.expected_guests, v.name AS venue FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE e.property_id=$1 AND e.status IN ('CONFIRMED','IN_PROGRESS') AND e.start_at < now() + interval '7 days' ORDER BY e.start_at LIMIT 8`, [pid])).rows);
  add('notifications', true, async () => (await pool.query(`SELECT id, type, title, link, severity, created_at FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 8`, [req.user!.id])).rows);
  await Promise.all(tasks);
  res.json(out);
}));
/** KPI series for management: occupancy, ADR, RevPAR, revenue by department, over a date range. */
dashboardRouter.get('/kpis', requirePermission('dashboard.management', 'reports.financial'), asyncHandler(async (req, res) => {
  const pid = req.propertyId!;
  const to = String(req.query.to ?? ymd(new Date())), from = String(req.query.from ?? addDays(to, -29));
  const days = (await pool.query(`SELECT d::date AS date FROM generate_series($1::date, $2::date, '1 day') d`, [from, to])).rows.map((r) => ymd(r.date));
  const series = [];
  for (const d of days) series.push({ date: d, ...(await dailyStatistics(pool as any, pid, d)) });
  const agg = series.reduce((a, s: any) => ({ room_nights: a.room_nights + Number(s.rooms_occupied ?? 0), available: a.available + Number(s.rooms_available ?? 0), room_revenue: a.room_revenue + Number(s.room_revenue ?? 0), total_revenue: a.total_revenue + Number(s.total_revenue ?? 0), fnb_revenue: a.fnb_revenue + (s.revenue_by_category ?? []).filter((c: any) => ['FOOD', 'BEVERAGE'].includes(c.category)).reduce((x: number, c: any) => x + Number(c.net), 0) }), { room_nights: 0, available: 0, room_revenue: 0, total_revenue: 0, fnb_revenue: 0 });
  const summary = { ...agg, occupancy_percent: agg.available ? Math.round((agg.room_nights / agg.available) * 10000) / 100 : 0, adr: agg.room_nights ? Math.round((agg.room_revenue / agg.room_nights) * 100) / 100 : 0, revpar: agg.available ? Math.round((agg.room_revenue / agg.available) * 100) / 100 : 0 };
  if (['csv', 'xlsx', 'pdf'].includes(String(req.query.format))) return sendExport(res, req, series, 'kpis', { title: 'Daily KPIs', meta: { from, to } });
  res.json({ from, to, summary, series });
}));

// =====================================================================================
// Reports — a catalogue of parameterised SQL reports, all exportable (csv/xlsx/pdf)
// =====================================================================================
interface ReportDef { key: string; name: string; group: string; permission: string | string[]; params: { name: string; type: 'date' | 'select' | 'text' | 'uuid'; required?: boolean; default?: string; options?: string }[]; run: (req: any, p: Record<string, any>) => Promise<{ rows: any[]; columns?: string[]; meta?: Record<string, any> }> }
const q = async (sql: string, params: any[]) => (await pool.query(sql, params)).rows;
const range = (p: Record<string, any>) => { const to = p.to || ymd(new Date()); const from = p.from || addDays(to, -29); return { from, to }; };
export const REPORTS: ReportDef[] = [
  { key: 'daily_revenue', name: 'Daily Revenue Report', group: 'Finance', permission: 'reports.financial', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT je.business_date AS date, a.code AS account, a.name AS revenue_account, SUM(jl.credit - jl.debit) AS revenue FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id WHERE je.property_id=$1 AND je.status='POSTED' AND a.type='REVENUE' AND je.business_date BETWEEN $2 AND $3 GROUP BY 1,2,3 ORDER BY 1,2`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'manager_flash', name: 'Manager Flash (Occupancy / ADR / RevPAR)', group: 'Management', permission: ['dashboard.management', 'reports.financial'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); const rows = []; let d = from; while (d <= to) { rows.push({ date: d, ...(await dailyStatistics(pool as any, req.propertyId, d)) }); d = addDays(d, 1); } return { rows, meta: { from, to } }; } },
  { key: 'occupancy_forecast', name: 'Occupancy Forecast', group: 'Front Office', permission: 'reports.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const from = p.from || ymd(new Date()); const to = p.to || addDays(from, 30); return { rows: await q(`SELECT d::date AS date, (SELECT COUNT(*) FROM rooms WHERE property_id=$1 AND is_active)::int AS rooms, (SELECT COUNT(*) FROM stays s WHERE s.property_id=$1 AND s.status='IN_HOUSE' AND s.expected_check_out > d AND s.check_in_at::date <= d)::int AS in_house, (SELECT COUNT(*) FROM reservations r WHERE r.property_id=$1 AND r.status IN ('CONFIRMED','GUARANTEED','TENTATIVE') AND r.arrival_date <= d AND r.departure_date > d)::int AS reserved, (SELECT COUNT(*) FROM reservations r WHERE r.property_id=$1 AND r.status IN ('CONFIRMED','GUARANTEED','TENTATIVE') AND r.arrival_date = d)::int AS arrivals, (SELECT COUNT(*) FROM reservations r WHERE r.property_id=$1 AND r.status IN ('CONFIRMED','GUARANTEED','TENTATIVE','CHECKED_IN') AND r.departure_date = d)::int + (SELECT COUNT(*) FROM stays s WHERE s.property_id=$1 AND s.status='IN_HOUSE' AND s.expected_check_out = d)::int AS departures FROM generate_series($2::date, $3::date, '1 day') d`, [req.propertyId, from, to]).then((rows) => rows.map((r) => ({ ...r, forecast_occupancy_percent: r.rooms ? Math.round(((r.in_house + r.reserved) / r.rooms) * 10000) / 100 : 0 }))), meta: { from, to } }; } },
  { key: 'arrivals', name: 'Arrivals List', group: 'Front Office', permission: 'reservations.view', params: [{ name: 'date', type: 'date' }], run: async (req, p) => { const d = p.date || ymd(new Date()); return { rows: await q(`SELECT r.number, g.first_name || ' ' || g.last_name AS guest, g.phone, rt.name AS room_type, rm.number AS room, r.adults, r.children, r.departure_date, r.rate, r.meal_plan, r.status, r.special_requests, r.eta, c.name AS company FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN customers c ON c.id=r.customer_id WHERE r.property_id=$1 AND r.arrival_date=$2 AND r.status NOT IN ('CANCELLED') ORDER BY r.status, guest`, [req.propertyId, d]), meta: { date: d } }; } },
  { key: 'departures', name: 'Departures List', group: 'Front Office', permission: 'reservations.view', params: [{ name: 'date', type: 'date' }], run: async (req, p) => { const d = p.date || ymd(new Date()); return { rows: await q(`SELECT rm.number AS room, g.first_name || ' ' || g.last_name AS guest, s.check_in_at::date AS arrived, s.expected_check_out, s.status, (SELECT COALESCE(SUM(fi.amount),0) FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.stay_id=s.id AND NOT fi.is_reversed) AS balance FROM stays s JOIN rooms rm ON rm.id=s.room_id JOIN guests g ON g.id=s.guest_id WHERE s.property_id=$1 AND s.expected_check_out=$2 AND s.status IN ('IN_HOUSE','CHECKED_OUT') ORDER BY rm.number`, [req.propertyId, d]), meta: { date: d } }; } },
  { key: 'in_house', name: 'In-House Guests', group: 'Front Office', permission: 'reservations.view', params: [], run: async (req) => ({ rows: await q(`SELECT rm.number AS room, rt.name AS room_type, g.first_name || ' ' || g.last_name AS guest, g.nationality, s.adults, s.children, s.check_in_at::date AS arrived, s.expected_check_out AS departing, s.rate, s.meal_plan, (SELECT COALESCE(SUM(fi.amount),0) FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.stay_id=s.id AND NOT fi.is_reversed) AS balance FROM stays s JOIN rooms rm ON rm.id=s.room_id JOIN room_types rt ON rt.id=rm.room_type_id JOIN guests g ON g.id=s.guest_id WHERE s.property_id=$1 AND s.status='IN_HOUSE' ORDER BY rm.number`, [req.propertyId]) }) },
  { key: 'guest_ledger', name: 'Guest Ledger (open folios)', group: 'Finance', permission: ['folios.view', 'reports.financial'], params: [], run: async (req) => ({ rows: await q(`SELECT f.number AS folio, f.type, rm.number AS room, COALESCE(g.first_name || ' ' || g.last_name, c.name) AS party, SUM(fi.amount) FILTER (WHERE fi.item_type='CHARGE' AND NOT fi.is_reversed) AS charges, -SUM(fi.amount) FILTER (WHERE fi.item_type IN ('PAYMENT','DEPOSIT','REFUND') AND NOT fi.is_reversed) AS payments, SUM(fi.amount) FILTER (WHERE NOT fi.is_reversed) AS balance FROM folios f LEFT JOIN folio_items fi ON fi.folio_id=f.id LEFT JOIN stays s ON s.id=f.stay_id LEFT JOIN rooms rm ON rm.id=s.room_id LEFT JOIN guests g ON g.id=f.guest_id LEFT JOIN customers c ON c.id=f.customer_id WHERE f.property_id=$1 AND f.status='OPEN' GROUP BY f.id, rm.number, g.first_name, g.last_name, c.name ORDER BY balance DESC`, [req.propertyId]) }) },
  { key: 'housekeeping_status', name: 'Housekeeping Room Status', group: 'Housekeeping', permission: 'housekeeping.view', params: [], run: async (req) => ({ rows: await q(`SELECT rm.number AS room, rm.floor, rt.name AS room_type, rm.status, rm.housekeeping_status, rm.maintenance_status, (SELECT u.full_name FROM housekeeping_tasks t JOIN users u ON u.id=t.assigned_to WHERE t.room_id=rm.id AND t.status IN ('PENDING','IN_PROGRESS') ORDER BY t.created_at DESC LIMIT 1) AS attendant, (SELECT g.first_name || ' ' || g.last_name FROM stays s JOIN guests g ON g.id=s.guest_id WHERE s.room_id=rm.id AND s.status='IN_HOUSE' LIMIT 1) AS guest FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id WHERE rm.property_id=$1 AND rm.is_active ORDER BY rm.number`, [req.propertyId]) }) },
  { key: 'housekeeping_productivity', name: 'Housekeeping Productivity', group: 'Housekeeping', permission: 'housekeeping.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT u.full_name AS attendant, COUNT(*)::int AS tasks, COUNT(*) FILTER (WHERE t.status IN ('DONE','INSPECTED'))::int AS completed, COUNT(*) FILTER (WHERE t.status='FAILED_INSPECTION')::int AS failed_inspection, ROUND(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.started_at))/60) FILTER (WHERE t.completed_at IS NOT NULL))::int AS avg_minutes FROM housekeeping_tasks t JOIN users u ON u.id=t.assigned_to WHERE t.property_id=$1 AND t.business_date BETWEEN $2 AND $3 GROUP BY u.full_name ORDER BY completed DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'maintenance_log', name: 'Maintenance Log & Costs', group: 'Maintenance', permission: 'maintenance.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }, { name: 'status', type: 'text' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT m.number, m.title, m.category, m.priority, m.status, rm.number AS room, a.name AS asset, u.full_name AS assigned_to, m.created_at::date AS reported, m.completed_at::date AS completed, m.labour_cost, m.parts_cost, m.contractor_cost, m.total_cost FROM maintenance_requests m LEFT JOIN rooms rm ON rm.id=m.room_id LEFT JOIN assets a ON a.id=m.asset_id LEFT JOIN users u ON u.id=m.assigned_to WHERE m.property_id=$1 AND m.created_at::date BETWEEN $2 AND $3 AND ($4::text IS NULL OR m.status=$4) ORDER BY m.created_at DESC`, [req.propertyId, from, to, p.status || null]), meta: { from, to } }; } },
  { key: 'pos_sales', name: 'POS Sales by Outlet', group: 'F&B', permission: ['pos.view', 'reports.view'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT o.business_date AS date, ol.name AS outlet, COUNT(o.id)::int AS orders, COALESCE(SUM(o.covers),0)::int AS covers, SUM(o.subtotal) AS subtotal, SUM(o.discount_total) AS discounts, SUM(o.service_charge) AS service_charge, SUM(o.tax_total) AS tax, SUM(o.total) AS total, SUM(o.cogs_total) AS cogs, ROUND(CASE WHEN SUM(o.total) > 0 THEN (SUM(o.total)-SUM(o.tax_total)-SUM(o.cogs_total))/NULLIF(SUM(o.total)-SUM(o.tax_total),0)*100 ELSE 0 END, 1) AS gross_margin_percent FROM orders o JOIN outlets ol ON ol.id=o.outlet_id WHERE o.property_id=$1 AND o.status='CLOSED' AND o.business_date BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY 1,2`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'menu_item_sales', name: 'Menu Item Sales Mix', group: 'F&B', permission: ['pos.view', 'reports.view'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }, { name: 'outlet_id', type: 'uuid' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT oi.name AS item, mc.name AS category, ol.name AS outlet, SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS sales, SUM(oi.discount) AS discounts, COUNT(*) FILTER (WHERE oi.is_complimentary)::int AS complimentary FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN outlets ol ON ol.id=o.outlet_id LEFT JOIN menu_items mi ON mi.id=oi.menu_item_id LEFT JOIN menu_categories mc ON mc.id=mi.category_id WHERE o.property_id=$1 AND o.status='CLOSED' AND NOT oi.voided AND o.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR o.outlet_id=$4) GROUP BY 1,2,3 ORDER BY sales DESC`, [req.propertyId, from, to, p.outlet_id || null]), meta: { from, to } }; } },
  { key: 'voids_discounts', name: 'Voids, Discounts & Complimentary', group: 'F&B', permission: ['pos.void_item', 'reports.view', 'dashboard.management'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT o.business_date AS date, o.number AS order_no, ol.name AS outlet, oi.name AS item, oi.quantity, oi.line_total AS amount, CASE WHEN oi.voided THEN 'VOID' WHEN oi.is_complimentary THEN 'COMPLIMENTARY' ELSE 'DISCOUNT' END AS type, COALESCE(oi.void_reason, o.discount_reason) AS reason, COALESCE(uv.full_name, ua.full_name) AS authorised_by FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN outlets ol ON ol.id=o.outlet_id LEFT JOIN users uv ON uv.id=oi.voided_by LEFT JOIN users ua ON ua.id=o.discount_approved_by WHERE o.property_id=$1 AND o.business_date BETWEEN $2 AND $3 AND (oi.voided OR oi.is_complimentary OR oi.discount > 0 OR o.discount_total > 0) ORDER BY o.business_date DESC, o.number`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'cashier_shifts', name: 'Cashier Shift Reconciliation', group: 'Finance', permission: ['pos.close_shift', 'reports.financial'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT cs.business_date AS date, cs.number, u.full_name AS cashier, ol.name AS outlet, cs.status, cs.opening_float, cs.expected_cash, cs.actual_cash, cs.variance, cs.variance_reason, cs.totals_by_method::text AS by_method, cs.opened_at, cs.closed_at FROM cashier_shifts cs JOIN users u ON u.id=cs.user_id LEFT JOIN outlets ol ON ol.id=cs.outlet_id WHERE cs.property_id=$1 AND cs.business_date BETWEEN $2 AND $3 ORDER BY cs.opened_at DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'payments', name: 'Payments & Receipts Register', group: 'Finance', permission: ['payments.view', 'reports.financial'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT p.business_date AS date, p.number, p.direction, p.kind, pm.name AS method, p.amount, p.currency, p.reference, p.party_type, p.source_type, p.status, u.full_name AS cashier FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id LEFT JOIN users u ON u.id=p.created_by WHERE p.property_id=$1 AND p.business_date BETWEEN $2 AND $3 ORDER BY p.created_at DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'stock_valuation', name: 'Stock Valuation', group: 'Inventory', permission: 'inventory.view', params: [{ name: 'store_id', type: 'uuid' }], run: async (req, p) => ({ rows: await q(`SELECT s.code AS store, pc.name AS category, p.sku, p.name AS product, u.code AS unit, sb.quantity, sb.avg_cost, ROUND(sb.quantity*sb.avg_cost,2) AS value, p.reorder_level, CASE WHEN p.reorder_level > 0 AND sb.quantity <= p.reorder_level THEN 'REORDER' ELSE '' END AS flag FROM stock_balances sb JOIN stores s ON s.id=sb.store_id JOIN products p ON p.id=sb.product_id LEFT JOIN product_categories pc ON pc.id=p.category_id LEFT JOIN units u ON u.id=p.unit_id WHERE s.property_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND (sb.quantity <> 0) ORDER BY s.code, pc.name, p.name`, [req.propertyId, p.store_id || null]) }) },
  { key: 'stock_movements', name: 'Stock Movement Ledger', group: 'Inventory', permission: 'inventory.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }, { name: 'store_id', type: 'uuid' }, { name: 'product_id', type: 'uuid' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT sm.business_date AS date, s.code AS store, p.name AS product, sm.movement_type, sm.quantity, sm.unit_cost, sm.total_cost, sm.balance_after, sm.reference_type, sm.reference_number, u.full_name AS user_name FROM stock_movements sm JOIN stores s ON s.id=sm.store_id JOIN products p ON p.id=sm.product_id LEFT JOIN users u ON u.id=sm.created_by WHERE sm.property_id=$1 AND sm.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR sm.store_id=$4) AND ($5::uuid IS NULL OR sm.product_id=$5) ORDER BY sm.created_at DESC LIMIT 5000`, [req.propertyId, from, to, p.store_id || null, p.product_id || null]), meta: { from, to } }; } },
  { key: 'consumption', name: 'Consumption by Department / Outlet', group: 'Inventory', permission: 'inventory.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT COALESCE(ol.name, d.name, s.name) AS consumer, p.name AS product, SUM(-sm.quantity) AS quantity, SUM(-sm.total_cost) AS cost FROM stock_movements sm JOIN stores s ON s.id=sm.store_id JOIN products p ON p.id=sm.product_id LEFT JOIN outlets ol ON ol.id=sm.outlet_id LEFT JOIN departments d ON d.id=sm.department_id WHERE sm.property_id=$1 AND sm.business_date BETWEEN $2 AND $3 AND sm.movement_type IN ('ISSUE_TO_DEPARTMENT','SALE','CONSUMPTION','WASTE','DAMAGE','EXPIRY') GROUP BY 1,2 ORDER BY cost DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'waste', name: 'Waste & Spoilage', group: 'Inventory', permission: 'inventory.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT sa.number, sa.status, s.code AS store, sa.reason, p.name AS product, -sai.variance_qty AS quantity, sai.unit_cost, -sai.variance_qty*sai.unit_cost AS cost, sa.created_at::date AS date, u.full_name AS reported_by FROM stock_adjustments sa JOIN stock_adjustment_items sai ON sai.adjustment_id=sa.id JOIN stores s ON s.id=sa.store_id JOIN products p ON p.id=sai.product_id LEFT JOIN users u ON u.id=sa.created_by WHERE sa.property_id=$1 AND sa.type='WASTE' AND sa.created_at::date BETWEEN $2 AND $3 ORDER BY sa.created_at DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'purchases', name: 'Purchases by Supplier', group: 'Procurement', permission: ['purchases.view', 'reports.view'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT s.name AS supplier, COUNT(DISTINCT po.id)::int AS purchase_orders, COUNT(DISTINCT g.id)::int AS deliveries, COALESCE(SUM(DISTINCT po.total),0) AS ordered_value, (SELECT COALESCE(SUM(si.total),0) FROM supplier_invoices si WHERE si.supplier_id=s.id AND si.invoice_date BETWEEN $2 AND $3 AND si.status<>'CANCELLED') AS invoiced_value, (SELECT COALESCE(SUM(si.balance),0) FROM supplier_invoices si WHERE si.supplier_id=s.id AND si.status IN ('APPROVED','PARTIALLY_PAID')) AS outstanding FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id=s.id AND po.created_at::date BETWEEN $2 AND $3 AND po.status<>'CANCELLED' LEFT JOIN grns g ON g.purchase_order_id=po.id WHERE s.property_id=$1 GROUP BY s.id ORDER BY invoiced_value DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'ap_aging', name: 'Accounts Payable Aging', group: 'Finance', permission: ['payables.view', 'reports.financial'], params: [], run: async (req) => ({ rows: await q(`SELECT s.name AS supplier, si.number, si.supplier_invoice_no, si.invoice_date, si.due_date, si.total, si.balance, GREATEST(0, CURRENT_DATE - si.due_date)::int AS days_overdue, CASE WHEN CURRENT_DATE <= si.due_date THEN 'current' WHEN CURRENT_DATE - si.due_date <= 30 THEN '1-30' WHEN CURRENT_DATE - si.due_date <= 60 THEN '31-60' WHEN CURRENT_DATE - si.due_date <= 90 THEN '61-90' ELSE '90+' END AS bucket FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id WHERE si.property_id=$1 AND si.balance > 0 AND si.status IN ('APPROVED','PARTIALLY_PAID') ORDER BY days_overdue DESC`, [req.propertyId]) }) },
  { key: 'ar_aging', name: 'Accounts Receivable Aging (City Ledger)', group: 'Finance', permission: ['receivables.view', 'reports.financial'], params: [], run: async (req) => ({ rows: await q(`SELECT c.name AS customer, c.type, c.credit_limit, SUM(pl.debit - pl.credit) AS balance, SUM(pl.debit) FILTER (WHERE pl.entry_date >= CURRENT_DATE - 30) AS current_30, SUM(pl.debit) FILTER (WHERE pl.entry_date < CURRENT_DATE - 30 AND pl.entry_date >= CURRENT_DATE - 60) AS d31_60, SUM(pl.debit) FILTER (WHERE pl.entry_date < CURRENT_DATE - 60 AND pl.entry_date >= CURRENT_DATE - 90) AS d61_90, SUM(pl.debit) FILTER (WHERE pl.entry_date < CURRENT_DATE - 90) AS d90_plus, MAX(pl.entry_date) AS last_activity FROM party_ledger pl JOIN customers c ON c.id=pl.party_id WHERE pl.property_id=$1 AND pl.party_type='CUSTOMER' GROUP BY c.id HAVING SUM(pl.debit - pl.credit) <> 0 ORDER BY balance DESC`, [req.propertyId]) }) },
  { key: 'expenses', name: 'Expenses by Category', group: 'Finance', permission: ['expenses.view', 'reports.financial'], params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT ec.name AS category, d.name AS department, COUNT(*)::int AS count, SUM(e.total) AS total, SUM(e.total) FILTER (WHERE e.payment_source='PETTY_CASH') AS petty_cash, SUM(e.total) FILTER (WHERE e.status='PAID') AS paid FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id LEFT JOIN departments d ON d.id=e.department_id WHERE e.property_id=$1 AND e.expense_date BETWEEN $2 AND $3 AND e.status IN ('APPROVED','PAID') GROUP BY 1,2 ORDER BY total DESC`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'tax_summary', name: 'Tax Summary', group: 'Finance', permission: 'reports.financial', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT t.code, t.name, t.rate, SUM(jl.credit) AS output_tax, SUM(jl.debit) AS input_tax_or_reversals, SUM(jl.credit - jl.debit) AS net FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN taxes t ON t.account_id=jl.account_id WHERE je.property_id=$1 AND je.status='POSTED' AND je.business_date BETWEEN $2 AND $3 GROUP BY t.id ORDER BY t.code`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'guest_history', name: 'Guest History & Loyalty', group: 'CRM', permission: 'guests.view', params: [{ name: 'search', type: 'text' }], run: async (req, p) => ({ rows: await q(`SELECT g.guest_no, g.first_name || ' ' || g.last_name AS guest, g.nationality, g.phone, g.email, g.vip_level, g.loyalty_points, COUNT(DISTINCT s.id)::int AS stays, COALESCE(SUM(DISTINCT (SELECT SUM(fi.amount) FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.stay_id=s.id AND fi.item_type='CHARGE' AND NOT fi.is_reversed)),0) AS lifetime_spend, MAX(s.check_in_at)::date AS last_stay, g.is_blacklisted FROM guests g LEFT JOIN stays s ON s.guest_id=g.id AND s.property_id=$1 WHERE ($2::text IS NULL OR g.first_name ILIKE '%'||$2||'%' OR g.last_name ILIKE '%'||$2||'%' OR g.phone ILIKE '%'||$2||'%') GROUP BY g.id ORDER BY stays DESC, guest LIMIT 2000`, [req.propertyId, p.search || null]) }) },
  { key: 'events_pipeline', name: 'Events Pipeline', group: 'Events', permission: 'events.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const from = p.from || ymd(new Date()); const to = p.to || addDays(from, 90); return { rows: await q(`SELECT e.number, e.name, e.type, e.status, v.name AS venue, e.start_at, e.end_at, e.expected_guests, e.quotation_total, e.deposit_required, e.deposit_paid, COALESCE(c.name, e.contact_name) AS client FROM events e LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN customers c ON c.id=e.customer_id WHERE e.property_id=$1 AND e.start_at::date BETWEEN $2 AND $3 ORDER BY e.start_at`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'staff_attendance', name: 'Staff Attendance', group: 'HR', permission: 'employees.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT a.shift_date AS date, e.employee_no, e.first_name || ' ' || e.last_name AS employee, d.name AS department, t.name AS shift, t.start_time, t.end_time, a.clock_in, a.clock_out, ROUND(EXTRACT(EPOCH FROM (a.clock_out - a.clock_in))/3600, 2) AS hours FROM staff_shift_assignments a JOIN employees e ON e.id=a.employee_id JOIN shift_templates t ON t.id=a.shift_template_id LEFT JOIN departments d ON d.id=e.department_id WHERE e.property_id=$1 AND a.shift_date BETWEEN $2 AND $3 ORDER BY a.shift_date DESC, employee`, [req.propertyId, from, to]), meta: { from, to } }; } },
  { key: 'audit_trail', name: 'Audit Trail', group: 'System', permission: 'audit.view', params: [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }, { name: 'entity_type', type: 'text' }, { name: 'username', type: 'text' }], run: async (req, p) => { const { from, to } = range(p); return { rows: await q(`SELECT created_at, username, action, entity_type, entity_id, reason, ip_address FROM audit_logs WHERE (property_id=$1 OR property_id IS NULL) AND created_at::date BETWEEN $2 AND $3 AND ($4::text IS NULL OR entity_type=$4) AND ($5::text IS NULL OR username=$5) ORDER BY created_at DESC LIMIT 5000`, [req.propertyId, from, to, p.entity_type || null, p.username || null]), meta: { from, to } }; } },
];
export const reportsRouter = Router();
const canRun = (req: any, r: ReportDef) => (Array.isArray(r.permission) ? r.permission : [r.permission]).some((p) => hasPermission(req, p));
reportsRouter.get('/', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  res.json(REPORTS.filter((r) => canRun(req, r)).map(({ run, ...r }) => r));
}));
reportsRouter.get('/:key', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  const r = REPORTS.find((x) => x.key === req.params.key);
  if (!r) throw new NotFound('Report not found');
  if (!canRun(req, r)) throw new Forbidden(`Missing permission for report ${r.key}`);
  const params: Record<string, any> = {}; r.params.forEach((p) => { const v = req.query[p.name]; if (v !== undefined && v !== '') params[p.name] = String(v); if (p.required && params[p.name] === undefined) throw new BadRequest(`Parameter ${p.name} is required`); });
  const out = await r.run(req, params);
  if (['csv', 'xlsx', 'pdf'].includes(String(req.query.format))) { if (!hasPermission(req, 'reports.export')) throw new Forbidden('Export permission required'); await audit({ ...auditCtx(req), action: 'EXPORT', entityType: 'report', entityId: null, newValue: { report: r.key, format: req.query.format, params } }); return sendExport(res, req, out.rows, r.key, { title: r.name, meta: out.meta }); }
  res.json({ report: { key: r.key, name: r.name, group: r.group }, params, meta: out.meta ?? {}, columns: out.columns ?? (out.rows[0] ? Object.keys(out.rows[0]) : []), rows: out.rows, count: out.rows.length });
}));

// =====================================================================================
// Global search — permission-filtered across guests, reservations, rooms, orders, products, suppliers, documents
// =====================================================================================
export const searchRouter = Router();
searchRouter.get('/', asyncHandler(async (req, res) => {
  const term = String(req.query.q ?? '').trim();
  if (term.length < 2) return res.json({ q: term, results: [] });
  const like = `%${term}%`; const pid = req.propertyId;
  const results: any[] = [];
  const push = (type: string, rows: any[], mapper: (r: any) => any) => rows.forEach((r) => results.push({ type, ...mapper(r) }));
  const jobs: Promise<any>[] = [];
  if (hasPermission(req, 'guests.view')) jobs.push(pool.query(`SELECT id, guest_no, first_name, last_name, phone, email FROM guests WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 OR guest_no ILIKE $1 OR id_number ILIKE $1 LIMIT 8`, [like]).then((r) => push('guest', r.rows, (g) => ({ id: g.id, title: `${g.first_name} ${g.last_name}`, subtitle: [g.guest_no, g.phone, g.email].filter(Boolean).join(' · '), link: `/guests/${g.id}` }))));
  if (hasPermission(req, 'reservations.view')) jobs.push(pool.query(`SELECT r.id, r.number, r.status, r.arrival_date, r.departure_date, g.first_name, g.last_name FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.property_id=$2 AND (r.number ILIKE $1 OR g.last_name ILIKE $1 OR g.first_name ILIKE $1 OR r.external_ref ILIKE $1) ORDER BY r.arrival_date DESC LIMIT 8`, [like, pid]).then((r) => push('reservation', r.rows, (x) => ({ id: x.id, title: `${x.number} · ${x.first_name} ${x.last_name}`, subtitle: `${x.status} · ${ymd(x.arrival_date)} → ${ymd(x.departure_date)}`, link: `/reservations/${x.id}` }))));
  if (hasPermission(req, 'rooms.view')) jobs.push(pool.query(`SELECT rm.id, rm.number, rm.status, rm.housekeeping_status, rt.name AS type FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id WHERE rm.property_id=$2 AND rm.number ILIKE $1 LIMIT 5`, [like, pid]).then((r) => push('room', r.rows, (x) => ({ id: x.id, title: `Room ${x.number}`, subtitle: `${x.type} · ${x.status} · ${x.housekeeping_status}`, link: `/rooms/${x.id}` }))));
  if (hasPermission(req, 'reservations.view') || hasPermission(req, 'folios.view')) jobs.push(pool.query(`SELECT s.id, rm.number AS room, g.first_name, g.last_name, s.status FROM stays s JOIN rooms rm ON rm.id=s.room_id JOIN guests g ON g.id=s.guest_id WHERE s.property_id=$2 AND s.status='IN_HOUSE' AND (rm.number ILIKE $1 OR g.last_name ILIKE $1) LIMIT 5`, [like, pid]).then((r) => push('stay', r.rows, (x) => ({ id: x.id, title: `In-house: Room ${x.room} · ${x.first_name} ${x.last_name}`, subtitle: x.status, link: `/front-desk/stays/${x.id}` }))));
  if (hasPermission(req, 'folios.view')) jobs.push(pool.query(`SELECT f.id, f.number, f.status, f.type FROM folios f WHERE f.property_id=$2 AND f.number ILIKE $1 LIMIT 5`, [like, pid]).then((r) => push('folio', r.rows, (x) => ({ id: x.id, title: `Folio ${x.number}`, subtitle: `${x.type} · ${x.status}`, link: `/folios/${x.id}` }))));
  if (hasPermission(req, 'pos.view')) jobs.push(pool.query(`SELECT o.id, o.number, o.status, o.total, ol.name AS outlet FROM orders o JOIN outlets ol ON ol.id=o.outlet_id WHERE o.property_id=$2 AND o.number ILIKE $1 ORDER BY o.opened_at DESC LIMIT 5`, [like, pid]).then((r) => push('order', r.rows, (x) => ({ id: x.id, title: `Order ${x.number}`, subtitle: `${x.outlet} · ${x.status} · ${x.total}`, link: `/pos/orders/${x.id}` }))));
  if (hasPermission(req, 'inventory.view') || hasPermission(req, 'products.view')) jobs.push(pool.query(`SELECT id, sku, name, barcode FROM products WHERE is_active AND (name ILIKE $1 OR sku ILIKE $1 OR barcode ILIKE $1) LIMIT 8`, [like]).then((r) => push('product', r.rows, (x) => ({ id: x.id, title: x.name, subtitle: [x.sku, x.barcode].filter(Boolean).join(' · '), link: `/inventory/products/${x.id}` }))));
  if (hasPermission(req, 'suppliers.view')) jobs.push(pool.query(`SELECT id, code, name, phone FROM suppliers WHERE property_id=$2 AND (name ILIKE $1 OR code ILIKE $1) LIMIT 5`, [like, pid]).then((r) => push('supplier', r.rows, (x) => ({ id: x.id, title: x.name, subtitle: [x.code, x.phone].filter(Boolean).join(' · '), link: `/procurement/suppliers/${x.id}` }))));
  if (hasPermission(req, 'customers.view')) jobs.push(pool.query(`SELECT id, code, name, type FROM customers WHERE (name ILIKE $1 OR code ILIKE $1) LIMIT 5`, [like]).then((r) => push('customer', r.rows, (x) => ({ id: x.id, title: x.name, subtitle: `${x.type} · ${x.code ?? ''}`, link: `/finance/customers/${x.id}` }))));
  if (hasPermission(req, 'maintenance.view')) jobs.push(pool.query(`SELECT id, number, title, status FROM maintenance_requests WHERE property_id=$2 AND (number ILIKE $1 OR title ILIKE $1) ORDER BY created_at DESC LIMIT 5`, [like, pid]).then((r) => push('maintenance', r.rows, (x) => ({ id: x.id, title: `${x.number} · ${x.title}`, subtitle: x.status, link: `/maintenance/${x.id}` }))));
  if (hasPermission(req, 'purchases.view')) jobs.push(pool.query(`SELECT po.id, po.number, po.status, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.property_id=$2 AND po.number ILIKE $1 LIMIT 5`, [like, pid]).then((r) => push('purchase_order', r.rows, (x) => ({ id: x.id, title: `${x.number} · ${x.supplier}`, subtitle: x.status, link: `/procurement/purchase-orders/${x.id}` }))));
  if (hasPermission(req, 'accounting.view')) jobs.push(pool.query(`SELECT id, number, description, entry_date, total_debit FROM journal_entries WHERE property_id=$2 AND (number ILIKE $1 OR description ILIKE $1) ORDER BY entry_date DESC LIMIT 5`, [like, pid]).then((r) => push('journal', r.rows, (x) => ({ id: x.id, title: `${x.number} · ${x.description}`, subtitle: `${ymd(x.entry_date)} · ${x.total_debit}`, link: `/finance/journals/${x.id}` }))));
  if (hasPermission(req, 'events.view')) jobs.push(pool.query(`SELECT id, number, name, status, start_at FROM events WHERE property_id=$2 AND (number ILIKE $1 OR name ILIKE $1) LIMIT 5`, [like, pid]).then((r) => push('event', r.rows, (x) => ({ id: x.id, title: `${x.number} · ${x.name}`, subtitle: `${x.status} · ${ymd(x.start_at)}`, link: `/events/${x.id}` }))));
  if (hasPermission(req, 'assets.view')) jobs.push(pool.query(`SELECT id, asset_number, name, status FROM assets WHERE property_id=$2 AND (asset_number ILIKE $1 OR name ILIKE $1 OR serial_number ILIKE $1 OR barcode ILIKE $1) LIMIT 5`, [like, pid]).then((r) => push('asset', r.rows, (x) => ({ id: x.id, title: `${x.asset_number} · ${x.name}`, subtitle: x.status, link: `/assets/${x.id}` }))));
  if (hasPermission(req, 'employees.view')) jobs.push(pool.query(`SELECT id, employee_no, first_name, last_name, position FROM employees WHERE property_id=$2 AND (first_name ILIKE $1 OR last_name ILIKE $1 OR employee_no ILIKE $1) LIMIT 5`, [like, pid]).then((r) => push('employee', r.rows, (x) => ({ id: x.id, title: `${x.first_name} ${x.last_name}`, subtitle: `${x.employee_no ?? ''} ${x.position ?? ''}`, link: `/hr/employees/${x.id}` }))));
  await Promise.all(jobs);
  res.json({ q: term, results });
}));

// =====================================================================================
// Attachments — generic file uploads for any entity (receipts, contracts, photos, IDs)
// =====================================================================================
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/vnd.ms-excel']);
fs.mkdirSync(path.resolve(env.storagePath), { recursive: true });
const upload = multer({ storage: multer.diskStorage({ destination: (_req, _f, cb) => cb(null, path.resolve(env.storagePath)), filename: (_req, f, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${path.extname(f.originalname).toLowerCase().slice(0, 10)}`) }), limits: { fileSize: env.uploadMaxSize, files: 5 }, fileFilter: (_req, f, cb) => { if (!ALLOWED_MIME.has(f.mimetype)) return cb(new BadRequest(`File type ${f.mimetype} not allowed`, undefined, 'UNSUPPORTED_FILE_TYPE')); cb(null, true); } });
export const attachmentsRouter = Router();
attachmentsRouter.get('/', asyncHandler(async (req, res) => {
  const b = validate(z.object({ entity_type: z.string().min(1), entity_id: z.string().min(1) }), req.query);
  res.json((await pool.query(`SELECT a.id, a.entity_type, a.entity_id, a.file_name, a.mime_type, a.size_bytes, a.description, a.created_at, u.full_name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.created_at`, [b.entity_type, b.entity_id])).rows);
}));
attachmentsRouter.post('/', requirePermission('attachments.upload'), upload.array('files', 5), asyncHandler(async (req, res) => {
  const b = validate(z.object({ entity_type: z.string().min(1), entity_id: z.string().min(1), description: optionalStr }), req.body);
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw new BadRequest('No files uploaded (use multipart field "files")');
  const rows = await withTransaction(async (c) => {
    const out = [];
    for (const f of files) {
      const r = (await c.query(`INSERT INTO attachments (property_id, entity_type, entity_id, file_name, stored_name, mime_type, size_bytes, description, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, entity_type, entity_id, file_name, mime_type, size_bytes, description, created_at`, [req.propertyId ?? null, b.entity_type, b.entity_id, f.originalname, f.filename, f.mimetype, f.size, b.description ?? null, req.user!.id])).rows[0];
      out.push(r);
    }
    await audit({ ...auditCtx(req), action: 'UPLOAD', entityType: b.entity_type, entityId: b.entity_id, newValue: { files: out.map((o) => o.file_name) } }, c);
    return out;
  });
  res.status(201).json(rows);
}));
attachmentsRouter.get('/:id/download', asyncHandler(async (req, res) => {
  const a = (await pool.query(`SELECT * FROM attachments WHERE id=$1`, [req.params.id])).rows[0];
  if (!a) throw new NotFound('Attachment not found');
  const file = path.resolve(env.storagePath, a.stored_name);
  if (!file.startsWith(path.resolve(env.storagePath)) || !fs.existsSync(file)) throw new NotFound('File missing from storage');
  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('Content-Disposition', `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.file_name)}"`);
  fs.createReadStream(file).pipe(res);
}));
attachmentsRouter.delete('/:id', requirePermission('attachments.delete'), asyncHandler(async (req, res) => {
  const a = (await pool.query(`DELETE FROM attachments WHERE id=$1 RETURNING *`, [req.params.id])).rows[0];
  if (!a) throw new NotFound('Attachment not found');
  fs.promises.unlink(path.resolve(env.storagePath, a.stored_name)).catch(() => undefined);
  await audit({ ...auditCtx(req), action: 'DELETE', entityType: 'attachment', entityId: a.id, oldValue: { entity_type: a.entity_type, entity_id: a.entity_id, file_name: a.file_name } });
  res.json({ ok: true });
}));

// =====================================================================================
// CSV imports — validate first (dry run), then commit; row-level errors reported
// =====================================================================================
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = '', inQ = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}
interface ImportDef { entity: string; permission: string; columns: { name: string; required?: boolean; note?: string }[]; validate: (row: Record<string, string>, ctx: any) => Promise<string[]>; insert: (c: any, row: Record<string, string>, ctx: any) => Promise<void> }
const IMPORTS: ImportDef[] = [
  { entity: 'guests', permission: 'guests.create', columns: [{ name: 'first_name', required: true }, { name: 'last_name', required: true }, { name: 'phone' }, { name: 'email' }, { name: 'nationality' }, { name: 'id_type' }, { name: 'id_number' }, { name: 'company_name' }, { name: 'vip_level' }, { name: 'notes' }],
    validate: async (r) => { const e = []; if (!r.first_name) e.push('first_name required'); if (!r.last_name) e.push('last_name required'); if (r.email && !/^[^@\s]+@[^@\s]+$/.test(r.email)) e.push('invalid email'); return e; },
    insert: async (c, r, ctx) => { const { nextNumber } = await import('../../core/numbering'); const no = await nextNumber(c, 'GUEST', null); await c.query(`INSERT INTO guests (guest_no, first_name, last_name, phone, email, nationality, id_type, id_number, company_name, vip_level, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [no, r.first_name, r.last_name, r.phone || null, r.email || null, r.nationality || null, r.id_type || null, r.id_number || null, r.company_name || null, parseInt(r.vip_level || '0', 10) || 0, r.notes || null]); void ctx; } },
  { entity: 'products', permission: 'products.manage', columns: [{ name: 'sku', required: true }, { name: 'name', required: true }, { name: 'category', note: 'category name (created if missing)' }, { name: 'unit', required: true, note: 'unit code e.g. KG, PC, LTR' }, { name: 'cost_price' }, { name: 'selling_price' }, { name: 'reorder_level' }, { name: 'barcode' }, { name: 'is_sellable' }],
    validate: async (r, ctx) => { const e = []; if (!r.sku) e.push('sku required'); if (!r.name) e.push('name required'); if (!r.unit) e.push('unit required'); else if (!ctx.units.has(r.unit.toUpperCase())) e.push(`unknown unit ${r.unit}`); if (r.sku && ctx.skus.has(r.sku)) e.push('sku already exists (will update prices)'); return e.filter((x) => !x.includes('will update')); },
    insert: async (c, r, ctx) => { let catId = null; if (r.category) { catId = (await c.query(`INSERT INTO product_categories (code, name) VALUES (upper(regexp_replace($1,'[^A-Za-z0-9]+','_','g')), $1) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [r.category])).rows[0].id; } await c.query(`INSERT INTO products (sku, name, category_id, unit_id, cost_price, selling_price, reorder_level, barcode, is_sellable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (sku) DO UPDATE SET name=EXCLUDED.name, cost_price=EXCLUDED.cost_price, selling_price=EXCLUDED.selling_price, reorder_level=EXCLUDED.reorder_level, category_id=COALESCE(EXCLUDED.category_id, products.category_id)`, [r.sku, r.name, catId, ctx.units.get(r.unit.toUpperCase()), Number(r.cost_price || 0), Number(r.selling_price || 0), Number(r.reorder_level || 0), r.barcode || null, ['1', 'true', 'yes', 'y'].includes((r.is_sellable || '').toLowerCase())]); } },
  { entity: 'suppliers', permission: 'suppliers.manage', columns: [{ name: 'code', required: true }, { name: 'name', required: true }, { name: 'contact_name' }, { name: 'phone' }, { name: 'email' }, { name: 'tax_number' }, { name: 'payment_terms_days' }, { name: 'categories', note: 'semicolon separated' }],
    validate: async (r) => { const e = []; if (!r.code) e.push('code required'); if (!r.name) e.push('name required'); return e; },
    insert: async (c, r, ctx) => { await c.query(`INSERT INTO suppliers (property_id, code, name, contact_name, phone, email, tax_number, payment_terms_days, categories) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, contact_name=EXCLUDED.contact_name, phone=EXCLUDED.phone, email=EXCLUDED.email`, [ctx.propertyId, r.code, r.name, r.contact_name || null, r.phone || null, r.email || null, r.tax_number || null, parseInt(r.payment_terms_days || '30', 10), (r.categories || '').split(';').map((x) => x.trim()).filter(Boolean)]); } },
  { entity: 'rooms', permission: 'rooms.create', columns: [{ name: 'number', required: true }, { name: 'room_type', required: true, note: 'room type code' }, { name: 'floor' }, { name: 'building' }, { name: 'features', note: 'semicolon separated' }],
    validate: async (r, ctx) => { const e = []; if (!r.number) e.push('number required'); if (!r.room_type) e.push('room_type required'); else if (!ctx.roomTypes.has(r.room_type.toUpperCase())) e.push(`unknown room type ${r.room_type}`); return e; },
    insert: async (c, r, ctx) => { await c.query(`INSERT INTO rooms (property_id, room_type_id, number, floor, building, features) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (property_id, number) DO UPDATE SET room_type_id=EXCLUDED.room_type_id, floor=EXCLUDED.floor, building=EXCLUDED.building`, [ctx.propertyId, ctx.roomTypes.get(r.room_type.toUpperCase()), r.number, r.floor || null, r.building || null, (r.features || '').split(';').map((x) => x.trim()).filter(Boolean)]); } },
  { entity: 'menu_items', permission: 'menus.manage', columns: [{ name: 'menu', required: true, note: 'menu name' }, { name: 'category', required: true }, { name: 'name', required: true }, { name: 'price', required: true }, { name: 'description' }, { name: 'tax', note: 'tax code e.g. VAT16' }],
    validate: async (r, ctx) => { const e = []; ['menu', 'category', 'name', 'price'].forEach((k) => { if (!r[k]) e.push(`${k} required`); }); if (r.menu && !ctx.menus.has(r.menu.toLowerCase())) e.push(`unknown menu ${r.menu}`); if (r.price && isNaN(Number(r.price))) e.push('price must be numeric'); return e; },
    insert: async (c, r, ctx) => { const menuId = ctx.menus.get(r.menu.toLowerCase()); const cat = (await c.query(`SELECT id FROM menu_categories WHERE menu_id=$1 AND lower(name)=lower($2)`, [menuId, r.category])).rows[0] ?? (await c.query(`INSERT INTO menu_categories (menu_id, name) VALUES ($1,$2) RETURNING id`, [menuId, r.category])).rows[0]; await c.query(`INSERT INTO menu_items (menu_id, category_id, name, price, description, tax_id) VALUES ($1,$2,$3,$4,$5,$6)`, [menuId, cat.id, r.name, Number(r.price), r.description || null, r.tax ? ctx.taxes.get(r.tax.toUpperCase()) ?? null : null]); } },
  { entity: 'opening_stock', permission: 'inventory.approve_adjustment', columns: [{ name: 'store', required: true, note: 'store code' }, { name: 'sku', required: true }, { name: 'quantity', required: true }, { name: 'unit_cost', required: true }],
    validate: async (r, ctx) => { const e = []; if (!ctx.stores.has((r.store || '').toUpperCase())) e.push(`unknown store ${r.store}`); if (!ctx.skus.has(r.sku)) e.push(`unknown sku ${r.sku}`); if (isNaN(Number(r.quantity)) || Number(r.quantity) <= 0) e.push('quantity must be > 0'); if (isNaN(Number(r.unit_cost))) e.push('unit_cost must be numeric'); return e; },
    insert: async (c, r, ctx) => { const { moveStock } = await import('../inventory/stock.service'); await moveStock(c, { propertyId: ctx.propertyId, storeId: ctx.stores.get(r.store.toUpperCase()), productId: ctx.skus.get(r.sku), type: 'OPENING', quantity: Number(r.quantity), unitCost: Number(r.unit_cost), referenceType: 'IMPORT', referenceNumber: ctx.jobRef, userId: ctx.userId, notes: 'Opening stock import' }); } },
];
async function importCtx(req: any) {
  const [units, skus, roomTypes, menus, taxes, stores] = await Promise.all([
    pool.query(`SELECT id, code FROM units`), pool.query(`SELECT id, sku FROM products`), pool.query(`SELECT id, code FROM room_types WHERE property_id=$1`, [req.propertyId]), pool.query(`SELECT id, name FROM menus WHERE property_id=$1`, [req.propertyId]), pool.query(`SELECT id, code FROM taxes WHERE property_id=$1 OR property_id IS NULL`, [req.propertyId]), pool.query(`SELECT id, code FROM stores WHERE property_id=$1`, [req.propertyId])]);
  return { propertyId: req.propertyId, userId: req.user.id, units: new Map(units.rows.map((r) => [r.code.toUpperCase(), r.id])), skus: new Map(skus.rows.map((r) => [r.sku, r.id])), roomTypes: new Map(roomTypes.rows.map((r) => [r.code.toUpperCase(), r.id])), menus: new Map(menus.rows.map((r) => [r.name.toLowerCase(), r.id])), taxes: new Map(taxes.rows.map((r) => [r.code.toUpperCase(), r.id])), stores: new Map(stores.rows.map((r) => [r.code.toUpperCase(), r.id])), jobRef: `IMP-${Date.now()}` };
}
export const importsRouter = Router();
importsRouter.get('/templates', requirePermission('imports.run'), asyncHandler(async (_req, res) => { res.json(IMPORTS.map((i) => ({ entity: i.entity, permission: i.permission, columns: i.columns }))); }));
importsRouter.get('/templates/:entity.csv', requirePermission('imports.run'), asyncHandler(async (req, res) => {
  const def = IMPORTS.find((i) => i.entity === req.params.entity); if (!def) throw new NotFound('Unknown import entity');
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename="${def.entity}-template.csv"`); res.send(def.columns.map((c) => c.name).join(',') + '\n');
}));
importsRouter.get('/', requirePermission('imports.run'), asyncHandler(async (req, res) => { res.json({ data: (await pool.query(`SELECT j.*, u.full_name AS user_name FROM import_jobs j LEFT JOIN users u ON u.id=j.user_id WHERE j.property_id=$1 OR j.property_id IS NULL ORDER BY j.created_at DESC LIMIT 100`, [req.propertyId])).rows }); }));
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
/** Upload a CSV: ?commit=false (default) validates only; ?commit=true imports valid rows atomically (all-or-nothing when strict=true). */
importsRouter.post('/:entity', requirePermission('imports.run'), csvUpload.single('file'), asyncHandler(async (req, res) => {
  const def = IMPORTS.find((i) => i.entity === req.params.entity); if (!def) throw new NotFound('Unknown import entity');
  if (!hasPermission(req, def.permission)) throw new Forbidden(`Missing permission: ${def.permission}`);
  const text = req.file ? req.file.buffer.toString('utf8') : typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!text.trim()) throw new BadRequest('Provide a CSV file (field "file") or a "csv" text body');
  const rows = parseCsv(text); if (!rows.length) throw new BadRequest('CSV has no data rows');
  const commit = String(req.query.commit ?? 'false') === 'true', strict = String(req.query.strict ?? 'false') === 'true';
  const ctx = await importCtx(req);
  const errors: { row: number; errors: string[] }[] = []; const valid: Record<string, string>[] = [];
  for (let i = 0; i < rows.length; i++) { const e = await def.validate(rows[i], ctx); if (e.length) errors.push({ row: i + 2, errors: e }); else valid.push(rows[i]); }
  let imported = 0; let status = 'VALIDATED';
  if (commit) {
    if (strict && errors.length) status = 'FAILED';
    else {
      await withTransaction(async (c) => { for (const r of valid) { await def.insert(c, r, ctx); imported++; } });
      status = 'IMPORTED';
    }
  }
  const job = (await pool.query(`INSERT INTO import_jobs (property_id, entity, file_name, total_rows, valid_rows, imported_rows, errors, status, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.propertyId ?? null, def.entity, req.file?.originalname ?? 'inline.csv', rows.length, valid.length, imported, JSON.stringify(errors.slice(0, 500)), status, req.user!.id])).rows[0];
  await audit({ ...auditCtx(req), action: commit ? 'IMPORT' : 'IMPORT_VALIDATE', entityType: 'import_job', entityId: job.id, newValue: { entity: def.entity, total: rows.length, valid: valid.length, imported, errors: errors.length } });
  res.status(commit ? 201 : 200).json({ job, preview: rows.slice(0, 10), errors, total_rows: rows.length, valid_rows: valid.length, imported_rows: imported });
}));

// =====================================================================================
// Backups — pg_dump to the backup folder, listing, verification, download
// =====================================================================================
export const backupsRouter = Router();
fs.mkdirSync(path.resolve(env.backupPath), { recursive: true });
backupsRouter.get('/', requirePermission('settings.backup'), asyncHandler(async (_req, res) => { res.json({ data: (await pool.query(`SELECT b.*, u.full_name AS created_by_name FROM backups b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.created_at DESC LIMIT 100`)).rows, path: path.resolve(env.backupPath) }); }));
backupsRouter.post('/', requirePermission('settings.backup'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ type: z.enum(['FULL', 'SCHEMA', 'DATA']).default('FULL') }), req.body ?? {});
  const fileName = `hms-${b.type.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz`;
  const target = path.resolve(env.backupPath, fileName);
  const args = ['--no-owner', '--no-privileges', '--compress=6', '-f', target];
  if (b.type === 'SCHEMA') args.push('--schema-only'); if (b.type === 'DATA') args.push('--data-only');
  args.push(env.databaseUrl);
  const row = (await pool.query(`INSERT INTO backups (file_name, type, status, created_by) VALUES ($1,$2,'RUNNING',$3) RETURNING *`, [fileName, b.type, req.user!.id])).rows[0];
  const result = await new Promise<{ code: number | null; err: string }>((resolve) => { let err = ''; const p = spawn('pg_dump', args, { env: { ...process.env, PATH: `${process.env.PATH}:/usr/lib/postgresql/17/bin:/usr/lib/postgresql/16/bin:/usr/lib/postgresql/15/bin` } }); p.stderr.on('data', (d) => { err += d.toString(); }); p.on('error', (e) => resolve({ code: -1, err: e.message })); p.on('close', (code) => resolve({ code, err })); });
  if (result.code !== 0) { await pool.query(`UPDATE backups SET status='FAILED' WHERE id=$1`, [row.id]); throw new BadRequest(`Backup failed: ${result.err.slice(0, 300) || 'pg_dump not available'}`, undefined, 'BACKUP_FAILED'); }
  const size = fs.statSync(target).size;
  // Verification: file exists, is non-trivial and has a valid gzip header
  const fd = fs.openSync(target, 'r'); const head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  const verified = size > 100 && head[0] === 0x1f && head[1] === 0x8b;
  const out = (await pool.query(`UPDATE backups SET status='COMPLETED', size_bytes=$2, verified=$3 WHERE id=$1 RETURNING *`, [row.id, size, verified])).rows[0];
  await audit({ ...auditCtx(req), action: 'BACKUP', entityType: 'backup', entityId: row.id, newValue: { fileName, size, verified } });
  res.status(201).json(out);
}));
backupsRouter.get('/:id/download', requirePermission('settings.backup'), asyncHandler(async (req, res) => {
  const b = (await pool.query(`SELECT * FROM backups WHERE id=$1`, [req.params.id])).rows[0];
  if (!b) throw new NotFound('Backup not found');
  const file = path.resolve(env.backupPath, b.file_name);
  if (!file.startsWith(path.resolve(env.backupPath)) || !fs.existsSync(file)) throw new NotFound('Backup file missing');
  await audit({ ...auditCtx(req), action: 'BACKUP_DOWNLOAD', entityType: 'backup', entityId: b.id });
  res.setHeader('Content-Type', 'application/gzip'); res.setHeader('Content-Disposition', `attachment; filename="${b.file_name}"`);
  fs.createReadStream(file).pipe(res);
}));
backupsRouter.delete('/:id', requirePermission('settings.backup'), asyncHandler(async (req, res) => {
  const b = (await pool.query(`DELETE FROM backups WHERE id=$1 RETURNING *`, [req.params.id])).rows[0];
  if (!b) throw new NotFound('Backup not found');
  fs.promises.unlink(path.resolve(env.backupPath, b.file_name)).catch(() => undefined);
  await audit({ ...auditCtx(req), action: 'BACKUP_DELETE', entityType: 'backup', entityId: b.id, oldValue: { file_name: b.file_name } });
  res.json({ ok: true });
}));

/** System health & info for the admin screen. */
export const systemRouter = Router();
systemRouter.get('/info', requirePermission('settings.view', 'settings.backup'), asyncHandler(async (_req, res) => {
  const db = (await pool.query(`SELECT version() AS version, pg_database_size(current_database()) AS size, (SELECT COUNT(*) FROM schema_migrations)::int AS migrations, (SELECT name FROM schema_migrations ORDER BY applied_at DESC LIMIT 1) AS latest_migration`)).rows[0];
  const counts = (await pool.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM reservations)::int AS reservations, (SELECT COUNT(*) FROM orders)::int AS orders, (SELECT COUNT(*) FROM journal_entries)::int AS journals, (SELECT COUNT(*) FROM stock_movements)::int AS stock_movements, (SELECT COUNT(*) FROM audit_logs)::int AS audit_logs`)).rows[0];
  res.json({ app: { name: 'HMS', version: process.env.npm_package_version ?? '1.0.0', node: process.version, env: env.nodeEnv, uptime_seconds: Math.round(process.uptime()) }, database: db, counts, storage: { uploads: path.resolve(env.storagePath), backups: path.resolve(env.backupPath) } });
}));
