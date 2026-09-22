import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { postCharge } from '../pms/folio.service';
import { currentBusinessDate } from '../finance/accounting.service';

/**
 * Housekeeping: room status board, task lifecycle (PENDING → IN_PROGRESS → DONE → INSPECTED/FAILED_INSPECTION),
 * automatic room housekeeping_status updates, minibar/room-item checks with folio charging.
 */
export const housekeepingRouter = Router();

const TASK_TYPES = ['CHECKOUT_CLEAN', 'STAYOVER', 'TURNDOWN', 'DEEP_CLEAN', 'INSPECTION', 'TOUCH_UP', 'LINEN_CHANGE', 'MINIBAR_CHECK'] as const;

// ---- Room status board: every room with HK status, occupancy, arrivals/departures, open task
housekeepingRouter.get('/rooms', requirePermission('housekeeping.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(
    `SELECT r.id, r.number, r.floor, r.building, r.status, r.housekeeping_status, r.maintenance_status, rt.name AS room_type,
        s.id AS stay_id, g.first_name || ' ' || g.last_name AS guest_name, s.expected_check_out, s.adults, s.children, g.vip_level,
        (s.expected_check_out = CURRENT_DATE) AS due_out,
        EXISTS (SELECT 1 FROM reservations x WHERE x.room_id=r.id AND x.arrival_date=CURRENT_DATE AND x.status IN ('CONFIRMED','DEPOSIT_PAID')) AS arrival_today,
        (SELECT json_build_object('id', t.id, 'task_type', t.task_type, 'status', t.status, 'assigned_to', t.assigned_to, 'assignee', u.full_name, 'priority', t.priority, 'started_at', t.started_at)
           FROM housekeeping_tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.room_id=r.id AND t.status IN ('PENDING','IN_PROGRESS','DONE','FAILED_INSPECTION') ORDER BY t.priority DESC, t.created_at LIMIT 1) AS task,
        (SELECT COUNT(*) FROM maintenance_requests m WHERE m.room_id=r.id AND m.status NOT IN ('COMPLETED','VERIFIED','REJECTED','CANCELLED'))::int AS open_maintenance
       FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id
       LEFT JOIN stays s ON s.room_id=r.id AND s.status='IN_HOUSE' LEFT JOIN guests g ON g.id=s.guest_id
      WHERE r.property_id=$1 AND r.is_active ORDER BY r.floor, r.number`, [req.propertyId])).rows;
  const summary = { total: rows.length, dirty: rows.filter((r) => r.housekeeping_status === 'DIRTY').length, cleaning: rows.filter((r) => r.housekeeping_status === 'CLEANING').length, clean: rows.filter((r) => r.housekeeping_status === 'CLEAN').length, inspected: rows.filter((r) => r.housekeeping_status === 'INSPECTED').length, out_of_order: rows.filter((r) => r.housekeeping_status === 'OUT_OF_ORDER' || r.status === 'OUT_OF_ORDER').length, occupied: rows.filter((r) => r.status === 'OCCUPIED').length, due_out: rows.filter((r) => r.due_out).length, arrivals: rows.filter((r) => r.arrival_today).length };
  res.json({ summary, rooms: rows });
}));

// ---- Update room housekeeping status directly (mobile quick action)
housekeepingRouter.post('/rooms/:roomId/status', requirePermission('housekeeping.update'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ housekeeping_status: z.enum(['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER']), notes: optionalStr }), req.body);
  if (b.housekeeping_status === 'INSPECTED' && !hasPermission(req, 'housekeeping.inspect')) throw new Forbidden('Inspection permission required');
  const room = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM rooms WHERE id=$1 FOR UPDATE`, [req.params.roomId])).rows[0];
    if (!old) throw new NotFound('Room not found');
    const r = (await c.query(`UPDATE rooms SET housekeeping_status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [old.id, b.housekeeping_status])).rows[0];
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'room', entityId: r.id, oldValue: { housekeeping_status: old.housekeeping_status }, newValue: { housekeeping_status: r.housekeeping_status }, reason: b.notes }, c);
    return r;
  });
  res.json(room);
}));

