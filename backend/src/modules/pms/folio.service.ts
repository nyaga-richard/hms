import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { nextNumber } from '../../core/numbering';
import { Errors, NotFound, BadRequest, Forbidden } from '../../core/errors';
import { audit } from '../../core/audit';
import { notify } from '../../core/notify';
import { AuthUser } from '../auth/auth.types';
import { postJournal, splitTax, getTax, defaultTaxFor, currentBusinessDate, r2 } from '../finance/accounting.service';
import { recordPayment } from '../finance/payments.service';

// Revenue mapping per folio charge category
export const CATEGORY_REVENUE_KEY: Record<string, string> = {
  ROOM: 'ROOM_REVENUE', RESTAURANT: 'RESTAURANT_REVENUE', BAR: 'BAR_REVENUE', CLUB: 'CLUB_REVENUE', MINIBAR: 'MINIBAR_REVENUE', LAUNDRY: 'LAUNDRY_REVENUE',
  TELEPHONE: 'OTHER_REVENUE', TRANSPORT: 'OTHER_REVENUE', SPA: 'SPA_REVENUE', ACTIVITY: 'OTHER_REVENUE', ROOM_SERVICE: 'RESTAURANT_REVENUE', CONFERENCE: 'EVENT_REVENUE',
  DAMAGE: 'OTHER_REVENUE', OTHER: 'OTHER_REVENUE', PACKAGE: 'ROOM_REVENUE', TICKET: 'CLUB_REVENUE', EVENT: 'EVENT_REVENUE',
};
const TAX_APPLIES: Record<string, string> = { ROOM: 'ROOM', RESTAURANT: 'FOOD', ROOM_SERVICE: 'FOOD', BAR: 'BEVERAGE', CLUB: 'BEVERAGE', MINIBAR: 'BEVERAGE' };

export async function folioBalance(client: PoolClient | typeof pool, folioId: string): Promise<{ charges: number; credits: number; balance: number }> {
  const r = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END),0) AS charges, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END),0) AS credits, COALESCE(SUM(amount),0) AS balance
       FROM folio_items WHERE folio_id=$1 AND NOT is_reversed AND reverses_id IS NULL`, [folioId]);
  const x = r.rows[0];
  return { charges: Number(x.charges), credits: Number(x.credits), balance: Number(x.balance) };
}

export async function openFolio(client: PoolClient, opts: { propertyId: string; type?: string; stayId?: string | null; reservationId?: string | null; guestId?: string | null; customerId?: string | null; eventId?: string | null; currency?: string }) {
  const number = await nextNumber(client, 'FOLIO', opts.propertyId);
  return (await client.query(
    `INSERT INTO folios (property_id, number, type, stay_id, reservation_id, guest_id, customer_id, event_id, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [opts.propertyId, number, opts.type ?? 'GUEST', opts.stayId ?? null, opts.reservationId ?? null, opts.guestId ?? null, opts.customerId ?? null, opts.eventId ?? null, opts.currency ?? 'KES'])).rows[0];
}

export interface ChargeInput {
  folioId: string; category: string; description: string; quantity?: number; unitPrice: number; discount?: number; taxId?: string | null; applyServiceCharge?: boolean;
  outletId?: string | null; sourceType?: string | null; sourceId?: string | null; userId: string; reason?: string | null;
  /** When the charge originates from a POS order whose revenue was already journaled, pass skipJournal to avoid double posting. */
  skipJournal?: boolean; revenueAccountId?: string | null; businessDate?: string | null;
}

/**
 * Post a charge to a folio. Computes tax + service charge, writes the immutable folio item and (unless skipJournal)
 * the accounting entry: DR Guest Ledger (AR_GUEST) / CR Revenue / CR Tax Payable / CR Service Charge Payable.
 */
