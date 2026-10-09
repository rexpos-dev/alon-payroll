-- Alon Payroll System - database schema (MySQL 8 / MariaDB 10.6+)
-- Gidagan sa scripts/migrate.js. Safe nga dagan-on balik (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role ENUM('admin','hr','payroll','approver') NOT NULL DEFAULT 'payroll',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(40) NULL,
  details TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity (entity, entity_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS company (
  id INT PRIMARY KEY,
  name VARCHAR(150) NOT NULL DEFAULT 'COMPANY NAME',
  address VARCHAR(255) NULL,
  contact VARCHAR(100) NULL,
  prepared_by VARCHAR(100) NULL,
  checked_by VARCHAR(100) NULL,
  approved_by VARCHAR(100) NULL,
  -- Asa nga cut-off ikaltas ang SSS/PhilHealth/Pag-IBIG:
  -- split = tunga sa matag cut-off, first = tanan sa 1st, second = tanan sa 2nd
  contrib_mode ENUM('split','first','second') NOT NULL DEFAULT 'split'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS positions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  emp_no VARCHAR(30) NOT NULL UNIQUE,
  status ENUM('Active','Inactive','Resigned') NOT NULL DEFAULT 'Active',
  last_name VARCHAR(80) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  middle_name VARCHAR(80) NULL,
  department_id INT NULL,
  position_id INT NULL,
  -- semi = monthly-paid (semi-monthly), daily = bayad kada adlaw nga nagtrabaho
  pay_type ENUM('semi','daily') NOT NULL DEFAULT 'semi',
  monthly_basic DECIMAL(12,2) NOT NULL DEFAULT 0,
  daily_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- Para sa semi: daily rate = (monthly_basic / 2) / days_per_cutoff
  days_per_cutoff DECIMAL(5,2) NOT NULL DEFAULT 13,
  tax_class ENUM('above_min','mwe') NOT NULL DEFAULT 'above_min',
  track_dtr TINYINT(1) NOT NULL DEFAULT 1,
  sss_enabled TINYINT(1) NOT NULL DEFAULT 1,
  philhealth_enabled TINYINT(1) NOT NULL DEFAULT 1,
  pagibig_enabled TINYINT(1) NOT NULL DEFAULT 1,
  tin VARCHAR(30) NULL,
  sss_no VARCHAR(30) NULL,
  philhealth_no VARCHAR(30) NULL,
  pagibig_no VARCHAR(30) NULL,
  contact VARCHAR(50) NULL,
  address VARCHAR(255) NULL,
  birth_date DATE NULL,
  civil_status VARCHAR(20) NULL,
  date_hired DATE NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_emp_dept FOREIGN KEY (department_id) REFERENCES departments(id),
  CONSTRAINT fk_emp_pos FOREIGN KEY (position_id) REFERENCES positions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schedules (
  employee_id INT PRIMARY KEY,
  am_in TIME NOT NULL DEFAULT '08:00:00',
  am_out TIME NOT NULL DEFAULT '12:00:00',
  pm_in TIME NOT NULL DEFAULT '13:00:00',
  pm_out TIME NOT NULL DEFAULT '17:00:00',
  rest_days VARCHAR(40) NOT NULL DEFAULT 'Sun',
  CONSTRAINT fk_sched_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS holidays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  type ENUM('regular','special') NOT NULL,
  name VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attendance_days (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  work_date DATE NOT NULL,
  am_in TIME NULL,
  am_out TIME NULL,
  pm_in TIME NULL,
  pm_out TIME NULL,
  day_type ENUM('regular','rest','special','regular_holiday') NOT NULL DEFAULT 'regular',
  leave_type ENUM('VL','SL') NULL,
  days_worked DECIMAL(4,2) NOT NULL DEFAULT 0,
  absent_days DECIMAL(4,2) NOT NULL DEFAULT 0,
  reg_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  ot_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  ot_approved TINYINT(1) NOT NULL DEFAULT 0,
  nd_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  late_min INT NOT NULL DEFAULT 0,
  undertime_min INT NOT NULL DEFAULT 0,
  remarks VARCHAR(255) NULL,
  source ENUM('manual','import') NOT NULL DEFAULT 'manual',
  updated_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_att (employee_id, work_date),
  CONSTRAINT fk_att_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leave_credits (
  employee_id INT NOT NULL,
  year INT NOT NULL,
  vl_days DECIMAL(5,2) NOT NULL DEFAULT 0,
  sl_days DECIMAL(5,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, year),
  CONSTRAINT fk_lc_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Allowance ug deduction categories (mopuli sa Settings sheet)
CREATE TABLE IF NOT EXISTS pay_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  -- fixed = parehas kada cut-off; variable = rate x qty kada cut-off; deduction = kaltas
  kind ENUM('fixed','variable','deduction') NOT NULL,
  taxable TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Recurring amount per employee (mopuli sa Fixed/Variable Allowance ug Deductions sheets)
CREATE TABLE IF NOT EXISTS employee_pay_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  pay_item_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_epi (employee_id, pay_item_id),
  CONSTRAINT fk_epi_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_epi_item FOREIGN KEY (pay_item_id) REFERENCES pay_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS loans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  loan_type ENUM('SSS','Pag-IBIG','Company') NOT NULL,
  reference_no VARCHAR(60) NULL,
  principal DECIMAL(12,2) NOT NULL,
  amortization DECIMAL(12,2) NOT NULL,
  start_date DATE NOT NULL,
  balance DECIMAL(12,2) NOT NULL,
  status ENUM('active','paid','cancelled') NOT NULL DEFAULT 'active',
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_loan_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Government rate tables (tanan naay effective_date)
CREATE TABLE IF NOT EXISTS sss_table (
  id INT AUTO_INCREMENT PRIMARY KEY,
  effective_date DATE NOT NULL,
  range_from DECIMAL(12,2) NOT NULL,
  range_to DECIMAL(12,2) NULL,
  msc DECIMAL(12,2) NOT NULL,
  ee DECIMAL(12,2) NOT NULL,
  er DECIMAL(12,2) NOT NULL,
  ec DECIMAL(12,2) NOT NULL DEFAULT 0,
  INDEX idx_sss (effective_date, range_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS philhealth_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  effective_date DATE NOT NULL UNIQUE,
  rate DECIMAL(6,4) NOT NULL,
  floor_salary DECIMAL(12,2) NOT NULL,
  ceiling_salary DECIMAL(12,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pagibig_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  effective_date DATE NOT NULL UNIQUE,
  low_threshold DECIMAL(12,2) NOT NULL,
  ee_rate_low DECIMAL(6,4) NOT NULL,
  ee_rate DECIMAL(6,4) NOT NULL,
  er_rate DECIMAL(6,4) NOT NULL,
  max_fund_salary DECIMAL(12,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tax_table (
  id INT AUTO_INCREMENT PRIMARY KEY,
  effective_date DATE NOT NULL,
  period ENUM('semi','monthly') NOT NULL,
  range_from DECIMAL(12,2) NOT NULL,
  fixed_tax DECIMAL(12,2) NOT NULL,
  rate DECIMAL(6,4) NOT NULL,
  INDEX idx_tax (effective_date, period, range_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- OT / holiday multipliers (editable sa Settings)
CREATE TABLE IF NOT EXISTS premium_rates (
  code VARCHAR(30) PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  multiplier DECIMAL(6,4) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payroll_periods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  pay_date DATE NOT NULL,
  cutoff ENUM('1st','2nd') NOT NULL,
  status ENUM('draft','computed','approved','posted') NOT NULL DEFAULT 'draft',
  notes VARCHAR(255) NULL,
  created_by INT NULL,
  computed_at DATETIME NULL,
  approved_by INT NULL,
  approved_at DATETIME NULL,
  posted_by INT NULL,
  posted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_period (date_from, date_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mano-mano nga entries kada period: variable allowance qty, one-time deduction, adjustments
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_id INT NOT NULL,
  employee_id INT NOT NULL,
  pay_item_id INT NULL,
  kind ENUM('variable','deduction','earning_adj','deduction_adj') NOT NULL,
  label VARCHAR(80) NOT NULL,
  qty DECIMAL(10,2) NOT NULL DEFAULT 1,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  taxable TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  CONSTRAINT fk_adj_period FOREIGN KEY (period_id) REFERENCES payroll_periods(id) ON DELETE CASCADE,
  CONSTRAINT fk_adj_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payslips (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_id INT NOT NULL,
  employee_id INT NOT NULL,
  basic_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  gross_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  taxable_allowances DECIMAL(12,2) NOT NULL DEFAULT 0,
  nontaxable_allowances DECIMAL(12,2) NOT NULL DEFAULT 0,
  sss_ee DECIMAL(12,2) NOT NULL DEFAULT 0,
  sss_er DECIMAL(12,2) NOT NULL DEFAULT 0,
  sss_ec DECIMAL(12,2) NOT NULL DEFAULT 0,
  philhealth_ee DECIMAL(12,2) NOT NULL DEFAULT 0,
  philhealth_er DECIMAL(12,2) NOT NULL DEFAULT 0,
  pagibig_ee DECIMAL(12,2) NOT NULL DEFAULT 0,
  pagibig_er DECIMAL(12,2) NOT NULL DEFAULT 0,
  taxable_income DECIMAL(12,2) NOT NULL DEFAULT 0,
  withholding_tax DECIMAL(12,2) NOT NULL DEFAULT 0,
  other_deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
  loan_deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payslip (period_id, employee_id),
  CONSTRAINT fk_ps_period FOREIGN KEY (period_id) REFERENCES payroll_periods(id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payslip_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payslip_id INT NOT NULL,
  section ENUM('earning','allowance','contribution','tax','deduction','loan') NOT NULL,
  code VARCHAR(40) NOT NULL,
  label VARCHAR(100) NOT NULL,
  qty DECIMAL(10,2) NULL,
  unit VARCHAR(10) NULL,
  rate DECIMAL(12,4) NULL,
  amount DECIMAL(12,2) NOT NULL,
  taxable TINYINT(1) NOT NULL DEFAULT 0,
  ref_id INT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_pl_ps FOREIGN KEY (payslip_id) REFERENCES payslips(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS loan_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  loan_id INT NOT NULL,
  period_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lp (loan_id, period_id),
  CONSTRAINT fk_lp_loan FOREIGN KEY (loan_id) REFERENCES loans(id),
  CONSTRAINT fk_lp_period FOREIGN KEY (period_id) REFERENCES payroll_periods(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
