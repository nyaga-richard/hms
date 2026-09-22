import { Router, Request } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr } from '../../core/http';
import { requirePermission, hasPermission, getLimit } from '../../middleware/auth';
import { NotFound, BadRequest, Errors, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { notify } from '../../core/notify';
import { nextNumber } from '../../core/numbering';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { LIMIT_CODES } from '../../core/permissions';
import { startApproval, registerWorkflowHandler } from '../workflow/workflow.service';
import { moveStock } from '../inventory/stock.service';
import { postJournal, currentBusinessDate, r2, getTax, splitTax } from '../finance/accounting.service';
import { recordPayment, resolvePaymentMethodId } from '../finance/payments.service';
import { AuthUser } from '../auth/auth.types';

/**
 * Procurement: Purchase Requisition → (Quotations) → Purchase Order (approval workflow) → GRN (stock receipt + accrual journal)
 * → Supplier Invoice (3-way match, AP) → Supplier Payment (approval + payment + AP settlement). Credit notes / returns supported.
 * Journals: GRN: DR Inventory (or expense), DR VAT input, CR AP (accrued). Invoice: reclass adjustments. Payment: DR AP, CR Cash/Bank.
 */

// ---------------- Suppliers ----------------
export const suppliersRouter = crudRouter({ table: 'suppliers', entity: 'supplier', permissions: { view: 'suppliers.view', create: 'suppliers.manage', edit: 'suppliers.manage', delete: 'suppliers.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['code', 'name', 'contact_name', 'phone', 'email', 'tax_number'], defaultSort: 'name', filters: { active: 'is_active' },
  selectSql: `SELECT t.*, (SELECT COALESCE(SUM(balance),0) FROM supplier_invoices si WHERE si.supplier_id=t.id AND si.status IN ('APPROVED','PARTIALLY_PAID') AND si.type='INVOICE') AS outstanding,
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id=t.id AND po.status IN ('APPROVED','SENT','PARTIALLY_RECEIVED'))::int AS open_pos,
      (SELECT MAX(order_date) FROM purchase_orders po WHERE po.supplier_id=t.id) AS last_order_date FROM suppliers t`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().optional(), name: z.string().min(1), contact_name: optionalStr, phone: optionalStr, email: optionalStr, address: optionalStr, tax_number: optionalStr, payment_terms_days: z.coerce.number().int().min(0).default(30), currency: z.string().length(3).default('KES'), bank_name: optionalStr, bank_account: optionalStr, bank_branch: optionalStr, categories: z.array(z.string()).default([]), credit_limit: z.coerce.number().min(0).default(0), opening_balance: z.coerce.number().default(0), rating: z.coerce.number().int().min(0).max(5).nullable().optional(), notes: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), contact_name: optionalStr, phone: optionalStr, email: optionalStr, address: optionalStr, tax_number: optionalStr, payment_terms_days: z.coerce.number().int().min(0), currency: z.string().length(3), bank_name: optionalStr, bank_account: optionalStr, bank_branch: optionalStr, categories: z.array(z.string()), credit_limit: z.coerce.number().min(0), rating: z.coerce.number().int().min(0).max(5).nullable(), notes: optionalStr, is_active: z.boolean() }).partial(),
  beforeCreate: async (d, req) => { if (!d.code) { const c = await pool.connect(); try { d.code = await nextNumber(c, 'SUPPLIER', null); } finally { c.release(); } } return d; },
  extraRoutes: (r) => {
    r.get('/:id/statement', requirePermission('payables.view', 'suppliers.view'), asyncHandler(async (req, res) => {
      const s = (await pool.query(`SELECT * FROM suppliers WHERE id=$1`, [req.params.id])).rows[0];
      if (!s) throw new NotFound('Supplier not found');
      const invoices = (await pool.query(`SELECT id, number, supplier_invoice_no, invoice_date, due_date, total, paid_total, balance, status, type, (CURRENT_DATE - due_date) AS days_overdue FROM supplier_invoices WHERE supplier_id=$1 AND status <> 'CANCELLED' ORDER BY invoice_date DESC LIMIT 200`, [s.id])).rows;
      const payments = (await pool.query(`SELECT p.id, p.number, p.amount, p.reference, p.business_date, pm.name AS method, (SELECT json_agg(json_build_object('invoice', si.number, 'amount', sip.amount)) FROM supplier_invoice_payments sip JOIN supplier_invoices si ON si.id=sip.invoice_id WHERE sip.payment_id=p.id) AS allocations FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.party_type='SUPPLIER' AND p.party_id=$1 AND p.status='COMPLETED' ORDER BY p.created_at DESC LIMIT 200`, [s.id])).rows;
      const aging = (await pool.query(`SELECT COALESCE(SUM(balance) FILTER (WHERE CURRENT_DATE - due_date <= 0),0) AS current, COALESCE(SUM(balance) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 1 AND 30),0) AS d30, COALESCE(SUM(balance) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 31 AND 60),0) AS d60, COALESCE(SUM(balance) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 61 AND 90),0) AS d90, COALESCE(SUM(balance) FILTER (WHERE CURRENT_DATE - due_date > 90),0) AS d90plus, COALESCE(SUM(balance),0) AS total FROM supplier_invoices WHERE supplier_id=$1 AND status IN ('APPROVED','PARTIALLY_PAID') AND type='INVOICE'`, [s.id])).rows[0];
      res.json({ supplier: s, invoices, payments, aging });
    }));
    r.get('/:id/products', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
      res.json((await pool.query(`SELECT p.id, p.sku, p.name, u.code AS unit, AVG(poi.unit_price) AS avg_price, MAX(po.order_date) AS last_ordered, SUM(poi.quantity) AS total_qty FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id JOIN products p ON p.id=poi.product_id JOIN units u ON u.id=p.unit_id WHERE po.supplier_id=$1 AND po.status NOT IN ('CANCELLED','REJECTED','DRAFT') GROUP BY p.id, u.code ORDER BY last_ordered DESC`, [req.params.id])).rows);
    }));
  } });

// ---------------- Purchase requisitions ----------------
export const purchaseRequisitionsRouter = Router();
const prSelect = `SELECT pr.*, d.name AS department_name, s.name AS store_name, rb.full_name AS requested_by_name, ab.full_name AS approved_by_name, (SELECT COUNT(*) FROM purchase_requisition_items i WHERE i.requisition_id=pr.id)::int AS item_count,
    (SELECT COUNT(*) FROM purchase_orders po WHERE po.requisition_id=pr.id AND po.status NOT IN ('CANCELLED','REJECTED'))::int AS po_count
  FROM purchase_requisitions pr LEFT JOIN departments d ON d.id=pr.department_id LEFT JOIN stores s ON s.id=pr.store_id LEFT JOIN users rb ON rb.id=pr.requested_by LEFT JOIN users ab ON ab.id=pr.approved_by`;
