-- =====================================================================
-- 008 EVENTS & BANQUETS, VENUES, HOTEL SERVICES (spa, transfers ...),
-- import jobs, backups registry
-- =====================================================================

CREATE TABLE venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CONFERENCE' CHECK (type IN ('CONFERENCE','BALLROOM','MEETING_ROOM','GARDEN','BOARDROOM','POOLSIDE','RESTAURANT','OTHER')),
  capacity_theatre INT, capacity_banquet INT, capacity_classroom INT, capacity_cocktail INT,
  hourly_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  half_day_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  full_day_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  amenities TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, code)
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CONFERENCE', -- CONFERENCE, WEDDING, MEETING, PARTY, CORPORATE, PRIVATE_DINNER, FUNCTION
  customer_id UUID REFERENCES customers(id),
  guest_id UUID REFERENCES guests(id),
  contact_name TEXT, contact_phone TEXT, contact_email TEXT,
  venue_id UUID REFERENCES venues(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  expected_guests INT NOT NULL DEFAULT 0,
  setup_style TEXT,
  status TEXT NOT NULL DEFAULT 'INQUIRY' CHECK (status IN ('INQUIRY','TENTATIVE','QUOTED','CONFIRMED','IN_PROGRESS','COMPLETED','INVOICED','CANCELLED')),
  quotation_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_required NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  folio_id UUID REFERENCES folios(id),
  invoice_id UUID REFERENCES invoices(id),
  contract_attachment_id UUID REFERENCES attachments(id),
  menu_notes TEXT, equipment_notes TEXT, staff_notes TEXT, notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX idx_events_venue ON events(venue_id, start_at, end_at);
ALTER TABLE folios ADD CONSTRAINT folios_event_fk FOREIGN KEY (event_id) REFERENCES events(id);
ALTER TABLE invoices ADD CONSTRAINT invoices_event_fk FOREIGN KEY (event_id) REFERENCES events(id);
ALTER TABLE orders ADD CONSTRAINT orders_event_fk FOREIGN KEY (event_id) REFERENCES events(id);

CREATE TABLE event_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL DEFAULT 'VENUE' CHECK (item_type IN ('VENUE','MENU','BEVERAGE','EQUIPMENT','STAFF','ACCOMMODATION','SERVICE','OTHER')),
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  menu_item_id UUID REFERENCES menu_items(id),
  posted_folio_item_id UUID REFERENCES folio_items(id)
);

CREATE TABLE event_status_history (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  notes TEXT,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Configurable hotel services (spa, gym, transfers, tours, car hire ...)
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'SPA', -- SPA, GYM, POOL, GOLF, TRANSPORT, TOUR, ACTIVITY, CAR_RENTAL, OTHER
  description TEXT,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  duration_minutes INT,
  tax_id UUID REFERENCES taxes(id),
  revenue_account_id UUID REFERENCES accounts(id),
  folio_category TEXT NOT NULL DEFAULT 'SPA',
  requires_staff BOOLEAN NOT NULL DEFAULT FALSE,
  capacity INT NOT NULL DEFAULT 1,
  outlet_id UUID REFERENCES outlets(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, code)
);

CREATE TABLE service_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'ROOM',  -- ROOM, THERAPIST, VEHICLE, EQUIPMENT
  employee_id UUID REFERENCES employees(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE service_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  service_id UUID NOT NULL REFERENCES services(id),
  guest_id UUID REFERENCES guests(id),
  stay_id UUID REFERENCES stays(id),
  customer_name TEXT,
  resource_id UUID REFERENCES service_resources(id),
  staff_employee_id UUID REFERENCES employees(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  quantity INT NOT NULL DEFAULT 1,
  price NUMERIC(12,2) NOT NULL,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','CONFIRMED','IN_PROGRESS','COMPLETED','NO_SHOW','CANCELLED')),
  settlement TEXT,                    -- ROOM_CHARGE, PAID
  folio_item_id UUID REFERENCES folio_items(id),
  payment_id UUID REFERENCES payments(id),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_bookings ON service_bookings(property_id, start_at);

CREATE TABLE import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID,
  entity TEXT NOT NULL,
  file_name TEXT,
  total_rows INT NOT NULL DEFAULT 0,
  valid_rows INT NOT NULL DEFAULT 0,
  imported_rows INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'VALIDATED' CHECK (status IN ('VALIDATED','IMPORTED','FAILED')),
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  size_bytes BIGINT,
  type TEXT NOT NULL DEFAULT 'MANUAL',
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_events_updated BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
