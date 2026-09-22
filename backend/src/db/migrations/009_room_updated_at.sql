-- 009: rooms.updated_at (used by housekeeping/maintenance status updates) + helpful indexes
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_due ON supplier_invoices (supplier_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (property_id, status);
