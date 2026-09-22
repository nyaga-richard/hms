import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { asyncHandler, validate, optionalStr, dateStr, sendExport, getPagination, paged , isExport } from '../../core/http';
import { requirePermission, hasPermission } from '../../middleware/auth';
import { NotFound, BadRequest, Errors, Forbidden } from '../../core/errors';
import { audit, auditCtx } from '../../core/audit';
import { runList } from '../../core/listing';
import { crudRouter } from '../../core/crud';
import { nextNumber } from '../../core/numbering';
import { postJournal, reverseJournal, resolveCompanyId, currentBusinessDate, r2 } from './accounting.service';
import { recordPayment, resolvePaymentMethodId } from './payments.service';

/**
 * Finance: chart of accounts, account mappings, taxes, payment methods, currencies, accounting periods,
 * journals (auto + manual + reversals), financial statements, payments register, customers & receivables.
 * Journals are immutable: corrections are always reversals (see accounting.service).
 */

// ---------------- Chart of accounts ----------------
export const accountsRouter = crudRouter({ table: 'accounts', entity: 'account', permissions: { view: 'accounting.view', create: 'accounting.accounts', edit: 'accounting.accounts', delete: 'accounting.accounts' }, softDelete: true, searchColumns: ['code', 'name', 'description'], defaultSort: 'code', filters: { type: 'type', company_id: 'company_id', header: 'is_header', active: 'is_active', parent_id: 'parent_id' },
  selectSql: `SELECT t.*, p.code AS parent_code, p.name AS parent_name FROM accounts t LEFT JOIN accounts p ON p.id=t.parent_id`,
  createSchema: z.object({ company_id: z.string().uuid().optional(), code: z.string().min(1), name: z.string().min(1), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE']), parent_id: z.string().uuid().nullable().optional(), is_header: z.boolean().default(false), currency: z.string().length(3).default('KES'), description: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), parent_id: z.string().uuid().nullable(), is_header: z.boolean(), description: optionalStr, is_active: z.boolean(), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE']) }).partial(),
  beforeCreate: async (d, req) => { if (!d.company_id) { const c = await pool.connect(); try { d.company_id = await resolveCompanyId(c, req.propertyId ?? null); } finally { c.release(); } } return d; },
  extraRoutes: (r) => {
    r.get('/tree', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
      const rows = (await pool.query(`SELECT a.*, COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=a.id AND je.status='POSTED' AND ($1::uuid IS NULL OR jl.property_id=$1 OR jl.property_id IS NULL)),0) AS balance FROM accounts a WHERE a.is_active ORDER BY a.code`, [req.query.all === 'true' ? null : req.propertyId])).rows;
      const byId: Record<string, any> = {}; rows.forEach((a) => { byId[a.id] = { ...a, balance: Number(a.balance), children: [] }; });
      const roots: any[] = [];
      rows.forEach((a) => { const n = byId[a.id]; if (a.parent_id && byId[a.parent_id]) byId[a.parent_id].children.push(n); else roots.push(n); });
      const roll = (n: any): number => { n.total = n.balance + n.children.reduce((s: number, c: any) => s + roll(c), 0); return n.total; };
      roots.forEach(roll);
      res.json(roots);
    }));
    r.get('/:id/ledger', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
      const acc = (await pool.query(`SELECT * FROM accounts WHERE id=$1`, [req.params.id])).rows[0];
      if (!acc) throw new NotFound('Account not found');
      const from = String(req.query.from ?? '1900-01-01'), to = String(req.query.to ?? '2999-12-31');
      const opening = Number((await pool.query(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=$1 AND je.status='POSTED' AND je.entry_date < $2 AND ($3::uuid IS NULL OR jl.property_id=$3 OR jl.property_id IS NULL)`, [acc.id, from, req.propertyId])).rows[0].b);
      const lines = (await pool.query(`SELECT je.number, je.entry_date, je.business_date, je.source_type, je.source_id, je.status, jl.description, jl.debit, jl.credit, jl.department_id, jl.outlet_id, jl.party_type, jl.party_id, je.id AS journal_entry_id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=$1 AND je.status='POSTED' AND je.entry_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR jl.property_id=$4 OR jl.property_id IS NULL) ORDER BY je.entry_date, je.created_at, jl.line_no`, [acc.id, from, to, req.propertyId])).rows;
      let bal = opening; const out = lines.map((l) => { bal = r2(bal + Number(l.debit) - Number(l.credit)); return { ...l, balance: bal }; });
      if (isExport(req)) return sendExport(res, req, out, `ledger_${acc.code}`);
      res.json({ account: acc, opening, closing: bal, lines: out });
    }));
  } });

export const accountMappingsRouter = Router();
accountMappingsRouter.get('/', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
  res.json((await pool.query(`SELECT m.*, a.code AS account_code, a.name AS account_name FROM account_mappings m JOIN accounts a ON a.id=m.account_id WHERE m.property_id IS NULL OR m.property_id=$1 ORDER BY m.mapping_key, m.property_id NULLS FIRST`, [req.propertyId])).rows);
}));
accountMappingsRouter.put('/:key', requirePermission('accounting.accounts'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ account_id: z.string().uuid(), property_specific: z.boolean().default(false) }), req.body);
  const pid = b.property_specific ? req.propertyId : null;
  const row = (await pool.query(`INSERT INTO account_mappings (property_id, mapping_key, account_id) VALUES ($1,$2,$3) ON CONFLICT (property_id, mapping_key) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING *`, [pid, req.params.key, b.account_id])).rows[0];
  await audit({ ...auditCtx(req), action: 'UPDATE', entityType: 'account_mapping', entityId: row.id, newValue: row });
  res.json(row);
}));

export const taxesRouter = crudRouter({ table: 'taxes', entity: 'tax', permissions: { view: 'settings.view', create: 'settings.edit', edit: 'settings.edit', delete: 'settings.edit' }, softDelete: true, searchColumns: ['code', 'name'], defaultSort: 'code', filters: { type: 'type', active: 'is_active' },
  selectSql: `SELECT t.*, a.code AS account_code, a.name AS account_name FROM taxes t LEFT JOIN accounts a ON a.id=t.account_id`, fixedWhere: (req) => ({ sql: `(t.property_id IS NULL OR t.property_id=$PARAM)`, params: [req.propertyId] }),
  createSchema: z.object({ property_id: z.string().uuid().nullable().optional(), code: z.string().min(1), name: z.string().min(1), rate: z.coerce.number().min(0).max(100), type: z.string().default('VAT'), is_inclusive: z.boolean().default(true), is_recoverable: z.boolean().default(true), account_id: z.string().uuid(), applies_to: z.array(z.string()).default([]), fiscal_code: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), rate: z.coerce.number().min(0).max(100), is_inclusive: z.boolean(), is_recoverable: z.boolean(), account_id: z.string().uuid(), applies_to: z.array(z.string()), fiscal_code: optionalStr, is_active: z.boolean() }).partial() });

export const paymentMethodsRouter = crudRouter({ table: 'payment_methods', entity: 'payment_method', permissions: { view: 'payments.view', create: 'settings.edit', edit: 'settings.edit', delete: 'settings.edit' }, softDelete: true, searchColumns: ['code', 'name'], defaultSort: 'name', filters: { type: 'type', active: 'is_active' },
  selectSql: `SELECT t.*, a.code AS account_code, a.name AS account_name FROM payment_methods t LEFT JOIN accounts a ON a.id=t.account_id`, fixedWhere: (req) => ({ sql: `(t.property_id IS NULL OR t.property_id=$PARAM)`, params: [req.propertyId] }),
  createSchema: z.object({ property_id: z.string().uuid().nullable().optional(), code: z.string().min(1), name: z.string().min(1), type: z.enum(['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'VOUCHER', 'CORPORATE_CREDIT', 'GUEST_DEPOSIT', 'ROOM_CHARGE', 'OTHER']), account_id: z.string().uuid().nullable().optional(), requires_reference: z.boolean().default(false), is_cash_drawer: z.boolean().default(false), is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), account_id: z.string().uuid().nullable(), requires_reference: z.boolean(), is_cash_drawer: z.boolean(), is_active: z.boolean() }).partial() });

export const currenciesRouter = Router();
currenciesRouter.get('/', requirePermission('settings.view', 'payments.view'), asyncHandler(async (_req, res) => {
  res.json((await pool.query(`SELECT c.*, (SELECT rate FROM exchange_rates x WHERE x.from_currency=c.code AND x.to_currency=(SELECT currency FROM properties WHERE id=$1) ORDER BY effective_date DESC LIMIT 1) AS latest_rate FROM currencies c ORDER BY code`, [_req.propertyId])).rows);
}));
currenciesRouter.post('/', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ code: z.string().length(3), name: z.string().min(1), symbol: z.string().min(1), decimals: z.coerce.number().int().min(0).max(4).default(2), is_active: z.boolean().default(true) }), req.body);
  res.status(201).json((await pool.query(`INSERT INTO currencies (code, name, symbol, decimals, is_active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, symbol=EXCLUDED.symbol, decimals=EXCLUDED.decimals, is_active=EXCLUDED.is_active RETURNING *`, [b.code.toUpperCase(), b.name, b.symbol, b.decimals, b.is_active])).rows[0]);
}));
currenciesRouter.get('/rates', requirePermission('settings.view', 'payments.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT x.*, u.full_name AS created_by_name FROM exchange_rates x LEFT JOIN users u ON u.id=x.created_by`, where: [], params: [], searchColumns: ['x.from_currency', 'x.to_currency'], defaultSort: 'x.effective_date', filters: { from_currency: 'x.from_currency', to_currency: 'x.to_currency' }, exportName: 'exchange_rates' });
}));
currenciesRouter.post('/rates', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ from_currency: z.string().length(3), to_currency: z.string().length(3), rate: z.coerce.number().positive(), effective_date: dateStr.optional() }), req.body);
  const row = (await pool.query(`INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_date, created_by) VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5) RETURNING *`, [b.from_currency.toUpperCase(), b.to_currency.toUpperCase(), b.rate, b.effective_date ?? null, req.user!.id])).rows[0];
  await audit({ ...auditCtx(req), action: 'CREATE', entityType: 'exchange_rate', entityId: row.id, newValue: row });
  res.status(201).json(row);
}));
currenciesRouter.get('/convert', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? '').toUpperCase(), to = String(req.query.to ?? '').toUpperCase(); const amount = Number(req.query.amount ?? 0);
  if (from === to) return res.json({ rate: 1, amount, converted: amount });
  const r = (await pool.query(`SELECT rate FROM exchange_rates WHERE from_currency=$1 AND to_currency=$2 AND effective_date <= CURRENT_DATE ORDER BY effective_date DESC LIMIT 1`, [from, to])).rows[0];
  const inv = r ? null : (await pool.query(`SELECT rate FROM exchange_rates WHERE from_currency=$2 AND to_currency=$1 AND effective_date <= CURRENT_DATE ORDER BY effective_date DESC LIMIT 1`, [from, to])).rows[0];
  const rate = r ? Number(r.rate) : inv ? 1 / Number(inv.rate) : null;
  if (rate == null) throw new BadRequest(`No exchange rate configured for ${from}→${to}`, undefined, 'NO_RATE');
  res.json({ rate, amount, converted: r2(amount * rate) });
}));

