-- =====================================================================
-- 002 FINANCE CORE: chart of accounts, account mappings, taxes,
-- accounting periods, business days, journals (immutable), payment
-- methods, payments, party ledgers (customers/suppliers)
-- =====================================================================

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','COST_OF_SALES','EXPENSE')),
  parent_id UUID REFERENCES accounts(id),
  is_header BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  currency CHAR(3),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

-- Maps logical posting keys (CASH, BANK, AR, AP, INVENTORY, TAX_PAYABLE, ROOM_REVENUE ...) to accounts.
CREATE TABLE account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  mapping_key TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id),
  UNIQUE NULLS NOT DISTINCT (property_id, mapping_key)
);

CREATE TABLE taxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate NUMERIC(8,4) NOT NULL DEFAULT 0,      -- percent
  type TEXT NOT NULL DEFAULT 'VAT' CHECK (type IN ('VAT','SERVICE_CHARGE','LEVY','OTHER','ZERO_RATED','EXEMPT')),
  is_inclusive BOOLEAN NOT NULL DEFAULT TRUE,
  is_recoverable BOOLEAN NOT NULL DEFAULT TRUE,
  account_id UUID REFERENCES accounts(id),
  applies_to TEXT[] NOT NULL DEFAULT '{}',     -- ROOM, FOOD, BEVERAGE, SERVICE, PURCHASE ...
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  fiscal_code TEXT,                            -- e.g. KRA eTIMS tax type code
  UNIQUE NULLS NOT DISTINCT (property_id, code)
);

CREATE TABLE accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','LOCKED')),
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  UNIQUE (company_id, start_date, end_date)
);

CREATE TABLE business_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  business_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSING','CLOSED')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id),
  night_audit_report JSONB,
  UNIQUE (property_id, business_date)
);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  property_id UUID REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  entry_date DATE NOT NULL,
  business_date DATE,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'MANUAL', -- FOLIO, ORDER, PAYMENT, GRN, SUPPLIER_INVOICE, EXPENSE, STOCK, WASTE, MANUAL ...
  source_id UUID,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  reversed_by_id UUID REFERENCES journal_entries(id),
  reverses_id UUID REFERENCES journal_entries(id),
  total_debit NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_credit NUMERIC(16,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  posted_by UUID REFERENCES users(id),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_debit = total_credit)
);
CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX idx_journal_entries_source ON journal_entries(source_type, source_id);

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id),
  property_id UUID REFERENCES properties(id),
  department_id UUID REFERENCES departments(id),
  outlet_id UUID,
  description TEXT,
  debit NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
  debit_txn NUMERIC(16,2) NOT NULL DEFAULT 0,   -- in transaction currency
  credit_txn NUMERIC(16,2) NOT NULL DEFAULT 0,
  party_type TEXT,
  party_id UUID,
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);

-- Journals are immutable: block UPDATE/DELETE on posted lines & entries except status flips done by reversal.
CREATE OR REPLACE FUNCTION protect_journal() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Posted journal entries cannot be deleted; post a reversal instead'; END IF;
  IF OLD.status = 'POSTED' AND (NEW.total_debit <> OLD.total_debit OR NEW.total_credit <> OLD.total_credit OR NEW.entry_date <> OLD.entry_date OR NEW.description <> OLD.description) THEN
    RAISE EXCEPTION 'Posted journal entries are immutable; post a reversal instead';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_protect_journal BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION protect_journal();

CREATE OR REPLACE FUNCTION protect_journal_lines() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'Journal lines are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_protect_journal_lines BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION protect_journal_lines();

CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('CASH','CARD','MOBILE_MONEY','BANK_TRANSFER','CHEQUE','VOUCHER','CORPORATE_CREDIT','GUEST_DEPOSIT','ROOM_CHARGE','OTHER')),
  account_id UUID REFERENCES accounts(id),
  requires_reference BOOLEAN NOT NULL DEFAULT FALSE,
  is_cash_drawer BOOLEAN NOT NULL DEFAULT FALSE, -- counts toward cashier drawer
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE NULLS NOT DISTINCT (property_id, code)
);

-- Credit customers (corporate, agents, government) for accounts receivable
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CORPORATE' CHECK (type IN ('CORPORATE','TRAVEL_AGENT','GOVERNMENT','OTA','GROUP','INDIVIDUAL','OTHER')),
  contact_name TEXT, phone TEXT, email TEXT, address TEXT, tax_number TEXT,
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_terms_days INT NOT NULL DEFAULT 30,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  commission_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact_name TEXT, phone TEXT, email TEXT, address TEXT, tax_number TEXT,
  payment_terms_days INT NOT NULL DEFAULT 30,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  bank_name TEXT, bank_account TEXT, bank_branch TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  rating INT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unified payments ledger (money in and money out)
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  kind TEXT NOT NULL DEFAULT 'PAYMENT' CHECK (kind IN ('PAYMENT','DEPOSIT','REFUND','SUPPLIER_PAYMENT','EXPENSE_PAYMENT','PETTY_CASH','CUSTOMER_PAYMENT','OTHER')),
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
  base_amount NUMERIC(14,2) NOT NULL,
  reference TEXT,
  party_type TEXT,           -- GUEST, CUSTOMER, SUPPLIER, EMPLOYEE, OTHER
  party_id UUID,
  source_type TEXT,          -- FOLIO, ORDER, SUPPLIER_INVOICE, EXPENSE, CUSTOMER_INVOICE, EVENT, TICKET, PETTY_CASH
  source_id UUID,
  cashier_shift_id UUID,
  outlet_id UUID,
  business_date DATE,
  journal_entry_id UUID REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING','COMPLETED','REVERSED','FAILED')),
  reversed_by_id UUID REFERENCES payments(id),
  idempotency_key TEXT UNIQUE,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_source ON payments(source_type, source_id);
CREATE INDEX idx_payments_party ON payments(party_type, party_id);
CREATE INDEX idx_payments_shift ON payments(cashier_shift_id);
CREATE INDEX idx_payments_date ON payments(property_id, business_date);

-- Immutable subsidiary ledgers for suppliers and customers
CREATE TABLE party_ledger (
  id BIGSERIAL PRIMARY KEY,
  party_type TEXT NOT NULL CHECK (party_type IN ('SUPPLIER','CUSTOMER')),
  party_id UUID NOT NULL,
  property_id UUID,
  entry_date DATE NOT NULL,
  entry_type TEXT NOT NULL, -- OPENING, INVOICE, PAYMENT, CREDIT_NOTE, DEBIT_NOTE, ADJUSTMENT
  reference TEXT,
  description TEXT,
  debit NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  source_type TEXT, source_id UUID,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_party_ledger ON party_ledger(party_type, party_id, entry_date);
CREATE OR REPLACE FUNCTION protect_ledger() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'Ledger rows are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_protect_party_ledger BEFORE UPDATE OR DELETE ON party_ledger FOR EACH ROW EXECUTE FUNCTION protect_ledger();

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
