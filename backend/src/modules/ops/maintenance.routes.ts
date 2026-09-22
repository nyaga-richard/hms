import { Router, Request } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { nextNumber } from '../../core/numbering';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { startApproval, registerWorkflowHandler } from '../workflow/workflow.service';
import { moveStock } from '../inventory/stock.service';
import { postJournal, currentBusinessDate } from '../finance/accounting.service';

/**
 * Maintenance: request lifecycle REPORTED → (APPROVED) → ASSIGNED → IN_PROGRESS → COMPLETED → VERIFIED.
 * Integrations: room blocking (OUT_OF_ORDER + room_blocks), spare parts issued from engineering store (stock ledger + expense journal),
 * asset status, configurable approval workflow (MAINTENANCE_REQUEST) above a cost threshold, notifications.
 */
export const maintenanceRouter = Router();

const CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'HVAC', 'CARPENTRY', 'PAINTING', 'IT', 'APPLIANCE', 'GENERAL', 'PREVENTIVE', 'SAFETY', 'POOL', 'GROUNDS', 'VEHICLE'];

export async function createMaintenanceRequest(c: PoolClient, req: Request, b: { title: string; description?: string | null; category?: string; priority?: string; location_type: string; room_id?: string | null; asset_id?: string | null; location?: string | null; blocks_room?: boolean; estimated_cost?: number }) {
  const number = await nextNumber(c, 'MAINTENANCE', req.propertyId);
  const r = (await c.query(`INSERT INTO maintenance_requests (property_id, number, title, description, category, priority, location_type, room_id, asset_id, location, status, reported_by, blocks_room) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REPORTED',$11,$12) RETURNING *`,
    [req.propertyId, number, b.title, b.description ?? null, b.category ?? 'GENERAL', b.priority ?? 'MEDIUM', b.location_type, b.room_id ?? null, b.asset_id ?? null, b.location ?? null, req.user!.id, !!b.blocks_room])).rows[0];
  await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'REPORTED',$2,$3)`, [r.id, b.description ?? null, req.user!.id]);
  if (b.room_id) {
    await c.query(`UPDATE rooms SET maintenance_status='ISSUE_REPORTED', updated_at=now() WHERE id=$1`, [b.room_id]);
    if (b.blocks_room) await blockRoomForMaintenance(c, r, req.user!.id);
  }
  if (b.asset_id) await c.query(`UPDATE assets SET status='UNDER_MAINTENANCE', updated_at=now() WHERE id=$1 AND status IN ('IN_USE','IN_STORE')`, [b.asset_id]);
  // Approval only kicks in when a workflow is configured for the estimated cost band
  const approval = await startApproval(c, { transactionType: 'MAINTENANCE_REQUEST', entityType: 'maintenance_request', entityId: r.id, entityNumber: number, amount: b.estimated_cost ?? 0, propertyId: req.propertyId!, user: req.user!, title: `Maintenance ${number}: ${b.title}`, link: `/maintenance/${r.id}` });
  if (approval.status === 'APPROVED') await c.query(`UPDATE maintenance_requests SET status='APPROVED', approved_by=$2, updated_at=now() WHERE id=$1`, [r.id, req.user!.id]);
  await notify({ permission: 'maintenance.assign', propertyId: req.propertyId, type: 'MAINTENANCE_REPORTED', title: `${b.priority ?? 'MEDIUM'} maintenance: ${b.title}`, body: `${number} — ${b.location_type}${b.room_id ? ' (room)' : ''}`, entityType: 'maintenance_request', entityId: r.id, link: `/maintenance/${r.id}`, severity: b.priority === 'URGENT' ? 'CRITICAL' : 'INFO' }, c);
  await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'maintenance_request', entityId: r.id, newValue: r }, c);
  return (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1`, [r.id])).rows[0];
}