// ---------------- Accounting periods ----------------
export const periodsRouter = Router();
periodsRouter.get('/', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
  res.json((await pool.query(`SELECT p.*, u.full_name AS closed_by_name FROM accounting_periods p LEFT JOIN users u ON u.id=p.closed_by ORDER BY p.start_date DESC`)).rows);
}));
periodsRouter.post('/', requirePermission('accounting.periods'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ name: z.string().min(1), start_date: dateStr, end_date: dateStr, company_id: z.string().uuid().optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const companyId = b.company_id ?? await resolveCompanyId(c, req.propertyId ?? null);
    const overlap = (await c.query(`SELECT name FROM accounting_periods WHERE company_id=$1 AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`, [companyId, b.start_date, b.end_date])).rows[0];
    if (overlap) throw new BadRequest(`Period overlaps with ${overlap.name}`);
    return (await c.query(`INSERT INTO accounting_periods (company_id, name, start_date, end_date, status) VALUES ($1,$2,$3,$4,'OPEN') RETURNING *`, [companyId, b.name, b.start_date, b.end_date])).rows[0];
  });
  res.status(201).json(out);
}));
periodsRouter.post('/generate', requirePermission('accounting.periods'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ year: z.coerce.number().int().min(2000).max(2100), company_id: z.string().uuid().optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const companyId = b.company_id ?? await resolveCompanyId(c, req.propertyId ?? null); const rows = [];
    for (let m = 1; m <= 12; m++) {
      const start = `${b.year}-${String(m).padStart(2, '0')}-01`; const end = new Date(Date.UTC(b.year, m, 0)).toISOString().slice(0, 10);
      const exists = (await c.query(`SELECT 1 FROM accounting_periods WHERE company_id=$1 AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`, [companyId, start, end])).rows[0];
      if (!exists) rows.push((await c.query(`INSERT INTO accounting_periods (company_id, name, start_date, end_date, status) VALUES ($1,$2,$3,$4,'OPEN') RETURNING *`, [companyId, `${b.year}-${String(m).padStart(2, '0')}`, start, end])).rows[0]);
    }
    return rows;
  });
  res.status(201).json(out);
}));
periodsRouter.post('/:id/close', requirePermission('accounting.periods'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ lock: z.boolean().default(false) }), req.body ?? {});
  const out = await withTransaction(async (c) => {
    const p = (await c.query(`SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!p) throw new NotFound('Period not found');
    if (p.status === 'LOCKED') throw Errors.invalidStatus('period', p.status, 'close');
    const openDays = (await c.query(`SELECT COUNT(*)::int AS n FROM business_days bd JOIN properties pr ON pr.id=bd.property_id WHERE pr.company_id=$1 AND bd.business_date BETWEEN $2 AND $3 AND bd.status <> 'CLOSED' AND bd.business_date < CURRENT_DATE`, [p.company_id, p.start_date, p.end_date])).rows[0].n;
    if (openDays > 0 && !b.lock) throw new BadRequest(`${openDays} business day(s) in this period have not been night-audited`, { openDays }, 'OPEN_BUSINESS_DAYS');
    const r = (await c.query(`UPDATE accounting_periods SET status=$2, closed_by=$3, closed_at=now() WHERE id=$1 RETURNING *`, [p.id, b.lock ? 'LOCKED' : 'CLOSED', req.user!.id])).rows[0];
    await audit({ ...auditCtx(req), action: b.lock ? 'LOCK' : 'CLOSE', entityType: 'accounting_period', entityId: p.id, newValue: r }, c);
    return r;
  });
  res.json(out);
}));
periodsRouter.post('/:id/reopen', requirePermission('accounting.periods'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3) }), req.body);
  const r = (await pool.query(`UPDATE accounting_periods SET status='OPEN', closed_by=NULL, closed_at=NULL WHERE id=$1 AND status='CLOSED' RETURNING *`, [req.params.id])).rows[0];
  if (!r) throw new BadRequest('Only closed (not locked) periods can be reopened');
  await audit({ ...auditCtx(req), action: 'REOPEN', entityType: 'accounting_period', entityId: r.id, reason: b.reason });
  res.json(r);
}));

// ---------------- Journals & statements ----------------
export const journalsRouter = Router();
const jeSelect = `SELECT je.*, u.full_name AS posted_by_name, (SELECT COUNT(*) FROM journal_lines jl WHERE jl.journal_entry_id=je.id)::int AS line_count FROM journal_entries je LEFT JOIN users u ON u.id=je.posted_by`;
journalsRouter.get('/', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
  const where = ['(je.property_id=$1 OR je.property_id IS NULL)']; const params: any[] = [req.propertyId];
  if (req.query.account_id) { params.push(req.query.account_id); where.push(`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.journal_entry_id=je.id AND jl.account_id=$${params.length})`); }
  await runList(req, res, { select: jeSelect, where, params, searchColumns: ['je.number', 'je.description', 'je.source_type'], defaultSort: 'je.created_at', filters: { status: 'je.status', source_type: 'je.source_type', source_id: 'je.source_id' }, dateFilters: { date: 'je.entry_date', business_date: 'je.business_date' }, exportName: 'journals' });
}));
journalsRouter.post('/', requirePermission('accounting.post'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ description: z.string().min(3), entry_date: dateStr.optional(), reference: optionalStr, lines: z.array(z.object({ account_id: z.string().uuid(), debit: z.coerce.number().min(0).default(0), credit: z.coerce.number().min(0).default(0), description: optionalStr, department_id: z.string().uuid().nullable().optional(), outlet_id: z.string().uuid().nullable().optional(), party_type: optionalStr, party_id: z.string().uuid().nullable().optional() })).min(2) }), req.body);
  const dr = r2(b.lines.reduce((s, l) => s + l.debit, 0)), cr = r2(b.lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.005) throw new BadRequest(`Journal is not balanced: debits ${dr} ≠ credits ${cr}`, { debit: dr, credit: cr }, 'UNBALANCED');
  if (b.lines.some((l) => l.debit > 0 && l.credit > 0)) throw new BadRequest('A line cannot have both debit and credit');
  const out = await withTransaction(async (c) => {
    const je = await postJournal(c, { propertyId: req.propertyId!, entryDate: b.entry_date, businessDate: b.entry_date ?? await currentBusinessDate(c, req.propertyId!, req.user!.id), description: b.reference ? `${b.description} [${b.reference}]` : b.description, sourceType: 'MANUAL', userId: req.user!.id, lines: b.lines.map((l) => ({ accountId: l.account_id, debit: l.debit || undefined, credit: l.credit || undefined, description: l.description ?? undefined, departmentId: l.department_id ?? null, outletId: l.outlet_id ?? null, partyType: l.party_type ?? null, partyId: l.party_id ?? null })) });
    await audit({ ...auditCtx(req), action: 'POST_JOURNAL', entityType: 'journal_entry', entityId: je.id, newValue: b }, c);
    return (await c.query(`${jeSelect} WHERE je.id=$1`, [je.id])).rows[0];
  });
  res.status(201).json(out);
}));
async function statementRows(propertyId: string | null, from: string, to: string, types: string[]) {
  return (await pool.query(`SELECT a.id, a.code, a.name, a.type, a.parent_id, p.name AS parent_name, COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
      FROM accounts a LEFT JOIN accounts p ON p.id=a.parent_id
      LEFT JOIN journal_lines jl ON jl.account_id=a.id AND ($1::uuid IS NULL OR jl.property_id=$1 OR jl.property_id IS NULL)
      LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.status='POSTED' AND je.entry_date BETWEEN $2 AND $3
      WHERE a.type = ANY($4) AND NOT a.is_header
      GROUP BY a.id, p.name HAVING COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit END),0) <> 0 OR COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit END),0) <> 0
      ORDER BY a.code`, [propertyId, from, to, types])).rows.map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }));
}
journalsRouter.get('/trial-balance', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? '1900-01-01'), to = String(req.query.to ?? new Date().toISOString().slice(0, 10)); const pid = req.query.all === 'true' ? null : (req.propertyId ?? null);
  const rows = (await pool.query(`SELECT a.id, a.code, a.name, a.type,
        COALESCE(SUM(CASE WHEN je.entry_date < $2 THEN jl.debit - jl.credit END),0) AS opening,
        COALESCE(SUM(CASE WHEN je.entry_date BETWEEN $2 AND $3 THEN jl.debit END),0) AS debit,
        COALESCE(SUM(CASE WHEN je.entry_date BETWEEN $2 AND $3 THEN jl.credit END),0) AS credit
      FROM accounts a JOIN journal_lines jl ON jl.account_id=a.id JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.status='POSTED'
      WHERE ($1::uuid IS NULL OR jl.property_id=$1 OR jl.property_id IS NULL) AND je.entry_date <= $3
      GROUP BY a.id ORDER BY a.code`, [pid, from, to])).rows.map((r) => { const opening = Number(r.opening), debit = Number(r.debit), credit = Number(r.credit); const closing = r2(opening + debit - credit); return { ...r, opening, debit, credit, closing, closing_debit: closing > 0 ? closing : 0, closing_credit: closing < 0 ? -closing : 0 }; });
  const totals = rows.reduce((t, r) => ({ opening: r2(t.opening + r.opening), debit: r2(t.debit + r.debit), credit: r2(t.credit + r.credit), closing_debit: r2(t.closing_debit + r.closing_debit), closing_credit: r2(t.closing_credit + r.closing_credit) }), { opening: 0, debit: 0, credit: 0, closing_debit: 0, closing_credit: 0 });
  if (isExport(req)) return sendExport(res, req, rows, 'trial_balance');
  res.json({ from, to, rows, totals, balanced: Math.abs(totals.closing_debit - totals.closing_credit) < 0.01 });
}));
journalsRouter.get('/profit-loss', requirePermission('accounting.view', 'reports.financial'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 8) + '01'), to = String(req.query.to ?? new Date().toISOString().slice(0, 10)); const pid = req.query.all === 'true' ? null : (req.propertyId ?? null);
  const rows = await statementRows(pid, from, to, ['REVENUE', 'COST_OF_SALES', 'EXPENSE']);
  const section = (type: string) => { const items = rows.filter((r) => r.type === type).map((r) => ({ ...r, amount: r2(type === 'REVENUE' ? r.credit - r.debit : r.debit - r.credit) })); return { items, total: r2(items.reduce((s, i) => s + i.amount, 0)) }; };
  const revenue = section('REVENUE'), cogs = section('COST_OF_SALES'), expenses = section('EXPENSE');
  const grossProfit = r2(revenue.total - cogs.total); const netProfit = r2(grossProfit - expenses.total);
  // Department/outlet breakdown of revenue
  const byOutlet = (await pool.query(`SELECT o.name AS outlet, COALESCE(SUM(jl.credit - jl.debit),0) AS revenue FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.status='POSTED' JOIN accounts a ON a.id=jl.account_id AND a.type='REVENUE' LEFT JOIN outlets o ON o.id=jl.outlet_id WHERE ($1::uuid IS NULL OR jl.property_id=$1) AND je.entry_date BETWEEN $2 AND $3 GROUP BY o.name ORDER BY revenue DESC`, [pid, from, to])).rows;
  if (isExport(req)) return sendExport(res, req, [...revenue.items, ...cogs.items, ...expenses.items], 'profit_loss');
  res.json({ from, to, revenue, cost_of_sales: cogs, gross_profit: grossProfit, gross_margin_percent: revenue.total ? r2(grossProfit / revenue.total * 100) : 0, expenses, net_profit: netProfit, revenue_by_outlet: byOutlet });
}));
journalsRouter.get('/balance-sheet', requirePermission('accounting.view', 'reports.financial'), asyncHandler(async (req, res) => {
  const asOf = String(req.query.as_of ?? new Date().toISOString().slice(0, 10)); const pid = req.query.all === 'true' ? null : (req.propertyId ?? null);
  const rows = await statementRows(pid, '1900-01-01', asOf, ['ASSET', 'LIABILITY', 'EQUITY']);
  const section = (type: string) => { const items = rows.filter((r) => r.type === type).map((r) => ({ ...r, amount: r2(type === 'ASSET' ? r.debit - r.credit : r.credit - r.debit) })); return { items, total: r2(items.reduce((s, i) => s + i.amount, 0)) }; };
  const pl = await statementRows(pid, '1900-01-01', asOf, ['REVENUE', 'COST_OF_SALES', 'EXPENSE']);
  const retained = r2(pl.reduce((s, r) => s + (r.type === 'REVENUE' ? r.credit - r.debit : -(r.debit - r.credit)), 0));
  const assets = section('ASSET'), liabilities = section('LIABILITY'), equity = section('EQUITY');
  const totalEquity = r2(equity.total + retained);
  res.json({ as_of: asOf, assets, liabilities, equity: { ...equity, retained_earnings: retained, total_with_earnings: totalEquity }, total_liabilities_and_equity: r2(liabilities.total + totalEquity), balanced: Math.abs(assets.total - (liabilities.total + totalEquity)) < 0.01 });
}));
journalsRouter.get('/tax-report', requirePermission('accounting.view', 'reports.financial'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 8) + '01'), to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
  const rows = (await pool.query(`SELECT t.code, t.name, t.rate, a.code AS account_code, COALESCE(SUM(jl.credit),0) AS output_tax, COALESCE(SUM(jl.debit),0) AS input_tax, COALESCE(SUM(jl.credit - jl.debit),0) AS net_payable
      FROM taxes t JOIN accounts a ON a.id=t.account_id LEFT JOIN journal_lines jl ON jl.account_id=a.id AND ($1::uuid IS NULL OR jl.property_id=$1) LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.status='POSTED' AND je.entry_date BETWEEN $2 AND $3
      WHERE (t.property_id IS NULL OR t.property_id=$1) GROUP BY t.id, a.code ORDER BY t.code`, [req.propertyId, from, to])).rows;
  const folioTax = (await pool.query(`SELECT fi.category, COALESCE(SUM(fi.tax_amount),0) AS tax, COALESCE(SUM(fi.amount - fi.tax_amount - fi.service_charge),0) AS taxable FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.property_id=$1 AND fi.item_type='CHARGE' AND NOT fi.is_reversed AND fi.business_date BETWEEN $2 AND $3 GROUP BY fi.category`, [req.propertyId, from, to])).rows;
  if (isExport(req)) return sendExport(res, req, rows, 'tax_report');
  res.json({ from, to, taxes: rows, folio_tax_by_category: folioTax });
}));
journalsRouter.get('/:id', requirePermission('accounting.view'), asyncHandler(async (req, res) => {
  const je = (await pool.query(`${jeSelect} WHERE je.id=$1 OR je.number=$2`, [/^[0-9a-f-]{36}$/.test(req.params.id) ? req.params.id : '00000000-0000-0000-0000-000000000000', req.params.id])).rows[0];
  if (!je) throw new NotFound('Journal entry not found');
  je.lines = (await pool.query(`SELECT jl.*, a.code AS account_code, a.name AS account_name, a.type AS account_type, d.name AS department_name, o.name AS outlet_name FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id LEFT JOIN departments d ON d.id=jl.department_id LEFT JOIN outlets o ON o.id=jl.outlet_id WHERE jl.journal_entry_id=$1 ORDER BY jl.line_no`, [je.id])).rows;
  je.reversal = je.reversed_by_id ? (await pool.query(`SELECT id, number, entry_date FROM journal_entries WHERE id=$1`, [je.reversed_by_id])).rows[0] : null;
  je.reverses = je.reverses_id ? (await pool.query(`SELECT id, number, entry_date FROM journal_entries WHERE id=$1`, [je.reverses_id])).rows[0] : null;
  res.json(je);
}));
journalsRouter.post('/:id/reverse', requirePermission('accounting.reverse'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3), entry_date: dateStr.optional() }), req.body);
  const out = await withTransaction(async (c) => {
    const je = (await c.query(`SELECT * FROM journal_entries WHERE id=$1`, [req.params.id])).rows[0];
    if (!je) throw new NotFound('Journal entry not found');
    if (je.source_type !== 'MANUAL' && !req.user!.is_superuser && !hasPermission(req, 'accounting.periods')) throw new Forbidden('System-generated journals must be reversed through their source transaction (refund, credit note, adjustment). Accounting managers may override.');
    const rev = await reverseJournal(c, je.id, req.user!.id, b.reason, b.entry_date);
    await audit({ ...auditCtx(req), action: 'REVERSE', entityType: 'journal_entry', entityId: je.id, reason: b.reason, newValue: rev }, c);
    return (await c.query(`${jeSelect} WHERE je.id=$1`, [rev.id])).rows[0];
  });
  res.status(201).json(out);
}));

// ---------------- Payments register ----------------
export const paymentsRouter = Router();
const paySelect = `SELECT p.*, pm.name AS method_name, pm.type AS method_type, u.full_name AS created_by_name, o.name AS outlet_name, cs.number AS shift_number,
    CASE p.party_type WHEN 'GUEST' THEN (SELECT first_name || ' ' || last_name FROM guests g WHERE g.id=p.party_id) WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers s WHERE s.id=p.party_id) WHEN 'CUSTOMER' THEN (SELECT name FROM customers c WHERE c.id=p.party_id) END AS party_name
  FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id LEFT JOIN users u ON u.id=p.created_by LEFT JOIN outlets o ON o.id=p.outlet_id LEFT JOIN cashier_shifts cs ON cs.id=p.cashier_shift_id`;
paymentsRouter.get('/', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: paySelect, where: ['p.property_id=$1'], params: [req.propertyId], searchColumns: ['p.number', 'p.reference', 'pm.name'], defaultSort: 'p.created_at', filters: { direction: 'p.direction', kind: 'p.kind', status: 'p.status', payment_method_id: 'p.payment_method_id', cashier_shift_id: 'p.cashier_shift_id', outlet_id: 'p.outlet_id', party_type: 'p.party_type', party_id: 'p.party_id', source_type: 'p.source_type', source_id: 'p.source_id' }, dateFilters: { date: 'p.business_date' }, exportName: 'payments' });
}));
paymentsRouter.get('/summary', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 10)), to = String(req.query.to ?? from);
  const byMethod = (await pool.query(`SELECT pm.name AS method, pm.type, p.direction, COUNT(*)::int AS count, COALESCE(SUM(p.base_amount),0) AS amount FROM payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.property_id=$1 AND p.status='COMPLETED' AND p.business_date BETWEEN $2 AND $3 GROUP BY pm.name, pm.type, p.direction ORDER BY amount DESC`, [req.propertyId, from, to])).rows;
  const byKind = (await pool.query(`SELECT p.kind, p.direction, COUNT(*)::int AS count, COALESCE(SUM(p.base_amount),0) AS amount FROM payments p WHERE p.property_id=$1 AND p.status='COMPLETED' AND p.business_date BETWEEN $2 AND $3 GROUP BY p.kind, p.direction ORDER BY amount DESC`, [req.propertyId, from, to])).rows;
  const totals = byMethod.reduce((a, r) => { if (r.direction === 'IN') a.in += Number(r.amount); else a.out += Number(r.amount); return a; }, { in: 0, out: 0 });
  res.json({ from, to, by_method: byMethod, by_kind: byKind, totals: { ...totals, net: r2(totals.in - totals.out) } });
}));
paymentsRouter.get('/:id', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const p = (await pool.query(`${paySelect} WHERE p.id=$1`, [req.params.id])).rows[0];
  if (!p) throw new NotFound('Payment not found');
  p.journal = p.journal_entry_id ? (await pool.query(`SELECT id, number, status FROM journal_entries WHERE id=$1`, [p.journal_entry_id])).rows[0] : null;
  p.folio_item = (await pool.query(`SELECT fi.id, fi.folio_id, f.number AS folio_number, fi.is_reversed FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE fi.payment_id=$1`, [p.id])).rows[0] ?? null;
  res.json(p);
}));
/** Reverse a non-folio payment (supplier/expense/petty cash/customer receipt). Folio payments are reversed through the folio so the guest account stays consistent. */
paymentsRouter.post('/:id/reverse', requirePermission('payments.refund', 'accounting.reverse'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3) }), req.body);
  const out = await withTransaction(async (c) => {
    const p = (await c.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!p) throw new NotFound('Payment not found');
    if (p.status !== 'COMPLETED') throw Errors.invalidStatus('payment', p.status, 'reverse');
    const fi = (await c.query(`SELECT id FROM folio_items WHERE payment_id=$1 AND NOT is_reversed`, [p.id])).rows[0];
    if (fi) throw new BadRequest('This payment is posted on a guest folio; reverse it from the folio (POST /folios/:id/items/:itemId/reverse)', { folio_item_id: fi.id }, 'FOLIO_PAYMENT');
    if (p.source_type === 'ORDER') throw new BadRequest('POS payments are reversed by refunding the order', undefined, 'POS_PAYMENT');
    const shift = p.cashier_shift_id ? (await c.query(`SELECT status FROM cashier_shifts WHERE id=$1`, [p.cashier_shift_id])).rows[0] : null;
    if (shift && shift.status !== 'OPEN') throw new BadRequest('The cashier shift for this payment is closed; post a refund instead', undefined, 'SHIFT_CLOSED');
    let revJournal: any = null;
    if (p.journal_entry_id) revJournal = await reverseJournal(c, p.journal_entry_id, req.user!.id, `Payment ${p.number} reversed: ${b.reason}`);
    // Undo settlement effects
    for (const a of (await c.query(`SELECT * FROM supplier_invoice_payments WHERE payment_id=$1`, [p.id])).rows) await c.query(`UPDATE supplier_invoices SET paid_total = paid_total - $2, balance = balance + $2, status = CASE WHEN paid_total - $2 <= 0.005 THEN 'APPROVED' ELSE 'PARTIALLY_PAID' END WHERE id=$1`, [a.invoice_id, a.amount]);
    for (const a of (await c.query(`SELECT * FROM invoice_payments WHERE payment_id=$1`, [p.id])).rows) await c.query(`UPDATE invoices SET paid_total = paid_total - $2, balance = balance + $2, status = CASE WHEN paid_total - $2 <= 0.005 THEN 'ISSUED' ELSE 'PARTIALLY_PAID' END WHERE id=$1`, [a.invoice_id, a.amount]);
    if (p.party_type && p.party_id) await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ($1,$2,$3,CURRENT_DATE,'REVERSAL',$4,$5,$6,$7,'PAYMENT',$8,$9,$10)`,
      [p.party_type, p.party_id, p.property_id, p.number, `Payment reversed: ${b.reason}`, p.direction === 'OUT' ? 0 : p.base_amount, p.direction === 'OUT' ? p.base_amount : 0, p.id, revJournal?.id ?? null, req.user!.id]);
    await c.query(`UPDATE supplier_payment_requests SET status='CANCELLED', notes=COALESCE(notes,'') || ' [payment reversed]' WHERE payment_id=$1`, [p.id]);
    await c.query(`UPDATE expenses SET status='APPROVED', payment_id=NULL, paid_at=NULL WHERE payment_id=$1`, [p.id]);
    const r = (await c.query(`UPDATE payments SET status='REVERSED', notes=COALESCE(notes,'') || ' [reversed: ' || $2 || ']' WHERE id=$1 RETURNING *`, [p.id, b.reason])).rows[0];
    await audit({ ...auditCtx(req), action: 'REVERSE', entityType: 'payment', entityId: p.id, reason: b.reason, newValue: { reversal_journal: revJournal } }, c);
    return r;
  });
  res.json(out);
}));

