-- 010: stock_movements stay immutable, except linking a journal entry after posting (NULL -> value, nothing else may change)
CREATE OR REPLACE FUNCTION protect_stock_movements() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Ledger rows are immutable'; END IF;
  IF OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL
     AND row(NEW.id, NEW.property_id, NEW.store_id, NEW.product_id, NEW.movement_type, NEW.quantity, NEW.unit_cost, NEW.total_cost, NEW.balance_after, NEW.batch_id, NEW.reference_type, NEW.reference_id, NEW.reference_number, NEW.department_id, NEW.outlet_id, NEW.business_date, NEW.notes, NEW.created_by, NEW.created_at)
       IS NOT DISTINCT FROM row(OLD.id, OLD.property_id, OLD.store_id, OLD.product_id, OLD.movement_type, OLD.quantity, OLD.unit_cost, OLD.total_cost, OLD.balance_after, OLD.batch_id, OLD.reference_type, OLD.reference_id, OLD.reference_number, OLD.department_id, OLD.outlet_id, OLD.business_date, OLD.notes, OLD.created_by, OLD.created_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Ledger rows are immutable';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_stock_movements ON stock_movements;
CREATE TRIGGER trg_protect_stock_movements BEFORE DELETE OR UPDATE ON stock_movements FOR EACH ROW EXECUTE FUNCTION protect_stock_movements();
