-- =====================================================================
-- 003 PMS: guests, room types, rooms, amenities, rate plans, packages,
-- reservations, stays, folios, invoices, room blocks
-- =====================================================================

CREATE TABLE guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_no TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'INDIVIDUAL' CHECK (type IN ('INDIVIDUAL','CORPORATE','TRAVEL_AGENT','GROUP','GOVERNMENT')),
  title TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  gender TEXT,
  date_of_birth DATE,
  nationality TEXT,
  id_type TEXT,           -- PASSPORT, NATIONAL_ID, DRIVING_LICENCE
  id_number TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  company_name TEXT,
  customer_id UUID REFERENCES customers(id),   -- linked corporate / agent account
  vip_level INT NOT NULL DEFAULT 0,
  loyalty_number TEXT,
  loyalty_points INT NOT NULL DEFAULT 0,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_guests_name ON guests(lower(last_name), lower(first_name));
CREATE INDEX idx_guests_phone ON guests(phone);
CREATE INDEX idx_guests_email ON guests(lower(email));

CREATE TABLE guest_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  doc_number TEXT,
  issuing_country TEXT,
  expiry_date DATE,
  attachment_id UUID REFERENCES attachments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  max_adults INT NOT NULL DEFAULT 2,
  max_children INT NOT NULL DEFAULT 1,
  max_occupancy INT NOT NULL DEFAULT 3,
  bed_configuration TEXT,
  base_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  extra_adult_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  extra_child_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  amenities TEXT[] NOT NULL DEFAULT '{}',
  images TEXT[] NOT NULL DEFAULT '{}',
  size_sqm NUMERIC(8,2),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  room_type_id UUID NOT NULL REFERENCES room_types(id),
  number TEXT NOT NULL,
  floor TEXT,
  building TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','OUT_OF_ORDER','OUT_OF_SERVICE','BLOCKED')),
  housekeeping_status TEXT NOT NULL DEFAULT 'CLEAN' CHECK (housekeeping_status IN ('DIRTY','CLEANING','CLEAN','INSPECTED','OUT_OF_ORDER')),
  maintenance_status TEXT NOT NULL DEFAULT 'OK' CHECK (maintenance_status IN ('OK','ISSUE_REPORTED','UNDER_MAINTENANCE')),
  rate_override NUMERIC(12,2),
  amenities TEXT[] NOT NULL DEFAULT '{}',
  features TEXT[] NOT NULL DEFAULT '{}',
  phone_extension TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, number)
);
CREATE INDEX idx_rooms_status ON rooms(property_id, status, housekeeping_status);

CREATE TABLE room_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id),
  block_type TEXT NOT NULL CHECK (block_type IN ('OUT_OF_ORDER','OUT_OF_SERVICE','BLOCKED')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  maintenance_request_id UUID,
  created_by UUID REFERENCES users(id),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

-- Rate plans (standard, corporate, agent, promo, package) with date-banded prices per room type
CREATE TABLE rate_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (type IN ('STANDARD','SEASONAL','WEEKEND','HOLIDAY','CORPORATE','AGENT','GROUP','PROMOTIONAL','PACKAGE')),
  meal_plan TEXT NOT NULL DEFAULT 'ROOM_ONLY' CHECK (meal_plan IN ('ROOM_ONLY','BED_BREAKFAST','HALF_BOARD','FULL_BOARD','ALL_INCLUSIVE')),
  pricing_basis TEXT NOT NULL DEFAULT 'PER_ROOM' CHECK (pricing_basis IN ('PER_ROOM','PER_PERSON')),
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  customer_id UUID REFERENCES customers(id),      -- negotiated rate for a company/agent
  min_nights INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

CREATE TABLE rate_plan_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_plan_id UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  room_type_id UUID NOT NULL REFERENCES room_types(id),
  date_from DATE,
  date_to DATE,
  days_of_week INT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',  -- 0=Sunday
  price NUMERIC(12,2) NOT NULL,
  extra_adult NUMERIC(12,2) NOT NULL DEFAULT 0,
  extra_child NUMERIC(12,2) NOT NULL DEFAULT 0,
  priority INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_rate_plan_prices ON rate_plan_prices(rate_plan_id, room_type_id);

-- Package components (e.g. Romantic Weekend: dinner, spa, transfer) posted automatically
CREATE TABLE rate_plan_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_plan_id UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  charge_category TEXT NOT NULL, -- RESTAURANT, SPA, TRANSPORT, OTHER ...
  amount NUMERIC(12,2) NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'PER_STAY' CHECK (frequency IN ('PER_STAY','PER_NIGHT','PER_PERSON','PER_PERSON_PER_NIGHT')),
  revenue_account_id UUID REFERENCES accounts(id),
  tax_id UUID REFERENCES taxes(id)
);

CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  group_id UUID,                        -- group/master reservation link
  guest_id UUID NOT NULL REFERENCES guests(id),
  customer_id UUID REFERENCES customers(id),  -- bill-to company / agent
  room_type_id UUID NOT NULL REFERENCES room_types(id),
  room_id UUID REFERENCES rooms(id),
  rate_plan_id UUID REFERENCES rate_plans(id),
  arrival_date DATE NOT NULL,
  departure_date DATE NOT NULL,
  adults INT NOT NULL DEFAULT 1,
  children INT NOT NULL DEFAULT 0,
  rate NUMERIC(12,2) NOT NULL DEFAULT 0,         -- nightly rate agreed
  meal_plan TEXT NOT NULL DEFAULT 'ROOM_ONLY',
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  source TEXT NOT NULL DEFAULT 'FRONT_DESK',      -- FRONT_DESK, PHONE, WALK_IN, WEBSITE, AGENT, CORPORATE, OTA, GROUP
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('INQUIRY','TENTATIVE','CONFIRMED','DEPOSIT_PAID','CHECKED_IN','NO_SHOW','CANCELLED','CHECKED_OUT')),
  deposit_required NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  special_requests TEXT,
  notes TEXT,
  cancellation_policy TEXT,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  eta TIME,
  is_overbooking BOOLEAN NOT NULL DEFAULT FALSE,
  external_ref TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (departure_date > arrival_date)
);
CREATE INDEX idx_reservations_dates ON reservations(property_id, arrival_date, departure_date);
CREATE INDEX idx_reservations_room ON reservations(room_id, arrival_date, departure_date) WHERE status IN ('CONFIRMED','DEPOSIT_PAID','CHECKED_IN','TENTATIVE');
CREATE INDEX idx_reservations_guest ON reservations(guest_id);
CREATE INDEX idx_reservations_status ON reservations(property_id, status);

