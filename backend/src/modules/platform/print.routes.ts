import { Router } from 'express';
import { pool } from '../../db/pool';
import { asyncHandler } from '../../core/http';

/**
 * Print profile — everything a client needs to render a printable document for the active property:
 * letterhead (property + company), and the `print.*` settings (paper defaults, footers). Available to every
 * authenticated user because receipts and kitchen tickets are printed by waiters/cashiers who cannot read
 * the general settings endpoint.
 */
export const printRouter = Router();

export const PRINT_DEFAULTS: Record<string, any> = {
  'print.receipt_paper': 'thermal80',      // POS receipts, bills, tickets, shift reports
  'print.kitchen_paper': 'thermal80',      // kitchen / bar order tickets
  'print.document_paper': 'a4',            // folios, invoices, confirmations, purchase orders, BEOs, reports
  'print.receipt_footer': 'Thank you for your visit!',
  'print.document_footer': '',
  'print.show_logo': true,
  'print.kot_on_send': false,              // print kitchen tickets automatically when an order is sent
  'print.receipt_copies': 1,
};

printRouter.get('/profile', asyncHandler(async (req, res) => {
  const property = req.propertyId
    ? (await pool.query(
        `SELECT p.id, p.code, p.name, p.type, p.address, p.city, p.country, p.phone, p.email, p.website, p.tax_number, p.currency, p.timezone, p.logo_url,
                p.check_in_time, p.check_out_time, p.service_charge_percent,
                c.name AS company_name, c.legal_name AS company_legal_name, c.tax_number AS company_tax_number, c.website AS company_website
           FROM properties p LEFT JOIN companies c ON c.id = p.company_id WHERE p.id = $1`, [req.propertyId])).rows[0] ?? null
    : null;
  const rows = (await pool.query(
    `SELECT key, value FROM settings WHERE key LIKE 'print.%' AND (property_id IS NULL OR property_id = $1) ORDER BY property_id NULLS FIRST`,
    [req.propertyId ?? null])).rows;
  const settings: Record<string, any> = { ...PRINT_DEFAULTS };
  for (const r of rows) settings[r.key] = r.value;   // property rows come last and override global ones
  const policy = (await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('hotel.cancellation_policy') AND (property_id IS NULL OR property_id = $1) ORDER BY property_id NULLS FIRST`,
    [req.propertyId ?? null])).rows;
  for (const r of policy) settings[r.key] = r.value;
  res.json({ property, settings });
}));