async function blockRoomForMaintenance(c: PoolClient, r: any, userId: string) {
  const occupied = (await c.query(`SELECT 1 FROM stays WHERE room_id=$1 AND status='IN_HOUSE'`, [r.room_id])).rows[0];
  if (occupied) throw new BadRequest('Room is occupied; move the guest before putting it out of order', undefined, 'ROOM_OCCUPIED');
  await c.query(`UPDATE rooms SET status='OUT_OF_ORDER', housekeeping_status='OUT_OF_ORDER', maintenance_status='UNDER_MAINTENANCE', updated_at=now() WHERE id=$1`, [r.room_id]);
  await c.query(`INSERT INTO room_blocks (room_id, block_type, start_date, end_date, reason, maintenance_request_id, created_by) VALUES ($1,'OUT_OF_ORDER',CURRENT_DATE,CURRENT_DATE + 30,$2,$3,$4)`, [r.room_id, `Maintenance ${r.number}: ${r.title}`, r.id, userId]);
  await c.query(`UPDATE maintenance_requests SET blocks_room=true, downtime_start=COALESCE(downtime_start, now()) WHERE id=$1`, [r.id]);
}

async function releaseRoomBlock(c: PoolClient, r: any) {
  if (!r.room_id) return;
  await c.query(`UPDATE room_blocks SET released_at=now(), end_date=LEAST(end_date, CURRENT_DATE) WHERE maintenance_request_id=$1 AND released_at IS NULL`, [r.id]);
  const stillBlocked = (await c.query(`SELECT 1 FROM room_blocks WHERE room_id=$1 AND released_at IS NULL AND end_date >= CURRENT_DATE`, [r.room_id])).rows[0];
  const otherOpen = (await c.query(`SELECT 1 FROM maintenance_requests WHERE room_id=$1 AND id<>$2 AND status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED')`, [r.room_id, r.id])).rows[0];
  await c.query(`UPDATE rooms SET status = CASE WHEN $2::boolean THEN status ELSE 'AVAILABLE' END, housekeeping_status = CASE WHEN housekeeping_status='OUT_OF_ORDER' THEN 'DIRTY' ELSE housekeeping_status END, maintenance_status=$3, updated_at=now() WHERE id=$1 AND status IN ('OUT_OF_ORDER','OUT_OF_SERVICE','AVAILABLE')`, [r.room_id, !!stillBlocked, otherOpen ? 'ISSUE_REPORTED' : 'OK']);
  if (r.blocks_room) {
    await c.query(`UPDATE maintenance_requests SET downtime_end=COALESCE(downtime_end, now()) WHERE id=$1`, [r.id]);
    // room needs cleaning after works
    await c.query(`INSERT INTO housekeeping_tasks (property_id, room_id, task_type, priority, business_date, notes, created_by) SELECT $1,$2,'DEEP_CLEAN',7,CURRENT_DATE,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM housekeeping_tasks WHERE room_id=$2 AND task_type='DEEP_CLEAN' AND status IN ('PENDING','IN_PROGRESS'))`, [r.property_id, r.room_id, `Post-maintenance clean (${r.number})`, r.verified_by ?? r.assigned_to]);
  }
}

registerWorkflowHandler('MAINTENANCE_REQUEST', {
  onApproved: async (c, id, _req, user) => { await c.query(`UPDATE maintenance_requests SET status='APPROVED', approved_by=$2, updated_at=now() WHERE id=$1 AND status='REPORTED'`, [id, user.id]); await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'APPROVED','Approved via workflow',$2)`, [id, user.id]); },
  onRejected: async (c, id, _req, user, comment) => { await c.query(`UPDATE maintenance_requests SET status='REJECTED', updated_at=now() WHERE id=$1`, [id]); await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'REJECTED',$2,$3)`, [id, comment ?? null, user.id]); },
});

const listSelect = `SELECT m.*, r.number AS room_number, a.name AS asset_name, a.asset_number, rb.full_name AS reported_by_name, asg.full_name AS assigned_to_name, ap.full_name AS approved_by_name,
    EXTRACT(EPOCH FROM (COALESCE(m.completed_at, now()) - m.created_at))/3600 AS hours_open
  FROM maintenance_requests m LEFT JOIN rooms r ON r.id=m.room_id LEFT JOIN assets a ON a.id=m.asset_id LEFT JOIN users rb ON rb.id=m.reported_by LEFT JOIN users asg ON asg.id=m.assigned_to LEFT JOIN users ap ON ap.id=m.approved_by`;