// ---- Tasks
housekeepingRouter.get('/tasks', requirePermission('housekeeping.view'), asyncHandler(async (req, res) => {
  const where = ['t.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.mine === 'true') { params.push(req.user!.id); where.push(`t.assigned_to=$${params.length}`); }
  if (req.query.open === 'true') where.push(`t.status IN ('PENDING','IN_PROGRESS','DONE','FAILED_INSPECTION')`);
  await runList(req, res, {
    select: `SELECT t.*, r.number AS room_number, r.floor, r.housekeeping_status, rt.name AS room_type, u.full_name AS assignee, cb.full_name AS created_by_name, g.first_name || ' ' || g.last_name AS guest_name
      FROM housekeeping_tasks t JOIN rooms r ON r.id=t.room_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN users cb ON cb.id=t.created_by LEFT JOIN stays s ON s.id=t.stay_id LEFT JOIN guests g ON g.id=s.guest_id`,
    where, params, searchColumns: ['r.number', 't.notes'], defaultSort: 't.created_at',
    filters: { status: 't.status', task_type: 't.task_type', assigned_to: 't.assigned_to', room_id: 't.room_id', business_date: 't.business_date' }, dateFilters: { date: 't.business_date' }, exportName: 'housekeeping_tasks',
  });
}));

housekeepingRouter.post('/tasks', requirePermission('housekeeping.assign', 'housekeeping.update'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ room_id: z.string().uuid(), task_type: z.enum(TASK_TYPES), priority: z.coerce.number().int().min(0).max(10).default(5), assigned_to: z.string().uuid().nullable().optional(), business_date: dateStr.optional(), notes: optionalStr, checklist: z.array(z.object({ item: z.string(), done: z.boolean().default(false) })).optional() }), req.body);
  const task = await withTransaction(async (c) => {
    const room = (await c.query(`SELECT * FROM rooms WHERE id=$1 AND property_id=$2`, [b.room_id, req.propertyId])).rows[0];
    if (!room) throw new NotFound('Room not found');
    const stay = (await c.query(`SELECT id FROM stays WHERE room_id=$1 AND status='IN_HOUSE'`, [room.id])).rows[0];
    const bd = b.business_date ?? (await currentBusinessDate(c, req.propertyId!, req.user!.id));
    const t = (await c.query(`INSERT INTO housekeeping_tasks (property_id, room_id, stay_id, task_type, priority, assigned_to, business_date, notes, checklist, created_by, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING') RETURNING *`,
      [req.propertyId, room.id, stay?.id ?? null, b.task_type, b.priority, b.assigned_to ?? null, bd, b.notes ?? null, JSON.stringify(b.checklist ?? defaultChecklist(b.task_type)), req.user!.id])).rows[0];
    if (b.assigned_to) await notify({ userIds: [b.assigned_to], type: 'HK_TASK', title: `New housekeeping task: Room ${room.number}`, body: `${b.task_type.replace('_', ' ')}${b.notes ? ' — ' + b.notes : ''}`, entityType: 'housekeeping_task', entityId: t.id, link: `/housekeeping/tasks/${t.id}` }, c);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'housekeeping_task', entityId: t.id, newValue: t }, c);
    return t;
  });
  res.status(201).json(task);
}));

// Bulk assignment (morning allocation)
housekeepingRouter.post('/tasks/assign', requirePermission('housekeeping.assign'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ task_ids: z.array(z.string().uuid()).min(1), assigned_to: z.string().uuid() }), req.body);
  const n = await withTransaction(async (c) => {
    const r = await c.query(`UPDATE housekeeping_tasks SET assigned_to=$2 WHERE id = ANY($1) AND property_id=$3 AND status IN ('PENDING','IN_PROGRESS','FAILED_INSPECTION') RETURNING id, room_id`, [b.task_ids, b.assigned_to, req.propertyId]);
    if (r.rowCount) await notify({ userIds: [b.assigned_to], type: 'HK_TASK', title: `${r.rowCount} housekeeping task(s) assigned to you`, link: '/housekeeping/my-tasks' }, c);
    await audit({ ...auditCtx(req), action: 'ASSIGN', entityType: 'housekeeping_task', newValue: { task_ids: b.task_ids, assigned_to: b.assigned_to } }, c);
    return r.rowCount;
  });
  res.json({ assigned: n });
}));

