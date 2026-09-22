import { PoolClient } from 'pg';

const DEFAULT_PREFIX: Record<string, string> = {
  RESERVATION: 'RSV', FOLIO: 'FOL', INVOICE: 'INV', RECEIPT: 'RCT', PAYMENT: 'PAY', PURCHASE_REQUISITION: 'PRQ', PURCHASE_ORDER: 'PO',
  GRN: 'GRN', SUPPLIER_INVOICE: 'SINV', DEBIT_NOTE: 'DN', REQUISITION: 'SRQ', TRANSFER: 'STR', ADJUSTMENT: 'ADJ', ISSUE: 'ISS', EXPENSE: 'EXP', STOCK_TRANSFER: 'STR', STOCK_ADJUSTMENT: 'ADJ', STOCK_ISSUE: 'ISS', STOCKTAKE: 'STK',
  WASTE: 'WST', JOURNAL: 'JE', ORDER: 'ORD', SHIFT: 'SHF', MAINTENANCE: 'MNT', LAUNDRY: 'LND', EVENT: 'EVT', QUOTATION: 'QUO',
  CUSTOMER_INVOICE: 'CINV', CREDIT_NOTE: 'CN', TICKET: 'TKT', ASSET: 'AST', PETTY_CASH: 'PC', SERVICE_BOOKING: 'SVC', GUEST: 'G', EMPLOYEE: 'EMP', SUPPLIER: 'SUP', PRODUCT: 'PRD', CUSTOMER: 'CUS',
};

/**
 * Generate the next document number for a doc type (per property, falling back to global).
 * Must be called inside a transaction: it row-locks the sequence to guarantee uniqueness.
 */
export async function nextNumber(client: PoolClient, docType: string, propertyId?: string | null): Promise<string> {
  const year = new Date().getFullYear();
  let seq = (await client.query(
    `SELECT * FROM number_sequences WHERE doc_type=$1 AND property_id IS NOT DISTINCT FROM $2 FOR UPDATE`,
    [docType, propertyId ?? null],
  )).rows[0];
  if (!seq) {
    seq = (await client.query(
      `INSERT INTO number_sequences (property_id, doc_type, prefix, padding, next_value, reset_yearly, current_year)
       VALUES ($1,$2,$3,6,1,false,$4)
       ON CONFLICT (property_id, doc_type) DO UPDATE SET doc_type=EXCLUDED.doc_type
       RETURNING *`,
      [propertyId ?? null, docType, DEFAULT_PREFIX[docType] ?? docType.slice(0, 3), year],
    )).rows[0];
    // re-lock
    seq = (await client.query(`SELECT * FROM number_sequences WHERE id=$1 FOR UPDATE`, [seq.id])).rows[0];
  }
  let value = Number(seq.next_value);
  if (seq.reset_yearly && seq.current_year !== year) { value = 1; }
  await client.query(`UPDATE number_sequences SET next_value=$2, current_year=$3 WHERE id=$1`, [seq.id, value + 1, year]);
  const num = String(value).padStart(seq.padding, '0');
  return seq.reset_yearly ? `${seq.prefix}-${year}-${num}` : `${seq.prefix}-${num}`;
}
