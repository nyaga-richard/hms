import { PoolClient } from 'pg';
import { pool, DB } from '../../db/pool';
import { nextNumber } from '../../core/numbering';
import { Errors, BadRequest } from '../../core/errors';
import { postJournal, currentBusinessDate, r2 } from './accounting.service';
import { audit } from '../../core/audit';

export interface PaymentInput {
  propertyId: string;
  direction: 'IN' | 'OUT';
  kind?: string;
  paymentMethodId: string;
  amount: number;
  currency?: string;
  fxRate?: number;
  reference?: string | null;
  partyType?: string | null; partyId?: string | null;
  sourceType?: string | null; sourceId?: string | null;
  cashierShiftId?: string | null; outletId?: string | null;
  idempotencyKey?: string | null;
  notes?: string | null;
  userId: string;
  /** Offsetting account for the journal: e.g. AR for guest payments, AP for supplier payments. Provide mappingKey or accountId. */
  offset: { mappingKey?: string; accountId?: string };
  description?: string;
  skipJournal?: boolean;
}

/** Record a payment and its journal entry atomically. Enforces open cashier shift for drawer methods when a shift is required. */
export async function recordPayment(client: PoolClient, input: PaymentInput) {
  if (input.amount <= 0) throw Errors.invalidPayment('Payment amount must be greater than zero');
  if (input.idempotencyKey) {
    const dup = await client.query(`SELECT * FROM payments WHERE idempotency_key=$1`, [input.idempotencyKey]);
    if (dup.rows[0]) return { payment: dup.rows[0], duplicate: true };
  }
  const method = (await client.query(`SELECT * FROM payment_methods WHERE id=$1 AND is_active`, [input.paymentMethodId])).rows[0];
  if (!method) throw Errors.invalidPayment('Payment method is not available');
  if (method.requires_reference && !input.reference) throw Errors.invalidPayment(`${method.name} requires a transaction reference`);
  if (!method.account_id && !input.skipJournal) throw new BadRequest(`Payment method ${method.name} has no account mapped`, undefined, 'ACCOUNT_MAPPING_MISSING');
  let shiftId = input.cashierShiftId ?? null;
  if (shiftId) {
    const shift = (await client.query(`SELECT status FROM cashier_shifts WHERE id=$1`, [shiftId])).rows[0];
    if (!shift || shift.status !== 'OPEN') throw Errors.closedShift();
  }
  const fx = input.fxRate ?? 1;
  const baseAmount = r2(input.amount * fx);
  const businessDate = await currentBusinessDate(client, input.propertyId, input.userId);
  const number = await nextNumber(client, input.direction === 'IN' ? 'RECEIPT' : 'PAYMENT', input.propertyId);
  let journalId: string | null = null;
  if (!input.skipJournal) {
    const desc = input.description ?? `${input.direction === 'IN' ? 'Receipt' : 'Payment'} ${number} (${method.name})`;
    const cashLine = { accountId: method.account_id, description: desc };
    const offsetLine = { ...input.offset, description: desc, partyType: input.partyType, partyId: input.partyId };
    const je = await postJournal(client, {
      propertyId: input.propertyId, description: desc, sourceType: 'PAYMENT', businessDate, userId: input.userId, currency: input.currency ?? 'KES',
      lines: input.direction === 'IN'
        ? [{ ...cashLine, debit: baseAmount, outletId: input.outletId }, { ...offsetLine, credit: baseAmount, outletId: input.outletId }]
        : [{ ...offsetLine, debit: baseAmount }, { ...cashLine, credit: baseAmount }],
    });
    journalId = je.id;
  }
  const payment = (await client.query(
    `INSERT INTO payments (property_id, number, direction, kind, payment_method_id, amount, currency, fx_rate, base_amount, reference, party_type, party_id, source_type, source_id, cashier_shift_id, outlet_id, business_date, journal_entry_id, idempotency_key, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [input.propertyId, number, input.direction, input.kind ?? 'PAYMENT', input.paymentMethodId, input.amount, input.currency ?? 'KES', fx, baseAmount, input.reference ?? null,
      input.partyType ?? null, input.partyId ?? null, input.sourceType ?? null, input.sourceId ?? null, shiftId, input.outletId ?? null, businessDate, journalId, input.idempotencyKey ?? null, input.notes ?? null, input.userId])).rows[0];
  if (journalId) await client.query(`UPDATE journal_entries SET source_id=$2 WHERE id=$1`, [journalId, payment.id]);
  await audit({ userId: input.userId, propertyId: input.propertyId, action: 'PAYMENT', entityType: 'payment', entityId: payment.id, newValue: { number, amount: input.amount, method: method.name, direction: input.direction } }, client);
  return { payment, duplicate: false, method };
}

/** Accept either a payment method id or its code (e.g. "CASH", "MPESA"). */
export async function resolvePaymentMethodId(id?: string | null, code?: string | null, db: DB = pool): Promise<string> {
  if (id) return id;
  if (!code) throw new BadRequest('payment_method_id or payment_method_code is required');
  const r = (await db.query(`SELECT id FROM payment_methods WHERE code=$1 AND is_active ORDER BY property_id NULLS LAST LIMIT 1`, [code.toUpperCase()])).rows[0];
  if (!r) throw new BadRequest(`Unknown payment method code: ${code}`);
  return r.id;
}