purchaseRequisitionsRouter.get('/', requirePermission('requisitions.view', 'purchases.view'), asyncHandler(async (req, res) => {
  const where = ['pr.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.mine === 'true') { params.push(req.user!.id); where.push(`pr.requested_by=$${params.length}`); }
  await runList(req, res, { select: prSelect, where, params, searchColumns: ['pr.number', 'pr.justification', 'd.name'], defaultSort: 'pr.created_at', filters: { status: 'pr.status', department_id: 'pr.department_id', priority: 'pr.priority' }, dateFilters: { date: 'pr.created_at::date' }, exportName: 'purchase_requisitions' });
}));
const prItem = z.object({ product_id: z.string().uuid().nullable().optional(), description: optionalStr, quantity: z.coerce.number().positive(), unit_id: z.string().uuid().nullable().optional(), estimated_unit_cost: z.coerce.number().min(0).default(0), notes: optionalStr });
purchaseRequisitionsRouter.post('/', requirePermission('requisitions.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ department_id: z.string().uuid().nullable().optional(), store_id: z.string().uuid().nullable().optional(), required_by: dateStr.nullable().optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'), justification: optionalStr, submit: z.boolean().default(true), items: z.array(prItem).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const number = await nextNumber(c, 'PURCHASE_REQUISITION', req.propertyId);
    const est = r2(b.items.reduce((s, i) => s + i.quantity * i.estimated_unit_cost, 0));
    const pr = (await c.query(`INSERT INTO purchase_requisitions (property_id, number, department_id, store_id, required_by, priority, status, justification, estimated_total, requested_by) VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8,$9) RETURNING *`, [req.propertyId, number, b.department_id ?? req.user!.department_id ?? null, b.store_id ?? null, b.required_by ?? null, b.priority, b.justification ?? null, est, req.user!.id])).rows[0];
    for (const it of b.items) {
      if (!it.product_id && !it.description) throw new BadRequest('Each line needs a product or a description');
      const p = it.product_id ? (await c.query(`SELECT name, unit_id, cost_price FROM products WHERE id=$1`, [it.product_id])).rows[0] : null;
      await c.query(`INSERT INTO purchase_requisition_items (requisition_id, product_id, description, quantity, unit_id, estimated_unit_cost, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [pr.id, it.product_id ?? null, it.description ?? p?.name, it.quantity, it.unit_id ?? p?.unit_id ?? null, it.estimated_unit_cost || Number(p?.cost_price ?? 0), it.notes ?? null]);
    }
    if (b.submit) await submitPR(c, req, pr.id);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'purchase_requisition', entityId: pr.id, newValue: { ...pr, items: b.items } }, c);
    return (await c.query(`${prSelect} WHERE pr.id=$1`, [pr.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function submitPR(c: PoolClient, req: Request, id: string) {
  const pr = (await c.query(`SELECT * FROM purchase_requisitions WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!['DRAFT'].includes(pr.status)) throw Errors.invalidStatus('requisition', pr.status, 'submit');
  const est = Number((await c.query(`SELECT COALESCE(SUM(quantity*estimated_unit_cost),0) AS v FROM purchase_requisition_items WHERE requisition_id=$1`, [id])).rows[0].v);
  await c.query(`UPDATE purchase_requisitions SET estimated_total=$2, status='PENDING_APPROVAL', updated_at=now() WHERE id=$1`, [id, est]);
  const appr = await startApproval(c, { transactionType: 'PURCHASE_REQUISITION', entityType: 'purchase_requisition', entityId: id, entityNumber: pr.number, amount: est, propertyId: req.propertyId!, user: req.user!, title: `Purchase requisition ${pr.number} (${est})`, link: `/procurement/requisitions/${id}` });
  if (appr.status === 'APPROVED') {
    await c.query(`UPDATE purchase_requisitions SET status='APPROVED', approved_by=$2, approved_at=now() WHERE id=$1`, [id, req.user!.id]);
    await notify({ permission: 'purchases.create', propertyId: req.propertyId, type: 'PR_APPROVED', title: `Requisition ${pr.number} approved — raise PO`, entityType: 'purchase_requisition', entityId: id, link: `/procurement/requisitions/${id}` }, c);
  }
}
// The shared PURCHASE_REQUISITION handler in inventory.routes handles stock requisitions; extend it for purchase requisitions:
registerWorkflowHandler('PURCHASE_REQUISITION', {
  onApproved: async (c, id, _r, user) => {
    const sr = (await c.query(`SELECT id FROM stock_requisitions WHERE id=$1`, [id])).rows[0];
    if (sr) { await c.query(`UPDATE stock_requisitions SET status='APPROVED', approved_by=$2, approved_at=now() WHERE id=$1 AND status='PENDING'`, [id, user.id]); await c.query(`UPDATE stock_requisition_items SET approved_qty=COALESCE(approved_qty, requested_qty) WHERE requisition_id=$1`, [id]); return; }
    const pr = (await c.query(`UPDATE purchase_requisitions SET status='APPROVED', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 AND status='PENDING_APPROVAL' RETURNING *`, [id, user.id])).rows[0];
    if (pr) await notify({ permission: 'purchases.create', propertyId: pr.property_id, type: 'PR_APPROVED', title: `Requisition ${pr.number} approved — raise PO`, entityType: 'purchase_requisition', entityId: id, link: `/procurement/requisitions/${id}` }, c);
  },
  onRejected: async (c, id, _r, _u, comment) => {
    await c.query(`UPDATE stock_requisitions SET status='REJECTED' WHERE id=$1 AND status='PENDING'`, [id]);
    await c.query(`UPDATE purchase_requisitions SET status='REJECTED', rejection_reason=$2, updated_at=now() WHERE id=$1 AND status='PENDING_APPROVAL'`, [id, comment ?? null]);
  },
});
purchaseRequisitionsRouter.get('/:id', requirePermission('requisitions.view', 'purchases.view'), asyncHandler(async (req, res) => {
  const pr = (await pool.query(`${prSelect} WHERE pr.id=$1`, [req.params.id])).rows[0];
  if (!pr) throw new NotFound('Purchase requisition not found');
  pr.items = (await pool.query(`SELECT i.*, p.sku, p.name AS product_name, u.code AS unit, p.preferred_supplier_id, (SELECT COALESCE(SUM(sb.quantity),0) FROM stock_balances sb WHERE sb.product_id=p.id) AS on_hand FROM purchase_requisition_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN units u ON u.id=COALESCE(i.unit_id, p.unit_id) WHERE i.requisition_id=$1`, [pr.id])).rows;
  pr.quotations = (await pool.query(`SELECT q.*, s.name AS supplier_name FROM supplier_quotations q JOIN suppliers s ON s.id=q.supplier_id WHERE q.requisition_id=$1 ORDER BY q.total`, [pr.id])).rows;
  pr.purchase_orders = (await pool.query(`SELECT po.id, po.number, po.status, po.total, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.requisition_id=$1`, [pr.id])).rows;
  pr.approval = (await pool.query(`SELECT ar.*, (SELECT json_agg(json_build_object('step', a.step_order, 'name', a.step_name, 'action', a.action, 'actor', u.full_name, 'comment', a.comment, 'at', a.created_at) ORDER BY a.created_at) FROM approval_actions a LEFT JOIN users u ON u.id=a.user_id WHERE a.request_id=ar.id) AS actions FROM approval_requests ar WHERE ar.entity_type='purchase_requisition' AND ar.entity_id=$1 ORDER BY ar.requested_at DESC LIMIT 1`, [pr.id])).rows[0] ?? null;
  res.json(pr);
}));
purchaseRequisitionsRouter.post('/:id/submit', requirePermission('requisitions.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { await submitPR(c, req, req.params.id); return (await c.query(`${prSelect} WHERE pr.id=$1`, [req.params.id])).rows[0]; });
  res.json(out);
}));
purchaseRequisitionsRouter.post('/:id/approve', requirePermission('requisitions.approve'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const pr = (await c.query(`SELECT * FROM purchase_requisitions WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!pr) throw new NotFound('Purchase requisition not found');
    if (!['PENDING_APPROVAL', 'DRAFT'].includes(pr.status)) throw Errors.invalidStatus('requisition', pr.status, 'approve');
    if (Number(pr.estimated_total) > getLimit(req, LIMIT_CODES.PURCHASE_APPROVAL, Number.MAX_SAFE_INTEGER)) throw new Forbidden('Requisition value exceeds your approval limit');
    const r = (await c.query(`UPDATE purchase_requisitions SET status='APPROVED', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [pr.id, req.user!.id])).rows[0];
    await c.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE entity_type='purchase_requisition' AND entity_id=$1 AND status='PENDING'`, [pr.id]);
    await notify({ permission: 'purchases.create', propertyId: pr.property_id, type: 'PR_APPROVED', title: `Requisition ${pr.number} approved — raise PO`, entityType: 'purchase_requisition', entityId: pr.id, link: `/procurement/requisitions/${pr.id}` }, c);
    await audit({ ...auditCtx(req), action: 'APPROVE', entityType: 'purchase_requisition', entityId: pr.id }, c);
    return r;
  });
  res.json(out);
}));
purchaseRequisitionsRouter.post('/:id/reject', requirePermission('requisitions.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const r = (await c.query(`UPDATE purchase_requisitions SET status='REJECTED', rejection_reason=$2, approved_by=$3, updated_at=now() WHERE id=$1 AND status IN ('PENDING_APPROVAL','DRAFT') RETURNING *`, [req.params.id, b.reason, req.user!.id])).rows[0];
    if (!r) throw new BadRequest('Requisition cannot be rejected in its current status');
    await c.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE entity_type='purchase_requisition' AND entity_id=$1 AND status='PENDING'`, [r.id]);
    await notify({ userIds: [r.requested_by], type: 'PR_REJECTED', title: `Requisition ${r.number} rejected`, body: b.reason, entityType: 'purchase_requisition', entityId: r.id, link: `/procurement/requisitions/${r.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'REJECT', entityType: 'purchase_requisition', entityId: r.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));
purchaseRequisitionsRouter.post('/:id/cancel', requirePermission('requisitions.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const r = (await pool.query(`UPDATE purchase_requisitions SET status='CANCELLED', rejection_reason=$2, updated_at=now() WHERE id=$1 AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED') AND (requested_by=$3 OR $4) RETURNING *`, [req.params.id, b.reason, req.user!.id, hasPermission(req, 'requisitions.approve')])).rows[0];
  if (!r) throw new BadRequest('Requisition cannot be cancelled');
  await pool.query(`UPDATE approval_requests SET status='CANCELLED', completed_at=now() WHERE entity_type='purchase_requisition' AND entity_id=$1 AND status='PENDING'`, [r.id]);
  res.json(r);
}));

// ---------------- Supplier quotations ----------------
export const quotationsRouter = Router();
quotationsRouter.get('/', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT q.*, s.name AS supplier_name, pr.number AS requisition_number FROM supplier_quotations q JOIN suppliers s ON s.id=q.supplier_id LEFT JOIN purchase_requisitions pr ON pr.id=q.requisition_id`, where: ['q.property_id=$1'], params: [req.propertyId], searchColumns: ['q.number', 's.name', 'pr.number'], defaultSort: 'q.created_at', filters: { requisition_id: 'q.requisition_id', supplier_id: 'q.supplier_id', status: 'q.status' }, exportName: 'quotations' });
}));
quotationsRouter.post('/', requirePermission('purchases.quotations', 'purchases.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ requisition_id: z.string().uuid().nullable().optional(), supplier_id: z.string().uuid(), quote_date: dateStr.optional(), valid_until: dateStr.nullable().optional(), currency: z.string().length(3).default('KES'), notes: optionalStr, items: z.array(z.object({ product_id: z.string().uuid().nullable().optional(), description: optionalStr, quantity: z.coerce.number().positive(), unit_price: z.coerce.number().min(0), lead_time_days: z.coerce.number().int().min(0).nullable().optional() })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const number = await nextNumber(c, 'QUOTATION', req.propertyId);
    const total = r2(b.items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
    const q = (await c.query(`INSERT INTO supplier_quotations (property_id, number, requisition_id, supplier_id, quote_date, valid_until, currency, total, status, notes, created_by) VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,'RECEIVED',$9,$10) RETURNING *`, [req.propertyId, number, b.requisition_id ?? null, b.supplier_id, b.quote_date ?? null, b.valid_until ?? null, b.currency, total, b.notes ?? null, req.user!.id])).rows[0];
    for (const it of b.items) await c.query(`INSERT INTO supplier_quotation_items (quotation_id, product_id, description, quantity, unit_price, lead_time_days) VALUES ($1,$2,$3,$4,$5,$6)`, [q.id, it.product_id ?? null, it.description ?? null, it.quantity, it.unit_price, it.lead_time_days ?? null]);
    return q;
  });
  res.status(201).json(out);
}));
quotationsRouter.get('/compare/:requisitionId', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  const quotes = (await pool.query(`SELECT q.*, s.name AS supplier_name, s.rating, s.payment_terms_days, (SELECT json_agg(json_build_object('product_id', i.product_id, 'description', i.description, 'quantity', i.quantity, 'unit_price', i.unit_price, 'lead_time_days', i.lead_time_days)) FROM supplier_quotation_items i WHERE i.quotation_id=q.id) AS items FROM supplier_quotations q JOIN suppliers s ON s.id=q.supplier_id WHERE q.requisition_id=$1 ORDER BY q.total`, [req.params.requisitionId])).rows;
  res.json(quotes);
}));
quotationsRouter.get('/:id', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  const q = (await pool.query(`SELECT q.*, s.name AS supplier_name FROM supplier_quotations q JOIN suppliers s ON s.id=q.supplier_id WHERE q.id=$1`, [req.params.id])).rows[0];
  if (!q) throw new NotFound('Quotation not found');
  q.items = (await pool.query(`SELECT i.*, p.name AS product_name, p.sku FROM supplier_quotation_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.quotation_id=$1`, [q.id])).rows;
  res.json(q);
}));
quotationsRouter.post('/:id/select', requirePermission('purchases.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const q = (await c.query(`UPDATE supplier_quotations SET status='SELECTED' WHERE id=$1 RETURNING *`, [req.params.id])).rows[0];
    if (!q) throw new NotFound('Quotation not found');
    if (q.requisition_id) await c.query(`UPDATE supplier_quotations SET status='REJECTED' WHERE requisition_id=$1 AND id<>$2 AND status='RECEIVED'`, [q.requisition_id, q.id]);
    return q;
  });
  res.json(out);
}));

// ---------------- Purchase orders ----------------
export const purchaseOrdersRouter = Router();
const poSelect = `SELECT po.*, s.name AS supplier_name, s.email AS supplier_email, s.phone AS supplier_phone, st.name AS store_name, pr.number AS requisition_number, cb.full_name AS created_by_name, ab.full_name AS approved_by_name,
    (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id=po.id)::int AS item_count, (SELECT COALESCE(SUM(received_qty),0) FROM purchase_order_items i WHERE i.purchase_order_id=po.id) AS received_total_qty, (SELECT COALESCE(SUM(quantity),0) FROM purchase_order_items i WHERE i.purchase_order_id=po.id) AS ordered_total_qty,
    (SELECT COUNT(*) FROM grns g WHERE g.purchase_order_id=po.id AND g.status='COMPLETED')::int AS grn_count, (SELECT COUNT(*) FROM supplier_invoices si WHERE si.purchase_order_id=po.id AND si.status<>'CANCELLED')::int AS invoice_count
  FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN stores st ON st.id=po.store_id LEFT JOIN purchase_requisitions pr ON pr.id=po.requisition_id LEFT JOIN users cb ON cb.id=po.created_by LEFT JOIN users ab ON ab.id=po.approved_by`;
purchaseOrdersRouter.get('/', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  const where = ['po.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.receivable === 'true') where.push(`po.status IN ('APPROVED','SENT','PARTIALLY_RECEIVED')`);
  await runList(req, res, { select: poSelect, where, params, searchColumns: ['po.number', 's.name', 'pr.number', 'po.notes'], defaultSort: 'po.created_at', filters: { status: 'po.status', supplier_id: 'po.supplier_id', store_id: 'po.store_id', requisition_id: 'po.requisition_id' }, dateFilters: { date: 'po.order_date' }, exportName: 'purchase_orders' });
}));
const poItem = z.object({ product_id: z.string().uuid().nullable().optional(), description: optionalStr, quantity: z.coerce.number().positive(), unit_id: z.string().uuid().nullable().optional(), unit_price: z.coerce.number().min(0), tax_id: z.string().uuid().nullable().optional(), expense_account_id: z.string().uuid().nullable().optional() });
async function computePoLine(c: PoolClient, it: z.infer<typeof poItem>) {
  const p = it.product_id ? (await c.query(`SELECT name, unit_id, tax_id FROM products WHERE id=$1`, [it.product_id])).rows[0] : null;
  if (it.product_id && !p) throw new NotFound('Product not found');
  if (!it.product_id && !it.description) throw new BadRequest('Each line needs a product or description');
  if (!it.product_id && !it.expense_account_id) throw new BadRequest('Non-stock lines need an expense account');
  const tax = await getTax(c, it.tax_id ?? p?.tax_id ?? null);
  const gross = r2(it.quantity * it.unit_price);
  // Purchase prices are entered exclusive unless the tax is flagged inclusive
  const t = tax ? (tax.is_inclusive ? splitTax(gross, Number(tax.rate), true) : splitTax(gross, Number(tax.rate), false)) : { net: gross, tax: 0, gross };
  return { product: p, taxId: tax?.id ?? null, net: t.net, tax: t.tax, total: t.gross };
}
purchaseOrdersRouter.post('/', requirePermission('purchases.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ supplier_id: z.string().uuid(), requisition_id: z.string().uuid().nullable().optional(), quotation_id: z.string().uuid().nullable().optional(), store_id: z.string().uuid().nullable().optional(), order_date: dateStr.optional(), expected_date: dateStr.nullable().optional(), currency: z.string().length(3).default('KES'), fx_rate: z.coerce.number().positive().default(1), payment_terms: optionalStr, delivery_address: optionalStr, notes: optionalStr, is_cash_purchase: z.boolean().default(false), submit: z.boolean().default(true), items: z.array(poItem).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    if (b.requisition_id) { const pr = (await c.query(`SELECT status FROM purchase_requisitions WHERE id=$1`, [b.requisition_id])).rows[0]; if (!pr) throw new NotFound('Requisition not found'); if (!['APPROVED', 'ORDERED'].includes(pr.status)) throw new BadRequest('Requisition must be approved before ordering'); }
    const supplier = (await c.query(`SELECT * FROM suppliers WHERE id=$1 AND is_active`, [b.supplier_id])).rows[0];
    if (!supplier) throw new NotFound('Supplier not found');
    const number = await nextNumber(c, 'PURCHASE_ORDER', req.propertyId);
    const po = (await c.query(`INSERT INTO purchase_orders (property_id, number, supplier_id, requisition_id, quotation_id, store_id, order_date, expected_date, currency, fx_rate, status, payment_terms, delivery_address, notes, is_cash_purchase, created_by) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8,$9,$10,'DRAFT',$11,$12,$13,$14,$15) RETURNING *`,
      [req.propertyId, number, b.supplier_id, b.requisition_id ?? null, b.quotation_id ?? null, b.store_id ?? null, b.order_date ?? null, b.expected_date ?? null, b.currency, b.fx_rate, b.payment_terms ?? `${supplier.payment_terms_days} days`, b.delivery_address ?? null, b.notes ?? null, b.is_cash_purchase, req.user!.id])).rows[0];
    let subtotal = 0, taxTotal = 0;
    for (const it of b.items) {
      const l = await computePoLine(c, it);
      subtotal += l.net; taxTotal += l.tax;
      await c.query(`INSERT INTO purchase_order_items (purchase_order_id, product_id, description, quantity, unit_id, unit_price, tax_id, tax_amount, line_total, expense_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [po.id, it.product_id ?? null, it.description ?? l.product?.name, it.quantity, it.unit_id ?? l.product?.unit_id ?? null, it.unit_price, l.taxId, l.tax, l.total, it.expense_account_id ?? null]);
    }
    await c.query(`UPDATE purchase_orders SET subtotal=$2, tax_total=$3, total=$4 WHERE id=$1`, [po.id, r2(subtotal), r2(taxTotal), r2(subtotal + taxTotal)]);
    if (b.requisition_id) {
      for (const it of b.items) if (it.product_id) await c.query(`UPDATE purchase_requisition_items SET ordered_qty = ordered_qty + $3 WHERE requisition_id=$1 AND product_id=$2`, [b.requisition_id, it.product_id, it.quantity]);
      await c.query(`UPDATE purchase_requisitions SET status='ORDERED', updated_at=now() WHERE id=$1 AND status='APPROVED'`, [b.requisition_id]);
    }
    if (b.submit) await submitPO(c, req, po.id);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'purchase_order', entityId: po.id, newValue: { number, supplier: supplier.name, items: b.items } }, c);
    return (await c.query(`${poSelect} WHERE po.id=$1`, [po.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function submitPO(c: PoolClient, req: Request, id: string) {
  const po = (await c.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (po.status !== 'DRAFT') throw Errors.invalidStatus('purchase order', po.status, 'submit');
  const appr = await startApproval(c, { transactionType: 'PURCHASE_ORDER', entityType: 'purchase_order', entityId: id, entityNumber: po.number, amount: Number(po.total), propertyId: req.propertyId!, user: req.user!, title: `Purchase order ${po.number} (${po.total})`, link: `/procurement/purchase-orders/${id}` });
  if (appr.status === 'APPROVED') {
    // no workflow: creator needs approve permission + limit
    if (hasPermission(req, 'purchases.approve') && Number(po.total) <= getLimit(req, LIMIT_CODES.PURCHASE_APPROVAL, Number.MAX_SAFE_INTEGER)) await approvePO(c, id, req.user!);
    else { await c.query(`UPDATE purchase_orders SET status='PENDING_APPROVAL', updated_at=now() WHERE id=$1`, [id]); await notify({ permission: 'purchases.approve', propertyId: po.property_id, type: 'PO_PENDING', title: `PO ${po.number} awaiting approval (${po.total})`, entityType: 'purchase_order', entityId: id, link: `/procurement/purchase-orders/${id}` }, c); }
  } else await c.query(`UPDATE purchase_orders SET status='PENDING_APPROVAL', updated_at=now() WHERE id=$1`, [id]);
}
async function approvePO(c: PoolClient, id: string, user: AuthUser) {
  const po = (await c.query(`UPDATE purchase_orders SET status='APPROVED', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 AND status IN ('DRAFT','PENDING_APPROVAL') RETURNING *`, [id, user.id])).rows[0];
  if (!po) return null;
  await c.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE entity_type='purchase_order' AND entity_id=$1 AND status='PENDING'`, [id]);
  await notify({ userIds: [po.created_by], permission: 'purchases.receive', propertyId: po.property_id, type: 'PO_APPROVED', title: `PO ${po.number} approved`, body: 'Send to supplier / await delivery', entityType: 'purchase_order', entityId: id, link: `/procurement/purchase-orders/${id}`, severity: 'SUCCESS' }, c);
  await audit({ userId: user.id, username: user.username, propertyId: po.property_id, action: 'APPROVE', entityType: 'purchase_order', entityId: id }, c);
  return po;
}
registerWorkflowHandler('PURCHASE_ORDER', { onApproved: async (c, id, _r, user) => { await approvePO(c, id, user); }, onRejected: async (c, id, _r, _u, comment) => { await c.query(`UPDATE purchase_orders SET status='REJECTED', notes=COALESCE(notes,'') || ' [rejected: ' || COALESCE($2,'') || ']', updated_at=now() WHERE id=$1 AND status='PENDING_APPROVAL'`, [id, comment ?? null]); } });

purchaseOrdersRouter.get('/:id', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  const po = (await pool.query(`${poSelect} WHERE po.id=$1`, [req.params.id])).rows[0];
  if (!po) throw new NotFound('Purchase order not found');
  po.items = (await pool.query(`SELECT i.*, p.sku, p.name AS product_name, p.track_batches, p.track_expiry, u.code AS unit, t.name AS tax_name, t.rate AS tax_rate, (i.quantity - i.received_qty) AS outstanding_qty FROM purchase_order_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN units u ON u.id=COALESCE(i.unit_id, p.unit_id) LEFT JOIN taxes t ON t.id=i.tax_id WHERE i.purchase_order_id=$1 ORDER BY i.id`, [po.id])).rows;
  po.grns = (await pool.query(`SELECT g.id, g.number, g.received_date, g.status, g.total_value, u.full_name AS received_by_name FROM grns g LEFT JOIN users u ON u.id=g.received_by WHERE g.purchase_order_id=$1 ORDER BY g.created_at`, [po.id])).rows;
  po.invoices = (await pool.query(`SELECT id, number, supplier_invoice_no, invoice_date, total, paid_total, balance, status FROM supplier_invoices WHERE purchase_order_id=$1 ORDER BY created_at`, [po.id])).rows;
  po.approval = (await pool.query(`SELECT ar.*, (SELECT json_agg(json_build_object('step', a.step_order, 'name', a.step_name, 'action', a.action, 'actor', u.full_name, 'comment', a.comment, 'at', a.created_at) ORDER BY a.created_at) FROM approval_actions a LEFT JOIN users u ON u.id=a.user_id WHERE a.request_id=ar.id) AS actions FROM approval_requests ar WHERE ar.entity_type='purchase_order' AND ar.entity_id=$1 ORDER BY ar.requested_at DESC LIMIT 1`, [po.id])).rows[0] ?? null;
  res.json(po);
}));
purchaseOrdersRouter.put('/:id', requirePermission('purchases.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ expected_date: dateStr.nullable().optional(), store_id: z.string().uuid().nullable().optional(), payment_terms: optionalStr, delivery_address: optionalStr, notes: optionalStr, items: z.array(poItem).min(1).optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const po = (await c.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!po) throw new NotFound('Purchase order not found');
    if (!['DRAFT', 'REJECTED'].includes(po.status)) throw new BadRequest('Only draft/rejected purchase orders can be edited; cancel and re-create otherwise');
    await c.query(`UPDATE purchase_orders SET expected_date=COALESCE($2, expected_date), store_id=COALESCE($3, store_id), payment_terms=COALESCE($4, payment_terms), delivery_address=COALESCE($5, delivery_address), notes=COALESCE($6, notes), status='DRAFT', updated_at=now() WHERE id=$1`, [po.id, b.expected_date ?? null, b.store_id ?? null, b.payment_terms ?? null, b.delivery_address ?? null, b.notes ?? null]);
    if (b.items) {
      await c.query(`DELETE FROM purchase_order_items WHERE purchase_order_id=$1`, [po.id]);
      let subtotal = 0, taxTotal = 0;
      for (const it of b.items) { const l = await computePoLine(c, it); subtotal += l.net; taxTotal += l.tax; await c.query(`INSERT INTO purchase_order_items (purchase_order_id, product_id, description, quantity, unit_id, unit_price, tax_id, tax_amount, line_total, expense_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [po.id, it.product_id ?? null, it.description ?? l.product?.name, it.quantity, it.unit_id ?? l.product?.unit_id ?? null, it.unit_price, l.taxId, l.tax, l.total, it.expense_account_id ?? null]); }
      await c.query(`UPDATE purchase_orders SET subtotal=$2, tax_total=$3, total=$4 WHERE id=$1`, [po.id, r2(subtotal), r2(taxTotal), r2(subtotal + taxTotal)]);
    }
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'purchase_order', entityId: po.id, newValue: b }, c);
    return (await c.query(`${poSelect} WHERE po.id=$1`, [po.id])).rows[0];
  });
  res.json(out);
}));
purchaseOrdersRouter.post('/:id/submit', requirePermission('purchases.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { await submitPO(c, req, req.params.id); return (await c.query(`${poSelect} WHERE po.id=$1`, [req.params.id])).rows[0]; });
  res.json(out);
}));
purchaseOrdersRouter.post('/:id/approve', requirePermission('purchases.approve'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const po = (await c.query(`SELECT * FROM purchase_orders WHERE id=$1`, [req.params.id])).rows[0];
    if (!po) throw new NotFound('Purchase order not found');
    if (!['PENDING_APPROVAL', 'DRAFT'].includes(po.status)) throw Errors.invalidStatus('purchase order', po.status, 'approve');
    if (Number(po.total) > getLimit(req, LIMIT_CODES.PURCHASE_APPROVAL, Number.MAX_SAFE_INTEGER)) throw new Forbidden(`PO value ${po.total} exceeds your approval limit`);
    if (po.created_by === req.user!.id && !req.user!.is_superuser && Number(po.total) > 0) {
      const wf = (await c.query(`SELECT 1 FROM approval_requests WHERE entity_type='purchase_order' AND entity_id=$1 AND status='PENDING'`, [po.id])).rows[0];
      if (wf) throw new Forbidden('Segregation of duties: you cannot approve your own purchase order through the workflow');
    }
    return approvePO(c, po.id, req.user!);
  });
  res.json(out);
}));
purchaseOrdersRouter.post('/:id/reject', requirePermission('purchases.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const po = (await c.query(`UPDATE purchase_orders SET status='REJECTED', notes=COALESCE(notes,'') || ' [rejected: ' || $2 || ']', updated_at=now() WHERE id=$1 AND status IN ('PENDING_APPROVAL','DRAFT') RETURNING *`, [req.params.id, b.reason])).rows[0];
    if (!po) throw new BadRequest('PO cannot be rejected in its current status');
    await c.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE entity_type='purchase_order' AND entity_id=$1 AND status='PENDING'`, [po.id]);
    await notify({ userIds: [po.created_by], type: 'PO_REJECTED', title: `PO ${po.number} rejected`, body: b.reason, entityType: 'purchase_order', entityId: po.id, link: `/procurement/purchase-orders/${po.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'REJECT', entityType: 'purchase_order', entityId: po.id, reason: b.reason }, c);
    return po;
  });
  res.json(out);
}));
purchaseOrdersRouter.post('/:id/send', requirePermission('purchases.create'), asyncHandler(async (req, res) => {
  const po = (await pool.query(`UPDATE purchase_orders SET status='SENT', sent_at=now(), updated_at=now() WHERE id=$1 AND status='APPROVED' RETURNING *`, [req.params.id])).rows[0];
  if (!po) throw new BadRequest('Only approved purchase orders can be marked as sent');
  await audit({ ...auditCtx(req), action: 'SEND', entityType: 'purchase_order', entityId: po.id });
  res.json(po);
}));
purchaseOrdersRouter.post('/:id/close', requirePermission('purchases.approve', 'purchases.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: optionalStr }), req.body);
  const po = (await pool.query(`UPDATE purchase_orders SET status='CLOSED', notes=COALESCE(notes,'') || COALESCE(' [closed: ' || $2 || ']',''), updated_at=now() WHERE id=$1 AND status IN ('APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED') RETURNING *`, [req.params.id, b.reason ?? null])).rows[0];
  if (!po) throw new BadRequest('PO cannot be closed in its current status');
  await audit({ ...auditCtx(req), action: 'CLOSE', entityType: 'purchase_order', entityId: po.id, reason: b.reason });
  res.json(po);
}));
purchaseOrdersRouter.post('/:id/cancel', requirePermission('purchases.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const po = (await c.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!po) throw new NotFound('Purchase order not found');
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'REJECTED'].includes(po.status)) throw Errors.invalidStatus('purchase order', po.status, 'cancel');
    const received = (await c.query(`SELECT 1 FROM grns WHERE purchase_order_id=$1 AND status='COMPLETED'`, [po.id])).rows[0];
    if (received) throw new BadRequest('Goods were already received against this PO; close it instead');
    const r = (await c.query(`UPDATE purchase_orders SET status='CANCELLED', notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']', updated_at=now() WHERE id=$1 RETURNING *`, [po.id, b.reason])).rows[0];
    await c.query(`UPDATE approval_requests SET status='CANCELLED', completed_at=now() WHERE entity_type='purchase_order' AND entity_id=$1 AND status='PENDING'`, [po.id]);
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'purchase_order', entityId: po.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- GRN (goods received) ----------------
export const grnsRouter = Router();
const grnSelect = `SELECT g.*, s.name AS supplier_name, st.name AS store_name, po.number AS po_number, rb.full_name AS received_by_name, cb.full_name AS checked_by_name, (SELECT COUNT(*) FROM grn_items i WHERE i.grn_id=g.id)::int AS item_count
  FROM grns g JOIN suppliers s ON s.id=g.supplier_id JOIN stores st ON st.id=g.store_id LEFT JOIN purchase_orders po ON po.id=g.purchase_order_id LEFT JOIN users rb ON rb.id=g.received_by LEFT JOIN users cb ON cb.id=g.checked_by`;
