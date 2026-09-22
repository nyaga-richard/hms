-- =====================================================================
-- 004 HOUSEKEEPING, ROOM ITEMS, LAUNDRY, MAINTENANCE, ASSETS
-- =====================================================================

CREATE TABLE housekeeping_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  stay_id UUID REFERENCES stays(id),
  task_type TEXT NOT NULL DEFAULT 'CHECKOUT_CLEAN' CHECK (task_type IN ('CHECKOUT_CLEAN','STAYOVER','TURNDOWN','DEEP_CLEAN','INSPECTION','TOUCH_UP','LINEN_CHANGE','MINIBAR_CHECK')),
  priority INT NOT NULL DEFAULT 3,       -- 1 highest
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','DONE','INSPECTED','FAILED_INSPECTION','CANCELLED')),
  assigned_to UUID REFERENCES users(id),
  business_date DATE NOT NULL DEFAULT CURRENT_DATE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  inspected_at TIMESTAMPTZ,
  inspected_by UUID REFERENCES users(id),
  notes TEXT,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  minutes_taken INT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hk_tasks ON housekeeping_tasks(property_id, business_date, status);
CREATE INDEX idx_hk_tasks_assignee ON housekeeping_tasks(assigned_to, status);

CREATE TABLE housekeeping_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES housekeeping_tasks(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  inspector_id UUID NOT NULL REFERENCES users(id),
  passed BOOLEAN NOT NULL,
  score INT,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Item catalogue for in-room items (TV, kettle, towels ...)
CREATE TABLE room_item_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'AMENITY', -- APPLIANCE, FURNITURE, LINEN, AMENITY, MINIBAR, GLASSWARE, TOILETRY
  is_serialized BOOLEAN NOT NULL DEFAULT FALSE,
  is_consumable BOOLEAN NOT NULL DEFAULT FALSE,
  product_id UUID,                          -- link to inventory product for consumables/minibar
  replacement_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  standard_quantity INT NOT NULL DEFAULT 1, -- expected per room
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, name)
);

CREATE TABLE room_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  item_type_id UUID NOT NULL REFERENCES room_item_types(id),
  room_id UUID REFERENCES rooms(id),
  asset_id UUID,
  serial_number TEXT,
  asset_number TEXT,
  quantity INT NOT NULL DEFAULT 1,
  condition TEXT NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('NEW','GOOD','FAIR','POOR','DAMAGED')),
  status TEXT NOT NULL DEFAULT 'ASSIGNED_TO_ROOM' CHECK (status IN ('PURCHASED','IN_STORE','ASSIGNED_TO_ROOM','REMOVED_FROM_ROOM','DAMAGED','LOST','DISPOSED')),
  purchase_date DATE,
  cost NUMERIC(12,2),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_items_room ON room_items(room_id);

CREATE TABLE room_item_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_item_id UUID REFERENCES room_items(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  stay_id UUID REFERENCES stays(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('MISSING','BROKEN','DAMAGED','REPLACED','GUEST_DAMAGE','CONSUMED','RETURNED')),
  quantity INT NOT NULL DEFAULT 1,
  charge_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  charged_folio_item_id UUID REFERENCES folio_items(id),
  notes TEXT,
  reported_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Laundry
CREATE TABLE laundry_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'GUEST' CHECK (type IN ('GUEST','HOTEL_LINEN','UNIFORM')),
  stay_id UUID REFERENCES stays(id),
  guest_id UUID REFERENCES guests(id),
  room_id UUID REFERENCES rooms(id),
  department_id UUID REFERENCES departments(id),
  status TEXT NOT NULL DEFAULT 'COLLECTED' CHECK (status IN ('COLLECTED','SORTING','WASHING','DRYING','IRONING','QUALITY_CHECK','READY','DELIVERED','RETURNED_TO_STORE','CANCELLED')),
  express BOOLEAN NOT NULL DEFAULT FALSE,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  folio_item_id UUID REFERENCES folio_items(id),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE laundry_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'GARMENT',
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  express_multiplier NUMERIC(6,2) NOT NULL DEFAULT 1.5,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE laundry_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES laundry_orders(id) ON DELETE CASCADE,
  service_id UUID REFERENCES laundry_services(id),
  description TEXT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE laundry_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES laundry_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Assets
CREATE TABLE asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  depreciation_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
  account_id UUID REFERENCES accounts(id)
);

CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  asset_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id UUID REFERENCES asset_categories(id),
  serial_number TEXT,
  model TEXT,
  location TEXT,
  room_id UUID REFERENCES rooms(id),
  department_id UUID REFERENCES departments(id),
  supplier_id UUID REFERENCES suppliers(id),
  purchase_date DATE,
  cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  warranty_expiry DATE,
  status TEXT NOT NULL DEFAULT 'IN_USE' CHECK (status IN ('IN_USE','IN_STORE','UNDER_MAINTENANCE','DAMAGED','DISPOSED','LOST')),
  responsible_user_id UUID REFERENCES users(id),
  barcode TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE asset_movements (
  id BIGSERIAL PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_location TEXT, to_location TEXT,
  from_department_id UUID, to_department_id UUID,
  from_room_id UUID, to_room_id UUID,
  status_after TEXT,
  reason TEXT,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Maintenance
CREATE TABLE maintenance_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'GENERAL', -- PLUMBING, ELECTRICAL, HVAC, CARPENTRY, IT, KITCHEN_EQUIPMENT, POOL, ELEVATOR, GENERATOR, VEHICLE, FURNITURE, GENERAL
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  location_type TEXT NOT NULL DEFAULT 'ROOM' CHECK (location_type IN ('ROOM','ASSET','AREA','OUTLET','VEHICLE','OTHER')),
  room_id UUID REFERENCES rooms(id),
  asset_id UUID REFERENCES assets(id),
  location TEXT,
  status TEXT NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','APPROVED','ASSIGNED','IN_PROGRESS','ON_HOLD','COMPLETED','VERIFIED','REJECTED','CANCELLED')),
  reported_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  assigned_to UUID REFERENCES users(id),
  contractor_name TEXT,
  contractor_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  labour_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
  labour_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  parts_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cost NUMERIC(12,2) GENERATED ALWAYS AS (contractor_cost + labour_cost + parts_cost) STORED,
  blocks_room BOOLEAN NOT NULL DEFAULT FALSE,
  downtime_start TIMESTAMPTZ,
  downtime_end TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES users(id),
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_maintenance_status ON maintenance_requests(property_id, status, priority);

CREATE TABLE maintenance_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  product_id UUID,
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_movement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_history (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  notes TEXT,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_maint_fk FOREIGN KEY (maintenance_request_id) REFERENCES maintenance_requests(id);
ALTER TABLE room_items ADD CONSTRAINT room_items_asset_fk FOREIGN KEY (asset_id) REFERENCES assets(id);
CREATE TRIGGER trg_assets_updated BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_maint_updated BEFORE UPDATE ON maintenance_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_room_items_updated BEFORE UPDATE ON room_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
