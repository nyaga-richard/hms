import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, getPagination, paged, optionalStr, sendExport , isExport } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { crudRouter } from '../../core/crud';
import { NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { nextNumber } from '../../core/numbering';
import * as pos from './pos.service';
import { recordPayment } from '../finance/payments.service';
import { postJournal, currentBusinessDate } from '../finance/accounting.service';

const outletSelect = `SELECT t.*, d.name AS department_name, s.name AS store_name, k.name AS kitchen_name,
  (SELECT COUNT(*) FROM outlet_tables x WHERE x.outlet_id=t.id AND x.is_active)::int AS table_count,
  (SELECT COUNT(*) FROM orders o WHERE o.outlet_id=t.id AND o.status IN ('OPEN','BILLED'))::int AS open_orders
  FROM outlets t LEFT JOIN departments d ON d.id=t.department_id LEFT JOIN stores s ON s.id=t.store_id LEFT JOIN kitchens k ON k.id=t.default_kitchen_id`;
const outletCreate = z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), type: z.enum(['RESTAURANT', 'BAR', 'CLUB', 'ROOM_SERVICE', 'COFFEE_SHOP', 'BANQUET', 'SPA', 'OTHER']), department_id: z.string().uuid().nullable().optional(), store_id: z.string().uuid().nullable().optional(), default_kitchen_id: z.string().uuid().nullable().optional(),
  revenue_account_id: z.string().uuid().nullable().optional(), cogs_account_id: z.string().uuid().nullable().optional(), service_charge_percent: z.coerce.number().nullable().optional(), tax_id: z.string().uuid().nullable().optional(), allows_room_charge: z.boolean().default(true), allows_takeaway: z.boolean().default(true), allows_delivery: z.boolean().default(false), opening_time: optionalStr, closing_time: optionalStr, is_active: z.boolean().default(true), settings: z.record(z.any()).optional() });
const outletUpdate = outletCreate.omit({ property_id: true }).partial();

function outletRouter(type?: string) {
  return crudRouter({ table: 'outlets', entity: 'outlet', permissions: { view: 'outlets.view', create: 'outlets.manage', edit: 'outlets.manage', delete: 'outlets.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['name', 'code'], defaultSort: 'name', selectSql: outletSelect,
    filters: { type: 'type', active: 'is_active' }, fixedWhere: type ? { sql: 't.type = $PARAM', params: [type] } : undefined, createSchema: outletCreate, updateSchema: outletUpdate, beforeCreate: (d) => { if (type) d.type = type; return d; } });
}
export const outletsRouter = outletRouter();
export const restaurantsRouter = outletRouter('RESTAURANT');
export const barsRouter = outletRouter('BAR');

export const kitchensRouter = crudRouter({ table: 'kitchens', entity: 'kitchen', permissions: { view: 'outlets.view', create: 'outlets.manage', edit: 'outlets.manage', delete: 'outlets.manage' }, propertyScoped: true, softDelete: true, defaultSort: 'name',
  selectSql: `SELECT t.*, s.name AS store_name, (SELECT COUNT(*) FROM kitchen_tickets kt WHERE kt.kitchen_id=t.id AND kt.status IN ('NEW','ACCEPTED','PREPARING'))::int AS queue FROM kitchens t LEFT JOIN stores s ON s.id=t.store_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string(), name: z.string(), store_id: z.string().uuid().nullable().optional(), printer_name: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ code: z.string(), name: z.string(), store_id: z.string().uuid().nullable(), printer_name: optionalStr, is_active: z.boolean() }).partial() });

export const tablesRouter = crudRouter({ table: 'outlet_tables', entity: 'table', permissions: { view: 'outlets.view', create: 'outlets.manage', edit: 'outlets.manage', delete: 'outlets.manage' }, defaultSort: 'number', filters: { outlet_id: 'outlet_id', section_id: 'section_id', status: 'status' },
  selectSql: `SELECT t.*, s.name AS section_name, o.name AS outlet_name, (SELECT json_build_object('id', ord.id, 'number', ord.number, 'total', ord.total, 'status', ord.status, 'waiter', u.full_name, 'opened_at', ord.opened_at, 'covers', ord.covers) FROM orders ord LEFT JOIN users u ON u.id=ord.waiter_id WHERE ord.table_id=t.id AND ord.status IN ('OPEN','BILLED') ORDER BY ord.opened_at LIMIT 1) AS current_order
    FROM outlet_tables t LEFT JOIN outlet_sections s ON s.id=t.section_id JOIN outlets o ON o.id=t.outlet_id`,
  createSchema: z.object({ outlet_id: z.string().uuid(), section_id: z.string().uuid().nullable().optional(), number: z.string(), capacity: z.coerce.number().int().default(4), pos_x: z.coerce.number().int().default(0), pos_y: z.coerce.number().int().default(0), shape: z.string().default('SQUARE'), min_spend: z.coerce.number().default(0), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ section_id: z.string().uuid().nullable(), number: z.string(), capacity: z.coerce.number().int(), status: z.enum(['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'BLOCKED']), pos_x: z.coerce.number().int(), pos_y: z.coerce.number().int(), shape: z.string(), min_spend: z.coerce.number(), is_active: z.boolean() }).partial(),
  extraRoutes: (r) => {
    r.post('/:id/status', requirePermission('pos.view'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ status: z.enum(['AVAILABLE', 'RESERVED', 'CLEANING', 'BLOCKED']) }), req.body);
      const occupied = await pool.query(`SELECT 1 FROM orders WHERE table_id=$1 AND status IN ('OPEN','BILLED')`, [req.params.id]);
      if (occupied.rows[0]) throw new BadRequest('Table has an open order');
      res.json((await pool.query(`UPDATE outlet_tables SET status=$2 WHERE id=$1 RETURNING *`, [req.params.id, b.status])).rows[0]);
    }));
  } });

export const sectionsRouter = crudRouter({ table: 'outlet_sections', entity: 'section', permissions: { view: 'outlets.view', create: 'outlets.manage', edit: 'outlets.manage', delete: 'outlets.manage' }, defaultSort: 'sort_order', filters: { outlet_id: 'outlet_id' },
  createSchema: z.object({ outlet_id: z.string().uuid(), name: z.string(), is_vip: z.boolean().default(false), sort_order: z.coerce.number().int().default(0) }), updateSchema: z.object({ name: z.string(), is_vip: z.boolean(), sort_order: z.coerce.number().int() }).partial() });

export const terminalsRouter = crudRouter({ table: 'pos_terminals', entity: 'pos_terminal', permissions: { view: 'outlets.view', create: 'outlets.manage', edit: 'outlets.manage', delete: 'outlets.manage' }, propertyScoped: true, softDelete: true, defaultSort: 'name', selectSql: `SELECT t.*, o.name AS outlet_name FROM pos_terminals t LEFT JOIN outlets o ON o.id=t.outlet_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), outlet_id: z.string().uuid().nullable().optional(), code: z.string(), name: z.string(), receipt_printer: optionalStr, is_active: z.boolean().default(true) }), updateSchema: z.object({ outlet_id: z.string().uuid().nullable(), code: z.string(), name: z.string(), receipt_printer: optionalStr, is_active: z.boolean() }).partial() });