grnsRouter.get('/', requirePermission('purchases.view', 'inventory.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: grnSelect, where: ['g.property_id=$1'], params: [req.propertyId], searchColumns: ['g.number', 's.name', 'po.number', 'g.delivery_note_no'], defaultSort: 'g.created_at', filters: { status: 'g.status', supplier_id: 'g.supplier_id', store_id: 'g.store_id', purchase_order_id: 'g.purchase_order_id' }, dateFilters: { date: 'g.received_date' }, exportName: 'grns' });
}));
grnsRouter.post('/', requirePermission('purchases.receive'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ purchase_order_id: z.string().uuid().nullable().optional(), supplier_id: z.string().uuid().optional(), store_id: z.string().uuid(), delivery_note_no: optionalStr, received_date: dateStr.optional(), notes: optionalStr, complete: z.boolean().default(true),
    items: z.array(z.object({ po_item_id: z.string().uuid().nullable().optional(), product_id: z.string().uuid().nullable().optional(), description: optionalStr, received_qty: z.coerce.number().min(0), accepted_qty: z.coerce.number().min(0).optional(), rejected_qty: z.coerce.number().min(0).default(0), damaged_qty: z.coerce.number().min(0).default(0), unit_cost: z.coerce.number().min(0).optional(), tax_id: z.string().uuid().nullable().optional(), batch_no: optionalStr, expiry_date: dateStr.nullable().optional(), serial_numbers: z.array(z.string()).optional(), rejection_reason: optionalStr })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    let po: any = null;
    if (b.purchase_order_id) { po = (await c.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [b.purchase_order_id])).rows[0]; if (!po) throw new NotFound('Purchase order not found'); if (!['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new BadRequest(`Cannot receive against a PO in status ${po.status}`, undefined, 'PO_NOT_RECEIVABLE'); }
    const supplierId = po?.supplier_id ?? b.supplier_id;
    if (!supplierId) throw new BadRequest('supplier_id is required for direct (non-PO) receipts');
    if (!po && !hasPermission(req, 'purchases.create')) throw new Forbidden('Direct receipts without a PO require purchases.create');
    const number = await nextNumber(c, 'GRN', req.propertyId);
    const g = (await c.query(`INSERT INTO grns (property_id, number, purchase_order_id, supplier_id, store_id, delivery_note_no, received_date, status, notes, received_by) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),'DRAFT',$8,$9) RETURNING *`, [req.propertyId, number, po?.id ?? null, supplierId, b.store_id, b.delivery_note_no ?? null, b.received_date ?? null, b.notes ?? null, req.user!.id])).rows[0];
    for (const it of b.items) {
      let poi: any = null;
      if (it.po_item_id) { poi = (await c.query(`SELECT * FROM purchase_order_items WHERE id=$1 AND purchase_order_id=$2 FOR UPDATE`, [it.po_item_id, po?.id])).rows[0]; if (!poi) throw new BadRequest('PO line does not belong to this purchase order'); }
      const productId = it.product_id ?? poi?.product_id ?? null;
      const accepted = it.accepted_qty ?? Math.max(0, it.received_qty - it.rejected_qty - it.damaged_qty);
      if (accepted + it.rejected_qty + it.damaged_qty > it.received_qty + 0.0001) throw new BadRequest('accepted + rejected + damaged cannot exceed received');
      if (poi) { const outstanding = Number(poi.quantity) - Number(poi.received_qty); if (accepted > outstanding + 0.0001 && !hasPermission(req, 'purchases.approve')) throw new BadRequest(`Over-receipt: PO line has ${outstanding} outstanding but ${accepted} accepted. Manager approval required.`, undefined, 'OVER_RECEIPT'); }
      const unitCost = it.unit_cost ?? Number(poi?.unit_price ?? 0);
      const prod = productId ? (await c.query(`SELECT track_batches, track_expiry FROM products WHERE id=$1`, [productId])).rows[0] : null;
      if (prod?.track_expiry && !it.expiry_date && accepted > 0) throw new BadRequest('Expiry date is required for this product', undefined, 'EXPIRY_REQUIRED');
      await c.query(`INSERT INTO grn_items (grn_id, po_item_id, product_id, description, ordered_qty, received_qty, accepted_qty, rejected_qty, damaged_qty, unit_cost, tax_id, batch_no, expiry_date, serial_numbers, rejection_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [g.id, poi?.id ?? null, productId, it.description ?? poi?.description ?? null, poi?.quantity ?? null, it.received_qty, accepted, it.rejected_qty, it.damaged_qty, unitCost, it.tax_id ?? poi?.tax_id ?? null, it.batch_no ?? null, it.expiry_date ?? null, it.serial_numbers ?? null, it.rejection_reason ?? null]);
    }
    if (b.complete) await completeGRN(c, req, g.id);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'grn', entityId: g.id, newValue: { number, po: po?.number, items: b.items } }, c);
    return (await c.query(`${grnSelect} WHERE g.id=$1`, [g.id])).rows[0];
  });
  res.status(201).json(out);
}));
/** Complete a GRN: stock receipts (moving average), PO progress, accrual journal DR Inventory/Expense + DR VAT input, CR AP (goods received not invoiced). */
async function completeGRN(c: PoolClient, req: Request, id: string) {
  const g = (await c.query(`SELECT * FROM grns WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!g) throw new NotFound('GRN not found');
  if (g.status !== 'DRAFT' && g.status !== 'PENDING_QC') throw Errors.invalidStatus('GRN', g.status, 'complete');
  const bd = await currentBusinessDate(c, g.property_id, req.user!.id);
  const items = (await c.query(`SELECT gi.*, poi.expense_account_id, pc.inventory_account_id FROM grn_items gi LEFT JOIN purchase_order_items poi ON poi.id=gi.po_item_id LEFT JOIN products p ON p.id=gi.product_id LEFT JOIN product_categories pc ON pc.id=p.category_id WHERE gi.grn_id=$1`, [id])).rows;
  const debits: Record<string, number> = {}; let taxTotal = 0, total = 0;
  for (const it of items) {
    const acc = Number(it.accepted_qty); if (acc <= 0) continue;
    const tax = await getTax(c, it.tax_id);
    const gross = r2(acc * Number(it.unit_cost));
    const t = tax ? splitTax(gross, Number(tax.rate), !!tax.is_inclusive) : { net: gross, tax: 0, gross };
    const netUnit = acc ? t.net / acc : Number(it.unit_cost);
    if (it.product_id) {
      const mv = await moveStock(c, { propertyId: g.property_id, storeId: g.store_id, productId: it.product_id, type: 'PURCHASE_RECEIPT', quantity: acc, unitCost: r2(netUnit), referenceType: 'GRN', referenceId: g.id, referenceNumber: g.number, businessDate: bd, userId: req.user!.id, batch: it.batch_no || it.expiry_date ? { batchNo: it.batch_no, expiryDate: it.expiry_date } : null });
      if (mv.movement) await c.query(`UPDATE grn_items SET stock_movement_id=$2 WHERE id=$1`, [it.id, mv.movement.id]);
      if (!mv.skipped) { const k = it.inventory_account_id ?? 'INVENTORY'; debits[k] = (debits[k] ?? 0) + t.net; }
      else { const k = it.expense_account_id ?? 'GENERAL_EXPENSE'; debits[k] = (debits[k] ?? 0) + t.net; }
    } else { const k = it.expense_account_id ?? 'GENERAL_EXPENSE'; debits[k] = (debits[k] ?? 0) + t.net; }
    taxTotal += t.tax; total += t.gross;
    if (it.po_item_id) await c.query(`UPDATE purchase_order_items SET received_qty = received_qty + $2 WHERE id=$1`, [it.po_item_id, acc]);
  }
  let journalId: string | null = null;
  if (total > 0) {
    const isUuid = (k: string) => /^[0-9a-f-]{36}$/.test(k);
    const lines: any[] = Object.entries(debits).map(([k, v]) => ({ ...(isUuid(k) ? { accountId: k } : { mappingKey: k }), debit: r2(v) }));
    if (taxTotal > 0) lines.push({ mappingKey: 'TAX_RECEIVABLE', debit: r2(taxTotal), description: 'Input VAT' });
    lines.push({ mappingKey: 'AP', credit: r2(total), partyType: 'SUPPLIER', partyId: g.supplier_id, description: 'Goods received (accrued)' });
    const j = await postJournal(c, { propertyId: g.property_id, businessDate: bd, description: `GRN ${g.number} from supplier`, sourceType: 'GRN', sourceId: g.id, userId: req.user!.id, lines });
    journalId = j.id;
  }
  await c.query(`UPDATE grns SET status='COMPLETED', total_value=$2, journal_entry_id=$3, checked_by=$4, completed_at=now() WHERE id=$1`, [id, r2(total), journalId, req.user!.id]);
  if (g.purchase_order_id) {
    const prog = (await c.query(`SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(received_qty),0) AS r FROM purchase_order_items WHERE purchase_order_id=$1`, [g.purchase_order_id])).rows[0];
    await c.query(`UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1`, [g.purchase_order_id, Number(prog.r) + 0.0001 >= Number(prog.q) ? 'RECEIVED' : 'PARTIALLY_RECEIVED']);
    const po = (await c.query(`SELECT number, requisition_id FROM purchase_orders WHERE id=$1`, [g.purchase_order_id])).rows[0];
    if (po.requisition_id && Number(prog.r) + 0.0001 >= Number(prog.q)) await c.query(`UPDATE purchase_requisitions SET status='CLOSED', updated_at=now() WHERE id=$1 AND status='ORDERED'`, [po.requisition_id]);
  }
  await notify({ permission: 'purchases.invoice', propertyId: g.property_id, type: 'GRN_COMPLETED', title: `GRN ${g.number} received (${r2(total)})`, body: 'Record the supplier invoice when it arrives', entityType: 'grn', entityId: id, link: `/procurement/grns/${id}` }, c);
}
grnsRouter.get('/:id', requirePermission('purchases.view', 'inventory.view'), asyncHandler(async (req, res) => {
  const g = (await pool.query(`${grnSelect} WHERE g.id=$1`, [req.params.id])).rows[0];
  if (!g) throw new NotFound('GRN not found');
  g.items = (await pool.query(`SELECT gi.*, p.sku, p.name AS product_name, u.code AS unit, t.name AS tax_name FROM grn_items gi LEFT JOIN products p ON p.id=gi.product_id LEFT JOIN units u ON u.id=p.unit_id LEFT JOIN taxes t ON t.id=gi.tax_id WHERE gi.grn_id=$1`, [g.id])).rows;
  res.json(g);
}));
grnsRouter.post('/:id/complete', requirePermission('purchases.receive'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { await completeGRN(c, req, req.params.id); return (await c.query(`${grnSelect} WHERE g.id=$1`, [req.params.id])).rows[0]; });
  res.json(out);
}));
grnsRouter.post('/:id/cancel', requirePermission('purchases.receive'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const g = (await pool.query(`UPDATE grns SET status='CANCELLED', notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']' WHERE id=$1 AND status IN ('DRAFT','PENDING_QC') RETURNING *`, [req.params.id, b.reason])).rows[0];
  if (!g) throw new BadRequest('Only draft GRNs can be cancelled. Use a purchase return for completed receipts.');
  res.json(g);
}));
// Purchase return to supplier (after completion): stock OUT + reverse accrual → debit note against supplier
grnsRouter.post('/:id/return', requirePermission('purchases.receive', 'purchases.invoice'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2), items: z.array(z.object({ grn_item_id: z.string().uuid(), quantity: z.coerce.number().positive() })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const g = (await c.query(`SELECT * FROM grns WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!g || g.status !== 'COMPLETED') throw new BadRequest('Returns are only possible against completed GRNs');
    const bd = await currentBusinessDate(c, g.property_id, req.user!.id);
    let total = 0, tax = 0; const credits: Record<string, number> = {};
    const number = await nextNumber(c, 'DEBIT_NOTE', req.propertyId);
    const dn = (await c.query(`INSERT INTO supplier_invoices (property_id, number, supplier_id, purchase_order_id, grn_ids, invoice_date, due_date, status, type, notes, created_by, approved_by) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_DATE,'APPROVED','DEBIT_NOTE',$6,$7,$7) RETURNING *`, [req.propertyId, number, g.supplier_id, g.purchase_order_id, [g.id], `Return: ${b.reason}`, req.user!.id])).rows[0];
    for (const it of b.items) {
      const gi = (await c.query(`SELECT gi.*, pc.inventory_account_id FROM grn_items gi LEFT JOIN products p ON p.id=gi.product_id LEFT JOIN product_categories pc ON pc.id=p.category_id WHERE gi.id=$1 AND gi.grn_id=$2`, [it.grn_item_id, g.id])).rows[0];
      if (!gi) throw new NotFound('GRN line not found');
      if (it.quantity > Number(gi.accepted_qty) + 0.0001) throw new BadRequest('Cannot return more than accepted');
      const t = await getTax(c, gi.tax_id); const gross = r2(it.quantity * Number(gi.unit_cost)); const s = t ? splitTax(gross, Number(t.rate), !!t.is_inclusive) : { net: gross, tax: 0, gross };
      if (gi.product_id) await moveStock(c, { propertyId: g.property_id, storeId: g.store_id, productId: gi.product_id, type: 'PURCHASE_RETURN', quantity: -it.quantity, referenceType: 'DEBIT_NOTE', referenceId: dn.id, referenceNumber: number, businessDate: bd, userId: req.user!.id, notes: b.reason });
      const k = gi.inventory_account_id ?? 'INVENTORY'; credits[k] = (credits[k] ?? 0) + s.net; tax += s.tax; total += s.gross;
      await c.query(`INSERT INTO supplier_invoice_items (invoice_id, product_id, grn_item_id, description, quantity, unit_price, tax_id, tax_amount, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [dn.id, gi.product_id, gi.id, `Return: ${gi.description ?? ''}`, it.quantity, gi.unit_cost, gi.tax_id, s.tax, s.gross]);
      if (gi.po_item_id) await c.query(`UPDATE purchase_order_items SET received_qty = GREATEST(0, received_qty - $2) WHERE id=$1`, [gi.po_item_id, it.quantity]);
    }
    const isUuid = (k: string) => /^[0-9a-f-]{36}$/.test(k);
    const lines: any[] = [{ mappingKey: 'AP', debit: r2(total), partyType: 'SUPPLIER', partyId: g.supplier_id }, ...Object.entries(credits).map(([k, v]) => ({ ...(isUuid(k) ? { accountId: k } : { mappingKey: k }), credit: r2(v) }))];
    if (tax > 0) lines.push({ mappingKey: 'TAX_RECEIVABLE', credit: r2(tax) });
    const j = await postJournal(c, { propertyId: g.property_id, businessDate: bd, description: `Purchase return ${number} (GRN ${g.number})`, sourceType: 'DEBIT_NOTE', sourceId: dn.id, userId: req.user!.id, lines });
    await c.query(`UPDATE supplier_invoices SET subtotal=$2, tax_total=$3, total=$4, balance=$4, journal_entry_id=$5 WHERE id=$1`, [dn.id, r2(total - tax), r2(tax), r2(total), j.id]);
    await audit({ ...auditCtx(req), action: 'PURCHASE_RETURN', entityType: 'grn', entityId: g.id, newValue: { debit_note: number, items: b.items, total }, reason: b.reason }, c);
    return (await c.query(`SELECT * FROM supplier_invoices WHERE id=$1`, [dn.id])).rows[0];
  });
  res.status(201).json(out);
}));

