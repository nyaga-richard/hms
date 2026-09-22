-- =====================================================================
-- 005 INVENTORY: units, categories, products, stores, stock balances,
-- immutable stock ledger, requisitions/issues, transfers, adjustments,
-- stocktakes, waste, recipes
-- =====================================================================

CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_unit_id UUID REFERENCES units(id),
  factor NUMERIC(14,6) NOT NULL DEFAULT 1  -- how many base units in this unit
);

CREATE TABLE product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_id UUID REFERENCES product_categories(id),
  type TEXT NOT NULL DEFAULT 'FOOD' CHECK (type IN ('FOOD','BEVERAGE','HOUSEKEEPING','MAINTENANCE','OFFICE','LAUNDRY','GUEST_SUPPLIES','OTHER')),
  inventory_account_id UUID REFERENCES accounts(id),
  cogs_account_id UUID REFERENCES accounts(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES product_categories(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  purchase_unit_id UUID REFERENCES units(id),
  pack_size NUMERIC(12,4) NOT NULL DEFAULT 1,
  cost_price NUMERIC(14,4) NOT NULL DEFAULT 0,     -- last/average cost per stock unit
  selling_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  min_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  max_stock NUMERIC(14,3),
  reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  track_batches BOOLEAN NOT NULL DEFAULT FALSE,
  track_expiry BOOLEAN NOT NULL DEFAULT FALSE,
  track_serial BOOLEAN NOT NULL DEFAULT FALSE,
  is_sellable BOOLEAN NOT NULL DEFAULT FALSE,      -- can be sold directly through POS (e.g. bottled drinks)
  is_stock_item BOOLEAN NOT NULL DEFAULT TRUE,
  preferred_supplier_id UUID REFERENCES suppliers(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_name ON products(lower(name));

CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'MAIN' CHECK (type IN ('MAIN','FOOD','BEVERAGE','HOUSEKEEPING','ENGINEERING','KITCHEN','LAUNDRY','BAR','OUTLET','OTHER')),
  department_id UUID REFERENCES departments(id),
  outlet_id UUID,
  location TEXT,
  keeper_user_id UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, code)
);

CREATE TABLE stock_balances (
  store_id UUID NOT NULL REFERENCES stores(id),
  product_id UUID NOT NULL REFERENCES products(id),
  quantity NUMERIC(16,4) NOT NULL DEFAULT 0,
  reserved_qty NUMERIC(16,4) NOT NULL DEFAULT 0,
  avg_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  last_movement_at TIMESTAMPTZ,
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE stock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id),
  product_id UUID NOT NULL REFERENCES products(id),
  batch_no TEXT,
  expiry_date DATE,
  serial_number TEXT,
  quantity NUMERIC(16,4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','RESERVED','DAMAGED','EXPIRED','QUARANTINED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_batches ON stock_batches(store_id, product_id, expiry_date);

-- Immutable stock ledger
CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  product_id UUID NOT NULL REFERENCES products(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('OPENING','PURCHASE_RECEIPT','STORE_TRANSFER_OUT','STORE_TRANSFER_IN','ISSUE_TO_DEPARTMENT','RETURN_TO_STORE','STOCK_ADJUSTMENT','SALE','WASTE','DAMAGE','EXPIRY','PRODUCTION','CONSUMPTION','DISPOSAL','PURCHASE_RETURN')),
  quantity NUMERIC(16,4) NOT NULL,          -- signed
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
  balance_after NUMERIC(16,4) NOT NULL,
  batch_id UUID REFERENCES stock_batches(id),
  reference_type TEXT,                      -- GRN, TRANSFER, ISSUE, ADJUSTMENT, ORDER, WASTE, STOCKTAKE, MAINTENANCE
  reference_id UUID,
  reference_number TEXT,
  department_id UUID REFERENCES departments(id),
  outlet_id UUID,
  business_date DATE,
  journal_entry_id UUID REFERENCES journal_entries(id),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_prod ON stock_movements(store_id, product_id, created_at);
CREATE INDEX idx_stock_movements_ref ON stock_movements(reference_type, reference_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(property_id, business_date);
CREATE TRIGGER trg_protect_stock_movements BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION protect_ledger();

-- Department requisitions / issues from store
CREATE TABLE stock_requisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  store_id UUID NOT NULL REFERENCES stores(id),
  department_id UUID REFERENCES departments(id),
  to_store_id UUID REFERENCES stores(id),    -- if issuing into an outlet store
  outlet_id UUID,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('DRAFT','PENDING','APPROVED','PARTIALLY_ISSUED','ISSUED','REJECTED','CANCELLED')),
  purpose TEXT,
  requested_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  issued_by UUID REFERENCES users(id),
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_requisition_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id UUID NOT NULL REFERENCES stock_requisitions(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  requested_qty NUMERIC(14,3) NOT NULL,
  approved_qty NUMERIC(14,3),
  issued_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  from_store_id UUID NOT NULL REFERENCES stores(id),
  to_store_id UUID NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('DRAFT','IN_TRANSIT','COMPLETED','CANCELLED')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  received_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK (from_store_id <> to_store_id)
);

CREATE TABLE stock_transfer_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0
);

CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  store_id UUID NOT NULL REFERENCES stores(id),
  reason TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'STOCK_ADJUSTMENT' CHECK (type IN ('STOCK_ADJUSTMENT','WASTE','DAMAGE','EXPIRY','DISPOSAL','OPENING')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('DRAFT','PENDING','APPROVED','POSTED','REJECTED','CANCELLED')),
  stocktake_id UUID,
  total_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  department_id UUID REFERENCES departments(id),
  outlet_id UUID,
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  journal_entry_id UUID REFERENCES journal_entries(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_adjustment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id UUID NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  previous_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  new_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  variance_qty NUMERIC(14,3) NOT NULL,
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  reason TEXT
);

CREATE TABLE stocktakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  store_id UUID NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COUNTING','REVIEW','APPROVED','POSTED','CANCELLED')),
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  adjustment_id UUID REFERENCES stock_adjustments(id),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stocktake_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id UUID NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  system_qty NUMERIC(14,3) NOT NULL,
  counted_qty NUMERIC(14,3),
  variance_qty NUMERIC(14,3) GENERATED ALWAYS AS (COALESCE(counted_qty,0) - system_qty) STORED,
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  notes TEXT,
  counted_at TIMESTAMPTZ,
  UNIQUE (stocktake_id, product_id)
);

-- Recipes (food, cocktails, housekeeping kits) with versions
CREATE TABLE recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  menu_item_id UUID,          -- linked menu item (set in FNB migration)
  product_id UUID REFERENCES products(id), -- produced product (for production/batch recipes)
  yield_qty NUMERIC(12,3) NOT NULL DEFAULT 1,
  version INT NOT NULL DEFAULT 1,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recipe_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity NUMERIC(14,4) NOT NULL,
  unit_id UUID REFERENCES units(id),
  wastage_percent NUMERIC(6,2) NOT NULL DEFAULT 0
);

ALTER TABLE room_item_types ADD CONSTRAINT room_item_types_product_fk FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE maintenance_parts ADD CONSTRAINT maintenance_parts_product_fk FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE maintenance_parts ADD CONSTRAINT maintenance_parts_movement_fk FOREIGN KEY (stock_movement_id) REFERENCES stock_movements(id);
ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_stocktake_fk FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id);
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
