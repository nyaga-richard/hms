import { Router, Request } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr, sendExport , isExport } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { nextNumber } from '../../core/numbering';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { startApproval, registerWorkflowHandler } from '../workflow/workflow.service';
import { moveStock } from './stock.service';
import { postJournal, currentBusinessDate, r2 } from '../finance/accounting.service';
import { AuthUser } from '../auth/auth.types';

/**
 * Inventory module: master data (units, categories, products, stores), stock ledger queries,
 * requisitions (department → store issue), inter-store transfers, adjustments & waste (with approval → posting),
 * stocktakes (snapshot → count → review → approve → post variance adjustment), expiry tracking, valuation.
 * All quantity changes go through moveStock (immutable ledger).
 */

// ---------------- Master data ----------------
export const unitsRouter = crudRouter({ table: 'units', entity: 'unit', permissions: { view: 'products.view', create: 'products.manage', edit: 'products.manage', delete: 'products.manage' }, searchColumns: ['code', 'name'], defaultSort: 'code',
  createSchema: z.object({ code: z.string().min(1), name: z.string().min(1), base_unit_id: z.string().uuid().nullable().optional(), factor: z.coerce.number().positive().default(1) }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), base_unit_id: z.string().uuid().nullable(), factor: z.coerce.number().positive() }).partial() });

export const productCategoriesRouter = crudRouter({ table: 'product_categories', entity: 'product_category', permissions: { view: 'products.view', create: 'products.manage', edit: 'products.manage', delete: 'products.manage' }, softDelete: true, searchColumns: ['code', 'name'], defaultSort: 'name', filters: { type: 'type', parent_id: 'parent_id' },
  selectSql: `SELECT t.*, p.name AS parent_name, ia.code AS inventory_account_code, ca.code AS cogs_account_code, (SELECT COUNT(*) FROM products x WHERE x.category_id=t.id AND x.is_active)::int AS product_count FROM product_categories t LEFT JOIN product_categories p ON p.id=t.parent_id LEFT JOIN accounts ia ON ia.id=t.inventory_account_id LEFT JOIN accounts ca ON ca.id=t.cogs_account_id`,
  createSchema: z.object({ code: z.string().min(1), name: z.string().min(1), type: z.enum(['FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'GUEST_SUPPLIES', 'MAINTENANCE', 'OFFICE', 'LINEN', 'SPA', 'OTHER']).default('OTHER'), parent_id: z.string().uuid().nullable().optional(), inventory_account_id: z.string().uuid().nullable().optional(), cogs_account_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), type: z.enum(['FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'GUEST_SUPPLIES', 'MAINTENANCE', 'OFFICE', 'LINEN', 'SPA', 'OTHER']), parent_id: z.string().uuid().nullable(), inventory_account_id: z.string().uuid().nullable(), cogs_account_id: z.string().uuid().nullable(), is_active: z.boolean() }).partial() });

const productSchema = z.object({ sku: z.string().min(1), barcode: optionalStr, name: z.string().min(1), description: optionalStr, category_id: z.string().uuid(), unit_id: z.string().uuid(), purchase_unit_id: z.string().uuid().nullable().optional(), pack_size: z.coerce.number().positive().default(1), cost_price: z.coerce.number().min(0).default(0), selling_price: z.coerce.number().min(0).default(0), tax_id: z.string().uuid().nullable().optional(),
  min_stock: z.coerce.number().min(0).default(0), max_stock: z.coerce.number().min(0).nullable().optional(), reorder_level: z.coerce.number().min(0).default(0), reorder_qty: z.coerce.number().min(0).default(0), track_batches: z.boolean().default(false), track_expiry: z.boolean().default(false), track_serial: z.boolean().default(false), is_sellable: z.boolean().default(false), is_stock_item: z.boolean().default(true), preferred_supplier_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true), image_url: optionalStr });
export const productsRouter = crudRouter({ table: 'products', entity: 'product', permissions: { view: 'products.view', create: 'products.manage', edit: 'products.manage', delete: 'products.manage' }, softDelete: true, searchColumns: ['sku', 'name', 'barcode', 'c.name'], defaultSort: 'name',
  selectSql: `SELECT t.*, c.name AS category_name, c.type AS category_type, u.code AS unit, pu.code AS purchase_unit, s.name AS supplier_name, tx.name AS tax_name, tx.rate AS tax_rate,
      (SELECT COALESCE(SUM(sb.quantity),0) FROM stock_balances sb WHERE sb.product_id=t.id) AS total_on_hand, (SELECT COALESCE(SUM(sb.quantity*sb.avg_cost),0) FROM stock_balances sb WHERE sb.product_id=t.id) AS total_value
    FROM products t JOIN product_categories c ON c.id=t.category_id JOIN units u ON u.id=t.unit_id LEFT JOIN units pu ON pu.id=t.purchase_unit_id LEFT JOIN suppliers s ON s.id=t.preferred_supplier_id LEFT JOIN taxes tx ON tx.id=t.tax_id`,
  filters: { category_id: 'category_id', category_type: 'c.type', sellable: 'is_sellable', stock_item: 'is_stock_item', supplier_id: 'preferred_supplier_id', active: 'is_active', track_expiry: 'track_expiry' },
  createSchema: productSchema, updateSchema: productSchema.partial(),
  extraRoutes: (r) => {
    r.get('/lookup/:code', requirePermission('products.view'), asyncHandler(async (req, res) => {
      const p = (await pool.query(`SELECT p.*, u.code AS unit FROM products p JOIN units u ON u.id=p.unit_id WHERE p.barcode=$1 OR p.sku=$1 LIMIT 1`, [req.params.code])).rows[0];
      if (!p) throw new NotFound('Product not found');
      res.json(p);
    }));
    r.get('/:id/stock', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
      const balances = (await pool.query(`SELECT sb.*, s.code AS store_code, s.name AS store_name, s.type AS store_type FROM stock_balances sb JOIN stores s ON s.id=sb.store_id WHERE sb.product_id=$1 AND (s.property_id=$2 OR $2 IS NULL) ORDER BY s.name`, [req.params.id, req.propertyId])).rows;
      const batches = (await pool.query(`SELECT b.*, s.name AS store_name FROM stock_batches b JOIN stores s ON s.id=b.store_id WHERE b.product_id=$1 AND b.quantity > 0 ORDER BY b.expiry_date NULLS LAST`, [req.params.id])).rows;
      const usage = (await pool.query(`SELECT date_trunc('month', business_date)::date AS month, -SUM(quantity) FILTER (WHERE quantity < 0) AS consumed, SUM(quantity) FILTER (WHERE quantity > 0 AND movement_type='PURCHASE_RECEIPT') AS purchased FROM stock_movements WHERE product_id=$1 AND business_date >= CURRENT_DATE - 180 GROUP BY 1 ORDER BY 1`, [req.params.id])).rows;
      res.json({ balances, batches, usage });
    }));
  } });

export const storesRouter = crudRouter({ table: 'stores', entity: 'store', permissions: { view: 'stores.view', create: 'stores.manage', edit: 'stores.manage', delete: 'stores.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['code', 'name'], defaultSort: 'name', filters: { type: 'type', department_id: 'department_id', outlet_id: 'outlet_id' },
  selectSql: `SELECT t.*, d.name AS department_name, o.name AS outlet_name, u.full_name AS keeper_name, (SELECT COUNT(*) FROM stock_balances sb WHERE sb.store_id=t.id AND sb.quantity<>0)::int AS sku_count, (SELECT COALESCE(SUM(sb.quantity*sb.avg_cost),0) FROM stock_balances sb WHERE sb.store_id=t.id) AS stock_value FROM stores t LEFT JOIN departments d ON d.id=t.department_id LEFT JOIN outlets o ON o.id=t.outlet_id LEFT JOIN users u ON u.id=t.keeper_user_id`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), type: z.enum(['MAIN', 'FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'ENGINEERING', 'KITCHEN', 'LAUNDRY', 'BAR', 'OUTLET', 'OTHER']).default('OTHER'), department_id: z.string().uuid().nullable().optional(), outlet_id: z.string().uuid().nullable().optional(), location: optionalStr, keeper_user_id: z.string().uuid().nullable().optional(), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ code: z.string().min(1), name: z.string().min(1), type: z.enum(['MAIN', 'FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'ENGINEERING', 'KITCHEN', 'LAUNDRY', 'BAR', 'OUTLET', 'OTHER']), department_id: z.string().uuid().nullable(), outlet_id: z.string().uuid().nullable(), location: optionalStr, keeper_user_id: z.string().uuid().nullable(), is_active: z.boolean() }).partial() });