maintenanceRouter.get('/', requirePermission('maintenance.view'), asyncHandler(async (req, res) => {
  const where = ['m.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.mine === 'true') { params.push(req.user!.id); where.push(`(m.assigned_to=$${params.length} OR m.reported_by=$${params.length})`); }
  if (req.query.open === 'true') where.push(`m.status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED')`);
  await runList(req, res, { select: listSelect, where, params, searchColumns: ['m.number', 'm.title', 'm.description', 'r.number', 'a.name', 'm.location'], defaultSort: 'm.created_at',
    filters: { status: 'm.status', priority: 'm.priority', category: 'm.category', room_id: 'm.room_id', asset_id: 'm.asset_id', assigned_to: 'm.assigned_to', location_type: 'm.location_type' }, dateFilters: { date: 'm.created_at::date' }, exportName: 'maintenance_requests' });
}));

maintenanceRouter.get('/summary', requirePermission('maintenance.view'), asyncHandler(async (req, res) => {
  const r = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED'))::int AS open, COUNT(*) FILTER (WHERE priority='URGENT' AND status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED'))::int AS urgent,
      COUNT(*) FILTER (WHERE status='COMPLETED')::int AS awaiting_verification, COUNT(*) FILTER (WHERE status='REPORTED')::int AS unassigned, COUNT(*) FILTER (WHERE blocks_room AND status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED'))::int AS rooms_out_of_order,
      COALESCE(SUM(total_cost) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)),0) AS cost_this_month, ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/3600) FILTER (WHERE completed_at IS NOT NULL AND created_at >= CURRENT_DATE - 90)::numeric, 1) AS avg_hours_to_complete
      FROM maintenance_requests WHERE property_id=$1`, [req.propertyId])).rows[0];
  const byCategory = (await pool.query(`SELECT category, COUNT(*)::int AS count, COALESCE(SUM(total_cost),0) AS cost FROM maintenance_requests WHERE property_id=$1 AND created_at >= CURRENT_DATE - 90 GROUP BY category ORDER BY count DESC`, [req.propertyId])).rows;
  res.json({ ...r, by_category: byCategory });
}));

maintenanceRouter.post('/', requirePermission('maintenance.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ title: z.string().min(3), description: optionalStr, category: z.string().default('GENERAL'), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'), location_type: z.enum(['ROOM', 'ASSET', 'AREA', 'OUTLET', 'VEHICLE', 'OTHER']).default('AREA'), room_id: z.string().uuid().nullable().optional(), asset_id: z.string().uuid().nullable().optional(), location: optionalStr, blocks_room: z.boolean().default(false), estimated_cost: z.coerce.number().min(0).default(0) }), req.body);
  if (b.blocks_room && !hasPermission(req, 'rooms.block')) throw new Forbidden('rooms.block permission required to put a room out of order');
  if (b.location_type === 'ROOM' && !b.room_id) throw new BadRequest('room_id is required for room issues');
  res.status(201).json(await withTransaction((c) => createMaintenanceRequest(c, req, b)));
}));

maintenanceRouter.get('/categories', requirePermission('maintenance.view'), (_req, res) => res.json(CATEGORIES));

maintenanceRouter.get('/:id', requirePermission('maintenance.view'), asyncHandler(async (req, res) => {
  const m = (await pool.query(`${listSelect} WHERE m.id=$1`, [req.params.id])).rows[0];
  if (!m) throw new NotFound('Maintenance request not found');
  m.history = (await pool.query(`SELECT h.*, u.full_name AS user_name FROM maintenance_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.request_id=$1 ORDER BY h.created_at`, [m.id])).rows;
  m.parts = (await pool.query(`SELECT p.*, pr.name AS product_name, pr.sku, u.code AS unit FROM maintenance_parts p LEFT JOIN products pr ON pr.id=p.product_id LEFT JOIN units u ON u.id=pr.unit_id WHERE p.request_id=$1 ORDER BY p.created_at`, [m.id])).rows;
  m.approval = (await pool.query(`SELECT ar.*, (SELECT json_agg(json_build_object('step', a.step_order, 'name', a.step_name, 'action', a.action, 'actor', u.full_name, 'comment', a.comment, 'at', a.created_at) ORDER BY a.created_at) FROM approval_actions a LEFT JOIN users u ON u.id=a.user_id WHERE a.request_id=ar.id) AS actions FROM approval_requests ar WHERE ar.entity_type='maintenance_request' AND ar.entity_id=$1 ORDER BY ar.requested_at DESC LIMIT 1`, [m.id])).rows[0] ?? null;
  m.attachments = (await pool.query(`SELECT id, file_name, mime_type, size_bytes, created_at FROM attachments WHERE entity_type='maintenance_request' AND entity_id=$1 ORDER BY created_at`, [m.id])).rows;
  res.json(m);
}));

async function transition(req: Request, id: string, allowedFrom: string[], to: string, extraSql: string, extraParams: any[], notes?: string | null) {
  return withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new NotFound('Maintenance request not found');
    if (!allowedFrom.includes(old.status)) throw Errors.invalidStatus('maintenance request', old.status, to.toLowerCase());
    const params = [id, to, ...extraParams];
    const r = (await c.query(`UPDATE maintenance_requests SET status=$2, updated_at=now() ${extraSql} WHERE id=$1 RETURNING *`, params)).rows[0];
    await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,$2,$3,$4)`, [id, to, notes ?? null, req.user!.id]);
    await audit({ ...auditCtx(req), action: to, entityType: 'maintenance_request', entityId: id, oldValue: { status: old.status }, newValue: { status: to }, reason: notes }, c);
    return { old, r, c };
  });
}