// ---------- Menus ----------
export const menusRouter = crudRouter({ table: 'menus', entity: 'menu', permissions: { view: 'menus.view', create: 'menus.manage', edit: 'menus.manage', delete: 'menus.manage' }, propertyScoped: true, softDelete: true, defaultSort: 'name',
  selectSql: `SELECT t.*, (SELECT COUNT(*) FROM menu_categories c WHERE c.menu_id=t.id)::int AS category_count, (SELECT COUNT(*) FROM menu_items mi JOIN menu_categories c ON c.id=mi.category_id WHERE c.menu_id=t.id AND mi.is_active)::int AS item_count FROM menus t`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), name: z.string(), outlet_ids: z.array(z.string().uuid()).default([]), available_from: optionalStr, available_to: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string(), outlet_ids: z.array(z.string().uuid()), available_from: optionalStr, available_to: optionalStr, is_active: z.boolean() }).partial(),
  extraRoutes: (r) => {
    // Full menu tree for an outlet (POS)
    r.get('/for-outlet/:outletId', requirePermission('pos.view', 'menus.view'), asyncHandler(async (req, res) => {
      const menus = (await pool.query(`SELECT * FROM menus WHERE is_active AND $1 = ANY(outlet_ids)`, [req.params.outletId])).rows;
      const ids = menus.map((m) => m.id);
      const cats = ids.length ? (await pool.query(`SELECT * FROM menu_categories WHERE menu_id = ANY($1) AND is_active ORDER BY sort_order, name`, [ids])).rows : [];
      const items = cats.length ? (await pool.query(`SELECT mi.*, COALESCE((SELECT json_agg(json_build_object('id', m.id, 'group_name', m.group_name, 'name', m.name, 'price_delta', m.price_delta, 'product_id', m.product_id, 'product_qty', m.product_qty, 'is_required', m.is_required, 'max_select', m.max_select)) FROM menu_item_modifiers m WHERE m.menu_item_id=mi.id), '[]') AS modifiers
        FROM menu_items mi WHERE mi.category_id = ANY($1) AND mi.is_active ORDER BY mi.sort_order, mi.name`, [cats.map((c) => c.id)])).rows : [];
      res.json({ menus, categories: cats.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })) });
    }));
  } });

export const menuCategoriesRouter = crudRouter({ table: 'menu_categories', entity: 'menu_category', permissions: { view: 'menus.view', create: 'menus.manage', edit: 'menus.manage', delete: 'menus.manage' }, defaultSort: 'sort_order', filters: { menu_id: 'menu_id', type: 'type' },
  selectSql: `SELECT t.*, k.name AS kitchen_name, m.name AS menu_name FROM menu_categories t LEFT JOIN kitchens k ON k.id=t.kitchen_id JOIN menus m ON m.id=t.menu_id`,
  createSchema: z.object({ menu_id: z.string().uuid(), name: z.string(), type: z.enum(['FOOD', 'BEVERAGE', 'ALCOHOL', 'TOBACCO', 'SERVICE', 'TICKET', 'OTHER']).default('FOOD'), kitchen_id: z.string().uuid().nullable().optional(), sort_order: z.coerce.number().int().default(0), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string(), type: z.enum(['FOOD', 'BEVERAGE', 'ALCOHOL', 'TOBACCO', 'SERVICE', 'TICKET', 'OTHER']), kitchen_id: z.string().uuid().nullable(), sort_order: z.coerce.number().int(), is_active: z.boolean() }).partial() });

