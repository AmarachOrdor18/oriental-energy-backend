-- Oriental Energy TMS — PRD v4.0 Schema
-- All IDs follow PRD pattern: PREFIX-XXXXXX

-- Create sequences for IDs
CREATE SEQUENCE IF NOT EXISTS dept_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS user_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS project_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS timesheet_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS entry_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS holiday_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS period_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS daily_log_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS notification_id_seq START 1;

-- Helper to pad IDs to 6 digits
CREATE OR REPLACE FUNCTION pad_id(prefix TEXT, seq_val BIGINT) RETURNS TEXT AS $$
BEGIN
  RETURN prefix || LPAD(seq_val::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- departments table (updated v4.0)
CREATE TABLE IF NOT EXISTS departments (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('DEPT-', nextval('dept_id_seq')),
    name VARCHAR UNIQUE NOT NULL,
    code VARCHAR(10) UNIQUE,
    hod_id VARCHAR,  -- FK added after users table
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- users table (updated v4.0)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('USR-', nextval('user_id_seq')),
    email VARCHAR UNIQUE NOT NULL,
    password_hash VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    role VARCHAR NOT NULL CHECK (role IN ('user', 'line_manager', 'hod', 'admin', 'finance')),
    manager_id VARCHAR REFERENCES users(id),
    department_id VARCHAR REFERENCES departments(id),
    is_active BOOLEAN DEFAULT true,
    can_create_projects BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add hod_id foreign key to departments
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_dept_hod') THEN
    ALTER TABLE departments ADD CONSTRAINT fk_dept_hod FOREIGN KEY (hod_id) REFERENCES users(id);
  END IF;
END $$;

-- projects table (updated v4.0)
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('PRJ-', nextval('project_id_seq')),
    name VARCHAR NOT NULL,
    code VARCHAR UNIQUE NOT NULL,
    department_id VARCHAR REFERENCES departments(id),
    created_by VARCHAR REFERENCES users(id),
    max_hours_per_week DECIMAL DEFAULT 40,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- timesheets table
CREATE TABLE IF NOT EXISTS timesheets (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('TS-', nextval('timesheet_id_seq')),
    user_id VARCHAR REFERENCES users(id) NOT NULL,
    week_start_date DATE NOT NULL,
    week_end_date DATE NOT NULL,
    accounting_period VARCHAR NOT NULL,
    status VARCHAR NOT NULL CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'overdue')),
    submitted_at TIMESTAMP,
    approved_by VARCHAR REFERENCES users(id),
    approved_at TIMESTAMP,
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- timesheet_entries table
CREATE TABLE IF NOT EXISTS timesheet_entries (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('TSE-', nextval('entry_id_seq')),
    timesheet_id VARCHAR REFERENCES timesheets(id) NOT NULL,
    project_id VARCHAR REFERENCES projects(id),
    date DATE NOT NULL,
    hours DECIMAL(4,2),
    entry_type VARCHAR NOT NULL CHECK (entry_type IN ('work', 'annual_leave', 'sick_leave', 'public_holiday')),
    is_leave_blocked BOOLEAN DEFAULT false,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- daily_logs table (NEW v4.0)
CREATE TABLE IF NOT EXISTS daily_logs (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('DL-', nextval('daily_log_id_seq')),
    user_id VARCHAR REFERENCES users(id) NOT NULL,
    week_start_date DATE NOT NULL,
    project_id VARCHAR REFERENCES projects(id) NOT NULL,
    date DATE NOT NULL,
    hours DECIMAL(4,2) DEFAULT 0,
    notes TEXT,
    is_filled BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, project_id, date)
);

-- public_holidays table
CREATE TABLE IF NOT EXISTS public_holidays (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('PH-', nextval('holiday_id_seq')),
    name VARCHAR NOT NULL,
    date DATE NOT NULL,
    year INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- accounting_periods table
CREATE TABLE IF NOT EXISTS accounting_periods (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('AP-', nextval('period_id_seq')),
    period_code VARCHAR UNIQUE NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- notifications table (NEW v4.0)
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR PRIMARY KEY DEFAULT pad_id('NTF-', nextval('notification_id_seq')),
    user_id VARCHAR REFERENCES users(id) NOT NULL,
    type VARCHAR NOT NULL CHECK (type IN ('approval', 'reminder', 'overdue', 'system', 'broadcast')),
    title VARCHAR NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT false,
    link VARCHAR,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_logs_week ON daily_logs(user_id, week_start_date);
CREATE INDEX IF NOT EXISTS idx_timesheets_user ON timesheets(user_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_status ON timesheets(status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- ============================================================
-- v5.0 additions
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS finance_decision_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS audit_log_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS export_run_id_seq START 1;

-- finance_decisions: persists Finance review decisions
CREATE TABLE IF NOT EXISTS finance_decisions (
  id              VARCHAR PRIMARY KEY DEFAULT pad_id('FD-', nextval('finance_decision_id_seq')),
  timesheet_id    VARCHAR NOT NULL REFERENCES timesheets(id),
  user_id         VARCHAR NOT NULL REFERENCES users(id),
  project_id      VARCHAR NOT NULL REFERENCES projects(id),
  period          VARCHAR NOT NULL,
  decision        VARCHAR NOT NULL DEFAULT 'pending_review'
                  CHECK (decision IN ('pending_review','ok_for_export','queried','rejected','exported')),
  review_notes    TEXT,
  reviewed_by     VARCHAR REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  export_sequence VARCHAR,
  exported_at     TIMESTAMPTZ,
  exported_by     VARCHAR REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(timesheet_id, user_id, project_id, period)
);

-- audit_log
CREATE TABLE IF NOT EXISTS audit_log (
  id          VARCHAR PRIMARY KEY DEFAULT pad_id('AL-', nextval('audit_log_id_seq')),
  actor_id    VARCHAR NOT NULL REFERENCES users(id),
  actor_name  VARCHAR NOT NULL,
  action      VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL,
  entity_id   VARCHAR,
  description VARCHAR NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- export_runs
CREATE TABLE IF NOT EXISTS export_runs (
  id               VARCHAR PRIMARY KEY DEFAULT pad_id('ER-', nextval('export_run_id_seq')),
  sequence_number  VARCHAR NOT NULL UNIQUE,
  period           VARCHAR NOT NULL,
  exported_by      VARCHAR NOT NULL REFERENCES users(id),
  exported_at      TIMESTAMPTZ DEFAULT NOW(),
  record_count     INTEGER NOT NULL DEFAULT 0,
  status           VARCHAR NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('completed','failed','partial')),
  error_detail     TEXT
);

-- system_settings
CREATE TABLE IF NOT EXISTS system_settings (
  key         VARCHAR PRIMARY KEY,
  value       VARCHAR NOT NULL,
  updated_by  VARCHAR REFERENCES users(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO system_settings (key, value) VALUES
  ('min_daily_hours', '8'),
  ('hour_enforcement_mode', 'block')
ON CONFLICT (key) DO NOTHING;

-- New columns on timesheets
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS is_admin_unlocked BOOLEAN DEFAULT false;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS unlock_reason TEXT;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMPTZ;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS unlocked_by VARCHAR REFERENCES users(id);
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS shortfall_explanation TEXT;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS has_shortfall_flag BOOLEAN DEFAULT false;

-- week_of on notifications for dedup
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS week_of DATE;

-- Update notification type check to include weekly_reminder
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('approval','reminder','overdue','system','broadcast','weekly_reminder'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_finance_decisions_period ON finance_decisions(period);
CREATE INDEX IF NOT EXISTS idx_finance_decisions_user ON finance_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- ============================================================
-- v6.0 additions — Activities, AFE Codes
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS activity_id_seq START 1;

CREATE TABLE IF NOT EXISTS activities (
    id          VARCHAR PRIMARY KEY DEFAULT pad_id('ACT-', nextval('activity_id_seq')),
    project_id  VARCHAR NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        VARCHAR NOT NULL,
    code        VARCHAR NOT NULL,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, code)
);

CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS afe_code VARCHAR;

ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS activity_id VARCHAR REFERENCES activities(id);
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS activity_name VARCHAR;