// ---------------- Stock queries ----------------
export const stockRouter = Router();

stockRouter.get('/', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const where = ['s.property_id=$1', '(sb.quantity <> 0 OR p.reorder_level > 0)']; const params: any[] = [req.propertyId];
  if (req.query.low === 'true') where.push('sb.quantity <= p.reorder_level AND p.reorder_level > 0');
  if (req.query.negative === 'true') where.push('sb.quantity < 0');
  await runList(req, res, { select: `SELECT sb.store_id, sb.product_id, sb.quantity, sb.avg_cost, (sb.quantity*sb.avg_cost) AS value, sb.last_movement_at, p.sku, p.name AS product_name, p.reorder_level, p.min_stock, p.track_expiry, u.code AS unit, c.name AS category_name, c.type AS category_type, s.code AS store_code, s.name AS store_name,
      (sb.quantity <= p.reorder_level AND p.reorder_level > 0) AS is_low
    FROM stock_balances sb JOIN stores s ON s.id=sb.store_id JOIN products p ON p.id=sb.product_id JOIN units u ON u.id=p.unit_id JOIN product_categories c ON c.id=p.category_id`, where, params, searchColumns: ['p.sku', 'p.name', 's.name'], defaultSort: 'p.name', filters: { store_id: 'sb.store_id', product_id: 'sb.product_id', category_id: 'p.category_id', category_type: 'c.type' }, exportName: 'stock_on_hand' });
}));

