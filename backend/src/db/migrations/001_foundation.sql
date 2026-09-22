-- =====================================================================
-- 001 FOUNDATION: company, properties, departments, users, RBAC,
-- sessions, settings, numbering, audit, notifications, attachments,
-- approval limits and configurable workflow engine
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  legal_name TEXT,
  tax_number TEXT,
  base_currency CHAR(3) NOT NULL DEFAULT 'KES',
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'HOTEL',
  address TEXT,
  city TEXT,
  country TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  tax_number TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'KES',
  timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  check_in_time TIME NOT NULL DEFAULT '14:00',
  check_out_time TIME NOT NULL DEFAULT '11:00',
  late_checkout_grace_minutes INT NOT NULL DEFAULT 60,
  service_charge_percent NUMERIC(6,3) NOT NULL DEFAULT 0,
  logo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id UUID REFERENCES departments(id),
  manager_user_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  department_id UUID REFERENCES departments(id),
  employee_no TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  position TEXT,
  phone TEXT,
  email TEXT,
  national_id TEXT,
  hire_date DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  external_payroll_ref TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, employee_no)
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  employee_id UUID REFERENCES employees(id),
  department_id UUID REFERENCES departments(id),
  default_property_id UUID REFERENCES properties(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_superuser BOOLEAN NOT NULL DEFAULT FALSE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_secret TEXT,
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE departments ADD CONSTRAINT departments_manager_fk FOREIGN KEY (manager_user_id) REFERENCES users(id);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  description TEXT
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- user-specific overrides: explicit grant or deny
CREATE TABLE user_permissions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE user_properties (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, property_id)
);

-- Outlet / warehouse restrictions (scope_type: OUTLET, STORE, DEPARTMENT)
CREATE TABLE user_scopes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id UUID NOT NULL,
  PRIMARY KEY (user_id, scope_type, scope_id)
);

-- Approval / operational limits by role or user (e.g. discount_percent, refund_amount, expense_approval_amount)
CREATE TABLE authority_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ROLE','USER')),
  subject_id UUID NOT NULL,
  limit_code TEXT NOT NULL,
  limit_value NUMERIC(14,2) NOT NULL,
  UNIQUE (subject_type, subject_id, limit_code)
);

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  device_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE login_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  username_attempted TEXT,
  success BOOLEAN NOT NULL,
  reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_history_user ON login_history(user_id, created_at DESC);

CREATE TABLE password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key/value settings, global (property_id NULL) or per property
CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (property_id, key)
);

-- Configurable document numbering
CREATE TABLE number_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  padding INT NOT NULL DEFAULT 6,
  next_value BIGINT NOT NULL DEFAULT 1,
  reset_yearly BOOLEAN NOT NULL DEFAULT FALSE,
  current_year INT,
  UNIQUE NULLS NOT DISTINCT (property_id, doc_type)
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  property_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at DESC);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id TEXT,
  link TEXT,
  severity TEXT NOT NULL DEFAULT 'INFO',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  description TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);

-- ---------------------------------------------------------------
-- Configurable approval workflow engine
-- ---------------------------------------------------------------
CREATE TABLE workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL, -- PURCHASE_REQUISITION, PURCHASE_ORDER, EXPENSE, STOCK_ADJUSTMENT, REFUND, WASTE, SUPPLIER_PAYMENT, MAINTENANCE_REQUEST ...
  name TEXT NOT NULL,
  min_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(14,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  required_documents TEXT[] NOT NULL DEFAULT '{}',
  escalation_hours INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  name TEXT NOT NULL,
  approver_role_id UUID REFERENCES roles(id),
  approver_user_id UUID REFERENCES users(id),
  required_permission TEXT,
  min_amount NUMERIC(14,2) NOT NULL DEFAULT 0, -- step only applies if amount >= min_amount
  UNIQUE (definition_id, step_order)
);

CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID,
  definition_id UUID REFERENCES workflow_definitions(id),
  transaction_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  entity_number TEXT,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  current_step INT NOT NULL DEFAULT 1,
  total_steps INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by UUID REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (entity_type, entity_id, requested_at)
);
CREATE INDEX idx_approval_requests_status ON approval_requests(status, transaction_type);

CREATE TABLE approval_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  step_name TEXT,
  user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('APPROVE','REJECT','RETURN')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Currencies & exchange rates (historical, never overwritten)
CREATE TABLE currencies (
  code CHAR(3) PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT,
  decimals INT NOT NULL DEFAULT 2,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency CHAR(3) NOT NULL REFERENCES currencies(code),
  to_currency CHAR(3) NOT NULL REFERENCES currencies(code),
  rate NUMERIC(18,8) NOT NULL,
  effective_date DATE NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_currency, to_currency, effective_date)
);

-- Shifts (department schedules) and staff assignments
CREATE TABLE shift_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  department_id UUID REFERENCES departments(id),
  name TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE staff_shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_template_id UUID NOT NULL REFERENCES shift_templates(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  shift_date DATE NOT NULL,
  outlet_id UUID,
  supervisor_user_id UUID REFERENCES users(id),
  attendance_ref TEXT,
  clock_in TIMESTAMPTZ,
  clock_out TIMESTAMPTZ,
  UNIQUE (shift_template_id, employee_id, shift_date)
);

-- Generic updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT; BEGIN
  FOR t IN SELECT unnest(ARRAY['companies','properties','departments','employees','users','roles']) LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
