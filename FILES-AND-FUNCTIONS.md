# Alon Payroll – Files ug Functions

## Core (`src/`)

| File | Function | Gamit |
|---|---|---|
| src/server.js | `start()` | Sugdan ang web server |
| src/app.js | (Express app) | Setup sa session, CSRF, routes, 404/error handler |
| src/config.js | `dbConfig()` | Basaha ang DATABASE_URL ug uban pang config |
| src/db.js | `query()` | Dagan og SQL query |
| | `one()` | Kuhaon ang usa ka row |
| | `tx()` | Transaction wrapper |
| src/audit.js | `audit()` | Isulat sa audit log ang usa ka aksyon |
| | `diff()` | Itandi ang before/after nga data |
| src/middleware.js | `requireLogin()` | Kinahanglan naka-login |
| | `requireRole()` | Limitahan pinaagi sa role |
| | `csrf()` | CSRF protection |
| | `flash()` | Mensahe sa user |
| | `locals()` | Ibutang ang shared data sa views |
| | `fmtDate()` / `money` | Format sa petsa ug kantidad |
| src/legacyImport.js | `importLegacyWorkbook()` | Import sa daang Excel workbook |
| | `cellValue()`, `toDate()`, `toTime()` | Basa/convert sa Excel cells |
| | `idFor()`, `payItemFor()` | Pangita/himo og department, position, pay item |

## Payroll logic (`src/payroll/`)

| File | Function | Gamit |
|---|---|---|
| compute.js | `computePeriod()` | Kwentahon ang payroll sa usa ka period |
| | `postPeriod()` | I-post ang approved nga period (loans, final) |
| | `loadTables()` | Kuhaa ang SSS/PhilHealth/Pag-IBIG/tax rates |
| | `siblingPeriod()` | Pangitaon ang lain nga cutoff sa samang bulan |
| | `buildDays()` | Buhaton ang adlaw-adlaw nga data |
| | `datesBetween()` | Lista sa petsa sa range |
| contributions.js | `sssMonthly()` | SSS contribution |
| | `philhealthMonthly()` | PhilHealth contribution |
| | `pagibigMonthly()` | Pag-IBIG contribution |
| | `cutoffShare()` | Bahin sa matag cutoff |
| | `withholdingTax()` | Withholding tax |
| | `r2()` | Round sa 2 decimals |
| dtr.js | `summarizeDay()` | Summary sa usa ka adlaw (late, UT, OT, night diff) |
| | `toMin()`, `fmtTime()` | Convert oras ↔ minuto |
| | `overlap()`, `interval()`, `nightMinutes()` | Kwenta sa oras |
| | `isRestDay()`, `dayName()` | Rest day ug ngalan sa adlaw |
| engine.js | `computePayslip()` | Kwentahon ang usa ka payslip |
| | `rates()` | Hourly/daily rate sa empleyado |

## Routes (`src/routes/`)

| File | Mga URL | Gamit |
|---|---|---|
| auth.js | `/login`, `/logout`, `/account/password` | Login ug pagbag-o og password |
| dashboard.js | `/` | Dashboard |
| employees.js | `/employees`, `/employees/new`, `/employees/:id/edit`, `/employees/import`, `.../pay-items`, `.../schedule`, `.../leave-credits` | Empleyado, pay items, schedule, leave credits |
| | helpers: `readForm()`, `validate()`, `lists()`, `editData()` | |
| attendance.js | `/dtr`, `/dtr/import`, `/dtr/template.csv`, `/holidays` | DTR, import, holidays |
| | helpers: `scheduleOf()`, `holidayMap()`, `saveDay()`, `invalidatePeriods()`, `lockedPeriodFor()`, `parseCsv()`, `readRows()`, `splitDateTime()` | |
| loans.js | `/loans`, `/loans/:id` | Loans |
| periods.js | `/periods`, `/periods/:id`, `.../compute`, `.../approve`, `.../reject`, `.../post`, `.../delete`, `.../adjustments` | Payroll periods ug workflow |
| | helper: `loadPeriod()` | |
| reports.js | `/payslips/:id`, `/periods/:id/payslips`, `/periods/:id/register`, `.../register.csv` | Payslips ug register |
| | helpers: `payslipData()`, `registerRows()` | |
| settings.js | `/settings`, `/settings/company`, `/settings/premiums`, `/settings/lists`, `/settings/pay-items`, `/settings/rates/*`, `/audit` | Company, rates, listahan, audit log |
| users.js | `/users`, `/users/:id` | User management |

## Database ug scripts

| File | Function | Gamit |
|---|---|---|
| db/schema.sql | 22 ka `CREATE TABLE` | Definition sa mga table |
| db/seed.js | `seed()` | Default data (rates, tax, etc.) |
| | `sssRows2025()` | SSS table 2025 |
| | `isEmpty()` | Susihon kung walay sulod ang table |
| scripts/migrate.js | `main()` | Himoon ang database, tables, seed, admin user (`npm run migrate`) |
| tests/engine.test.js | tests | Test sa payroll engine (`npm test`) |

## Views (`views/`)

`login`, `dashboard`, `error`, `employees/{index,form,import}`, `attendance/{dtr,holidays,import}`, `loans/{index,show}`, `periods/{index,show,adjustments}`, `payslips/print`, `reports/register`, `settings/{company,lists,pay_items,rates,audit}`, `users/{index,password}`, `partials/{header,footer}`.