export const menuItemsRouter = crudRouter({ table: 'menu_items', entity: 'menu_item', permissions: { view: 'menus.view', create: 'menus.manage', edit: 'menus.manage', delete: 'menus.manage' }, softDelete: true, searchColumns: ['name', 'code', 'barcode'], defaultSort: 'name', filters: { category_id: 'category_id', active: 'is_active', available: 'is_available' },
  selectSql: `SELECT t.*, c.name AS category_name, c.type AS category_type, c.menu_id, k.name AS kitchen_name, p.name AS product_name, tx.name AS tax_name,
      (SELECT json_build_object('id', r.id, 'version', r.version, 'effective_from', r.effective_from, 'items', (SELECT json_agg(json_build_object('product_id', ri.product_id, 'product_name', pr.name, 'quantity', ri.quantity, 'unit', u.code, 'wastage_percent', ri.wastage_percent, 'cost', ri.quantity * pr.cost_price)) FROM recipe_items ri JOIN products pr ON pr.id=ri.product_id LEFT JOIN units u ON u.id=pr.unit_id WHERE ri.recipe_id=r.id))
         FROM recipes r WHERE r.menu_item_id=t.id AND r.is_active AND r.effective_from <= CURRENT_DATE AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE) ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) AS recipe,
      COALESCE((SELECT json_agg(json_build_object('id', m.id, 'group_name', m.group_name, 'name', m.name, 'price_delta', m.price_delta, 'product_id', m.product_id, 'product_qty', m.product_qty, 'is_required', m.is_required, 'max_select', m.max_select)) FROM menu_item_modifiers m WHERE m.menu_item_id=t.id), '[]') AS modifiers
    FROM menu_items t JOIN menu_categories c ON c.id=t.category_id LEFT JOIN kitchens k ON k.id=t.kitchen_id LEFT JOIN products p ON p.id=t.product_id LEFT JOIN taxes tx ON tx.id=t.tax_id`,
  createSchema: z.object({ category_id: z.string().uuid(), code: optionalStr, name: z.string(), description: optionalStr, price: z.coerce.number().min(0), cost_estimate: z.coerce.number().default(0), tax_id: z.string().uuid().nullable().optional(), kitchen_id: z.string().uuid().nullable().optional(), product_id: z.string().uuid().nullable().optional(), product_qty: z.coerce.number().default(1),
    is_service_charge_applicable: z.boolean().default(true), is_available: z.boolean().default(true), is_active: z.boolean().default(true), image_url: optionalStr, preparation_minutes: z.coerce.number().int().nullable().optional(), barcode: optionalStr, sort_order: z.coerce.number().int().default(0) }),
  updateSchema: z.object({ category_id: z.string().uuid(), code: optionalStr, name: z.string(), description: optionalStr, price: z.coerce.number().min(0), cost_estimate: z.coerce.number(), tax_id: z.string().uuid().nullable(), kitchen_id: z.string().uuid().nullable(), product_id: z.string().uuid().nullable(), product_qty: z.coerce.number(), is_service_charge_applicable: z.boolean(), is_available: z.boolean(), is_active: z.boolean(), image_url: optionalStr, preparation_minutes: z.coerce.number().int().nullable(), barcode: optionalStr, sort_order: z.coerce.number().int() }).partial(),
  extraRoutes: (r) => {
    r.put('/:id/recipe', requirePermission('menus.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.coerce.number().positive(), wastage_percent: z.coerce.number().min(0).default(0) })), yield_qty: z.coerce.number().positive().default(1), effective_from: z.string().optional(), notes: optionalStr }), req.body);
      const out = await withTransaction(async (c) => {
        const mi = (await c.query(`SELECT name FROM menu_items WHERE id=$1`, [req.params.id])).rows[0];
        if (!mi) throw new NotFound('Menu item not found');
        const ver = Number((await c.query(`SELECT COALESCE(MAX(version),0)+1 AS v FROM recipes WHERE menu_item_id=$1`, [req.params.id])).rows[0].v);
        const eff = b.effective_from ?? new Date().toISOString().slice(0, 10);
        await c.query(`UPDATE recipes SET effective_to = ($2::date - 1), is_active = CASE WHEN effective_from >= $2::date THEN false ELSE is_active END WHERE menu_item_id=$1 AND is_active AND (effective_to IS NULL OR effective_to >= $2::date)`, [req.params.id, eff]);
        const rec = (await c.query(`INSERT INTO recipes (name, menu_item_id, yield_qty, version, effective_from, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [mi.name, req.params.id, b.yield_qty, ver, eff, b.notes, req.user!.id])).rows[0];
        for (const it of b.items) await c.query(`INSERT INTO recipe_items (recipe_id, product_id, quantity, wastage_percent) VALUES ($1,$2,$3,$4)`, [rec.id, it.product_id, it.quantity, it.wastage_percent]);
        const cost = (await c.query(`SELECT COALESCE(SUM(ri.quantity * (1 + ri.wastage_percent/100) * p.cost_price),0) AS cost FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE ri.recipe_id=$1`, [rec.id])).rows[0].cost;
        await c.query(`UPDATE menu_items SET cost_estimate=$2 WHERE id=$1`, [req.params.id, Number(cost) / b.yield_qty]);
        await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'recipe', entityId: rec.id, newValue: b }, c);
        return rec;
      });
      res.json(out);
    }));
    r.get('/:id/recipes', requirePermission('menus.view'), asyncHandler(async (req, res) => {
      res.json({ data: (await pool.query(`SELECT r.*, COALESCE((SELECT json_agg(json_build_object('product_id', ri.product_id, 'product_name', p.name, 'quantity', ri.quantity, 'wastage_percent', ri.wastage_percent)) FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE ri.recipe_id=r.id), '[]') AS items FROM recipes r WHERE r.menu_item_id=$1 ORDER BY r.version DESC`, [req.params.id])).rows });
    }));
    r.put('/:id/modifiers', requirePermission('menus.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ modifiers: z.array(z.object({ group_name: z.string().default('Options'), name: z.string(), price_delta: z.coerce.number().default(0), product_id: z.string().uuid().nullable().optional(), product_qty: z.coerce.number().default(0), is_required: z.boolean().default(false), max_select: z.coerce.number().int().default(1) })) }), req.body);
      await withTransaction(async (c) => {
        await c.query(`DELETE FROM menu_item_modifiers WHERE menu_item_id=$1`, [req.params.id]);
        for (const m of b.modifiers) await c.query(`INSERT INTO menu_item_modifiers (menu_item_id, group_name, name, price_delta, product_id, product_qty, is_required, max_select) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [req.params.id, m.group_name, m.name, m.price_delta, m.product_id ?? null, m.product_qty, m.is_required, m.max_select]);
      });
      res.json({ ok: true });
    }));
  } });

