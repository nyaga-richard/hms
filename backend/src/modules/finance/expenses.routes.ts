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
import { postJournal, reverseJournal, currentBusinessDate, getTax, splitTax, r2 } from './accounting.service';
import { recordPayment, resolvePaymentMethodId } from './payments.service';
import { AuthUser } from '../auth/auth.types';

/**
 * Expenses & petty cash.
 * Expense lifecycle: DRAFT → PENDING_APPROVAL → APPROVED (accrual journal: DR expense (+VAT) / CR accrued expenses)
 *   → PAID (settlement: DR accrued expenses / CR cash|bank|petty cash|AP). Rejections & cancellations reverse the accrual.
 * Petty cash: funds with custodians; replenishment from bank/cash, expenses paid from the fund, reconciliation with over/short posting.
 */

export const expenseCategoriesRouter = crudRouter({ table: 'expense_categories', entity: 'expense_category', permissions: { view: 'expenses.view', create: 'settings.edit', edit: 'settings.edit', delete: 'settings.edit' }, softDelete: true, searchColumns: ['code', 'name'], defaultSort: 'name', filters: { active: 'is_active' },
  selectSql: `SELECT t.*, a.code AS account_code, a.name AS account_name FROM expense_categories t JOIN accounts a ON a.id=t.account_id`,
  createSchema: z.object({ code: z.string().min(1), name: z.string().min(1), account_id: z.string().uuid(), requires_receipt: z.boolean().default(true), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), account_id: z.string().uuid(), requires_receipt: z.boolean(), is_active: z.boolean() }).partial() });

// ---------------- Expenses ----------------
export const expensesRouter = Router();
const expSelect = `SELECT e.*, ec.name AS category_name, d.name AS department_name, o.name AS outlet_name, s.name AS supplier_name, pf.name AS fund_name, pm.name AS method_name, rb.full_name AS requested_by_name, ab.full_name AS approved_by_name, p.number AS payment_number,
    (SELECT COUNT(*) FROM attachments a WHERE a.entity_type='expense' AND a.entity_id=e.id::text)::int AS attachment_count
  FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN outlets o ON o.id=e.outlet_id LEFT JOIN suppliers s ON s.id=e.supplier_id LEFT JOIN petty_cash_funds pf ON pf.id=e.petty_cash_fund_id LEFT JOIN payment_methods pm ON pm.id=e.payment_method_id LEFT JOIN users rb ON rb.id=e.requested_by LEFT JOIN users ab ON ab.id=e.approved_by LEFT JOIN payments p ON p.id=e.payment_id`;
