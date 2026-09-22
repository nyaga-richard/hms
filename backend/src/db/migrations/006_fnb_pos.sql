-- =====================================================================
-- 006 F&B: outlets (restaurants/bars/clubs/room service), sections,
-- tables, kitchens, menus, POS orders, kitchen tickets, cashier shifts,
-- club events & tickets
-- =====================================================================

CREATE TABLE outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RESTAURANT','BAR','CLUB','ROOM_SERVICE','COFFEE_SHOP','BANQUET','SPA','OTHER')),
  department_id UUID REFERENCES departments(id),
  store_id UUID REFERENCES stores(id),          -- stock is consumed from this store
  default_kitchen_id UUID,
  revenue_account_id UUID REFERENCES accounts(id),
  cogs_account_id UUID REFERENCES accounts(id),
  service_charge_percent NUMERIC(6,3),          -- null = property default
  tax_id UUID REFERENCES taxes(id),
  allows_room_charge BOOLEAN NOT NULL DEFAULT TRUE,
  allows_takeaway BOOLEAN NOT NULL DEFAULT TRUE,
  allows_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  opening_time TIME, closing_time TIME,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

CREATE TABLE kitchens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  store_id UUID REFERENCES stores(id),
  printer_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, code)
);
ALTER TABLE outlets ADD CONSTRAINT outlets_kitchen_fk FOREIGN KEY (default_kitchen_id) REFERENCES kitchens(id);

CREATE TABLE outlet_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE outlet_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  section_id UUID REFERENCES outlet_sections(id),
  number TEXT NOT NULL,
  capacity INT NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','OCCUPIED','RESERVED','CLEANING','BLOCKED')),
  pos_x INT NOT NULL DEFAULT 0, pos_y INT NOT NULL DEFAULT 0,
  shape TEXT NOT NULL DEFAULT 'SQUARE',
  min_spend NUMERIC(12,2) NOT NULL DEFAULT 0,   -- VIP tables / bottle service
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (outlet_id, number)
);

CREATE TABLE menus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  outlet_ids UUID[] NOT NULL DEFAULT '{}',
  available_from TIME, available_to TIME,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'FOOD' CHECK (type IN ('FOOD','BEVERAGE','ALCOHOL','TOBACCO','SERVICE','TICKET','OTHER')),
  kitchen_id UUID REFERENCES kitchens(id),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL,
  cost_estimate NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  kitchen_id UUID REFERENCES kitchens(id),       -- route override
  product_id UUID REFERENCES products(id),        -- direct stock deduction (e.g. bottle of water) when no recipe
  product_qty NUMERIC(12,4) NOT NULL DEFAULT 1,
  is_service_charge_applicable BOOLEAN NOT NULL DEFAULT TRUE,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  image_url TEXT,
  preparation_minutes INT,
  barcode TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_menu_items_cat ON menu_items(category_id);
ALTER TABLE recipes ADD CONSTRAINT recipes_menu_item_fk FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE;

CREATE TABLE menu_item_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL DEFAULT 'Options',
  name TEXT NOT NULL,
  price_delta NUMERIC(12,2) NOT NULL DEFAULT 0,
  product_id UUID REFERENCES products(id),
  product_qty NUMERIC(12,4) NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  max_select INT NOT NULL DEFAULT 1
);

CREATE TABLE pos_terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  outlet_id UUID REFERENCES outlets(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  receipt_printer TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, code)
);