// ---------- Orders / POS ----------
export const ordersRouter = Router();
ordersRouter.get('/', requirePermission('pos.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'opened_at');
  const params: any[] = [req.propertyId]; const where = ['o.property_id=$1'];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  if (req.query.outlet_id) add('o.outlet_id=$P', req.query.outlet_id);
  if (req.query.status) add(`o.status = ANY(string_to_array($P, ','))`, req.query.status);
  if (req.query.table_id) add('o.table_id=$P', req.query.table_id);
  if (req.query.waiter_id) add('o.waiter_id=$P', req.query.waiter_id);
  if (req.query.shift_id) add('o.cashier_shift_id=$P', req.query.shift_id);
  if (req.query.stay_id) add('o.stay_id=$P', req.query.stay_id);
  if (req.query.date) add('o.business_date=$P', req.query.date);
  if (req.query.from) add('o.business_date>=$P', req.query.from);
  if (req.query.to) add('o.business_date<=$P', req.query.to);
  if (p.search) add(`(o.number ILIKE $P OR t.number ILIKE $P OR g.first_name ILIKE $P OR g.last_name ILIKE $P)`, `%${p.search}%`);
  const sql = `SELECT o.*, ol.name AS outlet_name, ol.type AS outlet_type, t.number AS table_number, u.full_name AS waiter_name, g.first_name || ' ' || g.last_name AS guest_name, r.number AS room_number,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id AND NOT oi.voided)::int AS item_count,
      (SELECT MIN(oi.kitchen_status) FROM order_items oi WHERE oi.order_id=o.id AND NOT oi.voided AND oi.kitchen_status NOT IN ('SERVED','CANCELLED')) AS pending_kitchen
    FROM orders o JOIN outlets ol ON ol.id=o.outlet_id LEFT JOIN outlet_tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.waiter_id LEFT JOIN guests g ON g.id=o.guest_id LEFT JOIN stays s ON s.id=o.stay_id LEFT JOIN rooms r ON r.id=s.room_id WHERE ${where.join(' AND ')}`;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${sql}) x`, params)).rows[0].count);
  const rows = (await pool.query(`${sql} ORDER BY o.opened_at ${p.order} LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
  if (isExport(req)) { if (!hasPermission(req, 'reports.export')) throw new Forbidden(); return sendExport(res, req, rows, 'orders'); }
  res.json(paged(rows, total, p));
}));
ordersRouter.get('/:id', requirePermission('pos.view'), asyncHandler(async (req, res) => res.json(await pos.orderDetail(req.params.id))));
const itemSchema = z.object({ menu_item_id: z.string().uuid(), quantity: z.coerce.number().positive(), modifiers: z.array(z.object({ id: z.string().uuid().optional(), name: z.string(), price_delta: z.coerce.number().optional(), product_id: z.string().uuid().nullable().optional(), product_qty: z.coerce.number().optional() })).optional(), special_instructions: optionalStr, seat_no: z.coerce.number().int().nullable().optional(), course: z.coerce.number().int().nullable().optional(), is_complimentary: z.boolean().optional() });
ordersRouter.post('/', requirePermission('pos.create_order'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ outlet_id: z.string().uuid(), type: z.enum(['DINE_IN', 'TAKEAWAY', 'ROOM_SERVICE', 'DELIVERY', 'COUNTER', 'EVENT']).default('DINE_IN'), table_id: z.string().uuid().nullable().optional(), covers: z.coerce.number().int().min(1).default(1), stay_id: z.string().uuid().nullable().optional(), guest_id: z.string().uuid().nullable().optional(), customer_id: z.string().uuid().nullable().optional(), event_id: z.string().uuid().nullable().optional(), notes: optionalStr, delivery_address: optionalStr, idempotency_key: optionalStr, items: z.array(itemSchema).optional() }), req.body);
  res.status(201).json(await pos.createOrder(req.user!, req.propertyId!, b as any));
}));
ordersRouter.post('/:id/items', requirePermission('pos.create_order', 'pos.modify_order'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ items: z.array(itemSchema).min(1) }), req.body);
  res.json(await pos.addItems(req.params.id, b.items as any, req.user!));
}));
ordersRouter.post('/:id/send', requirePermission('pos.create_order'), asyncHandler(async (req, res) => res.json(await pos.sendToKitchen(req.params.id, req.user!, req.body?.item_ids))));
ordersRouter.post('/:id/items/:itemId/void', requirePermission('pos.modify_order', 'pos.void_item'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  res.json(await pos.voidItem(req.params.id, req.params.itemId, b.reason, req.user!));
}));
ordersRouter.post('/:id/items/:itemId/serve', requirePermission('pos.view'), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE order_items SET kitchen_status='SERVED', served_at=now() WHERE id=$1 AND order_id=$2`, [req.params.itemId, req.params.id]);
  res.json(await pos.orderDetail(req.params.id));
}));
ordersRouter.post('/:id/discount', requirePermission('pos.discount'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ type: z.enum(['PERCENT', 'FIXED']), value: z.coerce.number().min(0), reason: z.string().min(2), item_id: z.string().uuid().nullable().optional() }), req.body);
  res.json(await pos.applyDiscount(req.params.id, req.user!, b));
}));
ordersRouter.post('/:id/bill', requirePermission('pos.settle', 'pos.create_order'), asyncHandler(async (req, res) => res.json(await pos.billOrder(req.params.id, req.user!))));
ordersRouter.post('/:id/settle', requirePermission('pos.settle'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ payments: z.array(z.object({ payment_method_id: z.string().uuid().optional(), method: z.enum(['PAYMENT', 'ROOM_CHARGE', 'CORPORATE', 'COMPLIMENTARY']).default('PAYMENT'), amount: z.coerce.number().min(0).optional().default(0), payment_method_code: z.string().optional(), reference: optionalStr, tip: z.coerce.number().min(0).optional(), stay_id: z.string().uuid().nullable().optional(), customer_id: z.string().uuid().nullable().optional() })).min(1), idempotency_key: optionalStr }), req.body);
  res.json(await pos.settleOrder(req.params.id, req.user!, b as any));
}));
ordersRouter.post('/:id/cancel', requirePermission('pos.cancel_order', 'pos.create_order'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  res.json(await pos.cancelOrder(req.params.id, b.reason, req.user!));
}));
ordersRouter.post('/:id/refund', requirePermission('pos.refund'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ payment_method_id: z.string().uuid(), amount: z.coerce.number().positive(), reason: z.string().min(2), reference: optionalStr }), req.body);
  res.json(await pos.refundOrder(req.params.id, req.user!, b));
}));
ordersRouter.post('/:id/transfer', requirePermission('pos.transfer'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ table_id: z.string().uuid().nullable().optional(), waiter_id: z.string().uuid().nullable().optional(), reason: optionalStr }), req.body);
  res.json(await pos.transferOrder(req.params.id, req.user!, b as any));
}));
ordersRouter.post('/:id/merge', requirePermission('pos.modify_order'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ source_order_id: z.string().uuid() }), req.body);
  res.json(await pos.mergeOrders(req.params.id, b.source_order_id, req.user!));
}));
ordersRouter.post('/:id/split', requirePermission('pos.modify_order'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ item_ids: z.array(z.string().uuid()).min(1) }), req.body);
  res.json(await pos.splitOrder(req.params.id, b.item_ids, req.user!));
}));
ordersRouter.get('/:id/receipt', requirePermission('pos.view'), asyncHandler(async (req, res) => {
  const o = await pos.orderDetail(req.params.id);
  const prop = (await pool.query(`SELECT name, address, phone, tax_number FROM properties WHERE id=$1`, [o.property_id])).rows[0];
  if (req.query.reprint === 'true') { if (!hasPermission(req, 'pos.reprint')) throw new Forbidden('Reprint permission required'); await audit({ ...auditCtx(req), action: 'REPRINT', entityType: 'order', entityId: o.id }); }
  res.json({ property: prop, order: o });
}));

// ---------- Kitchen display ----------
export const kitchenRouter = Router();
kitchenRouter.get('/tickets', requirePermission('kitchen.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT kt.*, k.name AS kitchen_name, o.number AS order_number, o.type AS order_type, t.number AS table_number, r.number AS room_number, u.full_name AS waiter_name, ol.name AS outlet_name,
      (SELECT json_agg(json_build_object('id', oi.id, 'name', oi.name, 'quantity', oi.quantity, 'modifiers', oi.modifiers, 'special_instructions', oi.special_instructions, 'kitchen_status', oi.kitchen_status, 'voided', oi.voided, 'seat_no', oi.seat_no, 'course', oi.course) ORDER BY oi.created_at) FROM order_items oi WHERE oi.id = ANY(kt.item_ids)) AS items,
      EXTRACT(EPOCH FROM (now() - kt.sent_at))::int AS age_seconds
    FROM kitchen_tickets kt JOIN kitchens k ON k.id=kt.kitchen_id JOIN orders o ON o.id=kt.order_id JOIN outlets ol ON ol.id=o.outlet_id LEFT JOIN outlet_tables t ON t.id=o.table_id LEFT JOIN stays s ON s.id=o.stay_id LEFT JOIN rooms r ON r.id=s.room_id LEFT JOIN users u ON u.id=o.waiter_id
    WHERE k.property_id=$1 AND ($2::uuid IS NULL OR kt.kitchen_id=$2) AND kt.status = ANY(string_to_array($3, ',')) ORDER BY kt.sent_at`, [req.propertyId, req.query.kitchen_id ?? null, (req.query.status as string) ?? 'NEW,ACCEPTED,PREPARING,READY'])).rows;
  res.json({ data: rows });
}));
kitchenRouter.post('/tickets/:id/status', requirePermission('kitchen.update'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED']) }), req.body);
  res.json(await pos.updateKitchenStatus(req.params.id, b.status, req.user!));
}));