expensesRouter.get('/', requirePermission('expenses.view'), asyncHandler(async (req, res) => {
  const where = ['e.property_id=$1']; const params: any[] = [req.propertyId];
  if (req.query.mine === 'true') { params.push(req.user!.id); where.push(`e.requested_by=$${params.length}`); }
  await runList(req, res, { select: expSelect, where, params, searchColumns: ['e.number', 'e.description', 'e.payee', 'ec.name', 'e.reference'], defaultSort: 'e.created_at', filters: { status: 'e.status', category_id: 'e.category_id', department_id: 'e.department_id', outlet_id: 'e.outlet_id', payment_source: 'e.payment_source', supplier_id: 'e.supplier_id', petty_cash_fund_id: 'e.petty_cash_fund_id' }, dateFilters: { date: 'e.expense_date' }, exportName: 'expenses' });
}));
expensesRouter.get('/summary', requirePermission('expenses.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 8) + '01'), to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
  const byCategory = (await pool.query(`SELECT ec.name AS category, COUNT(*)::int AS count, COALESCE(SUM(e.total),0) AS total FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id WHERE e.property_id=$1 AND e.status IN ('APPROVED','PAID') AND e.expense_date BETWEEN $2 AND $3 GROUP BY ec.name ORDER BY total DESC`, [req.propertyId, from, to])).rows;
  const byDept = (await pool.query(`SELECT COALESCE(d.name,'Unassigned') AS department, COUNT(*)::int AS count, COALESCE(SUM(e.total),0) AS total FROM expenses e LEFT JOIN departments d ON d.id=e.department_id WHERE e.property_id=$1 AND e.status IN ('APPROVED','PAID') AND e.expense_date BETWEEN $2 AND $3 GROUP BY d.name ORDER BY total DESC`, [req.propertyId, from, to])).rows;
  const byStatus = (await pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total),0) AS total FROM expenses WHERE property_id=$1 AND expense_date BETWEEN $2 AND $3 GROUP BY status`, [req.propertyId, from, to])).rows;
  res.json({ from, to, by_category: byCategory, by_department: byDept, by_status: byStatus });
}));
const expenseSchema = z.object({ category_id: z.string().uuid(), department_id: z.string().uuid().nullable().optional(), outlet_id: z.string().uuid().nullable().optional(), supplier_id: z.string().uuid().nullable().optional(), payee: optionalStr, description: z.string().min(3), expense_date: dateStr.optional(), amount: z.coerce.number().positive(), tax_id: z.string().uuid().nullable().optional(), tax_inclusive: z.boolean().default(true), currency: z.string().length(3).default('KES'),
  payment_source: z.enum(['CASH', 'BANK', 'MOBILE_MONEY', 'PETTY_CASH', 'CORPORATE_CARD', 'CREDIT']).default('PETTY_CASH'), petty_cash_fund_id: z.string().uuid().nullable().optional(), payment_method_id: z.string().uuid().nullable().optional(), reference: optionalStr, submit: z.boolean().default(true) });
async function computeExpense(c: PoolClient, b: z.infer<typeof expenseSchema>) {
  const tax = await getTax(c, b.tax_id);
  const t = tax ? splitTax(b.amount, Number(tax.rate), b.tax_inclusive) : { net: b.amount, tax: 0, gross: b.amount };
  return { taxId: tax?.id ?? null, net: t.net, tax: t.tax, total: t.gross };
}
expensesRouter.post('/', requirePermission('expenses.create'), asyncHandler(async (req, res) => {
  const b = validate(expenseSchema, req.body);
  const out = await withTransaction(async (c) => {
    if (b.payment_source === 'PETTY_CASH' && !b.petty_cash_fund_id) { const f = (await c.query(`SELECT id FROM petty_cash_funds WHERE property_id=$1 AND is_active AND (custodian_user_id=$2 OR department_id=$3) ORDER BY custodian_user_id=$2 DESC LIMIT 1`, [req.propertyId, req.user!.id, req.user!.department_id])).rows[0]; if (!f) throw new BadRequest('petty_cash_fund_id is required (no fund is assigned to you)'); b.petty_cash_fund_id = f.id; }
    if (b.payment_source === 'CREDIT' && !b.supplier_id) throw new BadRequest('Credit expenses require a supplier');
    const cat = (await c.query(`SELECT * FROM expense_categories WHERE id=$1 AND is_active`, [b.category_id])).rows[0];
    if (!cat) throw new NotFound('Expense category not found');
    const x = await computeExpense(c, b);
    const number = await nextNumber(c, 'EXPENSE', req.propertyId);
    const e = (await c.query(`INSERT INTO expenses (property_id, number, category_id, department_id, outlet_id, supplier_id, payee, description, expense_date, amount, tax_id, tax_amount, total, currency, payment_source, petty_cash_fund_id, payment_method_id, status, reference, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,CURRENT_DATE),$10,$11,$12,$13,$14,$15,$16,$17,'DRAFT',$18,$19) RETURNING *`,
      [req.propertyId, number, b.category_id, b.department_id ?? req.user!.department_id ?? null, b.outlet_id ?? null, b.supplier_id ?? null, b.payee ?? null, b.description, b.expense_date ?? null, x.net, x.taxId, x.tax, x.total, b.currency, b.payment_source, b.petty_cash_fund_id ?? null, b.payment_method_id ?? null, b.reference ?? null, req.user!.id])).rows[0];
    if (b.submit) await submitExpense(c, req, e.id);
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'expense', entityId: e.id, newValue: e }, c);
    return (await c.query(`${expSelect} WHERE e.id=$1`, [e.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function submitExpense(c: PoolClient, req: Request, id: string) {
  const e = (await c.query(`SELECT * FROM expenses WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (e.status !== 'DRAFT') throw Errors.invalidStatus('expense', e.status, 'submit');
  const cat = (await c.query(`SELECT requires_receipt FROM expense_categories WHERE id=$1`, [e.category_id])).rows[0];
  if (cat?.requires_receipt && Number(e.total) > 0) {
    const att = (await c.query(`SELECT 1 FROM attachments WHERE entity_type='expense' AND entity_id=$1::text`, [id])).rows[0];
    if (!att && !e.reference) throw new BadRequest('This category requires a receipt: attach a document or enter the receipt reference', undefined, 'RECEIPT_REQUIRED');
  }
  await c.query(`UPDATE expenses SET status='PENDING_APPROVAL' WHERE id=$1`, [id]);
  const appr = await startApproval(c, { transactionType: 'EXPENSE', entityType: 'expense', entityId: id, entityNumber: e.number, amount: Number(e.total), propertyId: e.property_id, user: req.user!, title: `Expense ${e.number}: ${e.description} (${e.total})`, link: `/finance/expenses/${id}` });
  if (appr.status === 'APPROVED') {
    if (hasPermission(req, 'expenses.approve') && Number(e.total) <= getLimit(req, LIMIT_CODES.EXPENSE_APPROVAL, Number.MAX_SAFE_INTEGER)) await approveExpense(c, id, req.user!);
    else await notify({ permission: 'expenses.approve', propertyId: e.property_id, type: 'EXPENSE_PENDING', title: `Expense ${e.number} awaiting approval (${e.total})`, entityType: 'expense', entityId: id, link: `/finance/expenses/${id}` }, c);
  }
}
/** Approve: accrue the expense. DR expense account (+ DR VAT input if recoverable) / CR accrued expenses (or AP for credit purchases). */
async function approveExpense(c: PoolClient, id: string, user: AuthUser) {
  const e = (await c.query(`SELECT e.*, ec.account_id AS expense_account_id FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id WHERE e.id=$1 FOR UPDATE OF e`, [id])).rows[0];
  if (!e || !['PENDING_APPROVAL', 'DRAFT'].includes(e.status)) return null;
  const bd = await currentBusinessDate(c, e.property_id, user.id);
  const tax = await getTax(c, e.tax_id);
  const recoverable = tax ? !!tax.is_recoverable : false;
  const lines: any[] = [{ accountId: e.expense_account_id, debit: recoverable ? Number(e.amount) : Number(e.total), departmentId: e.department_id, outletId: e.outlet_id, description: e.description }];
  if (recoverable && Number(e.tax_amount) > 0) lines.push({ mappingKey: 'TAX_RECEIVABLE', debit: Number(e.tax_amount), description: 'Input VAT' });
  const creditLine = e.payment_source === 'CREDIT' ? { mappingKey: 'AP', credit: Number(e.total), partyType: 'SUPPLIER', partyId: e.supplier_id } : { mappingKey: 'ACCRUED_EXPENSES', credit: Number(e.total) };
  lines.push(creditLine);
  const je = await postJournal(c, { propertyId: e.property_id, businessDate: bd, description: `Expense ${e.number}: ${e.description}`, sourceType: 'EXPENSE', sourceId: e.id, userId: user.id, lines });
  if (e.payment_source === 'CREDIT') await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ('SUPPLIER',$1,$2,$3,'INVOICE',$4,$5,0,$6,'EXPENSE',$7,$8,$9)`, [e.supplier_id, e.property_id, bd, e.number, e.description, e.total, e.id, je.id, user.id]);
  const r = (await c.query(`UPDATE expenses SET status='APPROVED', approved_by=$2, approved_at=now(), journal_entry_id=$3 WHERE id=$1 RETURNING *`, [id, user.id, je.id])).rows[0];
  await c.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE entity_type='expense' AND entity_id=$1 AND status='PENDING'`, [id]);
  await notify({ userIds: [e.requested_by], permission: 'expenses.pay', propertyId: e.property_id, type: 'EXPENSE_APPROVED', title: `Expense ${e.number} approved (${e.total})`, body: e.payment_source === 'CREDIT' ? 'Recorded as payable' : 'Ready for payment', entityType: 'expense', entityId: id, link: `/finance/expenses/${id}`, severity: 'SUCCESS' }, c);
  await audit({ userId: user.id, username: user.username, propertyId: e.property_id, action: 'APPROVE', entityType: 'expense', entityId: id }, c);
  return r;
}
registerWorkflowHandler('EXPENSE', { onApproved: async (c, id, _r, user) => { await approveExpense(c, id, user); }, onRejected: async (c, id, _r, _u, comment) => { await c.query(`UPDATE expenses SET status='REJECTED', rejection_reason=$2 WHERE id=$1 AND status='PENDING_APPROVAL'`, [id, comment ?? null]); } });