CREATE TABLE reservation_guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES guests(id),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (reservation_id, guest_id)
);

-- Reservation change history (audit of modifications, moves, extensions)
CREATE TABLE reservation_history (
  id BIGSERIAL PRIMARY KEY,
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details JSONB,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  reservation_id UUID NOT NULL REFERENCES reservations(id),
  guest_id UUID NOT NULL REFERENCES guests(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  check_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_check_out DATE NOT NULL,
  check_out_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'IN_HOUSE' CHECK (status IN ('IN_HOUSE','CHECKED_OUT')),
  adults INT NOT NULL DEFAULT 1,
  children INT NOT NULL DEFAULT 0,
  rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  meal_plan TEXT NOT NULL DEFAULT 'ROOM_ONLY',
  checked_in_by UUID REFERENCES users(id),
  checked_out_by UUID REFERENCES users(id),
  signature_attachment_id UUID REFERENCES attachments(id),
  registration_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_room_charge_date DATE,          -- night audit tracking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stays_room ON stays(room_id, status);
CREATE INDEX idx_stays_status ON stays(property_id, status);

-- Room moves inside a stay
CREATE TABLE stay_room_history (
  id BIGSERIAL PRIMARY KEY,
  stay_id UUID NOT NULL REFERENCES stays(id) ON DELETE CASCADE,
  from_room_id UUID REFERENCES rooms(id),
  to_room_id UUID NOT NULL REFERENCES rooms(id),
  reason TEXT,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE folios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'GUEST' CHECK (type IN ('GUEST','MASTER','COMPANY','EVENT','POS')),
  stay_id UUID REFERENCES stays(id),
  reservation_id UUID REFERENCES reservations(id),
  guest_id UUID REFERENCES guests(id),
  customer_id UUID REFERENCES customers(id),
  event_id UUID,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','SETTLED')),
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_folios_stay ON folios(stay_id);
CREATE INDEX idx_folios_guest ON folios(guest_id);

-- Folio ledger: immutable. Corrections are reversals (reversed_by_id) not edits.
CREATE TABLE folio_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_id UUID NOT NULL REFERENCES folios(id),
  line_no INT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('CHARGE','PAYMENT','DEPOSIT','REFUND','DISCOUNT','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT')),
  category TEXT NOT NULL, -- ROOM, RESTAURANT, BAR, CLUB, MINIBAR, LAUNDRY, TELEPHONE, TRANSPORT, SPA, ACTIVITY, ROOM_SERVICE, CONFERENCE, DAMAGE, OTHER, TAX, SERVICE_CHARGE, PAYMENT
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  service_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL,        -- signed: charges positive, payments/credits negative
  tax_id UUID REFERENCES taxes(id),
  outlet_id UUID,
  source_type TEXT,                     -- ORDER, ROOM_CHARGE, LAUNDRY, SERVICE_BOOKING, PAYMENT, ROOM_ITEM_EVENT, PACKAGE, MANUAL
  source_id UUID,
  payment_id UUID REFERENCES payments(id),
  business_date DATE,
  reversed_by_id UUID REFERENCES folio_items(id),
  reverses_id UUID REFERENCES folio_items(id),
  is_reversed BOOLEAN NOT NULL DEFAULT FALSE,
  journal_entry_id UUID REFERENCES journal_entries(id),
  posted_by UUID REFERENCES users(id),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT
);
CREATE INDEX idx_folio_items_folio ON folio_items(folio_id, line_no);
CREATE INDEX idx_folio_items_date ON folio_items(business_date, category);

CREATE OR REPLACE FUNCTION protect_folio_items() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Folio items cannot be deleted; post a reversal'; END IF;
  IF NEW.amount <> OLD.amount OR NEW.quantity <> OLD.quantity OR NEW.unit_price <> OLD.unit_price OR NEW.folio_id <> OLD.folio_id THEN
    RAISE EXCEPTION 'Folio items are immutable; post a reversal';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_protect_folio_items BEFORE UPDATE OR DELETE ON folio_items FOR EACH ROW EXECUTE FUNCTION protect_folio_items();

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  folio_id UUID REFERENCES folios(id),
  guest_id UUID REFERENCES guests(id),
  customer_id UUID REFERENCES customers(id),
  event_id UUID,
  invoice_date DATE NOT NULL,
  due_date DATE,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  service_charge_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','CANCELLED','CREDITED')),
  type TEXT NOT NULL DEFAULT 'GUEST' CHECK (type IN ('GUEST','CITY_LEDGER','EVENT','CREDIT_NOTE','DEBIT_NOTE')),
  related_invoice_id UUID REFERENCES invoices(id),
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  tax_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  fiscal_reference TEXT,      -- eTIMS / fiscal device reference
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, status);

CREATE TABLE invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  payment_id UUID NOT NULL REFERENCES payments(id),
  amount NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_guests_updated BEFORE UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_reservations_updated BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