// Auto-generate the day's stayover/turndown tasks for occupied rooms
housekeepingRouter.post('/tasks/generate', requirePermission('housekeeping.assign'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ task_type: z.enum(['STAYOVER', 'TURNDOWN', 'LINEN_CHANGE']).default('STAYOVER') }), req.body);
  const n = await withTransaction(async (c) => {
    const bd = await currentBusinessDate(c, req.propertyId!, req.user!.id);
    const r = await c.query(
      `INSERT INTO housekeeping_tasks (property_id, room_id, stay_id, task_type, priority, business_date, checklist, created_by)
         SELECT s.property_id, s.room_id, s.id, $2, 3, $3, $4, $5 FROM stays s
          WHERE s.property_id=$1 AND s.status='IN_HOUSE'
            AND NOT EXISTS (SELECT 1 FROM housekeeping_tasks t WHERE t.room_id=s.room_id AND t.task_type=$2 AND t.business_date=$3 AND t.status<>'CANCELLED')
         RETURNING id`, [req.propertyId, b.task_type, bd, JSON.stringify(defaultChecklist(b.task_type)), req.user!.id]);
    return r.rowCount;
  });
  res.json({ created: n });
}));

housekeepingRouter.get('/tasks/:id', requirePermission('housekeeping.view'), asyncHandler(async (req, res) => {
  const t = (await pool.query(`SELECT t.*, r.number AS room_number, r.housekeeping_status, u.full_name AS assignee, (SELECT json_agg(i ORDER BY i.created_at DESC) FROM housekeeping_inspections i WHERE i.task_id=t.id) AS inspections,
      (SELECT json_agg(json_build_object('id', ri.id, 'name', it.name, 'category', it.category, 'quantity', ri.quantity, 'standard_quantity', it.standard_quantity, 'condition', ri.condition, 'is_consumable', it.is_consumable, 'replacement_value', it.replacement_value) ORDER BY it.category, it.name) FROM room_items ri JOIN room_item_types it ON it.id=ri.item_type_id WHERE ri.room_id=t.room_id AND ri.status='IN_ROOM') AS room_items
      FROM housekeeping_tasks t JOIN rooms r ON r.id=t.room_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.id=$1`, [req.params.id])).rows[0];
  if (!t) throw new NotFound('Task not found');
  res.json(t);
}));

housekeepingRouter.post('/tasks/:id/start', requirePermission('housekeeping.update'), asyncHandler(async (req, res) => {
  const t = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM housekeeping_tasks WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Task not found');
    if (!['PENDING', 'FAILED_INSPECTION'].includes(old.status)) throw Errors.invalidStatus('task', old.status, 'start');
    const t = (await c.query(`UPDATE housekeeping_tasks SET status='IN_PROGRESS', started_at=now(), assigned_to=COALESCE(assigned_to,$2) WHERE id=$1 RETURNING *`, [old.id, req.user!.id])).rows[0];
    await c.query(`UPDATE rooms SET housekeeping_status='CLEANING', updated_at=now() WHERE id=$1 AND housekeeping_status IN ('DIRTY','CLEAN','INSPECTED')`, [old.room_id]);
    return t;
  });
  res.json(t);
}));