CREATE TABLE cashier_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  outlet_id UUID REFERENCES outlets(id),        -- null = front desk cashier
  terminal_id UUID REFERENCES pos_terminals(id),
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','PENDING_APPROVAL')),
  business_date DATE,
  opening_float NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_cash NUMERIC(12,2),
  actual_cash NUMERIC(12,2),
  variance NUMERIC(12,2),
  variance_reason TEXT,
  variance_approved_by UUID REFERENCES users(id),
  totals_by_method JSONB,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id),
  notes TEXT
);
CREATE INDEX idx_cashier_shifts_user ON cashier_shifts(user_id, status);
ALTER TABLE payments ADD CONSTRAINT payments_shift_fk FOREIGN KEY (cashier_shift_id) REFERENCES cashier_shifts(id);
ALTER TABLE payments ADD CONSTRAINT payments_outlet_fk FOREIGN KEY (outlet_id) REFERENCES outlets(id);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  outlet_id UUID NOT NULL REFERENCES outlets(id),
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'DINE_IN' CHECK (type IN ('DINE_IN','TAKEAWAY','ROOM_SERVICE','DELIVERY','COUNTER','EVENT')),
  table_id UUID REFERENCES outlet_tables(id),
  covers INT NOT NULL DEFAULT 1,
  waiter_id UUID REFERENCES users(id),
  cashier_shift_id UUID REFERENCES cashier_shifts(id),
  stay_id UUID REFERENCES stays(id),            -- room charge target
  guest_id UUID REFERENCES guests(id),
  customer_id UUID REFERENCES customers(id),    -- corporate account
  event_id UUID,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','BILLED','CLOSED','CANCELLED','REFUNDED')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_reason TEXT,
  discount_approved_by UUID REFERENCES users(id),
  service_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  settlement_type TEXT,                          -- CASH, CARD, ROOM_CHARGE, CORPORATE, MIXED, COMPLIMENTARY
  folio_item_id UUID REFERENCES folio_items(id),
  cogs_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  journal_entry_id UUID REFERENCES journal_entries(id),
  business_date DATE,
  notes TEXT,
  delivery_address TEXT,
  cancelled_reason TEXT,
  idempotency_key TEXT UNIQUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  billed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id)
);
CREATE INDEX idx_orders_outlet_status ON orders(outlet_id, status);
CREATE INDEX idx_orders_date ON orders(property_id, business_date);
CREATE INDEX idx_orders_stay ON orders(stay_id);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL,
  modifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  modifiers_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,2) NOT NULL,             -- gross incl tax (for inclusive) after discount
  is_complimentary BOOLEAN NOT NULL DEFAULT FALSE,
  special_instructions TEXT,
  kitchen_id UUID REFERENCES kitchens(id),
  kitchen_status TEXT NOT NULL DEFAULT 'NEW' CHECK (kitchen_status IN ('NEW','SENT','ACCEPTED','PREPARING','READY','SERVED','CANCELLED')),
  sent_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ, ready_at TIMESTAMPTZ, served_at TIMESTAMPTZ,
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason TEXT,
  voided_by UUID REFERENCES users(id),
  seat_no INT,
  course INT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_kitchen ON order_items(kitchen_id, kitchen_status);

CREATE TABLE kitchen_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kitchen_id UUID NOT NULL REFERENCES kitchens(id),
  ticket_no INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACCEPTED','PREPARING','READY','SERVED','CANCELLED')),
  item_ids UUID[] NOT NULL DEFAULT '{}',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ, ready_at TIMESTAMPTZ, served_at TIMESTAMPTZ,
  notes TEXT
);
CREATE INDEX idx_kitchen_tickets ON kitchen_tickets(kitchen_id, status, sent_at);

CREATE TABLE order_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  payment_id UUID REFERENCES payments(id),
  method TEXT NOT NULL,                          -- CASH/CARD/... or ROOM_CHARGE/CORPORATE/COMPLIMENTARY
  amount NUMERIC(14,2) NOT NULL,
  tip NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Club events, tickets, guest lists
CREATE TABLE club_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID NOT NULL REFERENCES outlets(id),
  name TEXT NOT NULL,
  event_date DATE NOT NULL,
  start_time TIME, end_time TIME,
  description TEXT,
  capacity INT,
  cover_charge NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','LIVE','CLOSED','CANCELLED')),
  promotions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE club_ticket_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES club_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,           -- Regular, VIP, Table for 6, Bottle service package
  price NUMERIC(12,2) NOT NULL,
  quantity_available INT,
  quantity_sold INT NOT NULL DEFAULT 0,
  includes TEXT
);

CREATE TABLE club_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES club_events(id),
  ticket_type_id UUID NOT NULL REFERENCES club_ticket_types(id),
  number TEXT NOT NULL UNIQUE,
  qr_code TEXT NOT NULL UNIQUE,
  holder_name TEXT,
  holder_phone TEXT,
  guest_id UUID REFERENCES guests(id),
  quantity INT NOT NULL DEFAULT 1,
  amount NUMERIC(12,2) NOT NULL,
  payment_id UUID REFERENCES payments(id),
  order_id UUID REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'SOLD' CHECK (status IN ('SOLD','CHECKED_IN','CANCELLED','REFUNDED')),
  checked_in_at TIMESTAMPTZ,
  sold_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE club_guest_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES club_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  plus_ones INT NOT NULL DEFAULT 0,
  table_id UUID REFERENCES outlet_tables(id),
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  arrived_at TIMESTAMPTZ,
  notes TEXT
);

ALTER TABLE stores ADD CONSTRAINT stores_outlet_fk FOREIGN KEY (outlet_id) REFERENCES outlets(id);
ALTER TABLE stock_requisitions ADD CONSTRAINT stock_req_outlet_fk FOREIGN KEY (outlet_id) REFERENCES outlets(id);
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_outlet_fk FOREIGN KEY (outlet_id) REFERENCES outlets(id);
ALTER TABLE folio_items ADD CONSTRAINT folio_items_outlet_fk FOREIGN KEY (outlet_id) REFERENCES outlets(id);