export async function postCharge(client: PoolClient, input: ChargeInput) {
  const folio = (await client.query(`SELECT * FROM folios WHERE id=$1 FOR UPDATE`, [input.folioId])).rows[0];
  if (!folio) throw new NotFound('Folio not found');
  if (folio.status !== 'OPEN') throw Errors.invalidStatus('folio', folio.status, 'post charge');
  const qty = input.quantity ?? 1;
  const gross = r2(qty * input.unitPrice - (input.discount ?? 0));
  if (gross < 0) throw new BadRequest('Discount cannot exceed the charge amount');
  let tax = input.taxId ? await getTax(client, input.taxId) : await defaultTaxFor(client, folio.property_id, TAX_APPLIES[input.category] ?? 'SERVICE');
  let serviceCharge = 0;
  if (input.applyServiceCharge) {
    const prop = (await client.query(`SELECT service_charge_percent FROM properties WHERE id=$1`, [folio.property_id])).rows[0];
    serviceCharge = r2(gross * Number(prop?.service_charge_percent ?? 0) / 100);
  }
  const split = tax ? splitTax(gross, Number(tax.rate), tax.is_inclusive) : { net: gross, tax: 0, gross };
  const total = r2(split.gross + serviceCharge);
  const businessDate = input.businessDate ?? (await currentBusinessDate(client, folio.property_id, input.userId));
  const lineNo = Number((await client.query(`SELECT COALESCE(MAX(line_no),0)+1 AS n FROM folio_items WHERE folio_id=$1`, [input.folioId])).rows[0].n);
  let journalId: string | null = null;
  if (!input.skipJournal && total !== 0) {
    const lines: any[] = [{ mappingKey: 'AR_GUEST', debit: total, partyType: 'GUEST', partyId: folio.guest_id, outletId: input.outletId }];
    const revenue = input.revenueAccountId ? { accountId: input.revenueAccountId } : { mappingKey: CATEGORY_REVENUE_KEY[input.category] ?? 'OTHER_REVENUE' };
    lines.push({ ...revenue, credit: split.net, outletId: input.outletId, description: input.description });
    if (split.tax) lines.push({ accountId: tax?.account_id ?? undefined, mappingKey: tax?.account_id ? undefined : 'TAX_PAYABLE', credit: split.tax, description: `${tax?.name ?? 'Tax'} on ${input.description}` });
    if (serviceCharge) lines.push({ mappingKey: 'SERVICE_CHARGE_PAYABLE', credit: serviceCharge, description: `Service charge on ${input.description}` });
    const je = await postJournal(client, { propertyId: folio.property_id, description: `Folio ${folio.number}: ${input.description}`, sourceType: 'FOLIO', sourceId: folio.id, businessDate, userId: input.userId, lines });
    journalId = je.id;
  }
  const item = (await client.query(
    `INSERT INTO folio_items (folio_id, line_no, item_type, category, description, quantity, unit_price, discount, tax_amount, service_charge, amount, tax_id, outlet_id, source_type, source_id, business_date, journal_entry_id, posted_by, reason)
     VALUES ($1,$2,'CHARGE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [input.folioId, lineNo, input.category, input.description, qty, input.unitPrice, input.discount ?? 0, split.tax, serviceCharge, total, tax?.id ?? null, input.outletId ?? null, input.sourceType ?? 'MANUAL', input.sourceId ?? null, businessDate, journalId, input.userId, input.reason ?? null])).rows[0];
  return item;
}

/** Post a payment/deposit/refund line onto a folio (money in/out) with journal via recordPayment */
export async function postFolioPayment(client: PoolClient, opts: { folioId: string; paymentMethodId: string; amount: number; reference?: string | null; kind?: 'PAYMENT' | 'DEPOSIT' | 'REFUND'; cashierShiftId?: string | null; userId: string; idempotencyKey?: string | null; notes?: string | null }) {
  const folio = (await client.query(`SELECT * FROM folios WHERE id=$1 FOR UPDATE`, [opts.folioId])).rows[0];
  if (!folio) throw new NotFound('Folio not found');
  if (folio.status !== 'OPEN') throw Errors.invalidStatus('folio', folio.status, 'post payment');
  const kind = opts.kind ?? 'PAYMENT';
  const method = (await client.query(`SELECT * FROM payment_methods WHERE id=$1`, [opts.paymentMethodId])).rows[0];
  if (!method) throw Errors.invalidPayment('Unknown payment method');
  let paymentId: string | null = null;
  if (method.type === 'CORPORATE_CREDIT') {
    // City ledger settlement: transfer guest balance to customer AR; no cash movement
    if (!folio.customer_id) throw Errors.invalidPayment('Folio has no bill-to company for corporate credit settlement');
    const customer = (await client.query(`SELECT * FROM customers WHERE id=$1`, [folio.customer_id])).rows[0];
    const bal = Number((await client.query(`SELECT COALESCE(SUM(debit-credit),0) AS b FROM party_ledger WHERE party_type='CUSTOMER' AND party_id=$1`, [customer.id])).rows[0].b);
    if (customer.credit_limit > 0 && bal + opts.amount > Number(customer.credit_limit)) throw Errors.invalidPayment(`Credit limit exceeded for ${customer.name} (limit ${customer.credit_limit}, exposure ${bal})`);
    const businessDate = await currentBusinessDate(client, folio.property_id, opts.userId);
    const je = await postJournal(client, { propertyId: folio.property_id, description: `City ledger transfer folio ${folio.number} → ${customer.name}`, sourceType: 'FOLIO', sourceId: folio.id, businessDate, userId: opts.userId,
      lines: [{ mappingKey: 'AR', debit: opts.amount, partyType: 'CUSTOMER', partyId: customer.id }, { mappingKey: 'AR_GUEST', credit: opts.amount, partyType: 'GUEST', partyId: folio.guest_id }] });
    await client.query(`INSERT INTO party_ledger (party_type, party_id, property_id, entry_date, entry_type, reference, description, debit, credit, source_type, source_id, journal_entry_id, created_by) VALUES ('CUSTOMER',$1,$2,$3,'INVOICE',$4,$5,$6,0,'FOLIO',$7,$8,$9)`,
      [customer.id, folio.property_id, businessDate, folio.number, `Guest folio ${folio.number} charged to account`, opts.amount, folio.id, je.id, opts.userId]);
  } else {
    const { payment } = await recordPayment(client, {
      propertyId: folio.property_id, direction: kind === 'REFUND' ? 'OUT' : 'IN', kind, paymentMethodId: opts.paymentMethodId, amount: opts.amount, reference: opts.reference,
      partyType: 'GUEST', partyId: folio.guest_id, sourceType: 'FOLIO', sourceId: folio.id, cashierShiftId: opts.cashierShiftId, userId: opts.userId, idempotencyKey: opts.idempotencyKey, notes: opts.notes,
      offset: { mappingKey: kind === 'DEPOSIT' ? 'GUEST_DEPOSITS' : 'AR_GUEST' }, description: `Folio ${folio.number} ${kind.toLowerCase()} (${method.name})`,
    });
    paymentId = payment.id;
  }
  const lineNo = Number((await client.query(`SELECT COALESCE(MAX(line_no),0)+1 AS n FROM folio_items WHERE folio_id=$1`, [opts.folioId])).rows[0].n);
  const businessDate = await currentBusinessDate(client, folio.property_id, opts.userId);
  const amount = kind === 'REFUND' ? opts.amount : -opts.amount;
  const item = (await client.query(
    `INSERT INTO folio_items (folio_id, line_no, item_type, category, description, quantity, unit_price, amount, source_type, payment_id, business_date, posted_by)
     VALUES ($1,$2,$3,'PAYMENT',$4,1,$5,$5,'PAYMENT',$6,$7,$8) RETURNING *`,
    [opts.folioId, lineNo, kind, `${kind === 'REFUND' ? 'Refund' : kind === 'DEPOSIT' ? 'Deposit' : 'Payment'} - ${method.name}${opts.reference ? ' #' + opts.reference : ''}`, amount, paymentId, businessDate, opts.userId])).rows[0];
  return item;
}

/** Reverse a folio line (charge or payment) with a mirrored line; original flagged reversed. Journal reversed too. */
export async function reverseFolioItem(client: PoolClient, itemId: string, reason: string, user: AuthUser) {
  const item = (await client.query(`SELECT * FROM folio_items WHERE id=$1 FOR UPDATE`, [itemId])).rows[0];
  if (!item) throw new NotFound('Folio item not found');
  if (item.is_reversed || item.reverses_id) throw new BadRequest('Item is already reversed or is itself a reversal');
  const folio = (await client.query(`SELECT * FROM folios WHERE id=$1`, [item.folio_id])).rows[0];
  if (folio.status !== 'OPEN') throw Errors.invalidStatus('folio', folio.status, 'reverse item');
  if (item.item_type !== 'CHARGE' && !user.permissions.has('payments.refund') && !user.is_superuser) throw Errors.unauthorizedRefund();
  const businessDate = await currentBusinessDate(client, folio.property_id, user.id);
  const lineNo = Number((await client.query(`SELECT COALESCE(MAX(line_no),0)+1 AS n FROM folio_items WHERE folio_id=$1`, [item.folio_id])).rows[0].n);
  let journalId: string | null = null;
  if (item.journal_entry_id) {
    const { reverseJournal } = await import('../finance/accounting.service');
    journalId = (await reverseJournal(client, item.journal_entry_id, user.id, reason)).id;
  } else if (item.payment_id) {
    const pay = (await client.query(`SELECT * FROM payments WHERE id=$1`, [item.payment_id])).rows[0];
    if (pay?.journal_entry_id) {
      const { reverseJournal } = await import('../finance/accounting.service');
      journalId = (await reverseJournal(client, pay.journal_entry_id, user.id, reason)).id;
    }
    await client.query(`UPDATE payments SET status='REVERSED' WHERE id=$1`, [item.payment_id]);
  }
  const rev = (await client.query(
    `INSERT INTO folio_items (folio_id, line_no, item_type, category, description, quantity, unit_price, discount, tax_amount, service_charge, amount, tax_id, outlet_id, source_type, source_id, business_date, reverses_id, journal_entry_id, posted_by, reason)
     VALUES ($1,$2,'ADJUSTMENT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'REVERSAL',$13,$14,$15,$16,$17,$18) RETURNING *`,
    [item.folio_id, lineNo, item.category, `Reversal: ${item.description}`, item.quantity, item.unit_price, -Number(item.discount), -Number(item.tax_amount), -Number(item.service_charge), -Number(item.amount), item.tax_id, item.outlet_id, item.id, businessDate, item.id, journalId, user.id, reason])).rows[0];
  await client.query(`UPDATE folio_items SET is_reversed=true, reversed_by_id=$2 WHERE id=$1`, [item.id, rev.id]);
  await audit({ userId: user.id, username: user.username, propertyId: folio.property_id, action: item.item_type === 'CHARGE' ? 'VOID' : 'REFUND', entityType: 'folio_item', entityId: item.id, oldValue: item, reason }, client);
  return rev;
}

/** Transfer a charge to another folio (guest→guest, room→room, guest→master) via mirrored lines */
export async function transferFolioItem(client: PoolClient, itemId: string, toFolioId: string, user: AuthUser, reason?: string) {
  const item = (await client.query(`SELECT * FROM folio_items WHERE id=$1 FOR UPDATE`, [itemId])).rows[0];
  if (!item) throw new NotFound('Folio item not found');
  if (item.is_reversed || item.reverses_id) throw new BadRequest('Reversed items cannot be transferred');
  const from = (await client.query(`SELECT * FROM folios WHERE id=$1`, [item.folio_id])).rows[0];
  const to = (await client.query(`SELECT * FROM folios WHERE id=$1 FOR UPDATE`, [toFolioId])).rows[0];
  if (!to) throw new NotFound('Target folio not found');
  if (from.status !== 'OPEN' || to.status !== 'OPEN') throw new BadRequest('Both folios must be open');
  const businessDate = await currentBusinessDate(client, from.property_id, user.id);
  const nextLine = async (fid: string) => Number((await client.query(`SELECT COALESCE(MAX(line_no),0)+1 AS n FROM folio_items WHERE folio_id=$1`, [fid])).rows[0].n);
  const out = (await client.query(
    `INSERT INTO folio_items (folio_id, line_no, item_type, category, description, quantity, unit_price, amount, source_type, source_id, business_date, reverses_id, posted_by, reason)
     VALUES ($1,$2,'TRANSFER_OUT',$3,$4,$5,$6,$7,'TRANSFER',$8,$9,$8,$10,$11) RETURNING *`,
    [from.id, await nextLine(from.id), item.category, `Transferred to ${to.number}: ${item.description}`, item.quantity, item.unit_price, -Number(item.amount), item.id, businessDate, user.id, reason ?? null])).rows[0];
  const inn = (await client.query(
    `INSERT INTO folio_items (folio_id, line_no, item_type, category, description, quantity, unit_price, discount, tax_amount, service_charge, amount, tax_id, outlet_id, source_type, source_id, business_date, posted_by, reason)
     VALUES ($1,$2,'TRANSFER_IN',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'TRANSFER',$13,$14,$15,$16) RETURNING *`,
    [to.id, await nextLine(to.id), item.category, `Transferred from ${from.number}: ${item.description}`, item.quantity, item.unit_price, item.discount, item.tax_amount, item.service_charge, item.amount, item.tax_id, item.outlet_id, item.id, businessDate, user.id, reason ?? null])).rows[0];
  await client.query(`UPDATE folio_items SET is_reversed=true, reversed_by_id=$2 WHERE id=$1`, [item.id, out.id]);
  if (from.guest_id !== to.guest_id) {
    await postJournal(client, { propertyId: from.property_id, description: `Transfer ${item.description} ${from.number} → ${to.number}`, sourceType: 'FOLIO', sourceId: to.id, businessDate, userId: user.id,
      lines: [{ mappingKey: 'AR_GUEST', debit: Number(item.amount), partyType: 'GUEST', partyId: to.guest_id }, { mappingKey: 'AR_GUEST', credit: Number(item.amount), partyType: 'GUEST', partyId: from.guest_id }] });
  }
  await audit({ userId: user.id, username: user.username, propertyId: from.property_id, action: 'TRANSFER', entityType: 'folio_item', entityId: item.id, newValue: { to: to.number }, reason }, client);
  return { out, in: inn };
}

export async function folioDetail(folioId: string) {
  const folio = (await pool.query(
    `SELECT f.*, g.first_name || ' ' || g.last_name AS guest_name, g.vip_level, c.name AS customer_name, r.number AS room_number, s.check_in_at, s.expected_check_out, s.status AS stay_status, res.number AS reservation_number
       FROM folios f LEFT JOIN guests g ON g.id=f.guest_id LEFT JOIN customers c ON c.id=f.customer_id LEFT JOIN stays s ON s.id=f.stay_id LEFT JOIN rooms r ON r.id=s.room_id LEFT JOIN reservations res ON res.id=f.reservation_id WHERE f.id=$1`, [folioId])).rows[0];
  if (!folio) throw new NotFound('Folio not found');
  const items = (await pool.query(`SELECT fi.*, u.full_name AS posted_by_name FROM folio_items fi LEFT JOIN users u ON u.id=fi.posted_by WHERE fi.folio_id=$1 ORDER BY fi.line_no`, [folioId])).rows;
  const totals = await folioBalance(pool, folioId);
  const byCategory = (await pool.query(`SELECT category, SUM(amount) AS amount FROM folio_items WHERE folio_id=$1 AND NOT is_reversed AND reverses_id IS NULL AND item_type IN ('CHARGE','TRANSFER_IN') GROUP BY category ORDER BY category`, [folioId])).rows;
  const taxes = (await pool.query(`SELECT COALESCE(SUM(tax_amount),0) AS tax, COALESCE(SUM(service_charge),0) AS service_charge, COALESCE(SUM(discount),0) AS discount FROM folio_items WHERE folio_id=$1 AND NOT is_reversed AND reverses_id IS NULL`, [folioId])).rows[0];
  return { ...folio, items, totals, by_category: byCategory, tax_total: Number(taxes.tax), service_charge_total: Number(taxes.service_charge), discount_total: Number(taxes.discount) };
}
