-- =====================================================================
-- 007 PROCUREMENT: purchase requisitions, quotations, purchase orders,
-- GRNs, supplier invoices, supplier payments allocations
--     EXPENSES: categories, expenses, petty cash funds & transactions
-- =====================================================================

CREATE TABLE purchase_requisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  department_id UUID REFERENCES departments(id),
  store_id UUID REFERENCES stores(id),
  required_by DATE,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','ORDERED','CLOSED','CANCELLED')),
  justification TEXT,
  estimated_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  requested_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_requisition_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id UUID NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_id UUID REFERENCES units(id),
  estimated_unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  ordered_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE supplier_quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  requisition_id UUID REFERENCES purchase_requisitions(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  quote_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','SELECTED','REJECTED','EXPIRED')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_quotation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES supplier_quotations(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,4) NOT NULL,
  lead_time_days INT
);

CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  requisition_id UUID REFERENCES purchase_requisitions(id),
  quotation_id UUID REFERENCES supplier_quotations(id),
  store_id UUID REFERENCES stores(id),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED','REJECTED')),
  payment_terms TEXT,
  delivery_address TEXT,
  notes TEXT,
  is_cash_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id, status);

CREATE TABLE purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_id UUID REFERENCES units(id),
  unit_price NUMERIC(14,4) NOT NULL,
  tax_id UUID REFERENCES taxes(id),
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL,
  received_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  invoiced_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  expense_account_id UUID REFERENCES accounts(id)   -- for non-stock purchases
);

CREATE TABLE grns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  purchase_order_id UUID REFERENCES purchase_orders(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  delivery_note_no TEXT,
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_QC','COMPLETED','CANCELLED')),
  total_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  journal_entry_id UUID REFERENCES journal_entries(id),
  notes TEXT,
  received_by UUID REFERENCES users(id),
  checked_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE grn_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id UUID NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  po_item_id UUID REFERENCES purchase_order_items(id),
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  ordered_qty NUMERIC(14,3),
  received_qty NUMERIC(14,3) NOT NULL,
  accepted_qty NUMERIC(14,3) NOT NULL,
  rejected_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  damaged_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14,4) NOT NULL,
  tax_id UUID REFERENCES taxes(id),
  batch_no TEXT,
  expiry_date DATE,
  serial_numbers TEXT[],
  rejection_reason TEXT,
  stock_movement_id UUID REFERENCES stock_movements(id)
);

CREATE TABLE supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  supplier_invoice_no TEXT NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  purchase_order_id UUID REFERENCES purchase_orders(id),
  grn_ids UUID[] NOT NULL DEFAULT '{}',
  invoice_date DATE NOT NULL,
  due_date DATE,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('DRAFT','PENDING','APPROVED','PARTIALLY_PAID','PAID','CANCELLED','DISPUTED')),
  type TEXT NOT NULL DEFAULT 'INVOICE' CHECK (type IN ('INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, supplier_invoice_no)
);

CREATE TABLE supplier_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  grn_item_id UUID REFERENCES grn_items(id),
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,4) NOT NULL,
  tax_id UUID REFERENCES taxes(id),
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL,
  account_id UUID REFERENCES accounts(id)
);

CREATE TABLE supplier_invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  payment_id UUID NOT NULL REFERENCES payments(id),
  amount NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  amount NUMERIC(14,2) NOT NULL,
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id),
  reference TEXT,
  allocations JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{invoice_id, amount}]
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','PAID','REJECTED','CANCELLED')),
  payment_id UUID REFERENCES payments(id),
  notes TEXT,
  requested_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Expenses
CREATE TABLE expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id),
  requires_receipt BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE petty_cash_funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  custodian_user_id UUID REFERENCES users(id),
  department_id UUID REFERENCES departments(id),
  account_id UUID REFERENCES accounts(id),      -- petty cash asset account
  float_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, name)
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  category_id UUID NOT NULL REFERENCES expense_categories(id),
  department_id UUID REFERENCES departments(id),
  outlet_id UUID REFERENCES outlets(id),
  supplier_id UUID REFERENCES suppliers(id),
  payee TEXT,
  description TEXT NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(14,2) NOT NULL,
  tax_id UUID REFERENCES taxes(id),
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  payment_source TEXT NOT NULL DEFAULT 'BANK' CHECK (payment_source IN ('CASH','BANK','MOBILE_MONEY','PETTY_CASH','CORPORATE_CARD','CREDIT')),
  petty_cash_fund_id UUID REFERENCES petty_cash_funds(id),
  payment_method_id UUID REFERENCES payment_methods(id),
  payment_id UUID REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PAID','REJECTED','CANCELLED')),
  reference TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  requested_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expenses_status ON expenses(property_id, status, expense_date);

CREATE TABLE petty_cash_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES petty_cash_funds(id),
  type TEXT NOT NULL CHECK (type IN ('OPENING','REPLENISHMENT','EXPENSE','RETURN','ADJUSTMENT','RECONCILIATION')),
  amount NUMERIC(12,2) NOT NULL,          -- signed: + in, - out
  balance_after NUMERIC(12,2) NOT NULL,
  expense_id UUID REFERENCES expenses(id),
  payment_id UUID REFERENCES payments(id),
  description TEXT,
  reference TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  counted_amount NUMERIC(12,2),
  variance NUMERIC(12,2),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_protect_petty_cash BEFORE UPDATE OR DELETE ON petty_cash_transactions FOR EACH ROW EXECUTE FUNCTION protect_ledger();

CREATE TRIGGER trg_pr_updated BEFORE UPDATE ON purchase_requisitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_po_updated BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