housekeepingRouter.post('/tasks/:id/complete', requirePermission('housekeeping.update'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ checklist: z.array(z.object({ item: z.string(), done: z.boolean() })).optional(), notes: optionalStr, minutes_taken: z.coerce.number().int().optional(),
    item_events: z.array(z.object({ room_item_id: z.string().uuid(), event_type: z.enum(['MISSING', 'BROKEN', 'DAMAGED', 'CONSUMED', 'GUEST_DAMAGE']), quantity: z.coerce.number().int().min(1).default(1), charge_guest: z.boolean().default(false), notes: optionalStr })).optional(),
    maintenance_issue: z.object({ title: z.string().min(3), description: optionalStr, priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM') }).nullable().optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT t.*, r.property_id FROM housekeeping_tasks t JOIN rooms r ON r.id=t.room_id WHERE t.id=$1 FOR UPDATE OF t`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Task not found');
    if (!['PENDING', 'IN_PROGRESS', 'FAILED_INSPECTION'].includes(old.status)) throw Errors.invalidStatus('task', old.status, 'complete');
    const minutes = b.minutes_taken ?? (old.started_at ? Math.round((Date.now() - new Date(old.started_at).getTime()) / 60000) : null);
    const t = (await c.query(`UPDATE housekeeping_tasks SET status='DONE', completed_at=now(), checklist=COALESCE($2, checklist), notes=COALESCE($3, notes), minutes_taken=$4, assigned_to=COALESCE(assigned_to,$5) WHERE id=$1 RETURNING *`, [old.id, b.checklist ? JSON.stringify(b.checklist) : null, b.notes ?? null, minutes, req.user!.id])).rows[0];
    // Room becomes CLEAN (pending inspection). Checkout cleans require inspection before INSPECTED.
    await c.query(`UPDATE rooms SET housekeeping_status='CLEAN', updated_at=now() WHERE id=$1 AND housekeeping_status <> 'OUT_OF_ORDER'`, [old.room_id]);
    const charges: any[] = [];
    for (const ev of b.item_events ?? []) charges.push(await recordRoomItemEvent(c, { roomItemId: ev.room_item_id, roomId: old.room_id, stayId: old.stay_id, eventType: ev.event_type, quantity: ev.quantity, chargeGuest: ev.charge_guest, notes: ev.notes, userId: req.user!.id, propertyId: old.property_id, canCharge: hasPermission(req, 'folios.post') }));
    let maintenance = null;
    if (b.maintenance_issue) {
      const { createMaintenanceRequest } = await import('./maintenance.routes');
      maintenance = await createMaintenanceRequest(c, req, { title: b.maintenance_issue.title, description: b.maintenance_issue.description ?? null, priority: b.maintenance_issue.priority, location_type: 'ROOM', room_id: old.room_id, category: 'GENERAL' });
    }
    await audit({ ...auditCtx(req), action: 'COMPLETE', entityType: 'housekeeping_task', entityId: t.id, newValue: { minutes, item_events: b.item_events?.length ?? 0 } }, c);
    await notify({ permission: 'housekeeping.inspect', propertyId: old.property_id, type: 'HK_READY_FOR_INSPECTION', title: `Room ready for inspection`, body: `Task ${old.task_type} completed`, entityType: 'housekeeping_task', entityId: t.id, link: `/housekeeping/tasks/${t.id}` }, c);
    return { task: t, item_events: charges, maintenance };
  });
  res.json(out);
}));

