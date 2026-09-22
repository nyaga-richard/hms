/**
 * Development seed. Idempotent and SAFE: it never deletes or overwrites existing production data.
 * Run: npm run seed
 */
import { pool, withTransaction } from './pool';
import { runMigrations } from './migrate';
import { bootstrapPermissions } from './bootstrap';
import { hashPassword } from '../modules/auth/auth.service';
import { PERMISSION_CODES, LIMIT_CODES } from '../core/permissions';

const ROLE_DEFS: Record<string, { name: string; perms: string[] | 'ALL'; limits?: Record<string, number> }> = {
  SUPER_ADMIN: { name: 'Super Administrator', perms: 'ALL' },
  GENERAL_MANAGER: { name: 'General Manager', perms: PERMISSION_CODES.filter((p) => !p.startsWith('users.') && !p.startsWith('roles.') && !p.startsWith('settings.backup')), limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 100, [LIMIT_CODES.REFUND_AMOUNT]: 1000000, [LIMIT_CODES.EXPENSE_APPROVAL]: 10000000, [LIMIT_CODES.PURCHASE_APPROVAL]: 10000000, [LIMIT_CODES.CASH_VARIANCE]: 100000 } },
  FRONT_OFFICE_MANAGER: { name: 'Front Office Manager', perms: ['events.view', 'events.manage', 'services.view', 'services.manage', 'services.book', 'petty_cash.view', 'petty_cash.manage', 'expenses.view', 'expenses.create', 'dashboard.view', 'guests.view', 'guests.create', 'guests.edit', 'guests.merge', 'room_types.view', 'room_types.manage', 'rooms.view', 'rooms.edit', 'rooms.block', 'reservations.view', 'reservations.create', 'reservations.modify', 'reservations.cancel', 'reservations.overbook', 'reservations.no_show', 'checkin.create', 'checkout.create', 'folios.view', 'folios.post', 'folios.transfer', 'folios.reverse', 'folios.discount', 'payments.view', 'payments.create', 'payments.refund', 'housekeeping.view', 'maintenance.view', 'maintenance.create', 'reports.view', 'reports.export', 'pos.open_shift', 'pos.close_shift', 'pos.approve_variance', 'services.view', 'services.book', 'laundry.view', 'laundry.manage', 'approvals.view', 'approvals.act', 'receivables.view', 'receivables.manage', 'accounting.night_audit'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 20, [LIMIT_CODES.REFUND_AMOUNT]: 50000, [LIMIT_CODES.CASH_VARIANCE]: 2000 } },
  RECEPTIONIST: { name: 'Receptionist', perms: ['events.view', 'services.view', 'services.book', 'dashboard.view', 'guests.view', 'guests.create', 'guests.edit', 'rooms.view', 'room_types.view', 'reservations.view', 'reservations.create', 'reservations.modify', 'reservations.cancel', 'checkin.create', 'checkout.create', 'folios.view', 'folios.post', 'folios.transfer', 'payments.view', 'payments.create', 'housekeeping.view', 'maintenance.create', 'pos.open_shift', 'pos.close_shift', 'services.view', 'services.book', 'laundry.view', 'laundry.manage'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 0, [LIMIT_CODES.CASH_VARIANCE]: 200 } },
  RESERVATIONS_OFFICER: { name: 'Reservations Officer', perms: ['dashboard.view', 'guests.view', 'guests.create', 'guests.edit', 'rooms.view', 'room_types.view', 'reservations.view', 'reservations.create', 'reservations.modify', 'reservations.cancel', 'payments.create', 'payments.view'] },
  HOUSEKEEPING_MANAGER: { name: 'Housekeeping Manager', perms: ['dashboard.view', 'rooms.view', 'rooms.items', 'rooms.block', 'housekeeping.view', 'housekeeping.update', 'housekeeping.assign', 'housekeeping.inspect', 'laundry.view', 'laundry.manage', 'maintenance.view', 'maintenance.create', 'inventory.view', 'inventory.issue', 'requisitions.view', 'requisitions.create', 'products.view', 'stores.view', 'reports.view', 'folios.post', 'employees.view'] },
  HOUSEKEEPER: { name: 'Housekeeper', perms: ['rooms.view', 'housekeeping.view', 'housekeeping.update', 'maintenance.create', 'rooms.items', 'laundry.view'] },
  RESTAURANT_MANAGER: { name: 'Restaurant Manager', perms: ['events.view', 'petty_cash.view', 'petty_cash.manage', 'expenses.view', 'expenses.create', 'dashboard.view', 'outlets.view', 'outlets.manage', 'menus.view', 'menus.manage', 'pos.view', 'pos.create_order', 'pos.modify_order', 'pos.cancel_order', 'pos.void_item', 'pos.discount', 'pos.refund', 'pos.settle', 'pos.room_charge', 'pos.open_shift', 'pos.close_shift', 'pos.approve_variance', 'pos.reprint', 'pos.transfer', 'kitchen.view', 'kitchen.update', 'inventory.view', 'inventory.issue', 'inventory.waste', 'inventory.stocktake', 'requisitions.view', 'requisitions.create', 'products.view', 'stores.view', 'reports.view', 'reports.export', 'reservations.view', 'guests.view', 'employees.view', 'approvals.view', 'approvals.act', 'events.view'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 20, [LIMIT_CODES.REFUND_AMOUNT]: 20000, [LIMIT_CODES.CASH_VARIANCE]: 1000 } },
  WAITER: { name: 'Waiter', perms: ['outlets.view', 'menus.view', 'pos.view', 'pos.create_order', 'pos.modify_order', 'pos.settle', 'pos.room_charge', 'pos.open_shift', 'pos.close_shift', 'pos.discount', 'kitchen.view', 'reservations.view'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 5, [LIMIT_CODES.CASH_VARIANCE]: 100 } },
  BAR_MANAGER: { name: 'Bar Manager', perms: ['dashboard.view', 'outlets.view', 'outlets.manage', 'menus.view', 'menus.manage', 'pos.view', 'pos.create_order', 'pos.modify_order', 'pos.cancel_order', 'pos.void_item', 'pos.discount', 'pos.refund', 'pos.settle', 'pos.room_charge', 'pos.open_shift', 'pos.close_shift', 'pos.approve_variance', 'pos.reprint', 'pos.transfer', 'inventory.view', 'inventory.issue', 'inventory.waste', 'inventory.stocktake', 'requisitions.view', 'requisitions.create', 'products.view', 'stores.view', 'reports.view', 'clubs.view', 'clubs.manage', 'clubs.sell_tickets'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 20, [LIMIT_CODES.REFUND_AMOUNT]: 20000, [LIMIT_CODES.CASH_VARIANCE]: 1000 } },
  BARTENDER: { name: 'Bartender', perms: ['outlets.view', 'menus.view', 'pos.view', 'pos.create_order', 'pos.modify_order', 'pos.settle', 'pos.room_charge', 'pos.open_shift', 'pos.close_shift', 'kitchen.view', 'kitchen.update', 'clubs.view', 'clubs.sell_tickets'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 0, [LIMIT_CODES.CASH_VARIANCE]: 100 } },
  CLUB_MANAGER: { name: 'Club Manager', perms: ['dashboard.view', 'outlets.view', 'outlets.manage', 'menus.view', 'menus.manage', 'pos.view', 'pos.create_order', 'pos.modify_order', 'pos.cancel_order', 'pos.void_item', 'pos.discount', 'pos.refund', 'pos.settle', 'pos.open_shift', 'pos.close_shift', 'pos.approve_variance', 'clubs.view', 'clubs.manage', 'clubs.sell_tickets', 'inventory.view', 'reports.view'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 25, [LIMIT_CODES.CASH_VARIANCE]: 2000 } },
  CHEF: { name: 'Chef', perms: ['kitchen.view', 'kitchen.update', 'menus.view', 'menus.manage', 'inventory.view', 'inventory.issue', 'inventory.waste', 'requisitions.view', 'requisitions.create', 'products.view', 'stores.view'] },
  KITCHEN_STAFF: { name: 'Kitchen Staff', perms: ['kitchen.view', 'kitchen.update', 'menus.view'] },
  STOREKEEPER: { name: 'Storekeeper', perms: ['dashboard.view', 'products.view', 'products.manage', 'stores.view', 'inventory.view', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.stocktake', 'inventory.waste', 'inventory.valuation', 'requisitions.view', 'requisitions.create', 'requisitions.approve', 'purchases.view', 'purchases.receive', 'suppliers.view', 'reports.view', 'reports.export', 'imports.run'] },
  PURCHASING_OFFICER: { name: 'Purchasing Officer', perms: ['dashboard.view', 'products.view', 'stores.view', 'inventory.view', 'suppliers.view', 'suppliers.manage', 'requisitions.view', 'requisitions.create', 'purchases.view', 'purchases.create', 'purchases.quotations', 'purchases.receive', 'purchases.invoice', 'payables.view', 'reports.view', 'reports.export', 'approvals.view'] },
  ACCOUNTS_MANAGER: { name: 'Accounts Manager', perms: ['dashboard.view', 'dashboard.management', 'accounting.view', 'accounting.post', 'accounting.reverse', 'accounting.accounts', 'accounting.periods', 'accounting.night_audit', 'payments.view', 'payments.create', 'payments.refund', 'payments.pay_supplier', 'payments.approve_supplier_payment', 'receivables.view', 'receivables.manage', 'payables.view', 'expenses.view', 'expenses.create', 'expenses.approve', 'expenses.pay', 'petty_cash.view', 'petty_cash.manage', 'petty_cash.reconcile', 'purchases.view', 'purchases.approve', 'purchases.invoice', 'suppliers.view', 'inventory.view', 'inventory.valuation', 'inventory.approve_adjustment', 'inventory.approve_stocktake', 'inventory.approve_waste', 'reports.view', 'reports.export', 'reports.financial', 'folios.view', 'folios.reverse', 'invoices.view', 'approvals.view', 'approvals.act', 'settings.view', 'settings.edit', 'settings.workflows', 'audit.view', 'pos.approve_variance', 'guests.view', 'reservations.view'], limits: { [LIMIT_CODES.EXPENSE_APPROVAL]: 500000, [LIMIT_CODES.PURCHASE_APPROVAL]: 1000000, [LIMIT_CODES.REFUND_AMOUNT]: 100000, [LIMIT_CODES.CASH_VARIANCE]: 10000 } },
  ACCOUNTANT: { name: 'Accountant', perms: ['dashboard.view', 'accounting.view', 'accounting.post', 'payments.view', 'payments.create', 'payments.pay_supplier', 'receivables.view', 'receivables.manage', 'payables.view', 'expenses.view', 'expenses.create', 'expenses.pay', 'petty_cash.view', 'petty_cash.manage', 'purchases.view', 'purchases.invoice', 'suppliers.view', 'inventory.view', 'inventory.valuation', 'reports.view', 'reports.export', 'reports.financial', 'folios.view', 'guests.view'] },
  CASHIER: { name: 'Cashier', perms: ['clubs.view', 'clubs.sell_tickets', 'services.view', 'services.book', 'pos.view', 'pos.settle', 'pos.open_shift', 'pos.close_shift', 'pos.reprint', 'payments.view', 'payments.create', 'folios.view', 'reservations.view', 'guests.view'], limits: { [LIMIT_CODES.DISCOUNT_PERCENT]: 0, [LIMIT_CODES.CASH_VARIANCE]: 200 } },
  EVENTS_MANAGER: { name: 'Events & Banquets Manager', perms: ['dashboard.view', 'events.view', 'events.manage', 'customers.view', 'customers.manage', 'guests.view', 'folios.view', 'folios.post', 'payments.view', 'payments.create', 'menu.view', 'kitchen.view', 'notifications.view', 'reports.view'] },
  HR_MANAGER: { name: 'HR Manager', perms: ['dashboard.view', 'employees.view', 'employees.manage', 'departments.view', 'departments.manage', 'users.view', 'reports.view'] },
  MAINTENANCE_MANAGER: { name: 'Maintenance Manager', perms: ['petty_cash.view', 'petty_cash.manage', 'expenses.view', 'expenses.create', 'dashboard.view', 'maintenance.view', 'maintenance.create', 'maintenance.approve', 'maintenance.assign', 'maintenance.work', 'maintenance.verify', 'assets.view', 'assets.manage', 'rooms.view', 'rooms.block', 'inventory.view', 'inventory.issue', 'requisitions.view', 'requisitions.create', 'products.view', 'stores.view', 'reports.view', 'expenses.create', 'expenses.view'] },
  MAINTENANCE_TECHNICIAN: { name: 'Maintenance Technician', perms: ['maintenance.view', 'maintenance.create', 'maintenance.work', 'assets.view', 'rooms.view'] },
  AUDITOR: { name: 'Auditor', perms: PERMISSION_CODES.filter((p) => p.endsWith('.view') || p === 'reports.export' || p === 'reports.financial' || p === 'dashboard.management' || p === 'inventory.valuation') },
};

const COA: [string, string, string, string?][] = [
  // code, name, type, parent code
  ['1000', 'Current Assets', 'ASSET'], ['1010', 'Cash on Hand', 'ASSET', '1000'], ['1020', 'Bank - Main Account', 'ASSET', '1000'], ['1030', 'Mobile Money (M-Pesa)', 'ASSET', '1000'], ['1040', 'Petty Cash', 'ASSET', '1000'], ['1050', 'POS Clearing', 'ASSET', '1000'], ['1060', 'Card Receivable (Bank Clearing)', 'ASSET', '1000'],
  ['1100', 'Accounts Receivable - City Ledger', 'ASSET', '1000'], ['1110', 'Guest Ledger (In-house)', 'ASSET', '1000'], ['1200', 'Inventory - Food', 'ASSET', '1000'], ['1210', 'Inventory - Beverage', 'ASSET', '1000'], ['1220', 'Inventory - General Stores', 'ASSET', '1000'], ['1300', 'VAT Receivable (Input)', 'ASSET', '1000'],
  ['1500', 'Fixed Assets', 'ASSET'], ['1510', 'Furniture & Fittings', 'ASSET', '1500'], ['1520', 'Kitchen Equipment', 'ASSET', '1500'], ['1530', 'Computers & POS Devices', 'ASSET', '1500'], ['1540', 'Vehicles', 'ASSET', '1500'],
  ['2000', 'Current Liabilities', 'LIABILITY'], ['2010', 'Accounts Payable', 'LIABILITY', '2000'], ['2100', 'VAT Payable (Output)', 'LIABILITY', '2000'], ['2110', 'Tourism Levy Payable', 'LIABILITY', '2000'], ['2120', 'Service Charge Payable', 'LIABILITY', '2000'], ['2130', 'Tips Payable', 'LIABILITY', '2000'], ['2200', 'Guest Deposits (Advance)', 'LIABILITY', '2000'], ['2300', 'Accrued Expenses', 'LIABILITY', '2000'],
  ['3000', 'Equity', 'EQUITY'], ['3010', 'Share Capital', 'EQUITY', '3000'], ['3020', 'Retained Earnings', 'EQUITY', '3000'],
  ['4000', 'Revenue', 'REVENUE'], ['4010', 'Room Revenue', 'REVENUE', '4000'], ['4100', 'Restaurant Revenue', 'REVENUE', '4000'], ['4200', 'Bar Revenue', 'REVENUE', '4000'], ['4300', 'Club Revenue', 'REVENUE', '4000'], ['4400', 'Minibar Revenue', 'REVENUE', '4000'], ['4500', 'Laundry Revenue', 'REVENUE', '4000'], ['4600', 'Spa & Wellness Revenue', 'REVENUE', '4000'], ['4700', 'Events & Banquet Revenue', 'REVENUE', '4000'], ['4800', 'Other Revenue', 'REVENUE', '4000'], ['4900', 'Sales Returns & Allowances', 'REVENUE', '4000'],
  ['5000', 'Cost of Sales', 'COST_OF_SALES'], ['5010', 'Food Cost', 'COST_OF_SALES', '5000'], ['5020', 'Beverage Cost', 'COST_OF_SALES', '5000'], ['5030', 'Other Cost of Sales', 'COST_OF_SALES', '5000'], ['5040', 'Complimentary & Entertainment', 'COST_OF_SALES', '5000'], ['5050', 'Inventory Waste & Spoilage', 'COST_OF_SALES', '5000'], ['5060', 'Stock Variance', 'COST_OF_SALES', '5000'],
  ['6000', 'Operating Expenses', 'EXPENSE'], ['6010', 'Salaries & Wages', 'EXPENSE', '6000'], ['6100', 'Electricity', 'EXPENSE', '6000'], ['6110', 'Water', 'EXPENSE', '6000'], ['6120', 'Internet & Telephone', 'EXPENSE', '6000'], ['6130', 'Fuel & Generator', 'EXPENSE', '6000'], ['6200', 'Repairs & Maintenance', 'EXPENSE', '6000'], ['6210', 'Cleaning & Housekeeping Supplies', 'EXPENSE', '6000'], ['6300', 'Marketing & Advertising', 'EXPENSE', '6000'], ['6310', 'Commissions (Agents/OTA)', 'EXPENSE', '6000'], ['6400', 'Licences & Permits', 'EXPENSE', '6000'], ['6410', 'Security', 'EXPENSE', '6000'], ['6420', 'Transport & Travel', 'EXPENSE', '6000'], ['6430', 'Office Expenses', 'EXPENSE', '6000'], ['6440', 'Professional Fees', 'EXPENSE', '6000'], ['6450', 'Bank Charges', 'EXPENSE', '6000'], ['6460', 'Cash Over/Short', 'EXPENSE', '6000'], ['6470', 'Insurance', 'EXPENSE', '6000'], ['6480', 'Depreciation', 'EXPENSE', '6000'], ['6490', 'Miscellaneous Expenses', 'EXPENSE', '6000'],
];

const MAPPINGS: Record<string, string> = { CASH: '1010', BANK: '1020', MOBILE_MONEY: '1030', PETTY_CASH: '1040', POS_CLEARING: '1050', CARD_CLEARING: '1060', AR: '1100', AR_GUEST: '1110', INVENTORY: '1220', INVENTORY_FOOD: '1200', INVENTORY_BEVERAGE: '1210', TAX_RECEIVABLE: '1300',
  AP: '2010', TAX_PAYABLE: '2100', LEVY_PAYABLE: '2110', SERVICE_CHARGE_PAYABLE: '2120', TIPS_PAYABLE: '2130', GUEST_DEPOSITS: '2200', ACCRUED_EXPENSES: '2300',
  ROOM_REVENUE: '4010', RESTAURANT_REVENUE: '4100', BAR_REVENUE: '4200', CLUB_REVENUE: '4300', MINIBAR_REVENUE: '4400', LAUNDRY_REVENUE: '4500', SPA_REVENUE: '4600', EVENT_REVENUE: '4700', OTHER_REVENUE: '4800', SALES_RETURNS: '4900',
  COGS: '5030', COGS_FOOD: '5010', COGS_BEVERAGE: '5020', COMPLIMENTARY_EXPENSE: '5040', WASTE_EXPENSE: '5050', STOCK_VARIANCE: '5060', CASH_OVER_SHORT: '6460', REPAIRS: '6200', GENERAL_EXPENSE: '6490', DEPRECIATION: '6480' };

export interface SeedOptions { /** production install: organisation + admin only, no demo data */ minimal?: boolean }

export async function seed(log: (m: string) => void = console.log, opts: SeedOptions = {}) {
  const minimal = opts.minimal ?? process.env.SEED_MODE === 'minimal';
  const full = !minimal;
  const e = (k: string, d: string) => (process.env[k] && process.env[k]!.trim()) || d;
  await runMigrations(log);
  await bootstrapPermissions();
  await withTransaction(async (c) => {
    // Company & property
    let company = (await c.query(`SELECT * FROM companies LIMIT 1`)).rows[0];
    if (!company) company = (await c.query(`INSERT INTO companies (name, legal_name, tax_number, base_currency, address, phone, email, website) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [e('COMPANY_NAME', 'Savanna Hospitality Group'), e('COMPANY_LEGAL_NAME', e('COMPANY_NAME', 'Savanna Hospitality Group Ltd')), e('COMPANY_TAX_NUMBER', 'P051234567X'), e('HOTEL_CURRENCY', 'KES'), e('HOTEL_ADDRESS', 'Nairobi, Kenya'), e('HOTEL_PHONE', '+254 700 000000'), e('HOTEL_EMAIL', 'info@savannahotels.example'), e('COMPANY_WEBSITE', 'https://savannahotels.example')])).rows[0];
    const propCode = e('HOTEL_CODE', 'DEMO');
    let prop = (await c.query(`SELECT * FROM properties WHERE code=$1`, [propCode])).rows[0];
    if (!prop) prop = (await c.query(`INSERT INTO properties (company_id, code, name, type, address, city, country, phone, email, tax_number, currency, timezone, service_charge_percent) VALUES ($1,$2,$3,'HOTEL',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [company.id, propCode, e('HOTEL_NAME', 'Demo Hotel & Resort'), e('HOTEL_ADDRESS', 'Mombasa Road'), e('HOTEL_CITY', 'Nairobi'), e('HOTEL_COUNTRY', 'Kenya'), e('HOTEL_PHONE', '+254 700 111222'), e('HOTEL_EMAIL', 'frontdesk@demohotel.example'), e('COMPANY_TAX_NUMBER', 'P051234567X'), e('HOTEL_CURRENCY', 'KES'), e('HOTEL_TIMEZONE', 'Africa/Nairobi'), Number(e('SERVICE_CHARGE_PERCENT', '10'))])).rows[0];
    const P = prop.id;
    log(`Property: ${prop.name}`);

    // Departments
    const deptIds: Record<string, string> = {};
    for (const [code, name] of [['ADMIN', 'Administration'], ['FO', 'Front Office'], ['HK', 'Housekeeping'], ['FNB', 'Food & Beverage'], ['KIT', 'Kitchen'], ['BAR', 'Bars'], ['CLUB', 'Club'], ['MNT', 'Maintenance'], ['STR', 'Stores'], ['PUR', 'Purchasing'], ['FIN', 'Finance'], ['HR', 'Human Resources'], ['SPA', 'Spa & Wellness'], ['EVT', 'Events & Banquets'], ['LND', 'Laundry'], ['SEC', 'Security']]) {
      const r = (await c.query(`INSERT INTO departments (property_id, code, name) VALUES ($1,$2,$3) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P, code, name])).rows[0];
      deptIds[code] = r.id;
    }

    // Roles
    const roleIds: Record<string, string> = {};
    for (const [code, def] of Object.entries(ROLE_DEFS)) {
      const r = (await c.query(`INSERT INTO roles (code, name, is_system) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, def.name, code === 'SUPER_ADMIN'])).rows[0];
      roleIds[code] = r.id;
      let perms = def.perms === 'ALL' ? PERMISSION_CODES : [...def.perms];
      // Any role that can approve something must be able to see & act on approval requests routed to it
      if (perms.some((p) => /\.(approve|approve_[a-z_]+|inspect|verify)$/.test(p)) || perms.includes('approvals.act')) perms = Array.from(new Set([...perms, 'approvals.view', 'approvals.act', 'notifications.view']));
      // Baseline every staff role needs: their own dashboard, notifications, global search results they are allowed to see, and attaching files to records they work on
      perms = Array.from(new Set([...perms, 'dashboard.view', 'notifications.view', 'attachments.upload']));
      await c.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2) ON CONFLICT DO NOTHING`, [r.id, perms]);
      for (const [lc, lv] of Object.entries(def.limits ?? {})) await c.query(`INSERT INTO authority_limits (subject_type, subject_id, limit_code, limit_value) VALUES ('ROLE',$1,$2,$3) ON CONFLICT (subject_type, subject_id, limit_code) DO NOTHING`, [r.id, lc, lv]);
    }

    // Users (password: Password123 for all demo users)
    const adminPassword = minimal ? e('ADMIN_PASSWORD', '') : 'Password123';
    if (minimal && adminPassword.length < 10) throw new Error('SEED_MODE=minimal requires ADMIN_PASSWORD (at least 10 characters)');
    const pw = await hashPassword(adminPassword);
    const users: [string, string, string, string, string][] = [ // username, name, email, role, dept
      ['admin', 'System Administrator', 'admin@demohotel.example', 'SUPER_ADMIN', 'ADMIN'], ['gm', 'Grace Mwangi', 'gm@demohotel.example', 'GENERAL_MANAGER', 'ADMIN'], ['fom', 'Faith Otieno', 'fom@demohotel.example', 'FRONT_OFFICE_MANAGER', 'FO'],
      ['reception', 'Brian Kamau', 'reception@demohotel.example', 'RECEPTIONIST', 'FO'], ['hkmanager', 'Mary Wanjiru', 'hk@demohotel.example', 'HOUSEKEEPING_MANAGER', 'HK'], ['housekeeper', 'Jane Achieng', 'jane@demohotel.example', 'HOUSEKEEPER', 'HK'],
      ['restaurant', 'Peter Njoroge', 'restaurant@demohotel.example', 'RESTAURANT_MANAGER', 'FNB'], ['waiter', 'Kevin Omondi', 'waiter@demohotel.example', 'WAITER', 'FNB'], ['barmanager', 'Lucy Wambui', 'bar@demohotel.example', 'BAR_MANAGER', 'BAR'],
      ['bartender', 'Samuel Kiptoo', 'bartender@demohotel.example', 'BARTENDER', 'BAR'], ['chef', 'Chef Daniel Mutua', 'chef@demohotel.example', 'CHEF', 'KIT'], ['storekeeper', 'Alice Nyambura', 'stores@demohotel.example', 'STOREKEEPER', 'STR'],
      ['purchasing', 'James Ochieng', 'purchasing@demohotel.example', 'PURCHASING_OFFICER', 'PUR'], ['accountant', 'Ruth Chebet', 'accounts@demohotel.example', 'ACCOUNTS_MANAGER', 'FIN'], ['cashier', 'Paul Maina', 'cashier@demohotel.example', 'CASHIER', 'FO'],
      ['maintenance', 'Joseph Kariuki', 'maintenance@demohotel.example', 'MAINTENANCE_MANAGER', 'MNT'], ['technician', 'Tom Barasa', 'tech@demohotel.example', 'MAINTENANCE_TECHNICIAN', 'MNT'], ['auditor', 'Internal Auditor', 'audit@demohotel.example', 'AUDITOR', 'FIN'],
    ].filter(([username]) => full || username === 'admin') as [string, string, string, string, string][];
    const userIds: Record<string, string> = {};
    let empNo = 1;
    for (const [username, name, email, role, dept] of users) {
      const existing = (await c.query(`SELECT id FROM users WHERE username=$1`, [username])).rows[0];
      if (existing) { userIds[username] = existing.id; continue; }
      const [first, ...rest] = name.split(' ');
      const emp = (await c.query(`INSERT INTO employees (property_id, department_id, employee_no, first_name, last_name, position, email, hire_date) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE - 365) ON CONFLICT (property_id, employee_no) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [P, deptIds[dept], `EMP-${String(empNo++).padStart(4, '0')}`, first, rest.join(' ') || '-', ROLE_DEFS[role].name, email])).rows[0];
      const u = (await c.query(`INSERT INTO users (username, email, full_name, password_hash, employee_id, department_id, default_property_id, is_superuser, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [username, email, name, pw, emp.id, deptIds[dept], P, role === 'SUPER_ADMIN', minimal])).rows[0];
      userIds[username] = u.id;
      await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, roleIds[role]]);
      await c.query(`INSERT INTO user_properties (user_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, P]);
    }
    log(minimal ? `Users: admin only (password from ADMIN_PASSWORD, must be changed at first login)` : `Users: ${users.length} (password: Password123)`);

    // Chart of accounts + mappings
    const acct: Record<string, string> = {};
    for (const [code, name, type, parent] of COA) {
      const r = (await c.query(`INSERT INTO accounts (company_id, code, name, type, parent_id, is_header, is_system) VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (company_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [company.id, code, name, type, parent ? acct[parent] : null, !parent])).rows[0];
      acct[code] = r.id;
    }
    for (const [key, code] of Object.entries(MAPPINGS)) await c.query(`INSERT INTO account_mappings (property_id, mapping_key, account_id) VALUES (NULL,$1,$2) ON CONFLICT (property_id, mapping_key) DO NOTHING`, [key, acct[code]]);
    // Accounting period: current year open
    const y = new Date().getFullYear();
    await c.query(`INSERT INTO accounting_periods (company_id, name, start_date, end_date) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [company.id, `FY${y}`, `${y}-01-01`, `${y}-12-31`]);
    await c.query(`INSERT INTO accounting_periods (company_id, name, start_date, end_date) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [company.id, `FY${y + 1}`, `${y + 1}-01-01`, `${y + 1}-12-31`]);

    // Taxes
    const taxIds: Record<string, string> = {};
    for (const [code, name, rate, type, incl, applies] of [['VAT16', 'VAT 16%', 16, 'VAT', true, ['ROOM', 'FOOD', 'BEVERAGE', 'SERVICE', 'PURCHASE']], ['TL2', 'Tourism Levy 2%', 2, 'LEVY', true, ['ROOM']], ['ZERO', 'Zero Rated', 0, 'ZERO_RATED', true, ['PURCHASE']], ['EXEMPT', 'Exempt', 0, 'EXEMPT', true, ['PURCHASE']]] as const) {
      const r = (await c.query(`INSERT INTO taxes (property_id, code, name, rate, type, is_inclusive, account_id, applies_to, fiscal_code) VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (property_id, code) DO UPDATE SET rate=EXCLUDED.rate RETURNING id`, [code, name, rate, type, incl, code === 'TL2' ? acct['2110'] : acct['2100'], applies, code === 'VAT16' ? 'B' : code === 'ZERO' ? 'C' : code === 'EXEMPT' ? 'A' : null])).rows[0];
      taxIds[code] = r.id;
    }

    // Payment methods
    const pmIds: Record<string, string> = {};
    for (const [code, name, type, a, ref, drawer] of [['CASH', 'Cash', 'CASH', '1010', false, true], ['CARD', 'Credit/Debit Card', 'CARD', '1060', true, false], ['MPESA', 'M-Pesa', 'MOBILE_MONEY', '1030', true, false], ['BANK', 'Bank Transfer', 'BANK_TRANSFER', '1020', true, false], ['CHEQUE', 'Cheque', 'CHEQUE', '1020', true, false], ['VOUCHER', 'Voucher', 'VOUCHER', '4900', true, false], ['CORP', 'Corporate Credit (City Ledger)', 'CORPORATE_CREDIT', '1100', false, false]] as const) {
      const r = (await c.query(`INSERT INTO payment_methods (property_id, code, name, type, account_id, requires_reference, is_cash_drawer) VALUES (NULL,$1,$2,$3,$4,$5,$6) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, name, type, acct[a], ref, drawer])).rows[0];
      pmIds[code] = r.id;
    }

    if (full) {
    // Room types & rooms
    const rtIds: Record<string, string> = {};
    for (const [code, name, adults, children, occ, rate, beds, sort] of [['STD', 'Standard Room', 2, 1, 3, 8500, '1 Queen', 1], ['DLX', 'Deluxe Room', 2, 2, 4, 12000, '1 King', 2], ['EXE', 'Executive Room', 2, 1, 3, 15000, '1 King', 3], ['FAM', 'Family Room', 4, 2, 6, 18000, '2 Queen', 4], ['STE', 'Suite', 2, 2, 4, 25000, '1 King + Sofa bed', 5], ['PRS', 'Presidential Suite', 4, 2, 6, 60000, '2 King', 6]] as const) {
      const r = (await c.query(`INSERT INTO room_types (property_id, code, name, max_adults, max_children, max_occupancy, base_rate, extra_adult_rate, extra_child_rate, bed_configuration, amenities, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,2500,1200,$8,$9,$10) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [P, code, name, adults, children, occ, rate, beds, ['WiFi', 'TV', 'Air Conditioning', 'Safe', 'Minibar', 'Tea/Coffee'], sort])).rows[0];
      rtIds[code] = r.id;
    }
    const rooms: [string, string, string][] = [['101', 'STD', '1'], ['102', 'STD', '1'], ['103', 'STD', '1'], ['104', 'DLX', '1'], ['105', 'DLX', '1'], ['201', 'DLX', '2'], ['202', 'DLX', '2'], ['203', 'EXE', '2'], ['204', 'EXE', '2'], ['205', 'FAM', '2'], ['301', 'STE', '3'], ['302', 'STE', '3'], ['303', 'FAM', '3'], ['401', 'PRS', '4']];
    for (const [no, rt, floor] of rooms) await c.query(`INSERT INTO rooms (property_id, room_type_id, number, floor, building) VALUES ($1,$2,$3,$4,'Main Block') ON CONFLICT (property_id, number) DO NOTHING`, [P, rtIds[rt], no, floor]);

    // Rate plans
    const rp = (await c.query(`INSERT INTO rate_plans (property_id, code, name, type, meal_plan) VALUES ($1,'BAR','Best Available Rate','STANDARD','BED_BREAKFAST') ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P])).rows[0];
    const corp = (await c.query(`INSERT INTO customers (property_id, code, name, type, credit_limit, payment_terms_days, email, phone, address) VALUES ($1,'CUS-000001','Safaricom PLC','CORPORATE',2000000,30,'travel@safaricom.example','+254 722 000000','Safaricom House, Nairobi') ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P])).rows[0];
    await c.query(`INSERT INTO customers (property_id, code, name, type, credit_limit, payment_terms_days, commission_percent) VALUES ($1,'CUS-000002','Bonfire Adventures','TRAVEL_AGENT',1000000,15,10) ON CONFLICT (code) DO NOTHING`, [P]);
    const corpPlan = (await c.query(`INSERT INTO rate_plans (property_id, code, name, type, meal_plan, customer_id) VALUES ($1,'CORP-SAF','Safaricom Corporate Rate','CORPORATE','BED_BREAKFAST',$2) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P, corp.id])).rows[0];
    const wknd = (await c.query(`INSERT INTO rate_plans (property_id, code, name, type, meal_plan, min_nights) VALUES ($1,'ROMANCE','Romantic Weekend Package','PACKAGE','HALF_BOARD',2) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P])).rows[0];
    if (Number((await c.query(`SELECT COUNT(*) FROM rate_plan_prices WHERE rate_plan_id=$1`, [rp.id])).rows[0].count) === 0) {
      for (const [code, price] of [['STD', 9500], ['DLX', 13500], ['EXE', 16500], ['FAM', 20000], ['STE', 28000], ['PRS', 65000]] as const) {
        await c.query(`INSERT INTO rate_plan_prices (rate_plan_id, room_type_id, price, extra_adult, extra_child) VALUES ($1,$2,$3,3000,1500)`, [rp.id, rtIds[code], price]);
        await c.query(`INSERT INTO rate_plan_prices (rate_plan_id, room_type_id, price, extra_adult, extra_child, days_of_week, priority) VALUES ($1,$2,$3,3000,1500,'{5,6}',10)`, [rp.id, rtIds[code], Math.round(price * 1.15)]);
        await c.query(`INSERT INTO rate_plan_prices (rate_plan_id, room_type_id, price, extra_adult, extra_child) VALUES ($1,$2,$3,2500,1200)`, [corpPlan.id, rtIds[code], Math.round(price * 0.85)]);
        await c.query(`INSERT INTO rate_plan_prices (rate_plan_id, room_type_id, price, extra_adult, extra_child) VALUES ($1,$2,$3,3000,1500)`, [wknd.id, rtIds[code], Math.round(price * 1.1)]);
      }
      await c.query(`INSERT INTO rate_plan_components (rate_plan_id, description, charge_category, amount, frequency, revenue_account_id, tax_id) VALUES ($1,'Candlelit dinner for two','RESTAURANT',6000,'PER_STAY',$2,$3), ($1,'Couples spa treatment','SPA',8000,'PER_STAY',$4,$3), ($1,'Airport transfer','TRANSPORT',3500,'PER_STAY',$5,$3)`, [wknd.id, acct['4100'], taxIds.VAT16, acct['4600'], acct['4800']]);
    }

    // Guests
    const guestRows: [string, string, string, string, string, string, number][] = [['Mr', 'John', 'Doe', 'john.doe@example.com', '+254 711 111111', 'Kenyan', 0], ['Ms', 'Amina', 'Hassan', 'amina.h@example.com', '+254 722 222222', 'Kenyan', 2], ['Dr', 'Michael', 'Smith', 'msmith@example.co.uk', '+44 7700 900000', 'British', 1], ['Mrs', 'Wanjiku', 'Kariuki', 'wanjiku.k@example.com', '+254 733 333333', 'Kenyan', 0], ['Mr', 'Raj', 'Patel', 'raj.patel@example.in', '+91 98765 43210', 'Indian', 0], ['Ms', 'Sarah', 'Johnson', 'sarah.j@example.com', '+1 555 0100', 'American', 3]];
    let gno = 1;
    for (const [title, fn, ln, email, phone, nat, vip] of guestRows) {
      await c.query(`INSERT INTO guests (guest_no, title, first_name, last_name, email, phone, nationality, vip_level, id_type, id_number, country, customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PASSPORT',$9,$7,$10) ON CONFLICT (guest_no) DO NOTHING`,
        [`G-${String(gno++).padStart(6, '0')}`, title, fn, ln, email, phone, nat, vip, `P${Math.floor(1000000 + Math.random() * 9000000)}`, fn === 'Wanjiku' ? corp.id : null]);
    }
    await c.query(`INSERT INTO number_sequences (property_id, doc_type, prefix, padding, next_value) VALUES (NULL,'GUEST','G',6,$1) ON CONFLICT (property_id, doc_type) DO UPDATE SET next_value=GREATEST(number_sequences.next_value, EXCLUDED.next_value)`, [gno]);
    }

    // Units, categories, stores, products
    const unitIds: Record<string, string> = {};
    for (const [code, name] of [['PC', 'Piece'], ['KG', 'Kilogram'], ['G', 'Gram'], ['L', 'Litre'], ['ML', 'Millilitre'], ['BTL', 'Bottle'], ['CRT', 'Crate'], ['PKT', 'Packet'], ['CTN', 'Carton'], ['ROLL', 'Roll'], ['SET', 'Set']]) {
      unitIds[code] = (await c.query(`INSERT INTO units (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, name])).rows[0].id;
    }
    const catIds: Record<string, string> = {};
    for (const [code, name, type, inv, cogs] of [['MEAT', 'Meat & Poultry', 'FOOD', '1200', '5010'], ['VEG', 'Vegetables & Fruit', 'FOOD', '1200', '5010'], ['DRY', 'Dry Goods', 'FOOD', '1200', '5010'], ['DAIRY', 'Dairy & Bakery', 'FOOD', '1200', '5010'], ['SOFT', 'Soft Drinks & Water', 'BEVERAGE', '1210', '5020'], ['BEER', 'Beer & Cider', 'BEVERAGE', '1210', '5020'], ['SPIRIT', 'Spirits', 'BEVERAGE', '1210', '5020'], ['WINE', 'Wine', 'BEVERAGE', '1210', '5020'], ['HKC', 'Housekeeping Chemicals', 'HOUSEKEEPING', '1220', '6210'], ['GSUP', 'Guest Supplies', 'GUEST_SUPPLIES', '1220', '6210'], ['LINEN', 'Linen', 'HOUSEKEEPING', '1220', '6210'], ['MNTP', 'Maintenance Parts', 'MAINTENANCE', '1220', '6200'], ['OFF', 'Office & Stationery', 'OFFICE', '1220', '6430']] as const) {
      catIds[code] = (await c.query(`INSERT INTO product_categories (code, name, type, inventory_account_id, cogs_account_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, name, type, acct[inv], acct[cogs]])).rows[0].id;
    }
    const storeIds: Record<string, string> = {};
    if (full) {
    for (const [code, name, type, dept] of [['MAIN', 'Main Store', 'MAIN', 'STR'], ['FOOD', 'Food Store', 'FOOD', 'STR'], ['BEV', 'Beverage Store', 'BEVERAGE', 'STR'], ['HK', 'Housekeeping Store', 'HOUSEKEEPING', 'HK'], ['ENG', 'Engineering Store', 'ENGINEERING', 'MNT'], ['KIT', 'Main Kitchen Store', 'KITCHEN', 'KIT'], ['LND', 'Laundry Store', 'LAUNDRY', 'LND'], ['PBAR', 'Pool Bar Store', 'BAR', 'BAR'], ['RBAR', 'Rooftop Bar Store', 'BAR', 'BAR'], ['CLUB', 'Night Club Store', 'BAR', 'CLUB']] as const) {
      storeIds[code] = (await c.query(`INSERT INTO stores (property_id, code, name, type, department_id, keeper_user_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P, code, name, type, deptIds[dept], userIds.storekeeper])).rows[0].id;
    }
    const products: [string, string, string, string, number, number, number, boolean, boolean?][] = [ // sku, name, cat, unit, cost, sell, reorder, sellable, track_expiry
      ['MEAT-001', 'Chicken Breast', 'MEAT', 'KG', 650, 0, 10, false, true], ['MEAT-002', 'Beef Fillet', 'MEAT', 'KG', 1200, 0, 5, false, true], ['MEAT-003', 'Tilapia Whole', 'MEAT', 'KG', 700, 0, 5, false, true], ['MEAT-004', 'Bacon', 'MEAT', 'KG', 900, 0, 3, false, true],
      ['VEG-001', 'Tomatoes', 'VEG', 'KG', 120, 0, 10, false], ['VEG-002', 'Lettuce', 'VEG', 'KG', 200, 0, 3, false], ['VEG-003', 'Onions', 'VEG', 'KG', 90, 0, 10, false], ['VEG-004', 'Potatoes', 'VEG', 'KG', 80, 0, 30, false], ['VEG-005', 'Lime', 'VEG', 'KG', 250, 0, 3, false], ['VEG-006', 'Fresh Mint', 'VEG', 'G', 1.5, 0, 200, false],
      ['DRY-001', 'Rice Basmati', 'DRY', 'KG', 220, 0, 20, false], ['DRY-002', 'Cooking Oil', 'DRY', 'L', 320, 0, 10, false], ['DRY-003', 'Sugar', 'DRY', 'KG', 150, 0, 10, false], ['DRY-004', 'Wheat Flour', 'DRY', 'KG', 110, 0, 20, false], ['DRY-005', 'Coffee Beans', 'DRY', 'KG', 1400, 0, 3, false], ['DRY-006', 'Tea Leaves', 'DRY', 'KG', 800, 0, 2, false], ['DRY-007', 'Salt', 'DRY', 'KG', 40, 0, 5, false], ['DRY-008', 'Pasta Spaghetti', 'DRY', 'KG', 260, 0, 10, false],
      ['DAIRY-001', 'Burger Buns', 'DAIRY', 'PC', 25, 0, 40, false, true], ['DAIRY-002', 'Cheddar Cheese', 'DAIRY', 'KG', 1100, 0, 2, false, true], ['DAIRY-003', 'Fresh Milk', 'DAIRY', 'L', 130, 0, 20, false, true], ['DAIRY-004', 'Eggs', 'DAIRY', 'PC', 15, 0, 120, false], ['DAIRY-005', 'Butter', 'DAIRY', 'KG', 950, 0, 3, false, true],
      ['SOFT-001', 'Coca-Cola 300ml', 'SOFT', 'BTL', 45, 150, 48, true], ['SOFT-002', 'Sprite 300ml', 'SOFT', 'BTL', 45, 150, 48, true], ['SOFT-003', 'Mineral Water 500ml', 'SOFT', 'BTL', 30, 120, 96, true], ['SOFT-004', 'Mineral Water 1L', 'SOFT', 'BTL', 50, 200, 48, true], ['SOFT-005', 'Tonic Water 200ml', 'SOFT', 'BTL', 60, 180, 24, true], ['SOFT-006', 'Orange Juice 1L', 'SOFT', 'L', 250, 0, 10, false, true], ['SOFT-007', 'Soda Water 300ml', 'SOFT', 'BTL', 45, 150, 24, true],
      ['BEER-001', 'Tusker Lager 500ml', 'BEER', 'BTL', 165, 350, 96, true], ['BEER-002', 'White Cap 500ml', 'BEER', 'BTL', 170, 350, 48, true], ['BEER-003', 'Heineken 330ml', 'BEER', 'BTL', 200, 400, 48, true], ['BEER-004', 'Guinness 500ml', 'BEER', 'BTL', 190, 400, 48, true],
      ['SPIRIT-001', 'Bacardi White Rum 750ml', 'SPIRIT', 'ML', 3.2, 0, 3000, false], ['SPIRIT-002', 'Gilbeys Gin 750ml', 'SPIRIT', 'ML', 2.4, 0, 3000, false], ['SPIRIT-003', 'Smirnoff Vodka 750ml', 'SPIRIT', 'ML', 2.6, 0, 3000, false], ['SPIRIT-004', 'Johnnie Walker Black 750ml', 'SPIRIT', 'ML', 6.5, 0, 1500, false], ['SPIRIT-005', 'Johnnie Walker Black 750ml (Bottle)', 'SPIRIT', 'BTL', 4800, 12000, 6, true], ['SPIRIT-006', 'Jameson 750ml (Bottle)', 'SPIRIT', 'BTL', 3200, 8500, 6, true], ['SPIRIT-007', 'Hennessy VS 700ml (Bottle)', 'SPIRIT', 'BTL', 6500, 18000, 4, true], ['SPIRIT-008', 'Triple Sec 750ml', 'SPIRIT', 'ML', 1.8, 0, 1500, false],
      ['WINE-001', 'Nederburg Cabernet 750ml', 'WINE', 'BTL', 1300, 3500, 12, true], ['WINE-002', 'Four Cousins Sweet Red 750ml', 'WINE', 'BTL', 950, 2800, 12, true], ['WINE-003', 'House White (Glass) 150ml', 'WINE', 'ML', 1.4, 0, 3000, false], ['WINE-004', 'Moet & Chandon 750ml', 'WINE', 'BTL', 7500, 20000, 4, true],
      ['HKC-001', 'Multi-surface Cleaner 5L', 'HKC', 'L', 180, 0, 20, false], ['HKC-002', 'Toilet Cleaner 5L', 'HKC', 'L', 160, 0, 20, false], ['HKC-003', 'Laundry Detergent 20kg', 'HKC', 'KG', 220, 0, 40, false], ['HKC-004', 'Glass Cleaner 5L', 'HKC', 'L', 150, 0, 10, false],
      ['GSUP-001', 'Shampoo 30ml', 'GSUP', 'PC', 18, 0, 200, false], ['GSUP-002', 'Shower Gel 30ml', 'GSUP', 'PC', 18, 0, 200, false], ['GSUP-003', 'Soap Bar 25g', 'GSUP', 'PC', 12, 0, 300, false], ['GSUP-004', 'Toilet Roll', 'GSUP', 'ROLL', 35, 0, 200, false], ['GSUP-005', 'Slippers (pair)', 'GSUP', 'PC', 85, 0, 50, false], ['GSUP-006', 'Coffee Sachet', 'GSUP', 'PC', 20, 0, 300, false], ['GSUP-007', 'Tea Bag', 'GSUP', 'PC', 8, 0, 500, false],
      ['LINEN-001', 'Bath Towel White', 'LINEN', 'PC', 650, 0, 30, false], ['LINEN-002', 'Hand Towel White', 'LINEN', 'PC', 280, 0, 30, false], ['LINEN-003', 'Bed Sheet Queen', 'LINEN', 'PC', 1500, 0, 20, false], ['LINEN-004', 'Bed Sheet King', 'LINEN', 'PC', 1800, 0, 20, false], ['LINEN-005', 'Pillow Case', 'LINEN', 'PC', 350, 0, 40, false], ['LINEN-006', 'Bathrobe', 'LINEN', 'PC', 2200, 0, 10, false], ['LINEN-007', 'Duvet Cover Queen', 'LINEN', 'PC', 2500, 0, 10, false],
      ['MNTP-001', 'LED Bulb 9W', 'MNTP', 'PC', 250, 0, 30, false], ['MNTP-002', 'Shower Head', 'MNTP', 'PC', 1200, 0, 5, false], ['MNTP-003', 'Toilet Flush Valve', 'MNTP', 'PC', 1500, 0, 5, false], ['MNTP-004', 'AC Filter', 'MNTP', 'PC', 800, 0, 10, false], ['MNTP-005', 'PVC Pipe 1/2"', 'MNTP', 'PC', 350, 0, 10, false], ['MNTP-006', 'Door Lock Cylinder', 'MNTP', 'PC', 2200, 0, 5, false], ['MNTP-007', 'Pool Chlorine 25kg', 'MNTP', 'KG', 280, 0, 25, false],
      ['OFF-001', 'A4 Paper Ream', 'OFF', 'PKT', 550, 0, 10, false], ['OFF-002', 'Thermal Receipt Roll', 'OFF', 'ROLL', 90, 0, 50, false], ['OFF-003', 'Key Cards', 'OFF', 'PC', 120, 0, 100, false],
    ];
    const prodIds: Record<string, string> = {};
    for (const [sku, name, cat, unit, cost, sell, reorder, sellable, expiry] of products) {
      prodIds[sku] = (await c.query(`INSERT INTO products (sku, name, category_id, unit_id, cost_price, selling_price, reorder_level, reorder_qty, min_stock, is_sellable, track_expiry, tax_id, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (sku) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [sku, name, catIds[cat], unitIds[unit], cost, sell, reorder, reorder * 2, Math.ceil(reorder / 2), sellable, !!expiry, sellable ? taxIds.VAT16 : null, `590${String(Object.keys(prodIds).length + 1).padStart(9, '0')}`])).rows[0].id;
    }
    log(`Products: ${products.length}`);

    // Suppliers
    const supIds: Record<string, string> = {};
    for (const [code, name, cats, terms] of [['SUP-000001', 'Farmers Choice Ltd', ['MEAT'], 30], ['SUP-000002', 'Fresh Produce Kenya', ['VEG', 'DAIRY'], 7], ['SUP-000003', 'EABL Distributors', ['BEER', 'SPIRIT'], 30], ['SUP-000004', 'Coca-Cola Beverages Africa', ['SOFT'], 14], ['SUP-000005', 'Wines of the World Ltd', ['WINE', 'SPIRIT'], 30], ['SUP-000006', 'Hygiene Supplies Co', ['HKC', 'GSUP'], 30], ['SUP-000007', 'Kenya Linen Company', ['LINEN'], 45], ['SUP-000008', 'Hardware & Engineering Ltd', ['MNTP'], 30], ['SUP-000009', 'Kenya Power (KPLC)', [], 30], ['SUP-000010', 'Nairobi Water Company', [], 30]] as const) {
      supIds[code] = (await c.query(`INSERT INTO suppliers (property_id, code, name, categories, payment_terms_days, email, phone, tax_number) VALUES ($1,$2,$3,$4,$5,$6,'+254 700 555000',$7) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P, code, name, [...cats], terms, `accounts@${name.toLowerCase().replace(/[^a-z]/g, '')}.example`, `P0${Math.floor(10000000 + Math.random() * 89999999)}X`])).rows[0].id;
    }
    await c.query(`INSERT INTO number_sequences (property_id, doc_type, prefix, padding, next_value) VALUES (NULL,'SUPPLIER','SUP',6,11),(NULL,'CUSTOMER','CUS',6,3) ON CONFLICT (property_id, doc_type) DO NOTHING`);

    // Outlets, kitchens, sections, tables
    const kitIds: Record<string, string> = {};
    for (const [code, name, store] of [['MAIN', 'Main Kitchen', 'KIT'], ['POOL', 'Pool Kitchen', 'KIT'], ['PASTRY', 'Pastry & Bakery', 'KIT'], ['PBAR', 'Pool Bar Counter', 'PBAR'], ['RBAR', 'Rooftop Bar Counter', 'RBAR'], ['CLUBBAR', 'Club Bar Counter', 'CLUB']] as const) {
      kitIds[code] = (await c.query(`INSERT INTO kitchens (property_id, code, name, store_id) VALUES ($1,$2,$3,$4) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P, code, name, storeIds[store]])).rows[0].id;
    }
    const outIds: Record<string, string> = {};
    for (const [code, name, type, dept, store, kit, rev, cogs] of [['REST', 'Main Restaurant', 'RESTAURANT', 'FNB', 'KIT', 'MAIN', '4100', '5010'], ['POOLR', 'Pool Restaurant', 'RESTAURANT', 'FNB', 'KIT', 'POOL', '4100', '5010'], ['PBAR', 'Pool Bar', 'BAR', 'BAR', 'PBAR', 'PBAR', '4200', '5020'], ['RBAR', 'Rooftop Bar', 'BAR', 'BAR', 'RBAR', 'RBAR', '4200', '5020'], ['CLUB', 'Night Club', 'CLUB', 'CLUB', 'CLUB', 'CLUBBAR', '4300', '5020'], ['RS', 'Room Service', 'ROOM_SERVICE', 'FNB', 'KIT', 'MAIN', '4100', '5010'], ['COFFEE', 'Coffee Shop', 'COFFEE_SHOP', 'FNB', 'KIT', 'PASTRY', '4100', '5010']] as const) {
      outIds[code] = (await c.query(`INSERT INTO outlets (property_id, code, name, type, department_id, store_id, default_kitchen_id, revenue_account_id, cogs_account_id, tax_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (property_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [P, code, name, type, deptIds[dept], storeIds[store], kitIds[kit], acct[rev], acct[cogs], taxIds.VAT16])).rows[0].id;
    }
    await c.query(`UPDATE stores SET outlet_id = (SELECT id FROM outlets WHERE code='PBAR' AND property_id=$1) WHERE code='PBAR' AND property_id=$1`, [P]);
    await c.query(`UPDATE stores SET outlet_id = (SELECT id FROM outlets WHERE code='RBAR' AND property_id=$1) WHERE code='RBAR' AND property_id=$1`, [P]);
    await c.query(`UPDATE stores SET outlet_id = (SELECT id FROM outlets WHERE code='CLUB' AND property_id=$1) WHERE code='CLUB' AND property_id=$1`, [P]);
    for (const [out, sections] of Object.entries({ REST: [['Indoor', 8], ['Terrace', 6]], POOLR: [['Poolside', 8]], PBAR: [['Bar Counter', 6], ['Loungers', 6]], RBAR: [['Lounge', 8], ['VIP Deck', 4]], CLUB: [['Dance Floor', 6], ['VIP Booths', 6]], COFFEE: [['Cafe', 6]] } as Record<string, [string, number][]>)) {
      if (Number((await c.query(`SELECT COUNT(*) FROM outlet_tables WHERE outlet_id=$1`, [outIds[out]])).rows[0].count) > 0) continue;
      let n = 1;
      for (const [sec, count] of sections) {
        const s = (await c.query(`INSERT INTO outlet_sections (outlet_id, name, is_vip) VALUES ($1,$2,$3) RETURNING id`, [outIds[out], sec, sec.includes('VIP')])).rows[0];
        for (let i = 0; i < count; i++, n++) await c.query(`INSERT INTO outlet_tables (outlet_id, section_id, number, capacity, pos_x, pos_y, min_spend) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [outIds[out], s.id, `T${n}`, sec.includes('VIP') ? 8 : 4, (i % 4) * 120 + 40, Math.floor(i / 4) * 120 + 40, sec.includes('VIP') ? 20000 : 0]);
      }
    }
    for (const [code, name, out] of [['POS-REST-1', 'Restaurant Till 1', 'REST'], ['POS-PBAR-1', 'Pool Bar Till', 'PBAR'], ['POS-RBAR-1', 'Rooftop Till', 'RBAR'], ['POS-CLUB-1', 'Club Till 1', 'CLUB'], ['POS-FD-1', 'Front Desk Till', null]] as const) {
      await c.query(`INSERT INTO pos_terminals (property_id, outlet_id, code, name) VALUES ($1,$2,$3,$4) ON CONFLICT (property_id, code) DO NOTHING`, [P, out ? outIds[out] : null, code, name]);
    }

    // Menus
    const menuExists = (await c.query(`SELECT id FROM menus WHERE property_id=$1 AND name='All Day Dining'`, [P])).rows[0];
    if (!menuExists) {
      const menu = (await c.query(`INSERT INTO menus (property_id, name, outlet_ids) VALUES ($1,'All Day Dining',$2) RETURNING id`, [P, [outIds.REST, outIds.POOLR, outIds.RS, outIds.COFFEE]])).rows[0];
      const barMenu = (await c.query(`INSERT INTO menus (property_id, name, outlet_ids) VALUES ($1,'Beverage Menu',$2) RETURNING id`, [P, [outIds.REST, outIds.POOLR, outIds.PBAR, outIds.RBAR, outIds.CLUB, outIds.RS]])).rows[0];
      const clubMenu = (await c.query(`INSERT INTO menus (property_id, name, outlet_ids) VALUES ($1,'Club Bottle Service',$2) RETURNING id`, [P, [outIds.CLUB, outIds.RBAR]])).rows[0];
      const cat = async (menuId: string, name: string, type: string, kitchen?: string) => (await c.query(`INSERT INTO menu_categories (menu_id, name, type, kitchen_id) VALUES ($1,$2,$3,$4) RETURNING id`, [menuId, name, type, kitchen ? kitIds[kitchen] : null])).rows[0].id;
      const item = async (catId: string, name: string, price: number, recipe?: [string, number][], productSku?: string, productQty = 1) => {
        const mi = (await c.query(`INSERT INTO menu_items (category_id, name, price, tax_id, product_id, product_qty) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [catId, name, price, taxIds.VAT16, productSku ? prodIds[productSku] : null, productQty])).rows[0];
        if (recipe) {
          const r = (await c.query(`INSERT INTO recipes (name, menu_item_id, created_by) VALUES ($1,$2,$3) RETURNING id`, [name, mi.id, userIds.chef])).rows[0];
          for (const [sku, q] of recipe) await c.query(`INSERT INTO recipe_items (recipe_id, product_id, quantity) VALUES ($1,$2,$3)`, [r.id, prodIds[sku], q]);
          const cost = (await c.query(`SELECT COALESCE(SUM(ri.quantity * p.cost_price),0) AS cost FROM recipe_items ri JOIN products p ON p.id=ri.product_id WHERE ri.recipe_id=$1`, [r.id])).rows[0].cost;
          await c.query(`UPDATE menu_items SET cost_estimate=$2 WHERE id=$1`, [mi.id, cost]);
        }
        return mi.id;
      };
      const starters = await cat(menu.id, 'Starters & Salads', 'FOOD', 'MAIN');
      await item(starters, 'Garden Salad', 650, [['VEG-002', 0.15], ['VEG-001', 0.1], ['VEG-003', 0.03]]);
      await item(starters, 'Soup of the Day', 550, [['VEG-004', 0.2], ['VEG-003', 0.05], ['DAIRY-005', 0.02]]);
      const mains = await cat(menu.id, 'Main Courses', 'FOOD', 'MAIN');
      await item(mains, 'Chicken Burger & Fries', 1200, [['MEAT-001', 0.15], ['DAIRY-001', 1], ['DAIRY-002', 0.03], ['VEG-001', 0.03], ['VEG-002', 0.02], ['VEG-004', 0.2], ['DRY-002', 0.05]]);
      await item(mains, 'Beef Fillet Steak', 2400, [['MEAT-002', 0.25], ['VEG-004', 0.2], ['DAIRY-005', 0.03], ['DRY-007', 0.005]]);
      await item(mains, 'Grilled Tilapia', 1600, [['MEAT-003', 0.4], ['VEG-001', 0.05], ['DRY-002', 0.03], ['VEG-005', 0.03]]);
      await item(mains, 'Spaghetti Bolognese', 1100, [['DRY-008', 0.15], ['MEAT-002', 0.1], ['VEG-001', 0.1], ['VEG-003', 0.05], ['DAIRY-002', 0.02]]);
      await item(mains, 'Chicken Biryani', 1300, [['MEAT-001', 0.2], ['DRY-001', 0.2], ['VEG-003', 0.08], ['DRY-002', 0.03]]);
      const breakfast = await cat(menu.id, 'Breakfast', 'FOOD', 'MAIN');
      await item(breakfast, 'Full English Breakfast', 1400, [['DAIRY-004', 2], ['MEAT-004', 0.08], ['VEG-001', 0.05], ['DAIRY-001', 1], ['DAIRY-005', 0.02]]);
      await item(breakfast, 'Continental Breakfast', 950, [['DAIRY-001', 1], ['DAIRY-005', 0.02], ['SOFT-006', 0.2], ['DAIRY-003', 0.1]]);
      const desserts = await cat(menu.id, 'Desserts & Pastry', 'FOOD', 'PASTRY');
      await item(desserts, 'Chocolate Cake Slice', 550, [['DRY-004', 0.08], ['DRY-003', 0.06], ['DAIRY-004', 1], ['DAIRY-005', 0.04]]);
      await item(desserts, 'Fruit Platter', 600, [['VEG-005', 0.05]]);
      const hot = await cat(menu.id, 'Hot Beverages', 'BEVERAGE', 'PASTRY');
      await item(hot, 'Cappuccino', 350, [['DRY-005', 0.018], ['DAIRY-003', 0.15]]);
      await item(hot, 'Kenyan Tea', 250, [['DRY-006', 0.005], ['DAIRY-003', 0.15], ['DRY-003', 0.01]]);
      const softCat = await cat(barMenu.id, 'Soft Drinks & Water', 'BEVERAGE');
      await item(softCat, 'Coca-Cola 300ml', 150, undefined, 'SOFT-001'); await item(softCat, 'Sprite 300ml', 150, undefined, 'SOFT-002'); await item(softCat, 'Mineral Water 500ml', 120, undefined, 'SOFT-003'); await item(softCat, 'Mineral Water 1L', 200, undefined, 'SOFT-004');
      await item(softCat, 'Fresh Orange Juice', 400, [['SOFT-006', 0.3]]);
      const beerCat = await cat(barMenu.id, 'Beers', 'ALCOHOL');
      await item(beerCat, 'Tusker Lager', 350, undefined, 'BEER-001'); await item(beerCat, 'White Cap', 350, undefined, 'BEER-002'); await item(beerCat, 'Heineken', 400, undefined, 'BEER-003'); await item(beerCat, 'Guinness', 400, undefined, 'BEER-004');
      const cocktails = await cat(barMenu.id, 'Cocktails', 'ALCOHOL');
      await item(cocktails, 'Mojito', 850, [['SPIRIT-001', 50], ['VEG-005', 0.03], ['DRY-003', 0.02], ['VEG-006', 10], ['SOFT-007', 0.5]]);
      await item(cocktails, 'Gin & Tonic', 750, [['SPIRIT-002', 50], ['SOFT-005', 1], ['VEG-005', 0.01]]);
      await item(cocktails, 'Margarita', 900, [['SPIRIT-003', 50], ['SPIRIT-008', 25], ['VEG-005', 0.04], ['DRY-007', 0.002]]);
      await item(cocktails, 'Dawa', 800, [['SPIRIT-003', 50], ['VEG-005', 0.04], ['DRY-003', 0.02]]);
      const spirits = await cat(barMenu.id, 'Spirits (Tot)', 'ALCOHOL');
      await item(spirits, 'Johnnie Walker Black (Tot)', 600, [['SPIRIT-004', 25]]);
      await item(spirits, 'Smirnoff Vodka (Tot)', 350, [['SPIRIT-003', 25]]);
      await item(spirits, 'Gilbeys Gin (Tot)', 350, [['SPIRIT-002', 25]]);
      const wine = await cat(barMenu.id, 'Wine', 'ALCOHOL');
      await item(wine, 'House White (Glass)', 550, [['WINE-003', 150]]); await item(wine, 'Nederburg Cabernet (Bottle)', 3500, undefined, 'WINE-001'); await item(wine, 'Four Cousins Sweet Red (Bottle)', 2800, undefined, 'WINE-002');
      const bottles = await cat(clubMenu.id, 'Bottle Service', 'ALCOHOL');
      await item(bottles, 'Johnnie Walker Black 750ml', 12000, undefined, 'SPIRIT-005'); await item(bottles, 'Jameson 750ml', 8500, undefined, 'SPIRIT-006'); await item(bottles, 'Hennessy VS 700ml', 18000, undefined, 'SPIRIT-007'); await item(bottles, 'Moet & Chandon 750ml', 20000, undefined, 'WINE-004');
      const entry = await cat(clubMenu.id, 'Entry & Cover', 'TICKET');
      await item(entry, 'Cover Charge', 1000); await item(entry, 'VIP Entry', 3000);
      log('Menus & recipes created');
    }

    }
    // Shift templates
    for (const [name, st, et] of [['Morning', '06:00', '14:00'], ['Afternoon', '14:00', '22:00'], ['Night', '22:00', '06:00'], ['Split (Restaurant)', '11:00', '23:00']] as const) {
      await c.query(`INSERT INTO shift_templates (property_id, name, start_time, end_time) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM shift_templates WHERE property_id=$1 AND name=$2)`, [P, name, st, et]);
    }
    // Room item types, laundry services, services, venues, expense categories, petty cash
    if (full) {
    for (const [name, cat, ser, val, qty] of [['Television 43"', 'APPLIANCE', true, 45000, 1], ['TV Remote', 'APPLIANCE', false, 1500, 1], ['Mini Fridge', 'APPLIANCE', true, 25000, 1], ['Electronic Safe', 'APPLIANCE', true, 15000, 1], ['Hair Dryer', 'APPLIANCE', false, 3500, 1], ['Electric Kettle', 'APPLIANCE', false, 2500, 1], ['Iron', 'APPLIANCE', false, 3000, 1], ['Ironing Board', 'FURNITURE', false, 4000, 1], ['Bath Towel', 'LINEN', false, 650, 2], ['Hand Towel', 'LINEN', false, 280, 2], ['Bathrobe', 'LINEN', false, 2200, 2], ['Slippers', 'AMENITY', false, 85, 2], ['Water Glass', 'GLASSWARE', false, 250, 2], ['Coffee Mug', 'GLASSWARE', false, 300, 2], ['Coffee Sachets', 'AMENITY', false, 20, 4], ['Tea Bags', 'AMENITY', false, 8, 4], ['Mineral Water 500ml (complimentary)', 'MINIBAR', false, 120, 2], ['Shampoo', 'TOILETRY', false, 18, 2], ['Shower Gel', 'TOILETRY', false, 18, 2], ['Soap', 'TOILETRY', false, 12, 2], ['Study Desk', 'FURNITURE', false, 12000, 1], ['Wardrobe Hangers (set)', 'FURNITURE', false, 800, 1]] as const) {
      await c.query(`INSERT INTO room_item_types (property_id, name, category, is_serialized, replacement_value, standard_quantity, is_consumable) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (property_id, name) DO NOTHING`, [P, name, cat, ser, val, qty, ['AMENITY', 'TOILETRY', 'MINIBAR'].includes(cat)]);
    }
    if (Number((await c.query(`SELECT COUNT(*) FROM room_items WHERE property_id=$1`, [P])).rows[0].count) === 0) {
      const roomList = (await c.query(`SELECT id, number FROM rooms WHERE property_id=$1`, [P])).rows;
      const types = (await c.query(`SELECT * FROM room_item_types WHERE property_id=$1`, [P])).rows;
      for (const r of roomList) for (const t of types) await c.query(`INSERT INTO room_items (property_id, item_type_id, room_id, quantity, serial_number, asset_number, condition, cost) VALUES ($1,$2,$3,$4,$5,$6,'GOOD',$7)`, [P, t.id, r.id, t.standard_quantity, t.is_serialized ? `SN-${r.number}-${t.name.slice(0, 3).toUpperCase()}${Math.floor(Math.random() * 90000 + 10000)}` : null, t.is_serialized ? `AST-R${r.number}-${t.name.slice(0, 2).toUpperCase()}` : null, t.replacement_value]);
    }
    for (const [name, cat, price] of [['Shirt / Blouse', 'GARMENT', 250], ['Trousers / Skirt', 'GARMENT', 300], ['Suit (2 piece)', 'GARMENT', 900], ['Dress', 'GARMENT', 500], ['Undergarments (per piece)', 'GARMENT', 100], ['Bed Sheet (hotel)', 'LINEN', 0], ['Towel (hotel)', 'LINEN', 0], ['Staff Uniform', 'UNIFORM', 0], ['Dry Cleaning - Jacket', 'DRY_CLEAN', 800]] as const) {
      await c.query(`INSERT INTO laundry_services (property_id, name, category, price) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM laundry_services WHERE property_id=$1 AND name=$2)`, [P, name, cat, price]);
    }
    for (const [code, name, cat, price, dur, folioCat, rev] of [['SPA-SWE', 'Swedish Massage (60 min)', 'SPA', 4500, 60, 'SPA', '4600'], ['SPA-DEEP', 'Deep Tissue Massage (90 min)', 'SPA', 6500, 90, 'SPA', '4600'], ['SPA-FACIAL', 'Signature Facial', 'SPA', 3800, 45, 'SPA', '4600'], ['GYM-DAY', 'Gym Day Pass', 'GYM', 1000, null, 'ACTIVITY', '4800'], ['POOL-DAY', 'Pool Day Pass', 'POOL', 1500, null, 'ACTIVITY', '4800'], ['TRF-APT', 'Airport Transfer (one way)', 'TRANSPORT', 3500, 60, 'TRANSPORT', '4800'], ['TOUR-NNP', 'Nairobi National Park Half Day Tour', 'TOUR', 9500, 300, 'ACTIVITY', '4800'], ['CAR-DAY', 'Car Hire (per day)', 'CAR_RENTAL', 7000, null, 'TRANSPORT', '4800'], ['CONF-HR', 'Meeting Room (per hour)', 'OTHER', 3000, 60, 'CONFERENCE', '4700']] as const) {
      await c.query(`INSERT INTO services (property_id, code, name, category, price, duration_minutes, tax_id, revenue_account_id, folio_category, requires_staff) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (property_id, code) DO UPDATE SET price=EXCLUDED.price`, [P, code, name, cat, price, dur, taxIds.VAT16, acct[rev], folioCat, cat === 'SPA']);
    }
    for (const [name, type] of [['Spa Room 1', 'ROOM'], ['Spa Room 2', 'ROOM'], ['Therapist - Grace', 'THERAPIST'], ['Therapist - Nancy', 'THERAPIST'], ['Shuttle Van KDA 123A', 'VEHICLE']] as const) {
      await c.query(`INSERT INTO service_resources (property_id, name, type) SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM service_resources WHERE property_id=$1 AND name=$2)`, [P, name, type]);
    }
    for (const [code, name, type, th, bq, hr, hd, fd] of [['KILI', 'Kilimanjaro Ballroom', 'BALLROOM', 400, 250, 15000, 60000, 100000], ['MARA', 'Mara Conference Room', 'CONFERENCE', 120, 80, 6000, 25000, 40000], ['TSAVO', 'Tsavo Boardroom', 'BOARDROOM', 20, 14, 3000, 12000, 20000], ['GARDEN', 'Acacia Gardens', 'GARDEN', 500, 350, 0, 80000, 150000]] as const) {
      await c.query(`INSERT INTO venues (property_id, code, name, type, capacity_theatre, capacity_banquet, hourly_rate, half_day_rate, full_day_rate, amenities) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (property_id, code) DO NOTHING`, [P, code, name, type, th, bq, hr, hd, fd, ['Projector', 'PA System', 'WiFi', 'Flipcharts']]);
    }
    }
    for (const [code, name, a] of [['ELEC', 'Electricity', '6100'], ['WATER', 'Water', '6110'], ['INTERNET', 'Internet & Telephone', '6120'], ['FUEL', 'Fuel & Generator', '6130'], ['REPAIRS', 'Repairs & Maintenance', '6200'], ['TRANSPORT', 'Transport & Travel', '6420'], ['MARKETING', 'Marketing & Advertising', '6300'], ['LICENSE', 'Licences & Permits', '6400'], ['SECURITY', 'Security Services', '6410'], ['CLEANING', 'Cleaning Supplies', '6210'], ['OFFICE', 'Office Expenses', '6430'], ['ENTERTAIN', 'Entertainment', '5040'], ['PROF', 'Professional Fees', '6440'], ['BANK', 'Bank Charges', '6450'], ['MISC', 'Miscellaneous', '6490']] as const) {
      await c.query(`INSERT INTO expense_categories (code, name, account_id) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET account_id=EXCLUDED.account_id`, [code, name, acct[a]]);
    }
    if (full) {
    for (const [name, cust, dept, fl] of [['Reception Petty Cash', 'fom', 'FO', 20000], ['Restaurant Petty Cash', 'restaurant', 'FNB', 15000], ['Maintenance Petty Cash', 'maintenance', 'MNT', 25000], ['General Petty Cash', 'accountant', 'FIN', 50000]] as const) {
      await c.query(`INSERT INTO petty_cash_funds (property_id, name, custodian_user_id, department_id, account_id, float_amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (property_id, name) DO NOTHING`, [P, name, userIds[cust], deptIds[dept], acct['1040'], fl]);
    }
    }
    for (const [name, rate] of [['Furniture & Fittings', 12.5], ['Kitchen Equipment', 12.5], ['Computers & POS Devices', 33.3], ['Vehicles', 25], ['Appliances', 12.5], ['Laundry Machines', 12.5], ['Generators', 12.5], ['Security Equipment', 20]] as const) {
      await c.query(`INSERT INTO asset_categories (name, depreciation_rate) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`, [name, rate]);
    }
    if (full) {
    if (Number((await c.query(`SELECT COUNT(*) FROM assets WHERE property_id=$1`, [P])).rows[0].count) === 0) {
      const cats = Object.fromEntries((await c.query(`SELECT id, name FROM asset_categories`)).rows.map((r) => [r.name, r.id]));
      let n = 1;
      for (const [name, cat, loc, dept, cost] of [['Standby Generator 250kVA', 'Generators', 'Generator House', 'MNT', 4500000], ['Walk-in Cold Room', 'Kitchen Equipment', 'Main Kitchen', 'KIT', 1200000], ['Industrial Washing Machine 25kg', 'Laundry Machines', 'Laundry', 'LND', 850000], ['Shuttle Van KDA 123A', 'Vehicles', 'Parking', 'FO', 3800000], ['POS Terminal - Restaurant', 'Computers & POS Devices', 'Main Restaurant', 'FNB', 65000], ['CCTV System (32 ch)', 'Security Equipment', 'Security Office', 'SEC', 480000], ['Pool Pump & Filter', 'Appliances', 'Pool Plant Room', 'MNT', 320000], ['Espresso Machine', 'Kitchen Equipment', 'Coffee Shop', 'FNB', 280000]] as const) {
        await c.query(`INSERT INTO assets (property_id, asset_number, name, category_id, location, department_id, purchase_date, cost, status, barcode) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE - 400,$7,'IN_USE',$2)`, [P, `AST-${String(n++).padStart(6, '0')}`, name, cats[cat], loc, deptIds[dept], cost]);
      }
      await c.query(`INSERT INTO number_sequences (property_id, doc_type, prefix, padding, next_value) VALUES (NULL,'ASSET','AST',6,$1) ON CONFLICT (property_id, doc_type) DO NOTHING`, [n]);
    }
    }

    // Default approval workflows
    if (Number((await c.query(`SELECT COUNT(*) FROM workflow_definitions`)).rows[0].count) === 0) {
      const wf = async (type: string, name: string, min: number, steps: [string, string][]) => {
        const d = (await c.query(`INSERT INTO workflow_definitions (property_id, transaction_type, name, min_amount) VALUES (NULL,$1,$2,$3) RETURNING id`, [type, name, min])).rows[0];
        let i = 1; for (const [sname, role] of steps) await c.query(`INSERT INTO workflow_steps (definition_id, step_order, name, approver_role_id) VALUES ($1,$2,$3,$4)`, [d.id, i++, sname, roleIds[role]]);
      };
      await wf('PURCHASE_REQUISITION', 'Requisition approval', 0, [['Department Manager / Storekeeper', 'STOREKEEPER']]);
      await wf('PURCHASE_ORDER', 'PO approval (standard)', 0, [['Finance approval', 'ACCOUNTS_MANAGER']]);
      await wf('PURCHASE_ORDER', 'PO approval (> 500k)', 500000, [['Finance approval', 'ACCOUNTS_MANAGER'], ['General Manager approval', 'GENERAL_MANAGER']]);
      await wf('EXPENSE', 'Expense approval', 0, [['Finance approval', 'ACCOUNTS_MANAGER']]);
      await wf('EXPENSE', 'Expense approval (> 100k)', 100000, [['Finance approval', 'ACCOUNTS_MANAGER'], ['General Manager approval', 'GENERAL_MANAGER']]);
      await wf('STOCK_ADJUSTMENT', 'Stock adjustment approval', 0, [['Store manager / Finance', 'ACCOUNTS_MANAGER']]);
      await wf('WASTE', 'Waste approval', 0, [['Manager approval', 'RESTAURANT_MANAGER']]);
      await wf('SUPPLIER_PAYMENT', 'Supplier payment approval', 0, [['Finance approval', 'ACCOUNTS_MANAGER']]);
      await wf('MAINTENANCE_REQUEST', 'Maintenance approval (> 50k)', 50000, [['Maintenance Manager', 'MAINTENANCE_MANAGER']]);
      log('Workflows created');
    }

    // Opening stock (only when store is empty) — posts OPENING movements + journal
    if (full && Number((await c.query(`SELECT COUNT(*) FROM stock_movements WHERE property_id=$1`, [P])).rows[0].count) === 0) {
      const { moveStock } = await import('../modules/inventory/stock.service');
      const { postJournal } = await import('../modules/finance/accounting.service');
      let openingFood = 0, openingBev = 0, openingGen = 0;
      const allProducts = (await c.query(`SELECT p.*, pc.type AS cat_type FROM products p JOIN product_categories pc ON pc.id=p.category_id`)).rows;
      for (const p of allProducts) {
        const qty = Number(p.reorder_level) * 3;
        const store = p.cat_type === 'FOOD' ? 'FOOD' : p.cat_type === 'BEVERAGE' ? 'BEV' : p.cat_type === 'HOUSEKEEPING' || p.cat_type === 'GUEST_SUPPLIES' ? 'HK' : p.cat_type === 'MAINTENANCE' ? 'ENG' : 'MAIN';
        await moveStock(c, { propertyId: P, storeId: storeIds[store], productId: p.id, type: 'OPENING', quantity: qty, unitCost: Number(p.cost_price), referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin, notes: 'Opening stock (seed)' });
        const val = qty * Number(p.cost_price);
        if (p.cat_type === 'FOOD') openingFood += val; else if (p.cat_type === 'BEVERAGE') openingBev += val; else openingGen += val;
        // issue part to outlet stores so POS can sell immediately
        if (p.cat_type === 'FOOD') await moveStock(c, { propertyId: P, storeId: storeIds.FOOD, productId: p.id, type: 'ISSUE_TO_DEPARTMENT', quantity: -qty / 3, referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin }).then(() => moveStock(c, { propertyId: P, storeId: storeIds.KIT, productId: p.id, type: 'RETURN_TO_STORE', quantity: qty / 3, unitCost: Number(p.cost_price), referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin }));
        if (p.cat_type === 'BEVERAGE') for (const s of ['PBAR', 'RBAR', 'CLUB']) { await moveStock(c, { propertyId: P, storeId: storeIds.BEV, productId: p.id, type: 'STORE_TRANSFER_OUT', quantity: -qty / 6, referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin }); await moveStock(c, { propertyId: P, storeId: storeIds[s], productId: p.id, type: 'STORE_TRANSFER_IN', quantity: qty / 6, unitCost: Number(p.cost_price), referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin }); }
        if (p.cat_type === 'FOOD' || p.sku.startsWith('SOFT') || p.sku.startsWith('BEER') || p.sku.startsWith('WINE')) { await moveStock(c, { propertyId: P, storeId: storeIds[p.cat_type === 'FOOD' ? 'FOOD' : 'BEV'], productId: p.id, type: 'ISSUE_TO_DEPARTMENT', quantity: -qty / 6, referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin }); await moveStock(c, { propertyId: P, storeId: storeIds.KIT, productId: p.id, type: 'RETURN_TO_STORE', quantity: qty / 6, unitCost: Number(p.cost_price), referenceType: 'OPENING', referenceNumber: 'SEED', userId: userIds.admin }); }
      }
      await postJournal(c, { propertyId: P, description: 'Opening stock balances', sourceType: 'OPENING', userId: userIds.admin, lines: [
        { mappingKey: 'INVENTORY_FOOD', debit: openingFood }, { mappingKey: 'INVENTORY_BEVERAGE', debit: openingBev }, { mappingKey: 'INVENTORY', debit: openingGen }, { accountId: acct['3010'], credit: openingFood + openingBev + openingGen }] });
      // opening cash/bank
      await postJournal(c, { propertyId: P, description: 'Opening cash & bank balances', sourceType: 'OPENING', userId: userIds.admin, lines: [{ mappingKey: 'BANK', debit: 2500000 }, { mappingKey: 'CASH', debit: 50000 }, { accountId: acct['3010'], credit: 2550000 }] });
      log('Opening stock & balances posted');
    }
    // Business day
    await c.query(`INSERT INTO business_days (property_id, business_date, status, opened_by) VALUES ($1, CURRENT_DATE, 'OPEN', $2) ON CONFLICT DO NOTHING`, [P, userIds.admin]);
    // Settings
    for (const [k, v] of Object.entries({ 'hotel.checkin_time': '14:00', 'hotel.checkout_time': '11:00', 'hotel.late_checkout_fee_percent': 50, 'hotel.default_deposit_percent': 30, 'hotel.cancellation_policy': 'Free cancellation up to 48 hours before arrival. Late cancellations and no-shows are charged one night.', 'pos.require_shift': true, 'pos.auto_send_kitchen': false, 'inventory.grn_auto_post': true, 'finance.fiscal_integration': 'NONE', 'notifications.low_stock': true })) {
      await c.query(`INSERT INTO settings (property_id, key, value) VALUES (NULL,$1,$2) ON CONFLICT (property_id, key) DO NOTHING`, [k, JSON.stringify(v)]);
    }
  });
  log(minimal ? 'Minimal (production) seed complete' : 'Seed complete');
}

if (require.main === module) {
  seed(console.log, { minimal: process.argv.includes('--minimal') || process.env.SEED_MODE === 'minimal' }).then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