// ---------------- Supplier invoices (AP) ----------------
export const supplierInvoicesRouter = Router();
const siSelect = `SELECT si.*, s.name AS supplier_name, po.number AS po_number, cb.full_name AS created_by_name, (CURRENT_DATE - si.due_date) AS days_overdue FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id LEFT JOIN purchase_orders po ON po.id=si.purchase_order_id LEFT JOIN users cb ON cb.id=si.created_by`;
supplierInvoicesRouter.get('/', requirePermission('payables.view', 'purchases.invoice'), asyncHandler(async (req, res) => {
  const where = ['si.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.unpaid === 'true') where.push(`si.status IN ('APPROVED','PARTIALLY_PAID')`);
  if (req.query.overdue === 'true') where.push(`si.status IN ('APPROVED','PARTIALLY_PAID') AND si.due_date < CURRENT_DATE`);
  await runList(req, res, { select: siSelect, where, params, searchColumns: ['si.number', 'si.supplier_invoice_no', 's.name', 'po.number'], defaultSort: 'si.created_at', filters: { status: 'si.status', supplier_id: 'si.supplier_id', type: 'si.type', purchase_order_id: 'si.purchase_order_id' }, dateFilters: { date: 'si.invoice_date', due: 'si.due_date' }, exportName: 'supplier_invoices' });
}));
supplierInvoicesRouter.get('/aging', requirePermission('payables.view'), asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT s.id, s.name, COALESCE(SUM(si.balance) FILTER (WHERE CURRENT_DATE - si.due_date <= 0),0) AS current, COALESCE(SUM(si.balance) FILTER (WHERE CURRENT_DATE - si.due_date BETWEEN 1 AND 30),0) AS d30, COALESCE(SUM(si.balance) FILTER (WHERE CURRENT_DATE - si.due_date BETWEEN 31 AND 60),0) AS d60, COALESCE(SUM(si.balance) FILTER (WHERE CURRENT_DATE - si.due_date BETWEEN 61 AND 90),0) AS d90, COALESCE(SUM(si.balance) FILTER (WHERE CURRENT_DATE - si.due_date > 90),0) AS d90plus, COALESCE(SUM(si.balance),0) AS total
      FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id WHERE si.property_id=$1 AND si.status IN ('APPROVED','PARTIALLY_PAID') AND si.type='INVOICE' GROUP BY s.id, s.name ORDER BY total DESC`, [req.propertyId])).rows;
  const totals = rows.reduce((a, r) => ({ current: a.current + Number(r.current), d30: a.d30 + Number(r.d30), d60: a.d60 + Number(r.d60), d90: a.d90 + Number(r.d90), d90plus: a.d90plus + Number(r.d90plus), total: a.total + Number(r.total) }), { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 });
  res.json({ data: rows, totals });
}));
// Record a supplier invoice against GRNs (3-way match: PO qty/price vs GRN accepted vs invoice)
supplierInvoicesRouter.post('/', requirePermission('purchases.invoice'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ supplier_id: z.string().uuid(), supplier_invoice_no: z.string().min(1), purchase_order_id: z.string().uuid().nullable().optional(), grn_ids: z.array(z.string().uuid()).default([]), invoice_date: dateStr, due_date: dateStr.optional(), currency: z.string().length(3).default('KES'), fx_rate: z.coerce.number().positive().default(1), notes: optionalStr, approve: z.boolean().default(true), tolerance_percent: z.coerce.number().min(0).max(100).default(2),
    items: z.array(z.object({ grn_item_id: z.string().uuid().nullable().optional(), product_id: z.string().uuid().nullable().optional(), description: optionalStr, quantity: z.coerce.number().positive(), unit_price: z.coerce.number().min(0), tax_id: z.string().uuid().nullable().optional(), account_id: z.string().uuid().nullable().optional() })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const dup = (await c.query(`SELECT number FROM supplier_invoices WHERE supplier_id=$1 AND supplier_invoice_no=$2 AND status<>'CANCELLED'`, [b.supplier_id, b.supplier_invoice_no])).rows[0];
    if (dup) throw Errors.duplicate(`Supplier invoice ${b.supplier_invoice_no} already recorded as ${dup.number}`);
    const supplier = (await c.query(`SELECT * FROM suppliers WHERE id=$1`, [b.supplier_id])).rows[0];
    if (!supplier) throw new NotFound('Supplier not found');
    const number = await nextNumber(c, 'SUPPLIER_INVOICE', req.propertyId);
    const due = b.due_date ?? new Date(new Date(b.invoice_date).getTime() + supplier.payment_terms_days * 86400000).toISOString().slice(0, 10);
    const si = (await c.query(`INSERT INTO supplier_invoices (property_id, number, supplier_invoice_no, supplier_id, purchase_order_id, grn_ids, invoice_date, due_date, currency, fx_rate, status, type, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT','INVOICE',$11,$12) RETURNING *`, [req.propertyId, number, b.supplier_invoice_no, b.supplier_id, b.purchase_order_id ?? null, b.grn_ids, b.invoice_date, due, b.currency, b.fx_rate, b.notes ?? null, req.user!.id])).rows[0];
    let subtotal = 0, taxTotal = 0, accrued = 0; const variances: any[] = [];
    for (const it of b.items) {
      let gi: any = null;
      if (it.grn_item_id) {
        gi = (await c.query(`SELECT gi.*, g.status AS grn_status, (SELECT COALESCE(SUM(sii.quantity),0) FROM supplier_invoice_items sii JOIN supplier_invoices x ON x.id=sii.invoice_id WHERE sii.grn_item_id=gi.id AND x.status<>'CANCELLED' AND x.type='INVOICE') AS already_invoiced FROM grn_items gi JOIN grns g ON g.id=gi.grn_id WHERE gi.id=$1`, [it.grn_item_id])).rows[0];
        if (!gi || gi.grn_status !== 'COMPLETED') throw new BadRequest('GRN line not found or GRN not completed');
        const remaining = Number(gi.accepted_qty) - Number(gi.already_invoiced);
        if (it.quantity > remaining + 0.0001) throw new BadRequest(`Invoice quantity ${it.quantity} exceeds uninvoiced received quantity ${remaining} (${gi.description ?? ''})`, undefined, 'MATCH_QTY');
        const priceVar = Number(gi.unit_cost) ? Math.abs(it.unit_price - Number(gi.unit_cost)) / Number(gi.unit_cost) * 100 : 0;
        if (priceVar > b.tolerance_percent) variances.push({ grn_item_id: gi.id, description: gi.description, po_price: Number(gi.unit_cost), invoice_price: it.unit_price, variance_percent: r2(priceVar) });
        const gt = await getTax(c, gi.tax_id); const gGross = r2(it.quantity * Number(gi.unit_cost)); accrued += gt ? splitTax(gGross, Number(gt.rate), !!gt.is_inclusive).gross : gGross;
      }
      const tax = await getTax(c, it.tax_id ?? gi?.tax_id ?? null);
      const gross = r2(it.quantity * it.unit_price);
      const t = tax ? splitTax(gross, Number(tax.rate), !!tax.is_inclusive) : { net: gross, tax: 0, gross };
      subtotal += t.net; taxTotal += t.tax;
      await c.query(`INSERT INTO supplier_invoice_items (invoice_id, product_id, grn_item_id, description, quantity, unit_price, tax_id, tax_amount, line_total, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [si.id, it.product_id ?? gi?.product_id ?? null, gi?.id ?? null, it.description ?? gi?.description ?? null, it.quantity, it.unit_price, tax?.id ?? null, t.tax, t.gross, it.account_id ?? null]);
      if (gi?.po_item_id) await c.query(`UPDATE purchase_order_items SET invoiced_qty = invoiced_qty + $2 WHERE id=$1`, [gi.po_item_id, it.quantity]);
    }
    const total = r2(subtotal + taxTotal);
    await c.query(`UPDATE supplier_invoices SET subtotal=$2, tax_total=$3, total=$4, balance=$4 WHERE id=$1`, [si.id, r2(subtotal), r2(taxTotal), total]);
    if (variances.length && !hasPermission(req, 'purchases.approve')) throw new BadRequest('Price variance beyond tolerance; a purchasing manager must approve this invoice', { variances }, 'PRICE_VARIANCE');
    if (b.approve) await approveSupplierInvoice(c, req, si.id, r2(accrued));
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'supplier_invoice', entityId: si.id, newValue: { number, total, variances } }, c);
    return { ...(await c.query(`${siSelect} WHERE si.id=$1`, [si.id])).rows[0], variances };
  });
  res.status(201).json(out);
}));
/** Approve: post journal. Lines matched to GRNs were already accrued to AP at receipt, so only the difference (price variance, tax difference, non-GRN lines) is posted. */
async function approveSupplierInvoice(c: PoolClient, req: Request, id: string, accruedHint?: number) {
  const si = (await c.query(`SELECT * FROM supplier_invoices WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!['DRAFT', 'PENDING', 'DISPUTED'].includes(si.status)) throw Errors.invalidStatus('supplier invoice', si.status, 'approve');
  const bd = await currentBusinessDate(c, si.property_id, req.user!.id);
  const items = (await c.query(`SELECT sii.*, gi.unit_cost AS grn_cost, gi.tax_id AS grn_tax_id, pc.inventory_account_id, pc.cogs_account_id, poi.expense_account_id FROM supplier_invoice_items sii LEFT JOIN grn_items gi ON gi.id=sii.grn_item_id LEFT JOIN purchase_order_items poi ON poi.id=gi.po_item_id LEFT JOIN products p ON p.id=sii.product_id LEFT JOIN product_categories pc ON pc.id=p.category_id WHERE sii.invoice_id=$1`, [id])).rows;
  const debits: Record<string, number> = {}; let accrued = 0, tax = 0, taxAccrued = 0;
  for (const it of items) {
    const t = await getTax(c, it.tax_id); const gross = Number(it.line_total); const s = t ? splitTax(gross, Number(t.rate), !!t.is_inclusive) : { net: gross, tax: 0, gross };
    tax += s.tax;
    if (it.grn_item_id) {
      const gt = await getTax(c, it.grn_tax_id); const gGross = r2(Number(it.quantity) * Number(it.grn_cost)); const gs = gt ? splitTax(gGross, Number(gt.rate), !!gt.is_inclusive) : { net: gGross, tax: 0, gross: gGross };
      accrued += gs.gross; taxAccrued += gs.tax;
      const diff = r2(s.net - gs.net); // price variance → cost of sales / stock variance
      if (Math.abs(diff) >= 0.01) { const k = 'STOCK_VARIANCE'; debits[k] = (debits[k] ?? 0) + diff; }
    } else { const k = it.account_id ?? it.expense_account_id ?? 'GENERAL_EXPENSE'; debits[k] = (debits[k] ?? 0) + s.net; }
  }
  const total = Number(si.total);
  const apDelta = r2(total - accrued);
  let journalId: string | null = null;
  const isUuid = (k: string) => /^[0-9a-f-]{36}$/.test(k);
  const lines: any[] = Object.entries(debits).filter(([, v]) => Math.abs(v) >= 0.01).map(([k, v]) => ({ ...(isUuid(k) ? { accountId: k } : { mappingKey: k }), ...(v >= 0 ? { debit: r2(v) } : { credit: r2(-v) }) }));
  const taxDelta = r2(tax - taxAccrued);
  if (Math.abs(taxDelta) >= 0.01) lines.push({ mappingKey: 'TAX_RECEIVABLE', ...(taxDelta > 0 ? { debit: taxDelta } : { credit: -taxDelta }), description: 'Input VAT' });
  if (Math.abs(apDelta) >= 0.01) lines.push({ mappingKey: 'AP', ...(apDelta > 0 ? { credit: apDelta } : { debit: -apDelta }), partyType: 'SUPPLIER', partyId: si.supplier_id });
  if (lines.length) { const j = await postJournal(c, { propertyId: si.property_id, businessDate: bd, description: `Supplier invoice ${si.number} (${si.supplier_invoice_no})`, sourceType: 'SUPPLIER_INVOICE', sourceId: si.id, userId: req.user!.id, lines }); journalId = j.id; }
  // AP sub-ledger entry for the full invoice (statement/aging)
  await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ('SUPPLIER',$1,$2,$3,'INVOICE',$4,$5,0,$6,'SUPPLIER_INVOICE',$7,$8,$9)`, [si.supplier_id, si.property_id, si.invoice_date, si.number, `Invoice ${si.supplier_invoice_no}`, total, si.id, journalId, req.user!.id]);
  await c.query(`UPDATE supplier_invoices SET status='APPROVED', approved_by=$2, journal_entry_id=$3 WHERE id=$1`, [id, req.user!.id, journalId]);
  await audit({ ...auditCtx(req), action: 'APPROVE', entityType: 'supplier_invoice', entityId: id, newValue: { total, accrued, apDelta } }, c);
}
supplierInvoicesRouter.get('/:id', requirePermission('payables.view', 'purchases.invoice'), asyncHandler(async (req, res) => {
  const si = (await pool.query(`${siSelect} WHERE si.id=$1`, [req.params.id])).rows[0];
  if (!si) throw new NotFound('Supplier invoice not found');
  si.items = (await pool.query(`SELECT sii.*, p.sku, p.name AS product_name, gi.unit_cost AS grn_unit_cost, g.number AS grn_number FROM supplier_invoice_items sii LEFT JOIN products p ON p.id=sii.product_id LEFT JOIN grn_items gi ON gi.id=sii.grn_item_id LEFT JOIN grns g ON g.id=gi.grn_id WHERE sii.invoice_id=$1`, [si.id])).rows;
  si.payments = (await pool.query(`SELECT sip.amount, p.number, p.reference, p.business_date, pm.name AS method FROM supplier_invoice_payments sip JOIN payments p ON p.id=sip.payment_id JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE sip.invoice_id=$1 ORDER BY p.created_at`, [si.id])).rows;
  res.json(si);
}));
supplierInvoicesRouter.post('/:id/approve', requirePermission('purchases.approve', 'purchases.invoice'), asyncHandler(async (req, res) => {
  await withTransaction((c) => approveSupplierInvoice(c, req, req.params.id));
  res.json((await pool.query(`${siSelect} WHERE si.id=$1`, [req.params.id])).rows[0]);
}));
supplierInvoicesRouter.post('/:id/dispute', requirePermission('purchases.invoice'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const si = (await pool.query(`UPDATE supplier_invoices SET status='DISPUTED', notes=COALESCE(notes,'') || ' [disputed: ' || $2 || ']' WHERE id=$1 AND status IN ('DRAFT','PENDING','APPROVED') AND paid_total=0 RETURNING *`, [req.params.id, b.reason])).rows[0];
  if (!si) throw new BadRequest('Invoice cannot be disputed (already paid or cancelled)');
  res.json(si);
}));
supplierInvoicesRouter.post('/:id/cancel', requirePermission('purchases.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const si = (await c.query(`SELECT * FROM supplier_invoices WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!si) throw new NotFound('Supplier invoice not found');
    if (Number(si.paid_total) > 0) throw new BadRequest('Paid invoices cannot be cancelled; issue a credit note');
    if (si.status === 'CANCELLED') throw Errors.invalidStatus('supplier invoice', si.status, 'cancel');
    if (si.journal_entry_id) { const { reverseJournal } = await import('../finance/accounting.service'); await reverseJournal(c, si.journal_entry_id, req.user!.id, `Supplier invoice ${si.number} cancelled: ${b.reason}`); }
    if (si.status !== 'DRAFT') await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, created_by) VALUES ('SUPPLIER',$1,$2,CURRENT_DATE,'REVERSAL',$3,$4,$5,0,'SUPPLIER_INVOICE',$6,$7)`, [si.supplier_id, si.property_id, si.number, `Cancelled: ${b.reason}`, si.total, si.id, req.user!.id]);
    for (const it of (await c.query(`SELECT sii.quantity, gi.po_item_id FROM supplier_invoice_items sii JOIN grn_items gi ON gi.id=sii.grn_item_id WHERE sii.invoice_id=$1`, [si.id])).rows) if (it.po_item_id) await c.query(`UPDATE purchase_order_items SET invoiced_qty = GREATEST(0, invoiced_qty - $2) WHERE id=$1`, [it.po_item_id, it.quantity]);
    const r = (await c.query(`UPDATE supplier_invoices SET status='CANCELLED', balance=0, notes=COALESCE(notes,'') || ' [cancelled: ' || $2 || ']' WHERE id=$1 RETURNING *`, [si.id, b.reason])).rows[0];
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'supplier_invoice', entityId: si.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- Supplier payments ----------------
export const supplierPaymentsRouter = Router();
supplierPaymentsRouter.get('/', requirePermission('payables.view', 'payments.pay_supplier'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT r.*, s.name AS supplier_name, pm.name AS method_name, u.full_name AS requested_by_name, p.number AS payment_number FROM supplier_payment_requests r JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN payment_methods pm ON pm.id=r.payment_method_id LEFT JOIN users u ON u.id=r.requested_by LEFT JOIN payments p ON p.id=r.payment_id`, where: ['r.property_id=$1'], params: [req.propertyId], searchColumns: ['s.name', 'r.reference', 'p.number'], defaultSort: 'r.created_at', filters: { status: 'r.status', supplier_id: 'r.supplier_id' }, exportName: 'supplier_payments' });
}));
// Request a supplier payment with allocations to invoices; workflow SUPPLIER_PAYMENT; executes payment on approval
supplierPaymentsRouter.post('/', requirePermission('payments.pay_supplier'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ supplier_id: z.string().uuid(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), reference: optionalStr, notes: optionalStr, allocations: z.array(z.object({ invoice_id: z.string().uuid(), amount: z.coerce.number().positive() })).min(1) }), req.body);
  const out = await withTransaction(async (c) => {
    const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
    let amount = 0;
    for (const a of b.allocations) {
      const inv = (await c.query(`SELECT * FROM supplier_invoices WHERE id=$1 AND supplier_id=$2 FOR UPDATE`, [a.invoice_id, b.supplier_id])).rows[0];
      if (!inv) throw new NotFound('Invoice not found for this supplier');
      if (!['APPROVED', 'PARTIALLY_PAID'].includes(inv.status) || inv.type !== 'INVOICE') throw new BadRequest(`Invoice ${inv.number} is not payable (${inv.status})`);
      const pendingAlloc = Number((await c.query(`SELECT COALESCE(SUM((x->>'amount')::numeric),0) AS v FROM supplier_payment_requests r, jsonb_array_elements(r.allocations) x WHERE r.status IN ('PENDING_APPROVAL','APPROVED') AND x->>'invoice_id'=$1`, [inv.id])).rows[0].v);
      if (a.amount > Number(inv.balance) - pendingAlloc + 0.001) throw new BadRequest(`Allocation ${a.amount} exceeds open balance ${r2(Number(inv.balance) - pendingAlloc)} on ${inv.number}`);
      amount += a.amount;
    }
    amount = r2(amount);
    const r = (await c.query(`INSERT INTO supplier_payment_requests (property_id, supplier_id, amount, payment_method_id, reference, allocations, status, notes, requested_by) VALUES ($1,$2,$3,$4,$5,$6,'PENDING_APPROVAL',$7,$8) RETURNING *`, [req.propertyId, b.supplier_id, amount, methodId, b.reference ?? null, JSON.stringify(b.allocations), b.notes ?? null, req.user!.id])).rows[0];
    const appr = await startApproval(c, { transactionType: 'SUPPLIER_PAYMENT', entityType: 'supplier_payment_request', entityId: r.id, amount, propertyId: req.propertyId!, user: req.user!, title: `Supplier payment ${amount}`, link: `/finance/supplier-payments/${r.id}` });
    if (appr.status === 'APPROVED') {
      if (hasPermission(req, 'payments.approve_supplier_payment')) await executeSupplierPayment(c, r.id, req.user!);
      else await notify({ permission: 'payments.approve_supplier_payment', propertyId: req.propertyId, type: 'SUPPLIER_PAYMENT_PENDING', title: `Supplier payment of ${amount} awaiting approval`, entityType: 'supplier_payment_request', entityId: r.id, link: `/finance/supplier-payments/${r.id}` }, c);
    }
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'supplier_payment_request', entityId: r.id, newValue: r }, c);
    return (await c.query(`SELECT * FROM supplier_payment_requests WHERE id=$1`, [r.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function executeSupplierPayment(c: PoolClient, id: string, user: AuthUser) {
  const r = (await c.query(`SELECT * FROM supplier_payment_requests WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!r || r.status === 'PAID') return r;
  const supplier = (await c.query(`SELECT name FROM suppliers WHERE id=$1`, [r.supplier_id])).rows[0];
  const { payment } = await recordPayment(c, { propertyId: r.property_id, direction: 'OUT', kind: 'SUPPLIER_PAYMENT', paymentMethodId: r.payment_method_id, amount: Number(r.amount), reference: r.reference, partyType: 'SUPPLIER', partyId: r.supplier_id, sourceType: 'SUPPLIER_PAYMENT_REQUEST', sourceId: r.id, userId: user.id, offset: { mappingKey: 'AP' }, description: `Payment to ${supplier?.name ?? 'supplier'}`, notes: r.notes });
  for (const a of r.allocations as { invoice_id: string; amount: number }[]) {
    await c.query(`INSERT INTO supplier_invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,$3)`, [a.invoice_id, payment.id, a.amount]);
    await c.query(`UPDATE supplier_invoices SET paid_total = paid_total + $2, balance = balance - $2, status = CASE WHEN balance - $2 <= 0.005 THEN 'PAID' ELSE 'PARTIALLY_PAID' END WHERE id=$1`, [a.invoice_id, a.amount]);
  }
  await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ('SUPPLIER',$1,$2,CURRENT_DATE,'PAYMENT',$3,$4,$5,0,'PAYMENT',$6,$7,$8)`, [r.supplier_id, r.property_id, payment.number, `Payment ${r.reference ?? ''}`, r.amount, payment.id, payment.journal_entry_id, user.id]);
  await c.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE entity_type='supplier_payment_request' AND entity_id=$1 AND status='PENDING'`, [id]);
  const upd = (await c.query(`UPDATE supplier_payment_requests SET status='PAID', payment_id=$2 WHERE id=$1 RETURNING *`, [id, payment.id])).rows[0];
  await notify({ userIds: [r.requested_by], type: 'SUPPLIER_PAID', title: `Supplier payment ${payment.number} executed (${r.amount})`, entityType: 'payment', entityId: payment.id, link: `/finance/payments/${payment.id}`, severity: 'SUCCESS' }, c);
  return upd;
}
registerWorkflowHandler('SUPPLIER_PAYMENT', { onApproved: async (c, id, _r, user) => { await executeSupplierPayment(c, id, user); }, onRejected: async (c, id) => { await c.query(`UPDATE supplier_payment_requests SET status='REJECTED' WHERE id=$1`, [id]); } });
supplierPaymentsRouter.get('/:id', requirePermission('payables.view', 'payments.pay_supplier'), asyncHandler(async (req, res) => {
  const r = (await pool.query(`SELECT r.*, s.name AS supplier_name, pm.name AS method_name, u.full_name AS requested_by_name, p.number AS payment_number, (SELECT json_agg(json_build_object('invoice_id', si.id, 'number', si.number, 'supplier_invoice_no', si.supplier_invoice_no, 'total', si.total, 'balance', si.balance, 'amount', (x->>'amount')::numeric)) FROM jsonb_array_elements(r.allocations) x JOIN supplier_invoices si ON si.id=(x->>'invoice_id')::uuid) AS invoices FROM supplier_payment_requests r JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN payment_methods pm ON pm.id=r.payment_method_id LEFT JOIN users u ON u.id=r.requested_by LEFT JOIN payments p ON p.id=r.payment_id WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!r) throw new NotFound('Payment request not found');
  res.json(r);
}));
supplierPaymentsRouter.post('/:id/approve', requirePermission('payments.approve_supplier_payment'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const r = (await c.query(`SELECT * FROM supplier_payment_requests WHERE id=$1`, [req.params.id])).rows[0];
    if (!r) throw new NotFound('Payment request not found');
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(r.status)) throw Errors.invalidStatus('payment request', r.status, 'approve');
    if (r.requested_by === req.user!.id && !req.user!.is_superuser) throw new Forbidden('Segregation of duties: you cannot approve your own payment request');
    return executeSupplierPayment(c, r.id, req.user!);
  });
  res.json(out);
}));
supplierPaymentsRouter.post('/:id/reject', requirePermission('payments.approve_supplier_payment'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const r = (await pool.query(`UPDATE supplier_payment_requests SET status='REJECTED', notes=COALESCE(notes,'') || ' [rejected: ' || $2 || ']' WHERE id=$1 AND status='PENDING_APPROVAL' RETURNING *`, [req.params.id, b.reason])).rows[0];
  if (!r) throw new BadRequest('Request cannot be rejected in its current status');
  await pool.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE entity_type='supplier_payment_request' AND entity_id=$1 AND status='PENDING'`, [r.id]);
  await audit({ ...auditCtx(req), action: 'REJECT', entityType: 'supplier_payment_request', entityId: r.id, reason: b.reason });
  res.json(r);
}));