// ---------- Cashier shifts ----------
export const shiftsRouter = Router();
shiftsRouter.get('/', requirePermission('pos.view', 'payments.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'opened_at');
  const params: any[] = [req.propertyId]; const where = ['s.property_id=$1'];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('$P', `$${params.length}`)); };
  if (req.query.status) add('s.status=$P', req.query.status);
  if (req.query.user_id) add('s.user_id=$P', req.query.user_id);
  if (req.query.outlet_id) add('s.outlet_id=$P', req.query.outlet_id);
  if (req.query.date) add('s.business_date=$P', req.query.date);
  if (!hasPermission(req, 'pos.approve_variance') && !hasPermission(req, 'payments.view')) add('s.user_id=$P', req.user!.id);
  const sql = `SELECT s.*, u.full_name AS cashier_name, o.name AS outlet_name, (SELECT COUNT(*) FROM orders x WHERE x.cashier_shift_id=s.id AND x.status='CLOSED')::int AS order_count, (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.cashier_shift_id=s.id AND p.direction='IN' AND p.status='COMPLETED') AS receipts
    FROM cashier_shifts s JOIN users u ON u.id=s.user_id LEFT JOIN outlets o ON o.id=s.outlet_id WHERE ${where.join(' AND ')}`;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${sql}) x`, params)).rows[0].count);
  res.json(paged((await pool.query(`${sql} ORDER BY s.opened_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows, total, p));
}));
shiftsRouter.get('/current', requirePermission('pos.view', 'payments.create'), asyncHandler(async (req, res) => {
  const s = (await pool.query(`SELECT s.*, o.name AS outlet_name FROM cashier_shifts s LEFT JOIN outlets o ON o.id=s.outlet_id WHERE s.user_id=$1 AND s.status='OPEN' ORDER BY s.opened_at DESC LIMIT 1`, [req.user!.id])).rows[0];
  res.json(s ? await pos.shiftSummary(pool, s.id) : { shift: null });
}));
shiftsRouter.get('/:id', requirePermission('pos.view', 'payments.view'), asyncHandler(async (req, res) => res.json(await pos.shiftSummary(pool, req.params.id))));
shiftsRouter.post('/open', requirePermission('pos.open_shift'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ outlet_id: z.string().uuid().nullable().optional(), terminal_id: z.string().uuid().nullable().optional(), opening_float: z.coerce.number().min(0).default(0), notes: optionalStr }), req.body);
  res.status(201).json(await pos.openShift(req.user!, req.propertyId!, { outletId: b.outlet_id, terminalId: b.terminal_id, openingFloat: b.opening_float, notes: b.notes }));
}));
shiftsRouter.post('/:id/close', requirePermission('pos.close_shift'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ actual_cash: z.coerce.number().min(0), variance_reason: optionalStr, notes: optionalStr }), req.body);
  res.json(await pos.closeShift(req.params.id, req.user!, b.actual_cash, b.variance_reason, b.notes));
}));
shiftsRouter.post('/:id/approve-variance', requirePermission('pos.approve_variance'), asyncHandler(async (req, res) => res.json(await pos.approveVariance(req.params.id, req.user!, req.body?.comment))));
shiftsRouter.get('/:id/payments', requirePermission('pos.view', 'payments.view'), asyncHandler(async (req, res) => {
  res.json({ data: (await pool.query(`SELECT p.*, pm.name AS method_name, o.number AS order_number FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id LEFT JOIN orders o ON o.id=p.source_id AND p.source_type='ORDER' WHERE p.cashier_shift_id=$1 ORDER BY p.created_at`, [req.params.id])).rows });
}));

