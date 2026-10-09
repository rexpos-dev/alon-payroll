# Alon Payroll System

Semi-monthly payroll system (Node.js + MySQL) that replaces the PAYROLL-V3 Excel workbook.

## Requirements

- **Node.js 18 or newer**: https://nodejs.org (LTS)
- **MySQL 8** (or MariaDB 10.6+), for example from XAMPP, Laragon or MySQL Installer

## Installation (first time)

1. Make sure MySQL is running.
2. Open `.env` and check `DATABASE_URL`:
   ```
   DATABASE_URL="mysql://USER:PASSWORD@localhost:3306/alon_payroll"
   ```
   The `alon_payroll` database is created automatically if it does not exist.
3. Double-click **`install.bat`**. It will:
   - install the packages (`npm install`)
   - create all tables and default data (`npm run migrate`)
   - create the first admin account (`admin` / `admin123`)
4. Double-click **`start.bat`**, then open http://localhost:3000
5. Log in as `admin` and **change the password right away** (Password link at the bottom left).

From the command line: `npm install`, `npm run migrate`, `npm start`.

## First-time setup inside the system

1. **Company Settings**: name, address, signatories, and when SSS/PhilHealth/Pag-IBIG are deducted.
2. **Employees › Import from Excel**: upload the old `PAYROLL-V3 FOR SEMI PAYROLL.xlsm`. It imports the 201FILE, allowances, deductions, schedules and loans.
3. **Government Rates**: verify the SSS (2025 schedule), PhilHealth (5%), Pag-IBIG and BIR tax tables.
4. **Holidays**: enter the holidays for the year.
5. **Users**: create accounts for HR, Payroll Officer and Approver.

## Process for every cut-off

1. **Payroll Periods › New cut-off** (1–15 or 16–end of month).
2. **DTR**: import from the biometric device (Excel/CSV) or type it in. Check "OT ok" for approved overtime.
3. **Adjustments**: variable allowances (qty × rate), one-time deductions, salary adjustments.
4. **Compute payroll** › read the warnings.
5. **Approve** (Approver) › **Post and lock** (loan balances are updated).
6. **Payroll register** (CSV export) and **Print all payslips** (Save as PDF).

## Roles

| Role | Can do |
| --- | --- |
| Admin | Everything: users, settings, rates |
| HR | Employees, schedules, holidays, leaves, DTR, loans |
| Payroll Officer | DTR, loans, adjustments, compute, post |
| Approver | Approve/reject, audit log |

## Computation rules

- Semi-monthly: basic = monthly / 2; daily rate = (monthly / 2) / workdays per cut-off; hourly = daily / 8.
- Daily-paid: paid for each day worked; an unworked regular holiday is still paid (100%).
- Absences, late and undertime are deducted from the DTR. A blank workday is counted as absent.
- OT (approved only): regular 125%; rest day/special 130% × 130%; regular holiday 200% × 130%. Night differential +10% (22:00–06:00).
- Semi-monthly employees who work on a holiday: only the premium is added (30% special, 100% regular), because the day is already in the monthly basic.
- SSS, PhilHealth, Pag-IBIG: based on the monthly basic; split according to Company Settings.
- Withholding tax: BIR semi-monthly table (TRAIN 2023). Minimum wage earner = no tax.
- Loans: the amortization is deducted until the balance reaches zero.
- Currency: Philippine Peso (₱) only.

All multipliers and rate tables can be edited in Settings without changing the code.

## Tests

`npm test` runs the payroll engine unit tests.

## Backup

Back up the database every day or after every post:
```
mysqldump -u root -p alon_payroll > backup-alon_payroll.sql
```