expensesRouter.get('/:id', requirePermission('expenses.view'), asyncHandler(async (req, res) => {
  const e = (await pool.query(`${expSelect} WHERE e.id=$1`, [req.params.id])).rows[0];
  if (!e) throw new NotFound('Expense not found');
  e.attachments = (await pool.query(`SELECT id, file_name, mime_type, size_bytes, description, created_at FROM attachments WHERE entity_type='expense' AND entity_id=$1::text`, [e.id])).rows;
  e.approval = (await pool.query(`SELECT ar.*, (SELECT json_agg(json_build_object('step', a.step_order, 'name', a.step_name, 'action', a.action, 'actor', u.full_name, 'comment', a.comment, 'at', a.created_at) ORDER BY a.created_at) FROM approval_actions a LEFT JOIN users u ON u.id=a.user_id WHERE a.request_id=ar.id) AS actions FROM approval_requests ar WHERE ar.entity_type='expense' AND ar.entity_id=$1 ORDER BY ar.requested_at DESC LIMIT 1`, [e.id])).rows[0] ?? null;
  res.json(e);
}));
expensesRouter.put('/:id', requirePermission('expenses.create'), asyncHandler(async (req, res) => {
  const b = validate(expenseSchema.partial(), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM expenses WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Expense not found');
    if (!['DRAFT', 'REJECTED'].includes(e.status)) throw new BadRequest('Only draft or rejected expenses can be edited');
    const merged = { ...e, ...b, amount: b.amount ?? Number(e.total), tax_inclusive: b.tax_inclusive ?? true } as any;
    const x = await computeExpense(c, merged);
    await c.query(`UPDATE expenses SET category_id=$2, department_id=$3, outlet_id=$4, supplier_id=$5, payee=$6, description=$7, expense_date=$8, amount=$9, tax_id=$10, tax_amount=$11, total=$12, payment_source=$13, petty_cash_fund_id=$14, payment_method_id=$15, reference=$16, status='DRAFT', rejection_reason=NULL WHERE id=$1`,
      [e.id, merged.category_id, merged.department_id ?? null, merged.outlet_id ?? null, merged.supplier_id ?? null, merged.payee ?? null, merged.description, merged.expense_date ?? e.expense_date, x.net, x.taxId, x.tax, x.total, merged.payment_source, merged.petty_cash_fund_id ?? null, merged.payment_method_id ?? null, merged.reference ?? null]);
    if (b.submit) await submitExpense(c, req, e.id);
    await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'expense', entityId: e.id, oldValue: e, newValue: b }, c);
    return (await c.query(`${expSelect} WHERE e.id=$1`, [e.id])).rows[0];
  });
  res.json(out);
}));
expensesRouter.post('/:id/submit', requirePermission('expenses.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => { await submitExpense(c, req, req.params.id); return (await c.query(`${expSelect} WHERE e.id=$1`, [req.params.id])).rows[0]; });
  res.json(out);
}));
expensesRouter.post('/:id/approve', requirePermission('expenses.approve'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM expenses WHERE id=$1`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Expense not found');
    if (!['PENDING_APPROVAL', 'DRAFT'].includes(e.status)) throw Errors.invalidStatus('expense', e.status, 'approve');
    if (Number(e.total) > getLimit(req, LIMIT_CODES.EXPENSE_APPROVAL, Number.MAX_SAFE_INTEGER)) throw new Forbidden(`Expense ${e.total} exceeds your approval limit`);
    if (e.requested_by === req.user!.id && !req.user!.is_superuser) throw new Forbidden('Segregation of duties: you cannot approve your own expense');
    await approveExpense(c, e.id, req.user!);
    return (await c.query(`${expSelect} WHERE e.id=$1`, [e.id])).rows[0];
  });
  res.json(out);
}));
expensesRouter.post('/:id/reject', requirePermission('expenses.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`UPDATE expenses SET status='REJECTED', rejection_reason=$2 WHERE id=$1 AND status IN ('PENDING_APPROVAL','DRAFT') RETURNING *`, [req.params.id, b.reason])).rows[0];
    if (!e) throw new BadRequest('Expense cannot be rejected in its current status');
    await c.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE entity_type='expense' AND entity_id=$1 AND status='PENDING'`, [e.id]);
    await notify({ userIds: [e.requested_by], type: 'EXPENSE_REJECTED', title: `Expense ${e.number} rejected`, body: b.reason, entityType: 'expense', entityId: e.id, link: `/finance/expenses/${e.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'REJECT', entityType: 'expense', entityId: e.id, reason: b.reason }, c);
    return e;
  });
  res.json(out);
}));
/** Pay an approved expense: settles the accrual from petty cash, cash drawer, bank or mobile money. */
expensesRouter.post('/:id/pay', requirePermission('expenses.pay', 'petty_cash.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), petty_cash_fund_id: z.string().uuid().optional(), reference: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional() }), req.body ?? {});
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM expenses WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Expense not found');
    if (e.status !== 'APPROVED') throw Errors.invalidStatus('expense', e.status, 'pay');
    if (e.payment_source === 'CREDIT') throw new BadRequest('Credit expenses are settled through supplier payments', undefined, 'USE_SUPPLIER_PAYMENT');
    const bd = await currentBusinessDate(c, e.property_id, req.user!.id);
    let paymentId: string | null = null;
    if (e.payment_source === 'PETTY_CASH') {
      if (!hasPermission(req, 'petty_cash.manage') && !hasPermission(req, 'expenses.pay')) throw new Forbidden('Missing permission petty_cash.manage');
      const fundId = b.petty_cash_fund_id ?? e.petty_cash_fund_id;
      const fund = (await c.query(`SELECT * FROM petty_cash_funds WHERE id=$1 AND is_active FOR UPDATE`, [fundId])).rows[0];
      if (!fund) throw new NotFound('Petty cash fund not found');
      if (fund.custodian_user_id !== req.user!.id && !hasPermission(req, 'petty_cash.reconcile') && !req.user!.is_superuser) throw new Forbidden('Only the fund custodian (or petty cash supervisor) can pay from this fund');
      if (Number(fund.balance) < Number(e.total)) throw new BadRequest(`Insufficient petty cash: fund balance ${fund.balance}, expense ${e.total}`, { balance: Number(fund.balance) }, 'INSUFFICIENT_FUND');
      const je = await postJournal(c, { propertyId: e.property_id, businessDate: bd, description: `Petty cash payment ${e.number} from ${fund.name}`, sourceType: 'PETTY_CASH', sourceId: e.id, userId: req.user!.id, lines: [{ mappingKey: 'ACCRUED_EXPENSES', debit: Number(e.total) }, { accountId: fund.account_id, credit: Number(e.total) }] });
      const newBal = r2(Number(fund.balance) - Number(e.total));
      await c.query(`UPDATE petty_cash_funds SET balance=$2 WHERE id=$1`, [fund.id, newBal]);
      await c.query(`INSERT INTO petty_cash_transactions (fund_id, type, amount, balance_after, expense_id, description, reference, journal_entry_id, created_by) VALUES ($1,'EXPENSE',$2,$3,$4,$5,$6,$7,$8)`, [fund.id, -Number(e.total), newBal, e.id, `${e.number}: ${e.description}`, b.reference ?? e.reference, je.id, req.user!.id]);
      if (newBal < Number(fund.float_amount) * 0.2) await notify({ userIds: [fund.custodian_user_id], permission: 'petty_cash.reconcile', propertyId: e.property_id, type: 'PETTY_CASH_LOW', title: `${fund.name} is low (${newBal})`, body: 'Request a replenishment', entityType: 'petty_cash_fund', entityId: fund.id, link: `/finance/petty-cash/${fund.id}`, severity: 'WARNING' }, c);
    } else {
      const methodId = await resolvePaymentMethodId(b.payment_method_id ?? e.payment_method_id, b.payment_method_code ?? (e.payment_source === 'BANK' ? 'BANK' : e.payment_source === 'MOBILE_MONEY' ? 'MPESA' : 'CASH'), c);
      const { payment } = await recordPayment(c, { propertyId: e.property_id, direction: 'OUT', kind: 'EXPENSE_PAYMENT', paymentMethodId: methodId, amount: Number(e.total), reference: b.reference ?? e.reference, partyType: e.supplier_id ? 'SUPPLIER' : null, partyId: e.supplier_id, sourceType: 'EXPENSE', sourceId: e.id, cashierShiftId: b.cashier_shift_id ?? null, userId: req.user!.id, offset: { mappingKey: 'ACCRUED_EXPENSES' }, description: `Expense ${e.number}: ${e.description}` });
      paymentId = payment.id;
    }
    const r = (await c.query(`UPDATE expenses SET status='PAID', paid_at=now(), payment_id=$2, petty_cash_fund_id=COALESCE($3, petty_cash_fund_id) WHERE id=$1 RETURNING *`, [e.id, paymentId, b.petty_cash_fund_id ?? null])).rows[0];
    await audit({ ...auditCtx(req), action: 'PAY', entityType: 'expense', entityId: e.id, newValue: { payment_id: paymentId, source: e.payment_source } }, c);
    return r;
  });
  res.json(out);
}));
expensesRouter.post('/:id/cancel', requirePermission('expenses.create', 'expenses.approve'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(2) }), req.body);
  const out = await withTransaction(async (c) => {
    const e = (await c.query(`SELECT * FROM expenses WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw new NotFound('Expense not found');
    if (e.status === 'PAID') throw new BadRequest('Paid expenses cannot be cancelled; reverse the payment first');
    if (['CANCELLED'].includes(e.status)) throw Errors.invalidStatus('expense', e.status, 'cancel');
    if (e.status === 'APPROVED' && !hasPermission(req, 'expenses.approve')) throw new Forbidden('Approved expenses can only be cancelled by an approver');
    if (e.requested_by !== req.user!.id && !hasPermission(req, 'expenses.approve')) throw new Forbidden('You can only cancel your own expenses');
    if (e.journal_entry_id) { await reverseJournal(c, e.journal_entry_id, req.user!.id, `Expense ${e.number} cancelled: ${b.reason}`); if (e.payment_source === 'CREDIT') await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, created_by) VALUES ('SUPPLIER',$1,$2,CURRENT_DATE,'REVERSAL',$3,$4,$5,0,'EXPENSE',$6,$7)`, [e.supplier_id, e.property_id, e.number, `Cancelled: ${b.reason}`, e.total, e.id, req.user!.id]); }
    await c.query(`UPDATE approval_requests SET status='CANCELLED', completed_at=now() WHERE entity_type='expense' AND entity_id=$1 AND status='PENDING'`, [e.id]);
    const r = (await c.query(`UPDATE expenses SET status='CANCELLED', rejection_reason=$2 WHERE id=$1 RETURNING *`, [e.id, b.reason])).rows[0];
    await audit({ ...auditCtx(req), action: 'CANCEL', entityType: 'expense', entityId: e.id, reason: b.reason }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- Petty cash ----------------
export const pettyCashRouter = Router();
const fundSelect = `SELECT f.*, u.full_name AS custodian_name, d.name AS department_name, a.code AS account_code, a.name AS account_name, (SELECT MAX(created_at) FROM petty_cash_transactions t WHERE t.fund_id=f.id AND t.type='RECONCILIATION') AS last_reconciled_at,
    (SELECT COALESCE(SUM(total),0) FROM expenses e WHERE e.petty_cash_fund_id=f.id AND e.status='APPROVED' AND e.payment_source='PETTY_CASH') AS approved_unpaid
  FROM petty_cash_funds f LEFT JOIN users u ON u.id=f.custodian_user_id LEFT JOIN departments d ON d.id=f.department_id LEFT JOIN accounts a ON a.id=f.account_id`;
pettyCashRouter.get('/funds', requirePermission('petty_cash.view'), asyncHandler(async (req, res) => {
  const where = ['f.property_id=$1']; const params: any[] = [req.propertyId];
  if (!hasPermission(req, 'petty_cash.reconcile') && !req.user!.is_superuser) { params.push(req.user!.id); where.push(`f.custodian_user_id=$${params.length}`); }
  await runList(req, res, { select: fundSelect, where, params, searchColumns: ['f.name', 'u.full_name'], defaultSort: 'f.name', filters: { active: 'f.is_active', custodian_user_id: 'f.custodian_user_id' }, exportName: 'petty_cash_funds' });
}));
pettyCashRouter.post('/funds', requirePermission('petty_cash.reconcile', 'settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ name: z.string().min(2), custodian_user_id: z.string().uuid(), department_id: z.string().uuid().nullable().optional(), account_id: z.string().uuid().optional(), float_amount: z.coerce.number().min(0) }), req.body);
  const out = await withTransaction(async (c) => {
    const accountId = b.account_id ?? (await c.query(`SELECT account_id FROM account_mappings WHERE mapping_key='PETTY_CASH' AND (property_id=$1 OR property_id IS NULL) ORDER BY property_id NULLS LAST LIMIT 1`, [req.propertyId])).rows[0]?.account_id;
    if (!accountId) throw new BadRequest('No petty cash account configured (mapping PETTY_CASH)');
    const f = (await c.query(`INSERT INTO petty_cash_funds (property_id, name, custodian_user_id, department_id, account_id, float_amount, balance) VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING *`, [req.propertyId, b.name, b.custodian_user_id, b.department_id ?? null, accountId, b.float_amount])).rows[0];
    await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'petty_cash_fund', entityId: f.id, newValue: f }, c);
    return f;
  });
  res.status(201).json(out);
}));
pettyCashRouter.put('/funds/:id', requirePermission('petty_cash.reconcile', 'settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ name: z.string().min(2), custodian_user_id: z.string().uuid(), department_id: z.string().uuid().nullable(), float_amount: z.coerce.number().min(0), is_active: z.boolean() }).partial(), req.body);
  const f = (await pool.query(`UPDATE petty_cash_funds SET name=COALESCE($2,name), custodian_user_id=COALESCE($3,custodian_user_id), department_id=COALESCE($4,department_id), float_amount=COALESCE($5,float_amount), is_active=COALESCE($6,is_active) WHERE id=$1 RETURNING *`, [req.params.id, b.name ?? null, b.custodian_user_id ?? null, b.department_id ?? null, b.float_amount ?? null, b.is_active ?? null])).rows[0];
  if (!f) throw new NotFound('Fund not found');
  await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'petty_cash_fund', entityId: f.id, newValue: b });
  res.json(f);
}));
pettyCashRouter.get('/funds/:id', requirePermission('petty_cash.view'), asyncHandler(async (req, res) => {
  const f = (await pool.query(`${fundSelect} WHERE f.id=$1`, [req.params.id])).rows[0];
  if (!f) throw new NotFound('Fund not found');
  if (f.custodian_user_id !== req.user!.id && !hasPermission(req, 'petty_cash.reconcile') && !req.user!.is_superuser) throw new Forbidden('You are not the custodian of this fund');
  f.recent = (await pool.query(`SELECT t.*, u.full_name AS created_by_name, e.number AS expense_number FROM petty_cash_transactions t LEFT JOIN users u ON u.id=t.created_by LEFT JOIN expenses e ON e.id=t.expense_id WHERE t.fund_id=$1 ORDER BY t.created_at DESC LIMIT 20`, [f.id])).rows;
  f.pending_expenses = (await pool.query(`SELECT id, number, description, total, status, expense_date FROM expenses WHERE petty_cash_fund_id=$1 AND status IN ('PENDING_APPROVAL','APPROVED') ORDER BY created_at`, [f.id])).rows;
  res.json(f);
}));
pettyCashRouter.get('/funds/:id/transactions', requirePermission('petty_cash.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT t.*, u.full_name AS created_by_name, e.number AS expense_number, e.description AS expense_description FROM petty_cash_transactions t LEFT JOIN users u ON u.id=t.created_by LEFT JOIN expenses e ON e.id=t.expense_id`, where: ['t.fund_id=$1'], params: [req.params.id], searchColumns: ['t.description', 't.reference', 'e.number'], defaultSort: 't.created_at', filters: { type: 't.type' }, dateFilters: { date: 't.created_at::date' }, exportName: 'petty_cash_transactions' });
}));
/** Replenish (top-up) a fund from bank/cash: DR petty cash account / CR bank|cash. Also used for the initial float (type OPENING). */
pettyCashRouter.post('/funds/:id/replenish', requirePermission('petty_cash.manage', 'petty_cash.reconcile'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ amount: z.coerce.number().positive().optional(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().default('BANK'), reference: optionalStr, notes: optionalStr }), req.body ?? {});
  const out = await withTransaction(async (c) => {
    const f = (await c.query(`SELECT * FROM petty_cash_funds WHERE id=$1 AND is_active FOR UPDATE`, [req.params.id])).rows[0];
    if (!f) throw new NotFound('Fund not found');
    const isOpening = Number(f.balance) === 0 && !(await c.query(`SELECT 1 FROM petty_cash_transactions WHERE fund_id=$1 LIMIT 1`, [f.id])).rows[0];
    const amount = r2(b.amount ?? Math.max(0, Number(f.float_amount) - Number(f.balance)));
    if (amount <= 0) throw new BadRequest('Fund is already at its float; nothing to replenish');
    const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
    const { payment } = await recordPayment(c, { propertyId: f.property_id, direction: 'OUT', kind: 'PETTY_CASH', paymentMethodId: methodId, amount, reference: b.reference, sourceType: 'PETTY_CASH_FUND', sourceId: f.id, userId: req.user!.id, offset: { accountId: f.account_id }, description: `${isOpening ? 'Opening float' : 'Replenishment'} for ${f.name}`, notes: b.notes });
    const newBal = r2(Number(f.balance) + amount);
    await c.query(`UPDATE petty_cash_funds SET balance=$2 WHERE id=$1`, [f.id, newBal]);
    const t = (await c.query(`INSERT INTO petty_cash_transactions (fund_id, type, amount, balance_after, payment_id, description, reference, journal_entry_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [f.id, isOpening ? 'OPENING' : 'REPLENISHMENT', amount, newBal, payment.id, `${isOpening ? 'Opening float' : 'Replenishment'} ${payment.number}`, b.reference ?? null, payment.journal_entry_id, req.user!.id])).rows[0];
    await notify({ userIds: [f.custodian_user_id], type: 'PETTY_CASH_REPLENISHED', title: `${f.name} replenished with ${amount}`, entityType: 'petty_cash_fund', entityId: f.id, link: `/finance/petty-cash/${f.id}`, severity: 'SUCCESS' }, c);
    await audit({ ...auditCtx(req), action: 'REPLENISH', entityType: 'petty_cash_fund', entityId: f.id, newValue: t }, c);
    return t;
  });
  res.status(201).json(out);
}));
/** Return surplus cash from the fund to bank/main cash. */
pettyCashRouter.post('/funds/:id/return', requirePermission('petty_cash.manage', 'petty_cash.reconcile'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ amount: z.coerce.number().positive(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().default('CASH'), reference: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const f = (await c.query(`SELECT * FROM petty_cash_funds WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!f) throw new NotFound('Fund not found');
    if (b.amount > Number(f.balance)) throw new BadRequest('Cannot return more than the fund balance');
    const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
    const { payment } = await recordPayment(c, { propertyId: f.property_id, direction: 'IN', kind: 'PETTY_CASH', paymentMethodId: methodId, amount: b.amount, reference: b.reference, sourceType: 'PETTY_CASH_FUND', sourceId: f.id, userId: req.user!.id, offset: { accountId: f.account_id }, description: `Cash returned from ${f.name}` });
    const newBal = r2(Number(f.balance) - b.amount);
    await c.query(`UPDATE petty_cash_funds SET balance=$2 WHERE id=$1`, [f.id, newBal]);
    return (await c.query(`INSERT INTO petty_cash_transactions (fund_id, type, amount, balance_after, payment_id, description, reference, journal_entry_id, created_by) VALUES ($1,'RETURN',$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [f.id, -b.amount, newBal, payment.id, `Returned ${payment.number}`, b.reference ?? null, payment.journal_entry_id, req.user!.id])).rows[0];
  });
  res.status(201).json(out);
}));
/** Reconcile: physical count vs book balance; variance posted to cash over/short and the fund re-based to the count. */
pettyCashRouter.post('/funds/:id/reconcile', requirePermission('petty_cash.reconcile', 'petty_cash.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ counted_amount: z.coerce.number().min(0), notes: optionalStr }), req.body);
  const out = await withTransaction(async (c) => {
    const f = (await c.query(`SELECT * FROM petty_cash_funds WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!f) throw new NotFound('Fund not found');
    const variance = r2(b.counted_amount - Number(f.balance));
    let journalId: string | null = null;
    if (Math.abs(variance) >= 0.01) {
      if (Math.abs(variance) > getLimit(req, LIMIT_CODES.CASH_VARIANCE, Number.MAX_SAFE_INTEGER)) throw new Forbidden(`Variance ${variance} exceeds your cash variance limit; escalate to finance`);
      const bd = await currentBusinessDate(c, f.property_id, req.user!.id);
      const je = await postJournal(c, { propertyId: f.property_id, businessDate: bd, description: `Petty cash reconciliation ${f.name}: ${variance > 0 ? 'overage' : 'shortage'} ${Math.abs(variance)}`, sourceType: 'PETTY_CASH', sourceId: f.id, userId: req.user!.id, lines: variance > 0 ? [{ accountId: f.account_id, debit: variance }, { mappingKey: 'CASH_OVER_SHORT', credit: variance }] : [{ mappingKey: 'CASH_OVER_SHORT', debit: -variance }, { accountId: f.account_id, credit: -variance }] });
      journalId = je.id;
    }
    await c.query(`UPDATE petty_cash_funds SET balance=$2 WHERE id=$1`, [f.id, b.counted_amount]);
    const t = (await c.query(`INSERT INTO petty_cash_transactions (fund_id, type, amount, balance_after, description, counted_amount, variance, journal_entry_id, created_by) VALUES ($1,'RECONCILIATION',$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [f.id, variance, b.counted_amount, b.notes ?? `Reconciled by ${req.user!.username}`, b.counted_amount, variance, journalId, req.user!.id])).rows[0];
    if (Math.abs(variance) >= 0.01) await notify({ permission: 'petty_cash.reconcile', propertyId: f.property_id, type: 'PETTY_CASH_VARIANCE', title: `${f.name} reconciliation variance ${variance}`, entityType: 'petty_cash_fund', entityId: f.id, link: `/finance/petty-cash/${f.id}`, severity: 'WARNING' }, c);
    await audit({ ...auditCtx(req), action: 'RECONCILE', entityType: 'petty_cash_fund', entityId: f.id, newValue: t }, c);
    return t;
  });
  res.status(201).json(out);
}));