// ---------- Clubs ----------
export const clubsRouter = outletRouter('CLUB');
export const clubEventsRouter = crudRouter({ table: 'club_events', entity: 'club_event', permissions: { view: 'clubs.view', create: 'clubs.manage', edit: 'clubs.manage', delete: 'clubs.manage' }, defaultSort: 'event_date', filters: { outlet_id: 'outlet_id', status: 'status' }, searchColumns: ['name'],
  selectSql: `SELECT t.*, o.name AS outlet_name, COALESCE((SELECT json_agg(json_build_object('id', tt.id, 'name', tt.name, 'price', tt.price, 'quantity_available', tt.quantity_available, 'quantity_sold', tt.quantity_sold, 'includes', tt.includes)) FROM club_ticket_types tt WHERE tt.event_id=t.id), '[]') AS ticket_types,
      (SELECT COALESCE(SUM(amount),0) FROM club_tickets ct WHERE ct.event_id=t.id AND ct.status<>'CANCELLED') AS ticket_revenue, (SELECT COUNT(*) FROM club_tickets ct WHERE ct.event_id=t.id AND ct.status='CHECKED_IN')::int AS checked_in, (SELECT COUNT(*) FROM club_guest_list gl WHERE gl.event_id=t.id)::int AS guest_list_count
    FROM club_events t JOIN outlets o ON o.id=t.outlet_id`,
  createSchema: z.object({ outlet_id: z.string().uuid(), name: z.string(), event_date: z.string(), start_time: optionalStr, end_time: optionalStr, description: optionalStr, capacity: z.coerce.number().int().nullable().optional(), cover_charge: z.coerce.number().default(0), status: z.string().default('SCHEDULED'), promotions: z.array(z.any()).default([]) }),
  updateSchema: z.object({ name: z.string(), event_date: z.string(), start_time: optionalStr, end_time: optionalStr, description: optionalStr, capacity: z.coerce.number().int().nullable(), cover_charge: z.coerce.number(), status: z.enum(['SCHEDULED', 'LIVE', 'CLOSED', 'CANCELLED']), promotions: z.array(z.any()) }).partial(),
  extraRoutes: (r) => {
    r.put('/:id/ticket-types', requirePermission('clubs.manage'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ ticket_types: z.array(z.object({ id: z.string().uuid().optional(), name: z.string(), price: z.coerce.number().min(0), quantity_available: z.coerce.number().int().nullable().optional(), includes: optionalStr })) }), req.body);
      await withTransaction(async (c) => {
        const keep: string[] = [];
        for (const t of b.ticket_types) {
          if (t.id) { await c.query(`UPDATE club_ticket_types SET name=$2, price=$3, quantity_available=$4, includes=$5 WHERE id=$1`, [t.id, t.name, t.price, t.quantity_available ?? null, t.includes]); keep.push(t.id); }
          else { const row = (await c.query(`INSERT INTO club_ticket_types (event_id, name, price, quantity_available, includes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [req.params.id, t.name, t.price, t.quantity_available ?? null, t.includes])).rows[0]; keep.push(row.id); }
        }
        await c.query(`DELETE FROM club_ticket_types WHERE event_id=$1 AND NOT (id = ANY($2)) AND quantity_sold=0`, [req.params.id, keep]);
      });
      res.json({ ok: true });
    }));
    r.post('/:id/tickets', requirePermission('clubs.sell_tickets'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ ticket_type_id: z.string().uuid(), quantity: z.coerce.number().int().min(1).default(1), holder_name: optionalStr, holder_phone: optionalStr, guest_id: z.string().uuid().nullable().optional(), payment_method_id: z.string().uuid(), reference: optionalStr, idempotency_key: optionalStr }), req.body);
      const out = await withTransaction(async (c) => {
        const ev = (await c.query(`SELECT e.*, o.property_id, o.revenue_account_id, o.tax_id FROM club_events e JOIN outlets o ON o.id=e.outlet_id WHERE e.id=$1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!ev) throw new NotFound('Event not found');
        if (!['SCHEDULED', 'LIVE'].includes(ev.status)) throw new BadRequest('Event is not open for ticket sales');
        const tt = (await c.query(`SELECT * FROM club_ticket_types WHERE id=$1 AND event_id=$2 FOR UPDATE`, [b.ticket_type_id, ev.id])).rows[0];
        if (!tt) throw new NotFound('Ticket type not found');
        if (tt.quantity_available !== null && tt.quantity_sold + b.quantity > tt.quantity_available) throw new BadRequest(`Only ${tt.quantity_available - tt.quantity_sold} ${tt.name} tickets left`);
        const shift = await pos.requireOpenShift(c, req.user!.id, ev.outlet_id);
        const amount = Number(tt.price) * b.quantity;
        const { payment } = await recordPayment(c, { propertyId: ev.property_id, direction: 'IN', kind: 'PAYMENT', paymentMethodId: b.payment_method_id, amount, reference: b.reference, partyType: b.guest_id ? 'GUEST' : null, partyId: b.guest_id ?? null, sourceType: 'TICKET', sourceId: ev.id, cashierShiftId: shift.id, outletId: ev.outlet_id, userId: req.user!.id, idempotencyKey: b.idempotency_key, offset: { mappingKey: 'POS_CLEARING' }, description: `Ticket ${ev.name}` });
        const bd = await currentBusinessDate(c, ev.property_id, req.user!.id);
        const { splitTax, getTax } = await import('../finance/accounting.service');
        const tax = ev.tax_id ? await getTax(c, ev.tax_id) : await (await import('../finance/accounting.service')).defaultTaxFor(c, ev.property_id, 'SERVICE');
        const sp = tax ? splitTax(amount, Number(tax.rate), tax.is_inclusive) : { net: amount, tax: 0, gross: amount };
        const lines: any[] = [{ mappingKey: 'POS_CLEARING', debit: amount, outletId: ev.outlet_id }, { accountId: ev.revenue_account_id ?? undefined, mappingKey: ev.revenue_account_id ? undefined : 'CLUB_REVENUE', credit: sp.net, outletId: ev.outlet_id }];
        if (sp.tax) lines.push({ accountId: tax?.account_id ?? undefined, mappingKey: tax?.account_id ? undefined : 'TAX_PAYABLE', credit: sp.tax });
        await postJournal(c, { propertyId: ev.property_id, description: `Ticket sales ${ev.name} x${b.quantity}`, sourceType: 'TICKET', sourceId: ev.id, businessDate: bd, userId: req.user!.id, lines });
        const number = await nextNumber(c, 'TICKET', ev.property_id);
        const ticket = (await c.query(`INSERT INTO club_tickets (event_id, ticket_type_id, number, qr_code, holder_name, holder_phone, guest_id, quantity, amount, payment_id, sold_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [ev.id, tt.id, number, crypto.randomBytes(12).toString('hex'), b.holder_name, b.holder_phone, b.guest_id ?? null, b.quantity, amount, payment.id, req.user!.id])).rows[0];
        await c.query(`UPDATE club_ticket_types SET quantity_sold=quantity_sold+$2 WHERE id=$1`, [tt.id, b.quantity]);
        await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'club_ticket', entityId: ticket.id, newValue: ticket }, c);
        return ticket;
      });
      res.status(201).json(out);
    }));
    r.get('/:id/tickets', requirePermission('clubs.view'), asyncHandler(async (req, res) => {
      res.json({ data: (await pool.query(`SELECT ct.*, tt.name AS ticket_type_name, u.full_name AS sold_by_name FROM club_tickets ct JOIN club_ticket_types tt ON tt.id=ct.ticket_type_id LEFT JOIN users u ON u.id=ct.sold_by WHERE ct.event_id=$1 ORDER BY ct.created_at DESC`, [req.params.id])).rows });
    }));
    r.post('/:id/tickets/check-in', requirePermission('clubs.sell_tickets'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ code: z.string() }), req.body);
      const t = (await pool.query(`SELECT * FROM club_tickets WHERE event_id=$1 AND (qr_code=$2 OR number=$2)`, [req.params.id, b.code])).rows[0];
      if (!t) throw new NotFound('Ticket not found');
      if (t.status === 'CHECKED_IN') throw new BadRequest(`Ticket already used at ${new Date(t.checked_in_at).toLocaleTimeString()}`);
      if (t.status !== 'SOLD') throw new BadRequest(`Ticket is ${t.status}`);
      res.json((await pool.query(`UPDATE club_tickets SET status='CHECKED_IN', checked_in_at=now() WHERE id=$1 RETURNING *`, [t.id])).rows[0]);
    }));
    r.get('/:id/guest-list', requirePermission('clubs.view'), asyncHandler(async (req, res) => res.json({ data: (await pool.query(`SELECT gl.*, t.number AS table_number FROM club_guest_list gl LEFT JOIN outlet_tables t ON t.id=gl.table_id WHERE gl.event_id=$1 ORDER BY gl.is_vip DESC, gl.name`, [req.params.id])).rows })));
    r.post('/:id/guest-list', requirePermission('clubs.manage', 'clubs.sell_tickets'), asyncHandler(async (req, res) => {
      const b = validate(z.object({ name: z.string(), phone: optionalStr, plus_ones: z.coerce.number().int().default(0), table_id: z.string().uuid().nullable().optional(), is_vip: z.boolean().default(false), notes: optionalStr }), req.body);
      res.status(201).json((await pool.query(`INSERT INTO club_guest_list (event_id, name, phone, plus_ones, table_id, is_vip, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.params.id, b.name, b.phone, b.plus_ones, b.table_id ?? null, b.is_vip, b.notes])).rows[0]);
    }));
    r.post('/:id/guest-list/:gid/arrive', requirePermission('clubs.sell_tickets'), asyncHandler(async (req, res) => res.json((await pool.query(`UPDATE club_guest_list SET arrived_at=now() WHERE id=$1 AND event_id=$2 RETURNING *`, [req.params.gid, req.params.id])).rows[0])));
  } });