housekeepingRouter.post('/tasks/:id/inspect', requirePermission('housekeeping.inspect'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ passed: z.boolean(), score: z.coerce.number().int().min(0).max(100).optional(), checklist: z.array(z.object({ item: z.string(), ok: z.boolean() })).optional(), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM housekeeping_tasks WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Task not found');
    if (old.status !== 'DONE') throw Errors.invalidStatus('task', old.status, 'inspect');
    const insp = (await c.query(`INSERT INTO housekeeping_inspections (task_id, room_id, inspector_id, passed, score, checklist, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [old.id, old.room_id, req.user!.id, b.passed, b.score ?? (b.passed ? 100 : 0), JSON.stringify(b.checklist ?? []), b.notes ?? null])).rows[0];
    const t = (await c.query(`UPDATE housekeeping_tasks SET status=$2, inspected_at=now(), inspected_by=$3 WHERE id=$1 RETURNING *`, [old.id, b.passed ? 'INSPECTED' : 'FAILED_INSPECTION', req.user!.id])).rows[0];
    await c.query(`UPDATE rooms SET housekeeping_status=$2, updated_at=now() WHERE id=$1 AND housekeeping_status <> 'OUT_OF_ORDER'`, [old.room_id, b.passed ? 'INSPECTED' : 'DIRTY']);
    if (!b.passed && old.assigned_to) await notify({ userIds: [old.assigned_to], type: 'HK_FAILED_INSPECTION', title: 'Room failed inspection', body: b.notes ?? 'Please re-clean', entityType: 'housekeeping_task', entityId: t.id, link: `/housekeeping/tasks/${t.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'INSPECT', entityType: 'housekeeping_task', entityId: t.id, newValue: insp }, c);
    return { task: t, inspection: insp };
  });
  res.json(out);
}));

housekeepingRouter.post('/tasks/:id/cancel', requirePermission('housekeeping.assign'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const t = await withTransaction(async (c) => {
    const r = await c.query(`UPDATE housekeeping_tasks SET status='CANCELLED', notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']' WHERE id=$1 AND status IN ('PENDING','IN_PROGRESS','FAILED_INSPECTION') RETURNING *`, [req.params.id, b.reason]);
    if (!r.rows[0]) throw new BadRequest('Task cannot be cancelled in its current status');
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'housekeeping_task', entityId: req.params.id, reason: b.reason }, c);
    return r.rows[0];
  });
  res.json(t);
}));

// Productivity report: tasks per attendant
housekeepingRouter.get('/productivity', requirePermission('housekeeping.view'), asyncHandler(async (req, res) => {
  const from = req.query.from ?? new Date().toISOString().slice(0, 10), to = req.query.to ?? from;
  const rows = (await pool.query(`SELECT u.id, u.full_name, COUNT(*) FILTER (WHERE t.status IN ('DONE','INSPECTED','FAILED_INSPECTION'))::int AS completed, COUNT(*) FILTER (WHERE t.status='INSPECTED')::int AS passed, COUNT(*) FILTER (WHERE t.status='FAILED_INSPECTION')::int AS failed, COUNT(*) FILTER (WHERE t.status IN ('PENDING','IN_PROGRESS'))::int AS open, ROUND(AVG(t.minutes_taken))::int AS avg_minutes
      FROM housekeeping_tasks t JOIN users u ON u.id=t.assigned_to WHERE t.property_id=$1 AND t.business_date BETWEEN $2 AND $3 GROUP BY u.id, u.full_name ORDER BY completed DESC`, [req.propertyId, from, to])).rows;
  res.json({ from, to, data: rows });
}));

function defaultChecklist(type: string) {
  const base = ['Bed made / linen changed', 'Bathroom cleaned & sanitised', 'Towels replaced', 'Amenities restocked', 'Floor vacuumed / mopped', 'Bin emptied', 'Minibar checked', 'Lights, AC & TV tested'];
  if (type === 'TURNDOWN') return ['Bed turned down', 'Curtains drawn', 'Lights dimmed', 'Towels refreshed', 'Chocolates/water placed'].map((item) => ({ item, done: false }));
  if (type === 'INSPECTION') return base.map((item) => ({ item: 'Check: ' + item, done: false }));
  if (type === 'MINIBAR_CHECK') return ['Count minibar items', 'Post consumption to folio', 'Restock'].map((item) => ({ item, done: false }));
  return base.map((item) => ({ item, done: false }));
}