stockRouter.get('/ledger', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT m.*, p.sku, p.name AS product_name, u.code AS unit, s.name AS store_name, usr.full_name AS created_by_name FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN units u ON u.id=p.unit_id JOIN stores s ON s.id=m.store_id LEFT JOIN users usr ON usr.id=m.created_by`,
    where: ['m.property_id=$1'], params: [req.propertyId], searchColumns: ['p.sku', 'p.name', 'm.reference_number', 'm.notes'], defaultSort: 'm.created_at', filters: { store_id: 'm.store_id', product_id: 'm.product_id', movement_type: 'm.movement_type', reference_type: 'm.reference_type', reference_id: 'm.reference_id' }, dateFilters: { date: 'm.business_date' }, exportName: 'stock_ledger' });
}));

stockRouter.get('/valuation', requirePermission('inventory.valuation'), asyncHandler(async (req, res) => {
  const byStore = (await pool.query(`SELECT s.id, s.code, s.name, s.type, COALESCE(SUM(sb.quantity*sb.avg_cost),0) AS value, COUNT(*) FILTER (WHERE sb.quantity<>0)::int AS skus FROM stores s LEFT JOIN stock_balances sb ON sb.store_id=s.id WHERE s.property_id=$1 AND s.is_active GROUP BY s.id ORDER BY value DESC`, [req.propertyId])).rows;
  const byCategory = (await pool.query(`SELECT c.id, c.name, c.type, COALESCE(SUM(sb.quantity*sb.avg_cost),0) AS value FROM stock_balances sb JOIN stores s ON s.id=sb.store_id JOIN products p ON p.id=sb.product_id JOIN product_categories c ON c.id=p.category_id WHERE s.property_id=$1 GROUP BY c.id ORDER BY value DESC`, [req.propertyId])).rows;
  const total = byStore.reduce((a, r) => a + Number(r.value), 0);
  const expiring = (await pool.query(`SELECT b.*, p.name AS product_name, p.sku, s.name AS store_name FROM stock_batches b JOIN products p ON p.id=b.product_id JOIN stores s ON s.id=b.store_id WHERE s.property_id=$1 AND b.quantity>0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + 30 ORDER BY b.expiry_date`, [req.propertyId])).rows;
  const low = (await pool.query(`SELECT COUNT(*)::int FROM stock_balances sb JOIN stores s ON s.id=sb.store_id JOIN products p ON p.id=sb.product_id WHERE s.property_id=$1 AND p.reorder_level>0 AND sb.quantity<=p.reorder_level`, [req.propertyId])).rows[0].count;
  res.json({ total_value: r2(total), by_store: byStore, by_category: byCategory, expiring_soon: expiring, low_stock_count: low });
}));

stockRouter.get('/expiry', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const days = Number(req.query.days ?? 30);
  await runList(req, res, { select: `SELECT b.*, p.name AS product_name, p.sku, u.code AS unit, s.name AS store_name, (b.expiry_date - CURRENT_DATE) AS days_left FROM stock_batches b JOIN products p ON p.id=b.product_id JOIN units u ON u.id=p.unit_id JOIN stores s ON s.id=b.store_id`,
    where: ['s.property_id=$1', 'b.quantity>0', 'b.expiry_date IS NOT NULL', `b.expiry_date <= CURRENT_DATE + $2::int`], params: [req.propertyId, days], defaultSort: 'b.expiry_date', filters: { store_id: 'b.store_id' }, exportName: 'expiring_stock' });
}));

// Direct issue to department (no requisition) — e.g. housekeeping supplies, kitchen daily issue
stockRouter.post('/issue', requirePermission('inventory.issue'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ store_id: z.string().uuid(), department_id: z.string().uuid().nullable().optional(), outlet_id: z.string().uuid().nullable().optional(), to_store_id: z.string().uuid().nullable().optional(), notes: optionalStr, items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.coerce.number().positive() })).min(1) }), req.body);
  const out = await withTransaction(async (c) => issueStock(c, req, { ...b, referenceType: 'ISSUE', referenceNumber: await nextNumber(c, 'ISSUE', req.propertyId) }));
  res.status(201).json(out);
}));

/** Issue stock out of a store: to another store (transfer semantics) or expensed to a department/outlet (journal DR expense/COGS, CR inventory). */
async function issueStock(c: PoolClient, req: Request, o: { store_id: string; to_store_id?: string | null; department_id?: string | null; outlet_id?: string | null; notes?: string | null; items: { product_id: string; quantity: number }[]; referenceType: string; referenceId?: string; referenceNumber: string }) {
  const bd = await currentBusinessDate(c, req.propertyId!, req.user!.id);
  const movements = []; const expenseLines: Record<string, number> = {}; const invLines: Record<string, number> = {}; let total = 0;
  for (const it of o.items) {
    const outMv = await moveStock(c, { propertyId: req.propertyId!, storeId: o.store_id, productId: it.product_id, type: o.to_store_id ? 'STORE_TRANSFER_OUT' : 'ISSUE_TO_DEPARTMENT', quantity: -it.quantity, referenceType: o.referenceType, referenceId: o.referenceId ?? null, referenceNumber: o.referenceNumber, departmentId: o.department_id ?? null, outletId: o.outlet_id ?? null, businessDate: bd, userId: req.user!.id, notes: o.notes ?? null });
    movements.push(outMv.movement);
    if (o.to_store_id) {
      const inMv = await moveStock(c, { propertyId: req.propertyId!, storeId: o.to_store_id, productId: it.product_id, type: 'STORE_TRANSFER_IN', quantity: it.quantity, unitCost: outMv.unitCost, referenceType: o.referenceType, referenceId: o.referenceId ?? null, referenceNumber: o.referenceNumber, businessDate: bd, userId: req.user!.id });
      movements.push(inMv.movement);
    } else if (!outMv.skipped) {
      // expensed: department consumption (COGS account of the category, or expense mapping)
      const cat = (await c.query(`SELECT pc.inventory_account_id, pc.cogs_account_id FROM products p JOIN product_categories pc ON pc.id=p.category_id WHERE p.id=$1`, [it.product_id])).rows[0];
      const val = r2(it.quantity * outMv.unitCost); total += val;
      const ek = cat?.cogs_account_id ?? 'GENERAL_EXPENSE'; const ik = cat?.inventory_account_id ?? 'INVENTORY';
      expenseLines[ek] = (expenseLines[ek] ?? 0) + val; invLines[ik] = (invLines[ik] ?? 0) + val;
    }
  }
  let journal = null;
  if (!o.to_store_id && total > 0) {
    const isUuid = (k: string) => /^[0-9a-f-]{36}$/.test(k);
    journal = await postJournal(c, { propertyId: req.propertyId!, businessDate: bd, description: `Stock issue ${o.referenceNumber}`, sourceType: o.referenceType, sourceId: o.referenceId ?? null, userId: req.user!.id, lines: [
      ...Object.entries(expenseLines).map(([k, v]) => (isUuid(k) ? { accountId: k, debit: r2(v), departmentId: o.department_id ?? null, outletId: o.outlet_id ?? null } : { mappingKey: k, debit: r2(v), departmentId: o.department_id ?? null, outletId: o.outlet_id ?? null })),
      ...Object.entries(invLines).map(([k, v]) => (isUuid(k) ? { accountId: k, credit: r2(v) } : { mappingKey: k, credit: r2(v) }))] });
    for (const m of movements) if (m) await c.query(`UPDATE stock_movements SET journal_entry_id=$2 WHERE id=$1`, [m.id, journal.id]);
  }
  await audit({ ...auditCtx(req), action: 'STOCK_ISSUE', entityType: o.referenceType.toLowerCase(), entityId: o.referenceId ?? null, newValue: { number: o.referenceNumber, items: o.items, total } }, c);
  return { number: o.referenceNumber, movements: movements.filter(Boolean), total: r2(total), journal_id: journal?.id ?? null };
}

// ---------------- Requisitions ----------------
export const requisitionsRouter = Router();
const reqSelect = `SELECT q.*, s.name AS store_name, ts.name AS to_store_name, d.name AS department_name, o.name AS outlet_name, rb.full_name AS requested_by_name, ab.full_name AS approved_by_name,
    (SELECT COUNT(*) FROM stock_requisition_items i WHERE i.requisition_id=q.id)::int AS item_count,
    (SELECT COALESCE(SUM(i.requested_qty * p.cost_price),0) FROM stock_requisition_items i JOIN products p ON p.id=i.product_id WHERE i.requisition_id=q.id) AS estimated_value
  FROM stock_requisitions q JOIN stores s ON s.id=q.store_id LEFT JOIN stores ts ON ts.id=q.to_store_id LEFT JOIN departments d ON d.id=q.department_id LEFT JOIN outlets o ON o.id=q.outlet_id LEFT JOIN users rb ON rb.id=q.requested_by LEFT JOIN users ab ON ab.id=q.approved_by`;

requisitionsRouter.get('/', requirePermission('requisitions.view'), asyncHandler(async (req, res) => {
  const where = ['q.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.mine === 'true') { params.push(req.user!.id); where.push(`q.requested_by=$${params.length}`); }
  await runList(req, res, { select: reqSelect, where, params, searchColumns: ['q.number', 'd.name', 's.name', 'q.purpose'], defaultSort: 'q.created_at', filters: { status: 'q.status', store_id: 'q.store_id', department_id: 'q.department_id', to_store_id: 'q.to_store_id' }, dateFilters: { date: 'q.created_at::date' }, exportName: 'requisitions' });
}));
requisitionsRouter.post('/', requirePermission('requisitions.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ store_id: z.string().uuid(), department_id: z.string().uuid().nullable().optional(), to_store_id: z.string().uuid().nullable().optional(), outlet_id: z.string().uuid().nullable().optional(), purpose: optionalStr, submit: z.boolean().default(true), items: z.array(z.object({ product_id: z.string().uuid(), requested_qty: z.coerce.number().positive(), notes: optionalStr })).min(1) }), req.body);
  if (!b.department_id && !b.to_store_id && !b.outlet_id) throw new BadRequest('Specify the requesting department, outlet or destination store');
  const out = await withTransaction(async (c) => {
    const number = await nextNumber(c, 'REQUISITION', req.propertyId);
    const q = (await c.query(`INSERT INTO stock_requisitions (property_id, number, store_id, department_id, to_store_id, outlet_id, status, purpose, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.propertyId, number, b.store_id, b.department_id ?? req.user!.department_id ?? null, b.to_store_id ?? null, b.outlet_id ?? null, b.submit ? 'PENDING' : 'DRAFT', b.purpose ?? null, req.user!.id])).rows[0];
    for (const it of b.items) await c.query(`INSERT INTO stock_requisition_items (requisition_id, product_id, requested_qty, notes) VALUES ($1,$2,$3,$4)`, [q.id, it.product_id, it.requested_qty, it.notes ?? null]);
    if (b.submit) await submitRequisition(c, req, q);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'stock_requisition', entityId: q.id, newValue: { ...q, items: b.items } }, c);
    return (await c.query(`${reqSelect} WHERE q.id=$1`, [q.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function submitRequisition(c: PoolClient, req: Request, q: any) {
  const est = Number((await c.query(`SELECT COALESCE(SUM(i.requested_qty*p.cost_price),0) AS v FROM stock_requisition_items i JOIN products p ON p.id=i.product_id WHERE i.requisition_id=$1`, [q.id])).rows[0].v);
  const appr = await startApproval(c, { transactionType: 'PURCHASE_REQUISITION', entityType: 'stock_requisition', entityId: q.id, entityNumber: q.number, amount: est, propertyId: req.propertyId!, user: req.user!, title: `Stock requisition ${q.number}`, link: `/inventory/requisitions/${q.id}` });
  if (appr.status === 'APPROVED') {
    await c.query(`UPDATE stock_requisitions SET status='APPROVED', approved_by=$2, approved_at=now() WHERE id=$1`, [q.id, req.user!.id]);
    await c.query(`UPDATE stock_requisition_items SET approved_qty=requested_qty WHERE requisition_id=$1`, [q.id]);
  } else await c.query(`UPDATE stock_requisitions SET status='PENDING' WHERE id=$1`, [q.id]);
  const keeper = (await c.query(`SELECT keeper_user_id FROM stores WHERE id=$1`, [q.store_id])).rows[0]?.keeper_user_id;
  await notify({ userIds: keeper ? [keeper] : undefined, permission: keeper ? undefined : 'inventory.issue', propertyId: req.propertyId, type: 'REQUISITION', title: `Requisition ${q.number} ${appr.status === 'APPROVED' ? 'ready to issue' : 'submitted'}`, entityType: 'stock_requisition', entityId: q.id, link: `/inventory/requisitions/${q.id}` }, c);
}
// PURCHASE_REQUISITION workflow handler (covers both stock & purchase requisitions) lives in procurement.routes.ts
requisitionsRouter.get('/:id', requirePermission('requisitions.view'), asyncHandler(async (req, res) => {
  const q = (await pool.query(`${reqSelect} WHERE q.id=$1`, [req.params.id])).rows[0];
  if (!q) throw new NotFound('Requisition not found');
  q.items = (await pool.query(`SELECT i.*, p.sku, p.name AS product_name, p.cost_price, u.code AS unit, COALESCE(sb.quantity,0) AS available FROM stock_requisition_items i JOIN products p ON p.id=i.product_id JOIN units u ON u.id=p.unit_id LEFT JOIN stock_balances sb ON sb.product_id=p.id AND sb.store_id=$2 WHERE i.requisition_id=$1 ORDER BY p.name`, [q.id, q.store_id])).rows;
  q.movements = (await pool.query(`SELECT m.*, p.name AS product_name, s.name AS store_name FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN stores s ON s.id=m.store_id WHERE m.reference_type='REQUISITION' AND m.reference_id=$1 ORDER BY m.created_at`, [q.id])).rows;
  res.json(q);
}));
requisitionsRouter.post('/:id/submit', requirePermission('requisitions.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const q = (await c.query(`SELECT * FROM stock_requisitions WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!q) throw new NotFound('Requisition not found');
    if (q.status !== 'DRAFT') throw Errors.invalidStatus('requisition', q.status, 'submit');
    await submitRequisition(c, req, q);
    return (await c.query(`${reqSelect} WHERE q.id=$1`, [q.id])).rows[0];
  });
  res.json(out);
}));
requisitionsRouter.post('/:id/approve', requirePermission('requisitions.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ items: z.array(z.object({ id: z.string().uuid(), approved_qty: z.coerce.number().min(0) })).optional(), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const q = (await c.query(`SELECT * FROM stock_requisitions WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!q) throw new NotFound('Requisition not found');
    if (!['PENDING', 'DRAFT'].includes(q.status)) throw Errors.invalidStatus('requisition', q.status, 'approve');
    for (const it of b.items ?? []) await c.query(`UPDATE stock_requisition_items SET approved_qty=$2 WHERE id=$1 AND requisition_id=$3`, [it.id, it.approved_qty, q.id]);
    await c.query(`UPDATE stock_requisition_items SET approved_qty=requested_qty WHERE requisition_id=$1 AND approved_qty IS NULL`, [q.id]);
    await c.query(`UPDATE stock_requisitions SET status='APPROVED', approved_by=$2, approved_at=now() WHERE id=$1`, [q.id, req.user!.id]);
    await c.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE entity_type='stock_requisition' AND entity_id=$1 AND status='PENDING'`, [q.id]);
    await notify({ userIds: [q.requested_by], type: 'REQUISITION_APPROVED', title: `Requisition ${q.number} approved`, entityType: 'stock_requisition', entityId: q.id, link: `/inventory/requisitions/${q.id}`, severity: 'SUCCESS' }, c);
    await audit({ ...auditCtx(req), action: 'APPROVE', entityType: 'stock_requisition', entityId: q.id, newValue: b }, c);
    return (await c.query(`${reqSelect} WHERE q.id=$1`, [q.id])).rows[0];
  });
  res.json(out);
}));
requisitionsRouter.post('/:id/reject', requirePermission('requisitions.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const q = (await c.query(`UPDATE stock_requisitions SET status='REJECTED', approved_by=$2 WHERE id=$1 AND status IN ('PENDING','DRAFT') RETURNING *`, [req.params.id, req.user!.id])).rows[0];
    if (!q) throw new BadRequest('Requisition cannot be rejected in its current status');
    await c.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE entity_type='stock_requisition' AND entity_id=$1 AND status='PENDING'`, [q.id]);
    await notify({ userIds: [q.requested_by], type: 'REQUISITION_REJECTED', title: `Requisition ${q.number} rejected`, body: b.reason, entityType: 'stock_requisition', entityId: q.id, link: `/inventory/requisitions/${q.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'REJECT', entityType: 'stock_requisition', entityId: q.id, reason: b.reason }, c);
    return q;
  });
  res.json(out);
}));
// Issue approved quantities (full or partial) → ledger + journal (department expense) or store-to-store transfer
requisitionsRouter.post('/:id/issue', requirePermission('inventory.issue'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ items: z.array(z.object({ id: z.string().uuid(), quantity: z.coerce.number().min(0) })).optional(), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const q = (await c.query(`SELECT * FROM stock_requisitions WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!q) throw new NotFound('Requisition not found');
    if (!['APPROVED', 'PARTIALLY_ISSUED'].includes(q.status)) throw Errors.invalidStatus('requisition', q.status, 'issue');
    const lines = (await c.query(`SELECT * FROM stock_requisition_items WHERE requisition_id=$1`, [q.id])).rows;
    const toIssue: { product_id: string; quantity: number; line: any }[] = [];
    for (const l of lines) {
      const remaining = Number(l.approved_qty ?? l.requested_qty) - Number(l.issued_qty);
      const want = b.items ? Number(b.items.find((x) => x.id === l.id)?.quantity ?? 0) : remaining;
      if (want <= 0) continue;
      if (want > remaining + 0.0001) throw new BadRequest(`Cannot issue more than the approved remaining quantity (${remaining}) for a line`);
      toIssue.push({ product_id: l.product_id, quantity: want, line: l });
    }
    if (!toIssue.length) throw new BadRequest('Nothing to issue');
    const result = await issueStock(c, req, { store_id: q.store_id, to_store_id: q.to_store_id, department_id: q.department_id, outlet_id: q.outlet_id, notes: b.notes, items: toIssue.map((t) => ({ product_id: t.product_id, quantity: t.quantity })), referenceType: 'REQUISITION', referenceId: q.id, referenceNumber: q.number });
    for (const t of toIssue) await c.query(`UPDATE stock_requisition_items SET issued_qty = issued_qty + $2 WHERE id=$1`, [t.line.id, t.quantity]);
    const left = (await c.query(`SELECT COALESCE(SUM(COALESCE(approved_qty, requested_qty) - issued_qty),0) AS rem FROM stock_requisition_items WHERE requisition_id=$1`, [q.id])).rows[0].rem;
    await c.query(`UPDATE stock_requisitions SET status=$2, issued_by=$3, issued_at=now() WHERE id=$1`, [q.id, Number(left) > 0.0001 ? 'PARTIALLY_ISSUED' : 'ISSUED', req.user!.id]);
    await notify({ userIds: [q.requested_by], type: 'REQUISITION_ISSUED', title: `Requisition ${q.number} ${Number(left) > 0.0001 ? 'partially ' : ''}issued`, entityType: 'stock_requisition', entityId: q.id, link: `/inventory/requisitions/${q.id}`, severity: 'SUCCESS' }, c);
    return { ...result, requisition: (await c.query(`${reqSelect} WHERE q.id=$1`, [q.id])).rows[0] };
  });
  res.json(out);
}));
requisitionsRouter.post('/:id/cancel', requirePermission('requisitions.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const q = await withTransaction(async (c) => {
    const old = (await c.query(`SELECT * FROM stock_requisitions WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!old) throw new NotFound('Requisition not found');
    if (!['DRAFT', 'PENDING', 'APPROVED'].includes(old.status)) throw Errors.invalidStatus('requisition', old.status, 'cancel');
    if (old.requested_by !== req.user!.id && !hasPermission(req, 'requisitions.approve')) throw new Forbidden();
    const r = (await c.query(`UPDATE stock_requisitions SET status='CANCELLED' WHERE id=$1 RETURNING *`, [old.id])).rows[0];
    await c.query(`UPDATE approval_requests SET status='CANCELLED', completed_at=now() WHERE entity_type='stock_requisition' AND entity_id=$1 AND status='PENDING'`, [old.id]);
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'stock_requisition', entityId: old.id, reason: b.reason }, c);
    return r;
  });
  res.json(q);
}));

// ---------------- Transfers (store → store, two-step: dispatch → receive) ----------------
export const transfersRouter = Router();
const trSelect = `SELECT t.*, fs.name AS from_store_name, ts.name AS to_store_name, cb.full_name AS created_by_name, rb.full_name AS received_by_name, (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id=t.id)::int AS item_count, (SELECT COALESCE(SUM(i.quantity*i.unit_cost),0) FROM stock_transfer_items i WHERE i.transfer_id=t.id) AS value
  FROM stock_transfers t JOIN stores fs ON fs.id=t.from_store_id JOIN stores ts ON ts.id=t.to_store_id LEFT JOIN users cb ON cb.id=t.created_by LEFT JOIN users rb ON rb.id=t.received_by`;
transfersRouter.get('/', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: trSelect, where: ['t.property_id=$1'], params: [req.propertyId], searchColumns: ['t.number', 'fs.name', 'ts.name'], defaultSort: 't.created_at', filters: { status: 't.status', from_store_id: 't.from_store_id', to_store_id: 't.to_store_id' }, dateFilters: { date: 't.created_at::date' }, exportName: 'stock_transfers' });
}));
transfersRouter.post('/', requirePermission('inventory.transfer'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ from_store_id: z.string().uuid(), to_store_id: z.string().uuid(), notes: optionalStr, dispatch: z.boolean().default(true), items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.coerce.number().positive() })).min(1) }), req.body);
  if (b.from_store_id === b.to_store_id) throw new BadRequest('Source and destination stores must differ');
  const out = await withTransaction(async (c) => {
    const number = await nextNumber(c, 'TRANSFER', req.propertyId);
    const t = (await c.query(`INSERT INTO stock_transfers (property_id, number, from_store_id, to_store_id, status, notes, created_by) VALUES ($1,$2,$3,$4,'DRAFT',$5,$6) RETURNING *`, [req.propertyId, number, b.from_store_id, b.to_store_id, b.notes ?? null, req.user!.id])).rows[0];
    for (const it of b.items) {
      const cost = (await c.query(`SELECT COALESCE(sb.avg_cost, p.cost_price) AS c FROM products p LEFT JOIN stock_balances sb ON sb.product_id=p.id AND sb.store_id=$2 WHERE p.id=$1`, [it.product_id, b.from_store_id])).rows[0]?.c ?? 0;
      await c.query(`INSERT INTO stock_transfer_items (transfer_id, product_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)`, [t.id, it.product_id, it.quantity, cost]);
    }
    if (b.dispatch) await dispatchTransfer(c, req, t.id);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'stock_transfer', entityId: t.id, newValue: { ...t, items: b.items } }, c);
    return (await c.query(`${trSelect} WHERE t.id=$1`, [t.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function dispatchTransfer(c: PoolClient, req: Request, id: string) {
  const t = (await c.query(`SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (t.status !== 'DRAFT') throw Errors.invalidStatus('transfer', t.status, 'dispatch');
  const bd = await currentBusinessDate(c, t.property_id, req.user!.id);
  const items = (await c.query(`SELECT * FROM stock_transfer_items WHERE transfer_id=$1`, [id])).rows;
  for (const it of items) {
    const mv = await moveStock(c, { propertyId: t.property_id, storeId: t.from_store_id, productId: it.product_id, type: 'STORE_TRANSFER_OUT', quantity: -Number(it.quantity), referenceType: 'TRANSFER', referenceId: t.id, referenceNumber: t.number, businessDate: bd, userId: req.user!.id });
    await c.query(`UPDATE stock_transfer_items SET unit_cost=$2 WHERE id=$1`, [it.id, mv.unitCost]);
  }
  await c.query(`UPDATE stock_transfers SET status='IN_TRANSIT' WHERE id=$1`, [id]);
  const keeper = (await c.query(`SELECT keeper_user_id, name FROM stores WHERE id=$1`, [t.to_store_id])).rows[0];
  await notify({ userIds: keeper?.keeper_user_id ? [keeper.keeper_user_id] : undefined, permission: keeper?.keeper_user_id ? undefined : 'inventory.transfer', propertyId: t.property_id, type: 'TRANSFER_IN_TRANSIT', title: `Transfer ${t.number} dispatched to ${keeper?.name ?? 'your store'}`, body: 'Receive it to update stock', entityType: 'stock_transfer', entityId: t.id, link: `/inventory/transfers/${t.id}` }, c);
}
transfersRouter.get('/:id', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const t = (await pool.query(`${trSelect} WHERE t.id=$1`, [req.params.id])).rows[0];
  if (!t) throw new NotFound('Transfer not found');
  t.items = (await pool.query(`SELECT i.*, p.sku, p.name AS product_name, u.code AS unit FROM stock_transfer_items i JOIN products p ON p.id=i.product_id JOIN units u ON u.id=p.unit_id WHERE i.transfer_id=$1 ORDER BY p.name`, [t.id])).rows;
  res.json(t);
}));
transfersRouter.post('/:id/dispatch', requirePermission('inventory.transfer'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { await dispatchTransfer(c, req, req.params.id); return (await c.query(`${trSelect} WHERE t.id=$1`, [req.params.id])).rows[0]; });
  res.json(out);
}));
transfersRouter.post('/:id/receive', requirePermission('inventory.transfer', 'inventory.issue'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ items: z.array(z.object({ id: z.string().uuid(), received_qty: z.coerce.number().min(0) })).optional(), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const t = (await c.query(`SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!t) throw new NotFound('Transfer not found');
    if (t.status !== 'IN_TRANSIT') throw Errors.invalidStatus('transfer', t.status, 'receive');
    const bd = await currentBusinessDate(c, t.property_id, req.user!.id);
    const items = (await c.query(`SELECT * FROM stock_transfer_items WHERE transfer_id=$1`, [t.id])).rows;
    let shortfall = 0;
    for (const it of items) {
      const recv = b.items ? Number(b.items.find((x) => x.id === it.id)?.received_qty ?? it.quantity) : Number(it.quantity);
      if (recv > Number(it.quantity) + 0.0001) throw new BadRequest('Cannot receive more than dispatched');
      if (recv > 0) await moveStock(c, { propertyId: t.property_id, storeId: t.to_store_id, productId: it.product_id, type: 'STORE_TRANSFER_IN', quantity: recv, unitCost: Number(it.unit_cost), referenceType: 'TRANSFER', referenceId: t.id, referenceNumber: t.number, businessDate: bd, userId: req.user!.id });
      const diff = Number(it.quantity) - recv;
      if (diff > 0.0001) {
        // in-transit loss: expense it (DR waste/stock variance, CR inventory) — stock already left source store
        shortfall += diff * Number(it.unit_cost);
        await c.query(`UPDATE stock_transfer_items SET quantity=$2 WHERE id=$1`, [it.id, recv]);
        await c.query(`INSERT INTO stock_movements (property_id, store_id, product_id, movement_type, quantity, unit_cost, total_cost, balance_after, reference_type, reference_id, reference_number, business_date, notes, created_by) SELECT $1,$2,$3,'DAMAGE',0,$4,0,COALESCE((SELECT quantity FROM stock_balances WHERE store_id=$2 AND product_id=$3),0),'TRANSFER',$5,$6,$7,$8,$9`, [t.property_id, t.to_store_id, it.product_id, it.unit_cost, t.id, t.number, bd, `Transit shortfall ${diff}`, req.user!.id]);
      }
    }
    if (shortfall > 0) await postJournal(c, { propertyId: t.property_id, businessDate: bd, description: `Transit loss on transfer ${t.number}`, sourceType: 'TRANSFER', sourceId: t.id, userId: req.user!.id, lines: [{ mappingKey: 'STOCK_VARIANCE', debit: r2(shortfall) }, { mappingKey: 'INVENTORY', credit: r2(shortfall) }] });
    const r = (await c.query(`UPDATE stock_transfers SET status='COMPLETED', received_by=$2, completed_at=now(), notes=COALESCE($3, notes) WHERE id=$1 RETURNING *`, [t.id, req.user!.id, b.notes ?? null])).rows[0];
    await audit({ ...auditCtx(req), action: 'RECEIVE', entityType: 'stock_transfer', entityId: t.id, newValue: { items: b.items, shortfall } }, c);
    return r;
  });
  res.json(out);
}));
transfersRouter.post('/:id/cancel', requirePermission('inventory.transfer'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const t = (await c.query(`SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!t) throw new NotFound('Transfer not found');
    if (t.status === 'IN_TRANSIT') {
      // return goods to source store
      const bd = await currentBusinessDate(c, t.property_id, req.user!.id);
      for (const it of (await c.query(`SELECT * FROM stock_transfer_items WHERE transfer_id=$1`, [t.id])).rows) await moveStock(c, { propertyId: t.property_id, storeId: t.from_store_id, productId: it.product_id, type: 'STORE_TRANSFER_IN', quantity: Number(it.quantity), unitCost: Number(it.unit_cost), referenceType: 'TRANSFER', referenceId: t.id, referenceNumber: t.number, businessDate: bd, userId: req.user!.id, notes: `Cancelled: ${b.reason}` });
    } else if (t.status !== 'DRAFT') throw Errors.invalidStatus('transfer', t.status, 'cancel');
    const r = (await c.query(`UPDATE stock_transfers SET status='CANCELLED', notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']' WHERE id=$1 RETURNING *`, [t.id, b.reason])).rows[0];
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'stock_transfer', entityId: t.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- Adjustments & waste (approval → posting) ----------------
export const adjustmentsRouter = Router();
const adjSelect = `SELECT a.*, s.name AS store_name, d.name AS department_name, o.name AS outlet_name, cb.full_name AS created_by_name, ab.full_name AS approved_by_name, (SELECT COUNT(*) FROM stock_adjustment_items i WHERE i.adjustment_id=a.id)::int AS item_count
  FROM stock_adjustments a JOIN stores s ON s.id=a.store_id LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN outlets o ON o.id=a.outlet_id LEFT JOIN users cb ON cb.id=a.created_by LEFT JOIN users ab ON ab.id=a.approved_by`;
const WASTE_TYPES = ['WASTE', 'DAMAGE', 'EXPIRY', 'DISPOSAL'];

adjustmentsRouter.get('/', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const where = ['a.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.waste === 'true') where.push(`a.type IN ('WASTE','DAMAGE','EXPIRY','DISPOSAL')`);
  await runList(req, res, { select: adjSelect, where, params, searchColumns: ['a.number', 'a.reason', 's.name'], defaultSort: 'a.created_at', filters: { status: 'a.status', type: 'a.type', store_id: 'a.store_id', outlet_id: 'a.outlet_id' }, dateFilters: { date: 'a.created_at::date' }, exportName: 'stock_adjustments' });
}));
adjustmentsRouter.post('/', requirePermission('inventory.adjust', 'inventory.waste'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ store_id: z.string().uuid(), type: z.enum(['STOCK_ADJUSTMENT', 'WASTE', 'DAMAGE', 'EXPIRY', 'DISPOSAL']).default('STOCK_ADJUSTMENT'), reason: z.string().min(2), department_id: z.string().uuid().nullable().optional(), outlet_id: z.string().uuid().nullable().optional(), notes: optionalStr,
    items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.coerce.number().optional(), new_qty: z.coerce.number().optional(), reason: optionalStr })).min(1) }), req.body);
  const isWaste = WASTE_TYPES.includes(b.type);
  if (isWaste && !hasPermission(req, 'inventory.waste')) throw new Forbidden('inventory.waste permission required');
  if (!isWaste && !hasPermission(req, 'inventory.adjust')) throw new Forbidden('inventory.adjust permission required');
  const out = await withTransaction(async (c) => {
    const number = await nextNumber(c, isWaste ? 'WASTE' : 'ADJUSTMENT', req.propertyId);
    const a = (await c.query(`INSERT INTO stock_adjustments (property_id, number, store_id, reason, type, status, department_id, outlet_id, created_by, notes) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9) RETURNING *`, [req.propertyId, number, b.store_id, b.reason, b.type, b.department_id ?? null, b.outlet_id ?? null, req.user!.id, b.notes ?? null])).rows[0];
    let total = 0;
    for (const it of b.items) {
      const bal = (await c.query(`SELECT COALESCE(sb.quantity,0) AS qty, COALESCE(sb.avg_cost, p.cost_price) AS cost FROM products p LEFT JOIN stock_balances sb ON sb.product_id=p.id AND sb.store_id=$2 WHERE p.id=$1`, [it.product_id, b.store_id])).rows[0];
      if (!bal) throw new NotFound('Product not found');
      const prev = Number(bal.qty);
      let variance: number;
      if (isWaste) { if (!it.quantity || it.quantity <= 0) throw new BadRequest('Waste quantity must be positive'); variance = -it.quantity; }
      else if (it.new_qty !== undefined) variance = it.new_qty - prev;
      else if (it.quantity !== undefined) variance = it.quantity;
      else throw new BadRequest('Provide new_qty or quantity (signed) for adjustments');
      if (Math.abs(variance) < 0.0001) continue;
      await c.query(`INSERT INTO stock_adjustment_items (adjustment_id, product_id, previous_qty, new_qty, variance_qty, unit_cost, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [a.id, it.product_id, prev, prev + variance, variance, bal.cost, it.reason ?? null]);
      total += variance * Number(bal.cost);
    }
    await c.query(`UPDATE stock_adjustments SET total_value=$2 WHERE id=$1`, [a.id, r2(total)]);
    const appr = await startApproval(c, { transactionType: isWaste ? 'WASTE' : 'STOCK_ADJUSTMENT', entityType: 'stock_adjustment', entityId: a.id, entityNumber: number, amount: Math.abs(total), propertyId: req.propertyId!, user: req.user!, title: `${isWaste ? 'Waste' : 'Stock adjustment'} ${number} (${r2(Math.abs(total))})`, link: `/inventory/adjustments/${a.id}` });
    if (appr.status === 'APPROVED') {
      // No workflow configured: creator must hold the approve permission to auto-post; otherwise stays PENDING for a manager.
      if (hasPermission(req, isWaste ? 'inventory.approve_waste' : 'inventory.approve_adjustment')) await postAdjustment(c, a.id, req.user!);
      else await notify({ permission: isWaste ? 'inventory.approve_waste' : 'inventory.approve_adjustment', propertyId: req.propertyId, type: 'ADJUSTMENT_PENDING', title: `${isWaste ? 'Waste' : 'Adjustment'} ${number} awaiting approval`, entityType: 'stock_adjustment', entityId: a.id, link: `/inventory/adjustments/${a.id}` }, c);
    }
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'stock_adjustment', entityId: a.id, newValue: { ...a, items: b.items, total } }, c);
    return (await c.query(`${adjSelect} WHERE a.id=$1`, [a.id])).rows[0];
  });
  res.status(201).json(out);
}));
/** Post an approved adjustment: ledger movements per line + journal (DR expense/waste or CR gain, vs inventory). */
export async function postAdjustment(c: PoolClient, id: string, user: AuthUser) {
  const a = (await c.query(`SELECT * FROM stock_adjustments WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!a) throw new NotFound('Adjustment not found');
  if (a.status === 'POSTED') return a;
  if (!['PENDING', 'APPROVED'].includes(a.status)) throw Errors.invalidStatus('adjustment', a.status, 'post');
  const bd = await currentBusinessDate(c, a.property_id, user.id);
  const items = (await c.query(`SELECT i.*, pc.inventory_account_id, pc.cogs_account_id FROM stock_adjustment_items i JOIN products p ON p.id=i.product_id JOIN product_categories pc ON pc.id=p.category_id WHERE i.adjustment_id=$1`, [id])).rows;
  const isWaste = WASTE_TYPES.includes(a.type);
  const inv: Record<string, number> = {}; let net = 0;
  for (const it of items) {
    const v = Number(it.variance_qty); if (Math.abs(v) < 0.0001) continue;
    const mv = await moveStock(c, { propertyId: a.property_id, storeId: a.store_id, productId: it.product_id, type: isWaste ? (a.type as any) : 'STOCK_ADJUSTMENT', quantity: v, unitCost: v > 0 ? Number(it.unit_cost) : undefined, referenceType: 'ADJUSTMENT', referenceId: a.id, referenceNumber: a.number, departmentId: a.department_id, outletId: a.outlet_id, businessDate: bd, userId: user.id, notes: it.reason ?? a.reason, allowNegative: true });
    const val = r2(v * (mv.unitCost || Number(it.unit_cost)));
    const k = it.inventory_account_id ?? 'INVENTORY'; inv[k] = (inv[k] ?? 0) + val; net += val;
  }
  let journalId: string | null = null;
  if (Math.abs(net) >= 0.01) {
    const isUuid = (k: string) => /^[0-9a-f-]{36}$/.test(k);
    const lines: any[] = Object.entries(inv).map(([k, v]) => ({ ...(isUuid(k) ? { accountId: k } : { mappingKey: k }), ...(v > 0 ? { debit: r2(v) } : { credit: r2(-v) }) }));
    // counter-entry: waste expense for losses, stock variance for count differences (gain or loss)
    lines.push({ mappingKey: isWaste ? 'WASTE_EXPENSE' : 'STOCK_VARIANCE', ...(net < 0 ? { debit: r2(-net) } : { credit: r2(net) }), departmentId: a.department_id, outletId: a.outlet_id, description: a.reason });
    const j = await postJournal(c, { propertyId: a.property_id, businessDate: bd, description: `${isWaste ? 'Waste' : 'Stock adjustment'} ${a.number}: ${a.reason}`, sourceType: 'ADJUSTMENT', sourceId: a.id, userId: user.id, lines });
    journalId = j.id;
    await c.query(`UPDATE stock_movements SET journal_entry_id=$2 WHERE reference_type='ADJUSTMENT' AND reference_id=$1`, [a.id, journalId]);
  }
  const r = (await c.query(`UPDATE stock_adjustments SET status='POSTED', approved_by=COALESCE(approved_by,$2), approved_at=COALESCE(approved_at, now()), posted_at=now(), journal_entry_id=$3, total_value=$4 WHERE id=$1 RETURNING *`, [id, user.id, journalId, r2(net)])).rows[0];
  await audit({ userId: user.id, username: user.username, propertyId: a.property_id, action: 'STOCK_ADJUSTMENT', entityType: 'stock_adjustment', entityId: id, newValue: { net, journalId } }, c);
  return r;
}
registerWorkflowHandler('STOCK_ADJUSTMENT', { onApproved: async (c, id, _r, user) => { await postAdjustment(c, id, user); }, onRejected: async (c, id) => { await c.query(`UPDATE stock_adjustments SET status='REJECTED' WHERE id=$1 AND status='PENDING'`, [id]); } });
registerWorkflowHandler('WASTE', { onApproved: async (c, id, _r, user) => { await postAdjustment(c, id, user); }, onRejected: async (c, id) => { await c.query(`UPDATE stock_adjustments SET status='REJECTED' WHERE id=$1 AND status='PENDING'`, [id]); } });

adjustmentsRouter.get('/:id', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const a = (await pool.query(`${adjSelect} WHERE a.id=$1`, [req.params.id])).rows[0];
  if (!a) throw new NotFound('Adjustment not found');
  a.items = (await pool.query(`SELECT i.*, p.sku, p.name AS product_name, u.code AS unit, (i.variance_qty*i.unit_cost) AS value FROM stock_adjustment_items i JOIN products p ON p.id=i.product_id JOIN units u ON u.id=p.unit_id WHERE i.adjustment_id=$1 ORDER BY p.name`, [a.id])).rows;
  a.approval = (await pool.query(`SELECT * FROM approval_requests WHERE entity_type='stock_adjustment' AND entity_id=$1 ORDER BY requested_at DESC LIMIT 1`, [a.id])).rows[0] ?? null;
  res.json(a);
}));
adjustmentsRouter.post('/:id/approve', requirePermission('inventory.approve_adjustment', 'inventory.approve_waste'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const a = (await c.query(`SELECT * FROM stock_adjustments WHERE id=$1`, [req.params.id])).rows[0];
    if (!a) throw new NotFound('Adjustment not found');
    const isWaste = WASTE_TYPES.includes(a.type);
    if (!hasPermission(req, isWaste ? 'inventory.approve_waste' : 'inventory.approve_adjustment')) throw new Forbidden();
    if (a.created_by === req.user!.id && !req.user!.is_superuser) throw new Forbidden('Segregation of duties: you cannot approve your own adjustment');
    await c.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE entity_type='stock_adjustment' AND entity_id=$1 AND status='PENDING'`, [a.id]);
    return postAdjustment(c, a.id, req.user!);
  });
  res.json(out);
}));
adjustmentsRouter.post('/:id/reject', requirePermission('inventory.approve_adjustment', 'inventory.approve_waste'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const a = (await c.query(`UPDATE stock_adjustments SET status='REJECTED', notes=COALESCE(notes,'') || ' [rejected: ' || $2 || ']' WHERE id=$1 AND status IN ('PENDING','APPROVED') RETURNING *`, [req.params.id, b.reason])).rows[0];
    if (!a) throw new BadRequest('Adjustment cannot be rejected in its current status');
    await c.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE entity_type='stock_adjustment' AND entity_id=$1 AND status='PENDING'`, [a.id]);
    await notify({ userIds: [a.created_by], type: 'ADJUSTMENT_REJECTED', title: `${a.number} rejected`, body: b.reason, entityType: 'stock_adjustment', entityId: a.id, link: `/inventory/adjustments/${a.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'REJECT', entityType: 'stock_adjustment', entityId: a.id, reason: b.reason }, c);
    return a;
  });
  res.json(out);
}));

// ---------------- Stocktakes ----------------
export const stocktakesRouter = Router();
const stSelect = `SELECT st.*, s.name AS store_name, cb.full_name AS created_by_name, ab.full_name AS approved_by_name, (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id=st.id)::int AS item_count, (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id=st.id AND i.counted_qty IS NOT NULL)::int AS counted_count,
    (SELECT COALESCE(SUM(i.variance_qty*i.unit_cost),0) FROM stocktake_items i WHERE i.stocktake_id=st.id AND i.counted_qty IS NOT NULL) AS variance_value
  FROM stocktakes st JOIN stores s ON s.id=st.store_id LEFT JOIN users cb ON cb.id=st.created_by LEFT JOIN users ab ON ab.id=st.approved_by`;
stocktakesRouter.get('/', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: stSelect, where: ['st.property_id=$1'], params: [req.propertyId], searchColumns: ['st.number', 's.name'], defaultSort: 'st.created_at', filters: { status: 'st.status', store_id: 'st.store_id' }, dateFilters: { date: 'st.created_at::date' }, exportName: 'stocktakes' });
}));
// Open a stocktake: snapshot system quantities for every product with a balance (or a category subset)
stocktakesRouter.post('/', requirePermission('inventory.stocktake'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ store_id: z.string().uuid(), category_id: z.string().uuid().nullable().optional(), include_zero: z.boolean().default(false), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const open = (await c.query(`SELECT number FROM stocktakes WHERE store_id=$1 AND status IN ('OPEN','COUNTING','REVIEW','APPROVED')`, [b.store_id])).rows[0];
    if (open) throw new BadRequest(`Stocktake ${open.number} is still open for this store`);
    const number = await nextNumber(c, 'STOCKTAKE', req.propertyId);
    const st = (await c.query(`INSERT INTO stocktakes (property_id, number, store_id, status, snapshot_at, notes, created_by) VALUES ($1,$2,$3,'COUNTING',now(),$4,$5) RETURNING *`, [req.propertyId, number, b.store_id, b.notes ?? null, req.user!.id])).rows[0];
    const n = await c.query(`INSERT INTO stocktake_items (stocktake_id, product_id, system_qty, unit_cost)
        SELECT $1, p.id, COALESCE(sb.quantity,0), COALESCE(sb.avg_cost, p.cost_price) FROM products p LEFT JOIN stock_balances sb ON sb.product_id=p.id AND sb.store_id=$2
         WHERE p.is_active AND p.is_stock_item AND ($3::uuid IS NULL OR p.category_id=$3) AND ($4::boolean OR COALESCE(sb.quantity,0) <> 0 OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.store_id=$2 AND m.product_id=p.id))`, [st.id, b.store_id, b.category_id ?? null, b.include_zero]);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'stocktake', entityId: st.id, newValue: { ...st, lines: n.rowCount } }, c);
    return { ...st, item_count: n.rowCount };
  });
  res.status(201).json(out);
}));
stocktakesRouter.get('/:id', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const st = (await pool.query(`${stSelect} WHERE st.id=$1`, [req.params.id])).rows[0];
  if (!st) throw new NotFound('Stocktake not found');
  // blind count: hide system quantities from counters unless they can review
  const canSee = hasPermission(req, 'inventory.approve_stocktake') || hasPermission(req, 'inventory.valuation') || st.status !== 'COUNTING';
  st.items = (await pool.query(`SELECT i.id, i.product_id, p.sku, p.name AS product_name, p.barcode, u.code AS unit, c.name AS category_name, i.counted_qty, i.notes, i.counted_at, i.unit_cost,
      CASE WHEN $2 THEN i.system_qty END AS system_qty, CASE WHEN $2 THEN i.variance_qty END AS variance_qty, CASE WHEN $2 THEN i.variance_qty*i.unit_cost END AS variance_value
    FROM stocktake_items i JOIN products p ON p.id=i.product_id JOIN units u ON u.id=p.unit_id JOIN product_categories c ON c.id=p.category_id WHERE i.stocktake_id=$1 ORDER BY c.name, p.name`, [st.id, canSee])).rows;
  if (isExport(req)) { if (!hasPermission(req, 'reports.export')) throw new Forbidden(); return sendExport(res, req, st.items, `stocktake_${st.number}`); }
  res.json(st);
}));
stocktakesRouter.post('/:id/count', requirePermission('inventory.stocktake'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ items: z.array(z.object({ id: z.string().uuid().optional(), product_id: z.string().uuid().optional(), barcode: z.string().optional(), counted_qty: z.coerce.number().min(0), notes: optionalStr })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const st = (await c.query(`SELECT * FROM stocktakes WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!st) throw new NotFound('Stocktake not found');
    if (!['OPEN', 'COUNTING', 'REVIEW'].includes(st.status)) throw Errors.invalidStatus('stocktake', st.status, 'count');
    let n = 0;
    for (const it of b.items) {
      let lineId = it.id;
      if (!lineId) {
        const pid = it.product_id ?? (it.barcode ? (await c.query(`SELECT id FROM products WHERE barcode=$1 OR sku=$1`, [it.barcode])).rows[0]?.id : null);
        if (!pid) throw new BadRequest('Unknown product in count line');
        let line = (await c.query(`SELECT id FROM stocktake_items WHERE stocktake_id=$1 AND product_id=$2`, [st.id, pid])).rows[0];
        if (!line) line = (await c.query(`INSERT INTO stocktake_items (stocktake_id, product_id, system_qty, unit_cost) SELECT $1, p.id, COALESCE(sb.quantity,0), COALESCE(sb.avg_cost,p.cost_price) FROM products p LEFT JOIN stock_balances sb ON sb.product_id=p.id AND sb.store_id=$3 WHERE p.id=$2 RETURNING id`, [st.id, pid, st.store_id])).rows[0];
        lineId = line.id;
      }
      const r = await c.query(`UPDATE stocktake_items SET counted_qty=$2, notes=COALESCE($3, notes), counted_at=now() WHERE id=$1 AND stocktake_id=$4`, [lineId, it.counted_qty, it.notes ?? null, st.id]);
      n += r.rowCount ?? 0;
    }
    await c.query(`UPDATE stocktakes SET counted_by=$2 WHERE id=$1`, [st.id, req.user!.id]);
    return { updated: n };
  });
  res.json(out);
}));
stocktakesRouter.post('/:id/submit', requirePermission('inventory.stocktake'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const st = (await c.query(`SELECT * FROM stocktakes WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!st) throw new NotFound('Stocktake not found');
    if (!['OPEN', 'COUNTING'].includes(st.status)) throw Errors.invalidStatus('stocktake', st.status, 'submit');
    const uncounted = Number((await c.query(`SELECT COUNT(*) FROM stocktake_items WHERE stocktake_id=$1 AND counted_qty IS NULL`, [st.id])).rows[0].count);
    if (uncounted > 0 && req.body?.treat_uncounted_as_zero !== true) throw new BadRequest(`${uncounted} line(s) not counted. Count them or submit with treat_uncounted_as_zero=true`, { uncounted }, 'UNCOUNTED_LINES');
    if (uncounted > 0) await c.query(`UPDATE stocktake_items SET counted_qty=0, counted_at=now(), notes=COALESCE(notes,'') || ' [not counted → 0]' WHERE stocktake_id=$1 AND counted_qty IS NULL`, [st.id]);
    const r = (await c.query(`UPDATE stocktakes SET status='REVIEW', counted_by=COALESCE(counted_by,$2) WHERE id=$1 RETURNING *`, [st.id, req.user!.id])).rows[0];
    const v = (await c.query(`SELECT COALESCE(SUM(variance_qty*unit_cost),0) AS v, COUNT(*) FILTER (WHERE variance_qty<>0)::int AS n FROM stocktake_items WHERE stocktake_id=$1`, [st.id])).rows[0];
    await notify({ permission: 'inventory.approve_stocktake', propertyId: st.property_id, type: 'STOCKTAKE_REVIEW', title: `Stocktake ${st.number} ready for review`, body: `${v.n} variance line(s), net value ${r2(Number(v.v))}`, entityType: 'stocktake', entityId: st.id, link: `/inventory/stocktakes/${st.id}` }, c);
    await audit({ ...auditCtx(req), action: 'SUBMIT', entityType: 'stocktake', entityId: st.id, newValue: v }, c);
    return r;
  });
  res.json(out);
}));
// Approve & post: creates + posts a STOCK_ADJUSTMENT for all variance lines (immutable ledger + journal)
stocktakesRouter.post('/:id/approve', requirePermission('inventory.approve_stocktake'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const st = (await c.query(`SELECT * FROM stocktakes WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!st) throw new NotFound('Stocktake not found');
    if (st.status !== 'REVIEW') throw Errors.invalidStatus('stocktake', st.status, 'approve');
    if (st.counted_by === req.user!.id && !req.user!.is_superuser) throw new Forbidden('Segregation of duties: the counter cannot approve the stocktake');
    // Re-base variance against CURRENT balances (sales may have happened since the snapshot)
    const lines = (await c.query(`SELECT i.*, COALESCE(sb.quantity,0) AS current_qty FROM stocktake_items i LEFT JOIN stock_balances sb ON sb.product_id=i.product_id AND sb.store_id=$2 WHERE i.stocktake_id=$1 AND i.counted_qty IS NOT NULL`, [st.id, st.store_id])).rows;
    const variances = lines.map((l) => ({ ...l, adj: Number(l.counted_qty) - Number(l.current_qty) })).filter((l) => Math.abs(l.adj) > 0.0001);
    let adjustmentId: string | null = null;
    if (variances.length) {
      const number = await nextNumber(c, 'ADJUSTMENT', req.propertyId);
      const a = (await c.query(`INSERT INTO stock_adjustments (property_id, number, store_id, reason, type, status, stocktake_id, created_by, approved_by, approved_at, notes) VALUES ($1,$2,$3,$4,'STOCK_ADJUSTMENT','APPROVED',$5,$6,$6,now(),$7) RETURNING *`, [req.propertyId, number, st.store_id, `Stocktake ${st.number} variance`, st.id, req.user!.id, b.notes ?? null])).rows[0];
      for (const l of variances) await c.query(`INSERT INTO stock_adjustment_items (adjustment_id, product_id, previous_qty, new_qty, variance_qty, unit_cost, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [a.id, l.product_id, l.current_qty, l.counted_qty, l.adj, l.unit_cost, l.notes ?? null]);
      await postAdjustment(c, a.id, req.user!);
      adjustmentId = a.id;
    }
    const r = (await c.query(`UPDATE stocktakes SET status='POSTED', reviewed_by=$2, approved_by=$2, approved_at=now(), posted_at=now(), adjustment_id=$3, notes=COALESCE($4, notes) WHERE id=$1 RETURNING *`, [st.id, req.user!.id, adjustmentId, b.notes ?? null])).rows[0];
    await audit({ ...auditCtx(req), action: 'APPROVE', entityType: 'stocktake', entityId: st.id, newValue: { adjustmentId, variance_lines: variances.length } }, c);
    return { ...r, adjustment_id: adjustmentId, variance_lines: variances.length };
  });
  res.json(out);
}));
stocktakesRouter.post('/:id/reopen', requirePermission('inventory.approve_stocktake'), asyncHandler(async (req, res) => {
  const r = (await pool.query(`UPDATE stocktakes SET status='COUNTING' WHERE id=$1 AND status='REVIEW' RETURNING *`, [req.params.id])).rows[0];
  if (!r) throw new BadRequest('Only stocktakes in REVIEW can be reopened');
  res.json(r);
}));
stocktakesRouter.post('/:id/cancel', requirePermission('inventory.stocktake'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const r = (await pool.query(`UPDATE stocktakes SET status='CANCELLED', notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']' WHERE id=$1 AND status IN ('OPEN','COUNTING','REVIEW') RETURNING *`, [req.params.id, b.reason])).rows[0];
  if (!r) throw new BadRequest('Stocktake cannot be cancelled in its current status');
  await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'stocktake', entityId: r.id, reason: b.reason });
  res.json(r);
}));

// Recipes list (cost cards) — recipes are managed through menu items, this gives a costing overview
export const recipesRouter = Router();
recipesRouter.get('/', requirePermission('menus.view', 'inventory.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT r.*, mi.name AS menu_item_name, mi.price AS selling_price, (SELECT COALESCE(SUM(ri.quantity*(1+ri.wastage_percent/100)*p.cost_price),0) FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE ri.recipe_id=r.id) AS cost,
      CASE WHEN mi.price > 0 THEN ROUND((SELECT COALESCE(SUM(ri.quantity*(1+ri.wastage_percent/100)*p.cost_price),0) FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE ri.recipe_id=r.id) / mi.price * 100, 1) END AS cost_percent
    FROM recipes r LEFT JOIN menu_items mi ON mi.id=r.menu_item_id`, where: ['r.is_active'], searchColumns: ['r.name', 'mi.name'], defaultSort: 'r.name', filters: { menu_item_id: 'r.menu_item_id' }, exportName: 'recipe_costs' });
}));