maintenanceRouter.post('/:id/approve', requirePermission('maintenance.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ notes: optionalStr }), req.body);
  const { r } = await transition(req, req.params.id, ['REPORTED'], 'APPROVED', ', approved_by=$3', [req.user!.id], b.notes);
  res.json(r);
}));
maintenanceRouter.post('/:id/reject', requirePermission('maintenance.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Maintenance request not found');
    if (!['REPORTED', 'APPROVED'].includes(old.status)) throw Errors.invalidStatus('maintenance request', old.status, 'reject');
    const r = (await c.query(`UPDATE maintenance_requests SET status='REJECTED', resolution=$2, updated_at=now() WHERE id=$1 RETURNING *`, [old.id, b.reason])).rows[0];
    await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'REJECTED',$2,$3)`, [old.id, b.reason, req.user!.id]);
    await releaseRoomBlock(c, r);
    if (old.asset_id) await c.query(`UPDATE assets SET status='IN_USE', updated_at=now() WHERE id=$1 AND status='UNDER_MAINTENANCE'`, [old.asset_id]);
    if (old.reported_by) await notify({ userIds: [old.reported_by], type: 'MAINTENANCE_REJECTED', title: `Maintenance ${old.number} rejected`, body: b.reason, entityType: 'maintenance_request', entityId: old.id, link: `/maintenance/${old.id}` }, c);
    return r;
  });
  res.json(out);
}));
maintenanceRouter.post('/:id/assign', requirePermission('maintenance.assign'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ assigned_to: z.string().uuid().nullable().optional(), contractor_name: optionalStr, contractor_cost: z.coerce.number().min(0).optional(), notes: optionalStr, blocks_room: z.boolean().optional() }), req.body);
  if (!b.assigned_to && !b.contractor_name) throw new BadRequest('Assign to a technician or a contractor');
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Maintenance request not found');
    if (!['REPORTED', 'APPROVED', 'ASSIGNED', 'ON_HOLD'].includes(old.status)) throw Errors.invalidStatus('maintenance request', old.status, 'assign');
    const r = (await c.query(`UPDATE maintenance_requests SET status='ASSIGNED', assigned_to=$2, contractor_name=COALESCE($3, contractor_name), contractor_cost=COALESCE($4, contractor_cost), approved_by=COALESCE(approved_by,$5), updated_at=now() WHERE id=$1 RETURNING *`, [old.id, b.assigned_to ?? null, b.contractor_name ?? null, b.contractor_cost ?? null, req.user!.id])).rows[0];
    await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'ASSIGNED',$2,$3)`, [old.id, b.notes ?? (b.contractor_name ? `Contractor: ${b.contractor_name}` : null), req.user!.id]);
    if (b.blocks_room && old.room_id && !old.blocks_room) { if (!hasPermission(req, 'rooms.block')) throw new Forbidden('rooms.block permission required'); await blockRoomForMaintenance(c, r, req.user!.id); }
    if (b.assigned_to) await notify({ userIds: [b.assigned_to], type: 'MAINTENANCE_ASSIGNED', title: `Work order ${old.number} assigned to you`, body: old.title, entityType: 'maintenance_request', entityId: old.id, link: `/maintenance/${old.id}`, severity: old.priority === 'URGENT' ? 'CRITICAL' : 'INFO' }, c);
    await audit({ ...auditCtx(req), action: 'ASSIGN', entityType: 'maintenance_request', entityId: old.id, newValue: b }, c);
    return r;
  });
  res.json(out);
}));
maintenanceRouter.post('/:id/start', requirePermission('maintenance.work'), asyncHandler(async (req, res) => {
  const { r } = await transition(req, req.params.id, ['ASSIGNED', 'ON_HOLD', 'APPROVED'], 'IN_PROGRESS', ', started_at=COALESCE(started_at, now()), assigned_to=COALESCE(assigned_to,$3)', [req.user!.id], req.body?.notes);
  res.json(r);
}));
maintenanceRouter.post('/:id/hold', requirePermission('maintenance.work'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const { r } = await transition(req, req.params.id, ['IN_PROGRESS', 'ASSIGNED'], 'ON_HOLD', '', [], b.reason);
  res.json(r);
}));
// Issue spare parts from a store to the work order → stock ledger OUT + expense journal (DR Repairs, CR Inventory)
maintenanceRouter.post('/:id/parts', requirePermission('maintenance.work', 'inventory.issue'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ store_id: z.string().uuid(), items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.coerce.number().positive(), description: optionalStr })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const m = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!m) throw new NotFound('Maintenance request not found');
    if (!['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'APPROVED'].includes(m.status)) throw Errors.invalidStatus('maintenance request', m.status, 'issue parts');
    const bd = await currentBusinessDate(c, m.property_id, req.user!.id);
    let total = 0; const parts = [];
    for (const it of b.items) {
      const { movement, unitCost } = await moveStock(c, { propertyId: m.property_id, storeId: b.store_id, productId: it.product_id, type: 'ISSUE_TO_DEPARTMENT', quantity: -it.quantity, referenceType: 'MAINTENANCE', referenceId: m.id, referenceNumber: m.number, businessDate: bd, userId: req.user!.id, notes: `Parts for ${m.number}` });
      const p = (await c.query(`INSERT INTO maintenance_parts (request_id, product_id, description, quantity, unit_cost, stock_movement_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [m.id, it.product_id, it.description ?? null, it.quantity, unitCost, movement?.id ?? null])).rows[0];
      parts.push(p); total += it.quantity * unitCost;
    }
    total = Math.round(total * 100) / 100;
    if (total > 0) {
      const invKey = (await c.query(`SELECT pc.inventory_account_id FROM products p JOIN product_categories pc ON pc.id=p.category_id WHERE p.id=$1`, [b.items[0].product_id])).rows[0]?.inventory_account_id;
      await postJournal(c, { propertyId: m.property_id, businessDate: bd, description: `Maintenance parts ${m.number}`, sourceType: 'MAINTENANCE', sourceId: m.id, userId: req.user!.id, lines: [{ mappingKey: 'REPAIRS', debit: total, description: m.title }, invKey ? { accountId: invKey, credit: total } : { mappingKey: 'INVENTORY', credit: total }] });
    }
    await c.query(`UPDATE maintenance_requests SET parts_cost = parts_cost + $2, updated_at=now() WHERE id=$1`, [m.id, total]);
    await audit({ ...auditCtx(req), action: 'ISSUE_PARTS', entityType: 'maintenance_request', entityId: m.id, newValue: { store_id: b.store_id, items: b.items, total } }, c);
    return { parts, total };
  });
  res.status(201).json(out);
}));
maintenanceRouter.post('/:id/complete', requirePermission('maintenance.work'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ resolution: z.string().min(2), labour_hours: z.coerce.number().min(0).optional(), labour_cost: z.coerce.number().min(0).optional(), contractor_cost: z.coerce.number().min(0).optional(), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Maintenance request not found');
    if (!['IN_PROGRESS', 'ASSIGNED', 'ON_HOLD'].includes(old.status)) throw Errors.invalidStatus('maintenance request', old.status, 'complete');
    const r = (await c.query(`UPDATE maintenance_requests SET status='COMPLETED', completed_at=now(), resolution=$2, labour_hours=COALESCE($3, labour_hours), labour_cost=COALESCE($4, labour_cost), contractor_cost=COALESCE($5, contractor_cost), updated_at=now() WHERE id=$1 RETURNING *`, [old.id, b.resolution, b.labour_hours ?? null, b.labour_cost ?? null, b.contractor_cost ?? null])).rows[0];
    await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'COMPLETED',$2,$3)`, [old.id, b.resolution, req.user!.id]);
    await notify({ permission: 'maintenance.verify', propertyId: old.property_id, type: 'MAINTENANCE_COMPLETED', title: `${old.number} completed — verify`, body: b.resolution, entityType: 'maintenance_request', entityId: old.id, link: `/maintenance/${old.id}` }, c);
    await audit({ ...auditCtx(req), action: 'COMPLETE', entityType: 'maintenance_request', entityId: old.id, newValue: b }, c);
    return r;
  });
  res.json(out);
}));
maintenanceRouter.post('/:id/verify', requirePermission('maintenance.verify'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ passed: z.boolean().default(true), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Maintenance request not found');
    if (old.status !== 'COMPLETED') throw Errors.invalidStatus('maintenance request', old.status, 'verify');
    if (!b.passed) {
      const r = (await c.query(`UPDATE maintenance_requests SET status='IN_PROGRESS', completed_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [old.id])).rows[0];
      await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'IN_PROGRESS',$2,$3)`, [old.id, `Verification failed: ${b.notes ?? ''}`, req.user!.id]);
      if (old.assigned_to) await notify({ userIds: [old.assigned_to], type: 'MAINTENANCE_REOPENED', title: `${old.number} failed verification`, body: b.notes ?? undefined, entityType: 'maintenance_request', entityId: old.id, link: `/maintenance/${old.id}`, severity: 'WARNING' }, c);
      return r;
    }
    const r = (await c.query(`UPDATE maintenance_requests SET status='VERIFIED', verified_at=now(), verified_by=$2, updated_at=now() WHERE id=$1 RETURNING *`, [old.id, req.user!.id])).rows[0];
    await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'VERIFIED',$2,$3)`, [old.id, b.notes ?? null, req.user!.id]);
    await releaseRoomBlock(c, r);
    if (old.asset_id) await c.query(`UPDATE assets SET status='IN_USE', updated_at=now() WHERE id=$1 AND status='UNDER_MAINTENANCE'`, [old.asset_id]);
    if (old.reported_by) await notify({ userIds: [old.reported_by], type: 'MAINTENANCE_VERIFIED', title: `${old.number} resolved`, body: old.resolution ?? undefined, entityType: 'maintenance_request', entityId: old.id, link: `/maintenance/${old.id}`, severity: 'SUCCESS' }, c);
    await audit({ ...auditCtx(req), action: 'VERIFY', entityType: 'maintenance_request', entityId: old.id }, c);
    return r;
  });
  res.json(out);
}));
maintenanceRouter.post('/:id/cancel', requirePermission('maintenance.assign', 'maintenance.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM maintenance_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Maintenance request not found');
    if (!['REPORTED', 'APPROVED', 'ASSIGNED', 'ON_HOLD'].includes(old.status)) throw Errors.invalidStatus('maintenance request', old.status, 'cancel');
    if (old.reported_by !== req.user!.id && !hasPermission(req, 'maintenance.assign')) throw new Forbidden('Only the reporter or a maintenance manager can cancel');
    const r = (await c.query(`UPDATE maintenance_requests SET status='CANCELLED', resolution=$2, updated_at=now() WHERE id=$1 RETURNING *`, [old.id, b.reason])).rows[0];
    await c.query(`INSERT INTO maintenance_history (request_id, status, notes, user_id) VALUES ($1,'CANCELLED',$2,$3)`, [old.id, b.reason, req.user!.id]);
    await releaseRoomBlock(c, r);
    if (old.asset_id) await c.query(`UPDATE assets SET status='IN_USE', updated_at=now() WHERE id=$1 AND status='UNDER_MAINTENANCE'`, [old.asset_id]);
    return r;
  });
  res.json(out);
}));

// ---------------- Assets ----------------