// ---------------- Room items (in-room inventory) ----------------
export const roomItemTypesRouter = crudRouter({ table: 'room_item_types', entity: 'room_item_type', permissions: { view: 'rooms.view', create: 'rooms.items', edit: 'rooms.items', delete: 'rooms.items' }, propertyScoped: true, softDelete: true, searchColumns: ['name', 'category'], defaultSort: 'name', filters: { category: 'category' },
  createSchema: z.object({ property_id: z.string().uuid().optional(), name: z.string().min(1), category: z.string().default('AMENITY'), is_serialized: z.boolean().default(false), is_consumable: z.boolean().default(false), replacement_value: z.coerce.number().min(0).default(0), standard_quantity: z.coerce.number().int().min(0).default(1), product_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), category: z.string(), is_serialized: z.boolean(), is_consumable: z.boolean(), replacement_value: z.coerce.number().min(0), standard_quantity: z.coerce.number().int().min(0), product_id: z.string().uuid().nullable(), is_active: z.boolean() }).partial() });

export const roomItemsRouter = crudRouter({ table: 'room_items', entity: 'room_item', permissions: { view: 'rooms.view', create: 'rooms.items', edit: 'rooms.items', delete: 'rooms.items' }, propertyScoped: true, searchColumns: ['serial_number', 'asset_number', 'it.name', 'r.number'], defaultSort: 'r.number',
  selectSql: `SELECT t.*, it.name AS item_name, it.category, it.is_serialized, it.is_consumable, it.standard_quantity, it.replacement_value, r.number AS room_number FROM room_items t JOIN room_item_types it ON it.id=t.item_type_id JOIN rooms r ON r.id=t.room_id`,
  filters: { room_id: 'room_id', item_type_id: 'item_type_id', status: 'status', condition: 'condition', category: 'it.category' },
  createSchema: z.object({ property_id: z.string().uuid().optional(), item_type_id: z.string().uuid(), room_id: z.string().uuid(), asset_id: z.string().uuid().nullable().optional(), serial_number: optionalStr, asset_number: optionalStr, quantity: z.coerce.number().int().min(0).default(1), condition: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED']).default('GOOD'), purchase_date: dateStr.nullable().optional(), cost: z.coerce.number().min(0).nullable().optional(), notes: optionalStr }),
  updateSchema: z.object({ item_type_id: z.string().uuid(), room_id: z.string().uuid(), serial_number: optionalStr, asset_number: optionalStr, quantity: z.coerce.number().int().min(0), condition: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED']), status: z.enum(['IN_ROOM', 'REMOVED', 'IN_REPAIR', 'WRITTEN_OFF']), notes: optionalStr }).partial(),
  extraRoutes: (r) => {
    r.post('/:id/event', requirePermission('rooms.items', 'housekeeping.update'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ event_type: z.enum(['MISSING', 'BROKEN', 'DAMAGED', 'REPLACED', 'GUEST_DAMAGE', 'CONSUMED', 'RETURNED']), quantity: z.coerce.number().int().min(1).default(1), charge_guest: z.boolean().default(false), charge_amount: z.coerce.number().min(0).optional(), notes: optionalStr }), req.body);
      const out = await withTransaction(async (c) => {
        const it = (await c.query(`SELECT ri.*, r.property_id AS room_property FROM room_items ri JOIN rooms r ON r.id=ri.room_id WHERE ri.id=$1`, [req.params.id])).rows[0];
        if (!it) throw new NotFound('Room item not found');
        const stay = (await c.query(`SELECT id FROM stays WHERE room_id=$1 AND status='IN_HOUSE'`, [it.room_id])).rows[0];
        return recordRoomItemEvent(c, { roomItemId: it.id, roomId: it.room_id, stayId: stay?.id ?? null, eventType: b.event_type, quantity: b.quantity, chargeGuest: b.charge_guest, chargeAmount: b.charge_amount, notes: b.notes, userId: req.user!.id, propertyId: it.room_property, canCharge: hasPermission(req, 'folios.post') });
      });
      res.status(201).json(out);
    }));
    r.get('/:id/events', requirePermission('rooms.view'), asyncHandler(async (req, res) => {
      res.json((await pool.query(`SELECT e.*, u.full_name AS reported_by_name FROM room_item_events e LEFT JOIN users u ON u.id=e.reported_by WHERE e.room_item_id=$1 ORDER BY e.created_at DESC`, [req.params.id])).rows);
    }));
  } });