// ---------------- Customers (corporate / travel agents) & receivables ----------------
export const customersRouter = crudRouter({ table: 'customers', entity: 'customer', permissions: { view: 'receivables.view', create: 'receivables.manage', edit: 'receivables.manage', delete: 'receivables.manage' }, propertyScoped: true, softDelete: true, searchColumns: ['code', 'name', 'contact_name', 'phone', 'email', 'tax_number'], defaultSort: 'name', filters: { type: 'type', active: 'is_active' },
  selectSql: `SELECT t.*, COALESCE((SELECT SUM(debit - credit) FROM party_ledger pl WHERE pl.party_type='CUSTOMER' AND pl.party_id=t.id),0) AS balance FROM customers t`,
  createSchema: z.object({ property_id: z.string().uuid().optional(), code: z.string().optional(), name: z.string().min(1), type: z.string().default('CORPORATE'), contact_name: optionalStr, phone: optionalStr, email: optionalStr, address: optionalStr, tax_number: optionalStr, credit_limit: z.coerce.number().min(0).default(0), payment_terms_days: z.coerce.number().int().min(0).default(30), currency: z.string().length(3).default('KES'), commission_percent: z.coerce.number().min(0).max(100).default(0), notes: optionalStr, is_active: z.boolean().default(true) }),
  updateSchema: z.object({ name: z.string().min(1), type: z.string(), contact_name: optionalStr, phone: optionalStr, email: optionalStr, address: optionalStr, tax_number: optionalStr, credit_limit: z.coerce.number().min(0), payment_terms_days: z.coerce.number().int().min(0), currency: z.string().length(3), commission_percent: z.coerce.number().min(0).max(100), notes: optionalStr, is_active: z.boolean() }).partial(),
  beforeCreate: async (d) => { if (!d.code) { const c = await pool.connect(); try { d.code = await nextNumber(c, 'CUSTOMER', null); } finally { c.release(); } } return d; },
  extraRoutes: (r) => {
    r.get('/:id/statement', requirePermission('receivables.view'), asyncHandler(async (req, res) => {
      const cust = (await pool.query(`SELECT * FROM customers WHERE id=$1`, [req.params.id])).rows[0];
      if (!cust) throw new NotFound('Customer not found');
      const from = String(req.query.from ?? '1900-01-01'), to = String(req.query.to ?? '2999-12-31');
      const opening = Number((await pool.query(`SELECT COALESCE(SUM(debit - credit),0) AS b FROM party_ledger WHERE party_type='CUSTOMER' AND party_id=$1 AND entry_date < $2`, [cust.id, from])).rows[0].b);
      const entries = (await pool.query(`SELECT pl.*, u.full_name AS created_by_name FROM party_ledger pl LEFT JOIN users u ON u.id=pl.created_by WHERE pl.party_type='CUSTOMER' AND pl.party_id=$1 AND pl.entry_date BETWEEN $2 AND $3 ORDER BY pl.entry_date, pl.created_at`, [cust.id, from, to])).rows;
      let bal = opening; const lines = entries.map((e) => { bal = r2(bal + Number(e.debit) - Number(e.credit)); return { ...e, balance: bal }; });
      const invoices = (await pool.query(`SELECT id, number, invoice_date, due_date, total, paid_total, balance, status, type FROM invoices WHERE customer_id=$1 AND status NOT IN ('CANCELLED') ORDER BY invoice_date DESC LIMIT 100`, [cust.id])).rows;
      res.json({ customer: cust, opening, closing: bal, lines, invoices, aging: agingFor(entries.filter((e) => Number(e.debit) > 0), entries.reduce((s, e) => s + Number(e.credit), 0) + Math.max(0, -opening), opening > 0 ? [{ entry_date: from, debit: opening }] : []) });
    }));
  } });
