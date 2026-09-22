import { PoolClient } from 'pg';
import { nextNumber } from '../../core/numbering';
import { Errors, BadRequest } from '../../core/errors';
import { audit } from '../../core/audit';

export interface JournalLineInput {
  accountId?: string;      // direct account
  mappingKey?: string;     // or resolve via account_mappings
  debit?: number;
  credit?: number;
  description?: string;
  departmentId?: string | null;
  outletId?: string | null;
  partyType?: string | null;
  partyId?: string | null;
  currency?: string;
  fxRate?: number;
}

export interface JournalInput {
  propertyId: string | null;
  companyId?: string;
  entryDate?: string | Date;
  businessDate?: string | null;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  lines: JournalLineInput[];
  userId?: string | null;
  currency?: string;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function resolveCompanyId(client: PoolClient, propertyId: string | null): Promise<string> {
  if (propertyId) {
    const r = await client.query(`SELECT company_id FROM properties WHERE id=$1`, [propertyId]);
    if (r.rows[0]) return r.rows[0].company_id;
  }
  const c = await client.query(`SELECT id FROM companies ORDER BY created_at LIMIT 1`);
  return c.rows[0].id;
}

/** Resolve a logical mapping key (e.g. 'AR', 'ROOM_REVENUE') to an account id for a property (falls back to global mapping). */
export async function mappedAccount(client: PoolClient, key: string, propertyId: string | null): Promise<string> {
  const r = await client.query(
    `SELECT account_id FROM account_mappings WHERE mapping_key=$1 AND (property_id=$2 OR property_id IS NULL) ORDER BY property_id NULLS LAST LIMIT 1`,
    [key, propertyId]);
  if (!r.rows[0]) throw new BadRequest(`No account mapped for "${key}". Configure account mappings in Finance → Settings.`, undefined, 'ACCOUNT_MAPPING_MISSING');
  return r.rows[0].account_id;
}

export async function assertPeriodOpen(client: PoolClient, companyId: string, date: string) {
  const r = await client.query(`SELECT status FROM accounting_periods WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date`, [companyId, date]);
  if (r.rows[0] && r.rows[0].status !== 'OPEN') throw Errors.closedPeriod(date);
}

/**
 * Post a balanced journal entry atomically inside the caller's transaction.
 * Validates debits == credits, period is open, and writes immutable lines.
 */
export async function postJournal(client: PoolClient, input: JournalInput): Promise<{ id: string; number: string }> {
  const companyId = input.companyId ?? (await resolveCompanyId(client, input.propertyId));
  const entryDate = input.entryDate ? new Date(input.entryDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  await assertPeriodOpen(client, companyId, entryDate);
  const lines = input.lines.filter((l) => r2(l.debit ?? 0) !== 0 || r2(l.credit ?? 0) !== 0);
  if (lines.length < 2) throw new BadRequest('A journal entry requires at least two non-zero lines');
  let dr = 0, cr = 0;
  const resolved: { accountId: string; debit: number; credit: number; l: JournalLineInput }[] = [];
  for (const l of lines) {
    const accountId = l.accountId ?? (l.mappingKey ? await mappedAccount(client, l.mappingKey, input.propertyId) : null);
    if (!accountId) throw new BadRequest('Journal line missing account');
    const debit = r2(l.debit ?? 0), credit = r2(l.credit ?? 0);
    if (debit < 0 || credit < 0) throw new BadRequest('Journal amounts cannot be negative; swap debit/credit instead');
    dr += debit; cr += credit;
    resolved.push({ accountId, debit, credit, l });
  }
  dr = r2(dr); cr = r2(cr);
  if (dr !== cr) throw Errors.unbalancedJournal(dr, cr);
  const number = await nextNumber(client, 'JOURNAL', input.propertyId);
  const je = (await client.query(
    `INSERT INTO journal_entries (company_id, property_id, number, entry_date, business_date, description, source_type, source_id, status, total_debit, total_credit, currency, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'POSTED',$9,$10,$11,$12) RETURNING id, number`,
    [companyId, input.propertyId, number, entryDate, input.businessDate ?? entryDate, input.description, input.sourceType, input.sourceId ?? null, dr, cr, input.currency ?? 'KES', input.userId ?? null])).rows[0];
  let n = 1;
  for (const x of resolved) {
    const fx = x.l.fxRate ?? 1;
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, line_no, account_id, property_id, department_id, outlet_id, description, debit, credit, currency, fx_rate, debit_txn, credit_txn, party_type, party_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [je.id, n++, x.accountId, input.propertyId, x.l.departmentId ?? null, x.l.outletId ?? null, x.l.description ?? input.description, x.debit, x.credit,
        x.l.currency ?? input.currency ?? 'KES', fx, r2(x.debit / fx), r2(x.credit / fx), x.l.partyType ?? null, x.l.partyId ?? null]);
  }
  return je;
}

/** Reverse a posted journal by posting a mirror entry; the original is flagged REVERSED (never edited/deleted). */
export async function reverseJournal(client: PoolClient, journalId: string, userId: string, reason: string, entryDate?: string): Promise<{ id: string; number: string }> {
  const je = (await client.query(`SELECT * FROM journal_entries WHERE id=$1 FOR UPDATE`, [journalId])).rows[0];
  if (!je) throw new BadRequest('Journal entry not found');
  if (je.status === 'REVERSED') throw Errors.invalidStatus('journal', 'REVERSED', 'reverse again');
  const lines = (await client.query(`SELECT * FROM journal_lines WHERE journal_entry_id=$1 ORDER BY line_no`, [journalId])).rows;
  const rev = await postJournal(client, {
    propertyId: je.property_id, companyId: je.company_id, entryDate: entryDate ?? new Date(), description: `Reversal of ${je.number}: ${reason}`,
    sourceType: 'REVERSAL', sourceId: je.id, userId, currency: je.currency,
    lines: lines.map((l) => ({ accountId: l.account_id, debit: Number(l.credit), credit: Number(l.debit), description: l.description, departmentId: l.department_id, outletId: l.outlet_id, partyType: l.party_type, partyId: l.party_id })),
  });
  await client.query(`UPDATE journal_entries SET status='REVERSED', reversed_by_id=$2 WHERE id=$1`, [journalId, rev.id]);
  await client.query(`UPDATE journal_entries SET reverses_id=$2 WHERE id=$1`, [rev.id, journalId]);
  await audit({ userId, action: 'JOURNAL_REVERSE', entityType: 'journal_entry', entityId: journalId, reason, newValue: { reversal: rev.number } }, client);
  return rev;
}

/** Split a gross amount into net + tax according to a tax definition */
export function splitTax(gross: number, ratePercent: number, inclusive: boolean): { net: number; tax: number; gross: number } {
  if (!ratePercent) return { net: r2(gross), tax: 0, gross: r2(gross) };
  if (inclusive) {
    const net = r2(gross / (1 + ratePercent / 100));
    return { net, tax: r2(gross - net), gross: r2(gross) };
  }
  const tax = r2(gross * ratePercent / 100);
  return { net: r2(gross), tax, gross: r2(gross + tax) };
}

export async function getTax(client: PoolClient, taxId: string | null | undefined) {
  if (!taxId) return null;
  return (await client.query(`SELECT * FROM taxes WHERE id=$1`, [taxId])).rows[0] ?? null;
}

export async function defaultTaxFor(client: PoolClient, propertyId: string | null, appliesTo: string) {
  const r = await client.query(`SELECT * FROM taxes WHERE is_active AND (property_id=$1 OR property_id IS NULL) AND $2 = ANY(applies_to) AND type='VAT' ORDER BY property_id NULLS LAST LIMIT 1`, [propertyId, appliesTo]);
  return r.rows[0] ?? null;
}

/** Current open business date for a property (falls back to today and opens it). */
export async function currentBusinessDate(client: PoolClient, propertyId: string, userId?: string | null): Promise<string> {
  const r = await client.query(`SELECT business_date FROM business_days WHERE property_id=$1 AND status IN ('OPEN','CLOSING') ORDER BY business_date DESC LIMIT 1`, [propertyId]);
  if (r.rows[0]) return String(r.rows[0].business_date).slice(0, 10);
  const last = await client.query(`SELECT business_date FROM business_days WHERE property_id=$1 ORDER BY business_date DESC LIMIT 1`, [propertyId]);
  const next = last.rows[0] ? new Date(new Date(last.rows[0].business_date).getTime() + 86400000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  await client.query(`INSERT INTO business_days (property_id, business_date, status, opened_by) VALUES ($1,$2,'OPEN',$3) ON CONFLICT (property_id, business_date) DO UPDATE SET status='OPEN'`, [propertyId, next, userId ?? null]);
  return next;
}

export { r2 };