/** Record a room item event (missing/broken/consumed...). Optionally charges the in-house guest folio (minibar consumption, damage). */
export async function recordRoomItemEvent(c: any, o: { roomItemId: string; roomId: string; stayId: string | null; eventType: string; quantity: number; chargeGuest: boolean; chargeAmount?: number; notes?: string | null; userId: string; propertyId: string; canCharge: boolean }) {
  const it = (await c.query(`SELECT ri.*, t.name, t.replacement_value, t.is_consumable, t.category FROM room_items ri JOIN room_item_types t ON t.id=ri.item_type_id WHERE ri.id=$1 FOR UPDATE`, [o.roomItemId])).rows[0];
  if (!it) throw new NotFound('Room item not found');
  let folioItemId: string | null = null; let chargeAmount = 0;
  if (o.chargeGuest) {
    if (!o.canCharge) throw new Forbidden('folios.post permission required to charge the guest');
    if (!o.stayId) throw new BadRequest('No in-house guest to charge for this room');
    const folio = (await c.query(`SELECT id FROM folios WHERE stay_id=$1 AND status='OPEN' ORDER BY (type='GUEST') DESC LIMIT 1`, [o.stayId])).rows[0];
    if (!folio) throw new BadRequest('Guest has no open folio');
    chargeAmount = o.chargeAmount ?? Number(it.replacement_value) * o.quantity;
    const category = it.category === 'MINIBAR' || o.eventType === 'CONSUMED' ? 'MINIBAR' : 'DAMAGE';
    const item = await postCharge(c, { folioId: folio.id, category, description: `${category === 'MINIBAR' ? 'Minibar' : 'Damage/loss'}: ${it.name} x${o.quantity}`, quantity: o.quantity, unitPrice: chargeAmount / o.quantity, sourceType: 'ROOM_ITEM', sourceId: it.id, userId: o.userId });
    folioItemId = item.id;
  }
  const ev = (await c.query(`INSERT INTO room_item_events (room_item_id, room_id, stay_id, event_type, quantity, charge_amount, charged_folio_item_id, notes, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [it.id, o.roomId, o.stayId, o.eventType, o.quantity, chargeAmount, folioItemId, o.notes ?? null, o.userId])).rows[0];
  // Update item state
  if (['MISSING', 'CONSUMED'].includes(o.eventType)) await c.query(`UPDATE room_items SET quantity=GREATEST(0, quantity-$2), status=CASE WHEN quantity-$2 <= 0 AND NOT $3 THEN 'REMOVED' ELSE status END, updated_at=now() WHERE id=$1`, [it.id, o.quantity, it.is_consumable]);
  else if (['BROKEN', 'DAMAGED', 'GUEST_DAMAGE'].includes(o.eventType)) await c.query(`UPDATE room_items SET condition='DAMAGED', updated_at=now() WHERE id=$1`, [it.id]);
  else if (['REPLACED', 'RETURNED'].includes(o.eventType)) await c.query(`UPDATE room_items SET quantity=quantity+$2, condition='GOOD', status='IN_ROOM', updated_at=now() WHERE id=$1`, [it.id, o.eventType === 'REPLACED' ? 0 : o.quantity]);
  if (['MISSING', 'BROKEN', 'DAMAGED', 'GUEST_DAMAGE'].includes(o.eventType)) await notify({ permission: 'housekeeping.assign', propertyId: o.propertyId, type: 'ROOM_ITEM_EVENT', title: `${it.name}: ${o.eventType.toLowerCase().replace('_', ' ')}`, body: o.notes ?? undefined, entityType: 'room_item', entityId: it.id, link: `/rooms/items?room_id=${o.roomId}`, severity: 'WARNING' }, c);
  return ev;
}