function agingFor(debits: any[], credits: number, extraDebits: any[] = []) {
  // FIFO: apply total credits to oldest debits first; leftover debits are aged by their entry date
  const all = [...extraDebits, ...debits].sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)));
  let remainingCredit = credits; const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 }; const today = Date.now();
  for (const d of all) {
    let open = Number(d.debit); const applied = Math.min(open, remainingCredit); open -= applied; remainingCredit -= applied;
    if (open <= 0.005) continue;
    const age = Math.floor((today - new Date(d.entry_date).getTime()) / 86400000);
    const k = age <= 0 ? 'current' : age <= 30 ? 'd30' : age <= 60 ? 'd60' : age <= 90 ? 'd90' : 'd90plus';
    buckets[k] = r2(buckets[k] + open); buckets.total = r2(buckets.total + open);
  }
  return buckets;
}
export const receivablesRouter = Router();
receivablesRouter.get('/aging', requirePermission('receivables.view'), asyncHandler(async (req, res) => {
  const customers = (await pool.query(`SELECT c.id, c.name, c.credit_limit, c.payment_terms_days, COALESCE(SUM(pl.debit - pl.credit),0) AS balance FROM customers c JOIN party_ledger pl ON pl.party_type='CUSTOMER' AND pl.party_id=c.id WHERE c.property_id=$1 GROUP BY c.id HAVING ABS(COALESCE(SUM(pl.debit - pl.credit),0)) >= 0.01 ORDER BY balance DESC`, [req.propertyId])).rows;
  const out = [];
  for (const c of customers) {
    const entries = (await pool.query(`SELECT entry_date, debit, credit FROM party_ledger WHERE party_type='CUSTOMER' AND party_id=$1 ORDER BY entry_date`, [c.id])).rows;
    out.push({ ...c, balance: Number(c.balance), ...agingFor(entries.filter((e) => Number(e.debit) > 0), entries.reduce((s, e) => s + Number(e.credit), 0)) });
  }
  const guestAr = Number((await pool.query(`SELECT COALESCE(SUM(fi.amount),0) AS b FROM folio_items fi JOIN folios f ON f.id=fi.folio_id WHERE f.property_id=$1 AND f.status='OPEN' AND NOT fi.is_reversed`, [req.propertyId])).rows[0].b);
  const totals = out.reduce((a, r) => ({ current: r2(a.current + r.current), d30: r2(a.d30 + r.d30), d60: r2(a.d60 + r.d60), d90: r2(a.d90 + r.d90), d90plus: r2(a.d90plus + r.d90plus), total: r2(a.total + r.total) }), { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 });
  if (isExport(req)) return sendExport(res, req, out, 'ar_aging');
  res.json({ data: out, totals, guest_ledger_balance: r2(guestAr) });
}));
receivablesRouter.get('/open-invoices', requirePermission('receivables.view'), asyncHandler(async (req, res) => {
  await runList(req, res, { select: `SELECT i.*, c.name AS customer_name, g.first_name || ' ' || g.last_name AS guest_name, (CURRENT_DATE - i.due_date) AS days_overdue FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN guests g ON g.id=i.guest_id`, where: ['i.property_id=$1', `i.status IN ('ISSUED','PARTIALLY_PAID')`, 'i.balance > 0'], params: [req.propertyId], searchColumns: ['i.number', 'c.name'], defaultSort: 'i.due_date', filters: { customer_id: 'i.customer_id', type: 'i.type' }, exportName: 'open_invoices' });
}));
/** Customer receipt against city-ledger balance, optionally allocated to invoices. */
receivablesRouter.post('/receipts', requirePermission('receivables.manage', 'payments.create'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ customer_id: z.string().uuid(), amount: z.coerce.number().positive(), payment_method_id: z.string().uuid().optional(), payment_method_code: z.string().optional(), reference: optionalStr, notes: optionalStr, cashier_shift_id: z.string().uuid().nullable().optional(), allocations: z.array(z.object({ invoice_id: z.string().uuid(), amount: z.coerce.number().positive() })).default([]) }), req.body);
  const out = await withTransaction(async (c) => {
    const cust = (await c.query(`SELECT * FROM customers WHERE id=$1`, [b.customer_id])).rows[0];
    if (!cust) throw new NotFound('Customer not found');
    const alloc = r2(b.allocations.reduce((s, a) => s + a.amount, 0));
    if (alloc > b.amount + 0.005) throw new BadRequest('Allocations exceed receipt amount');
    const methodId = await resolvePaymentMethodId(b.payment_method_id, b.payment_method_code, c);
    const { payment } = await recordPayment(c, { propertyId: req.propertyId!, direction: 'IN', kind: 'CUSTOMER_PAYMENT', paymentMethodId: methodId, amount: b.amount, reference: b.reference, partyType: 'CUSTOMER', partyId: cust.id, sourceType: 'CUSTOMER_RECEIPT', cashierShiftId: b.cashier_shift_id ?? null, userId: req.user!.id, offset: { mappingKey: 'AR' }, description: `Receipt from ${cust.name}`, notes: b.notes, idempotencyKey: (req.headers['idempotency-key'] as string) ?? null });
    for (const a of b.allocations) {
      const inv = (await c.query(`SELECT * FROM invoices WHERE id=$1 AND customer_id=$2 FOR UPDATE`, [a.invoice_id, cust.id])).rows[0];
      if (!inv) throw new NotFound('Invoice not found for this customer');
      if (a.amount > Number(inv.balance) + 0.005) throw new BadRequest(`Allocation exceeds balance on ${inv.number}`);
      await c.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,$3)`, [inv.id, payment.id, a.amount]);
      await c.query(`UPDATE invoices SET paid_total = paid_total + $2, balance = balance - $2, status = CASE WHEN balance - $2 <= 0.005 THEN 'PAID' ELSE 'PARTIALLY_PAID' END WHERE id=$1`, [inv.id, a.amount]);
    }
    await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ('CUSTOMER',$1,$2,$3,'PAYMENT',$4,$5,0,$6,'PAYMENT',$7,$8,$9)`, [cust.id, req.propertyId, payment.business_date, payment.number, `Receipt ${b.reference ?? ''}`.trim(), b.amount, payment.id, payment.journal_entry_id, req.user!.id]);
    return payment;
  });
  res.status(201).json(out);
}));
/** Credit note against a customer/guest invoice: reverses revenue & AR for the credited amount. */
receivablesRouter.post('/credit-notes', requirePermission('receivables.manage'), asyncHandler(async (req, res) => {
  const b = validate(z.object({ invoice_id: z.string().uuid(), amount: z.coerce.number().positive(), reason: z.string().min(3), revenue_mapping_key: z.string().default('SALES_RETURNS') }), req.body);
  const out = await withTransaction(async (c) => {
    const inv = (await c.query(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [b.invoice_id])).rows[0];
    if (!inv) throw new NotFound('Invoice not found');
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw Errors.invalidStatus('invoice', inv.status, 'credit');
    if (b.amount > Number(inv.balance) + 0.005) throw new BadRequest(`Credit note exceeds open balance ${inv.balance}`);
    const bd = await currentBusinessDate(c, inv.property_id, req.user!.id);
    const number = await nextNumber(c, 'CREDIT_NOTE', inv.property_id);
    const partyType = inv.customer_id ? 'CUSTOMER' : 'GUEST'; const partyId = inv.customer_id ?? inv.guest_id;
    const je = await postJournal(c, { propertyId: inv.property_id, businessDate: bd, description: `Credit note ${number} against ${inv.number}: ${b.reason}`, sourceType: 'CREDIT_NOTE', userId: req.user!.id, lines: [{ mappingKey: b.revenue_mapping_key, debit: b.amount }, { mappingKey: inv.customer_id ? 'AR' : 'AR_GUEST', credit: b.amount, partyType, partyId }] });
    const cn = (await c.query(`INSERT INTO invoices (property_id, number, folio_id, guest_id, customer_id, invoice_date, due_date, subtotal, total, paid_total, balance, status, type, related_invoice_id, currency, notes, created_by) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_DATE,$6,$6,0,0,'ISSUED','CREDIT_NOTE',$7,$8,$9,$10) RETURNING *`, [inv.property_id, number, inv.folio_id, inv.guest_id, inv.customer_id, -b.amount, inv.id, inv.currency, b.reason, req.user!.id])).rows[0];
    await c.query(`UPDATE journal_entries SET source_id=$2 WHERE id=$1`, [je.id, cn.id]);
    await c.query(`UPDATE invoices SET balance = balance - $2, status = CASE WHEN balance - $2 <= 0.005 THEN 'CREDITED' ELSE status END WHERE id=$1`, [inv.id, b.amount]);
    if (inv.customer_id) await c.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ('CUSTOMER',$1,$2,$3,'CREDIT_NOTE',$4,$5,0,$6,'CREDIT_NOTE',$7,$8,$9)`, [inv.customer_id, inv.property_id, bd, number, `Credit note vs ${inv.number}: ${b.reason}`, b.amount, cn.id, je.id, req.user!.id]);
    await audit({ ...auditCtx(req), action: 'CREDIT_NOTE', entityType: 'invoice', entityId: inv.id, reason: b.reason, newValue: { credit_note: number, amount: b.amount } }, c);
    return cn;
  });
  res.status(201).json(out);
}));

// ---------------- Party ledger (generic) ----------------
export const partyLedgerRouter = Router();
partyLedgerRouter.get('/:type/:id', requirePermission('receivables.view', 'payables.view', 'folios.view'), asyncHandler(async (req, res) => {
  const p = getPagination(req, 'entry_date');
  const rows = (await pool.query(`SELECT * FROM party_ledger WHERE party_type=$1 AND party_id=$2 ORDER BY entry_date DESC, created_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, [req.params.type.toUpperCase(), req.params.id])).rows;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM party_ledger WHERE party_type=$1 AND party_id=$2`, [req.params.type.toUpperCase(), req.params.id])).rows[0].count);
  const balance = Number((await pool.query(`SELECT COALESCE(SUM(debit - credit),0) AS b FROM party_ledger WHERE party_type=$1 AND party_id=$2`, [req.params.type.toUpperCase(), req.params.id])).rows[0].b);
  res.json({ ...paged(rows, total, p), balance });
}));
