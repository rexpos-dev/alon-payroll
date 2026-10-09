// Import sa data gikan sa daan nga PAYROLL-V3 Excel (sheets: 201FILE, Fixed Allowance,
// Variable Allowance, Deductions, Schedule, SSS Loan, Pagibig Loan).
const ExcelJS = require('exceljs');
const { query, one } = require('./db');

function cellValue(cell) {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if ('result' in v) v = v.result;               // formula
    else if ('richText' in v) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;              // hyperlink
  }
  if (v === undefined) v = null;
  return v;
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());
const num = v => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = str(v).toUpperCase();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^([A-Z]+)\s*(\d{1,2})\s*,?\s*(\d{4})$/);
  if (m) {
    const mi = MONTHS.findIndex(x => x.startsWith(m[1].slice(0, 3)));
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function toTime(v) {
  if (v instanceof Date && !isNaN(v)) return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}:00`;
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 1440);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;
  }
  const s = str(v);
  return /^\d{1,2}:\d{2}/.test(s) ? s : null;
}

// Ang key nga gigamit sa Excel: "LAST, FIRST M."
const legacyKey = (last, first, middle) => `${str(last)}, ${str(first)} ${str(middle).slice(0, 1)}.`.toUpperCase().replace(/\s+/g, ' ');
const normKey = s => str(s).toUpperCase().replace(/\s+/g, ' ');

async function idFor(table, name) {
  if (!name) return null;
  const row = await one(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  if (row) return row.id;
  const r = await query(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
  return r.insertId;
}

async function payItemFor(name, kind) {
  const clean = str(name).replace(/:$/, '');
  if (!clean) return null;
  const row = await one('SELECT id FROM pay_items WHERE kind = ? AND LOWER(name) = LOWER(?)', [kind, clean]);
  if (row) return row.id;
  const prefix = { fixed: 'F_', variable: 'V_', deduction: 'D_' }[kind];
  const code = (prefix + clean.toUpperCase().replace(/[^A-Z0-9]+/g, '')).slice(0, 30);
  const exists = await one('SELECT id FROM pay_items WHERE code = ?', [code]);
  const r = await query('INSERT INTO pay_items (code, name, kind, taxable, sort_order) VALUES (?,?,?,0,99)', [exists ? `${code.slice(0, 26)}_${Date.now() % 1000}` : code, clean, kind]);
  return r.insertId;
}

async function importLegacyWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const counts = { employees_new: 0, employees_updated: 0, pay_items: 0, schedules: 0, loans: 0 };
  const notes = [];
  const keyToId = {};

  const emp = wb.getWorksheet('201FILE');
  if (!emp) {
    notes.push('No "201FILE" sheet found. Make sure this is the PAYROLL Excel file.');
    return { counts, notes };
  }
  for (let r = 3; r <= emp.rowCount; r++) {
    const row = emp.getRow(r);
    const c = col => cellValue(row.getCell(col));
    const empNo = str(c('B'));
    const last = str(c('D'));
    const first = str(c('E'));
    if (!empNo || !last || !first) continue;
    const payroll = str(c('J')).toLowerCase();
    const payType = payroll === 'daily' || payroll === 'hours' ? 'daily' : 'semi';
    const status = ['Active', 'Inactive', 'Resigned'].includes(str(c('C'))) ? str(c('C')) : 'Active';
    const e = {
      emp_no: empNo,
      status,
      last_name: last.toUpperCase(),
      first_name: first.toUpperCase(),
      middle_name: str(c('F')).toUpperCase() || null,
      department_id: await idFor('departments', str(c('K'))),
      position_id: await idFor('positions', str(c('L'))),
      pay_type: payType,
      monthly_basic: num(c('H')),
      daily_rate: num(c('G')),
      days_per_cutoff: num(c('I')) > 0 ? num(c('I')) : 13,
      tax_class: /min/i.test(str(c('V'))) && !/above/i.test(str(c('V'))) ? 'mwe' : 'above_min',
      date_hired: toDate(c('M')),
      birth_date: toDate(c('N')),
      civil_status: str(c('O')) || null,
      tin: str(c('Q')) || null,
      sss_no: str(c('R')) || null,
      philhealth_no: str(c('S')) || null,
      pagibig_no: str(c('T')) || null,
      contact: str(c('U')) || null,
      address: str(c('W')) || null,
    };
    const fields = Object.keys(e);
    const existing = await one('SELECT id FROM employees WHERE emp_no = ?', [empNo]);
    let id;
    if (existing) {
      id = existing.id;
      await query(`UPDATE employees SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`, [...fields.map(f => e[f]), id]);
      counts.employees_updated++;
    } else {
      const ins = await query(`INSERT INTO employees (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(f => e[f]));
      id = ins.insertId;
      await query('INSERT IGNORE INTO schedules (employee_id) VALUES (?)', [id]);
      counts.employees_new++;
    }
    keyToId[legacyKey(last, first, c('F'))] = id;
    if (payType === 'semi' && !(e.monthly_basic > 0)) notes.push(`${empNo} ${last}: no Monthly Basic, please check.`);
  }

  // Allowances ug deductions: row 2 = headers (C..), row 3+ = employee name sa B
  const sheets = [['Fixed Allowance', 'fixed'], ['Variable Allowance', 'variable'], ['Deductions', 'deduction']];
  for (const [sheetName, kind] of sheets) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    const header = ws.getRow(2);
    const cols = [];
    for (let ci = 3; ci <= Math.max(ws.columnCount, 3); ci++) {
      const name = str(cellValue(header.getCell(ci)));
      if (name) cols.push({ ci, itemId: await payItemFor(name, kind) });
    }
    for (let r = 3; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const id = keyToId[normKey(cellValue(row.getCell(2)))];
      if (!id) continue;
      for (const { ci, itemId } of cols) {
        const amt = num(cellValue(row.getCell(ci)));
        if (amt > 0 && itemId) {
          await query('INSERT INTO employee_pay_items (employee_id, pay_item_id, amount) VALUES (?,?,?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)', [id, itemId, amt]);
          counts.pay_items++;
        }
      }
    }
  }

  const sched = wb.getWorksheet('Schedule');
  if (sched) {
    for (let r = 3; r <= sched.rowCount; r++) {
      const row = sched.getRow(r);
      const id = keyToId[normKey(cellValue(row.getCell(2)))];
      const t = [3, 4, 5, 6].map(ci => toTime(cellValue(row.getCell(ci))));
      if (!id || t.some(x => !x)) continue;
      await query(`INSERT INTO schedules (employee_id, am_in, am_out, pm_in, pm_out) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE am_in=VALUES(am_in), am_out=VALUES(am_out), pm_in=VALUES(pm_in), pm_out=VALUES(pm_out)`, [id, ...t]);
      counts.schedules++;
    }
  }

  for (const [sheetName, type] of [['SSS Loan', 'SSS'], ['Pagibig Loan', 'Pag-IBIG']]) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    for (let r = 4; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const id = keyToId[normKey(cellValue(row.getCell(2)))];
      const amort = num(cellValue(row.getCell(10)));
      if (!id || !(amort > 0)) continue;
      const ref = str(cellValue(row.getCell(3))) || null;
      const dup = await one('SELECT id FROM loans WHERE employee_id = ? AND loan_type = ? AND reference_no <=> ?', [id, type, ref]);
      if (dup) continue;
      const principal = num(cellValue(row.getCell(7))) || num(cellValue(row.getCell(4)));
      const start = toDate(cellValue(row.getCell(8))) || toDate(cellValue(row.getCell(6))) || new Date().toISOString().slice(0, 10);
      await query(`INSERT INTO loans (employee_id, loan_type, reference_no, principal, amortization, start_date, balance, notes)
        VALUES (?,?,?,?,?,?,?, 'From Excel import: please check the balance')`, [id, type, ref, principal, amort, start, principal]);
      counts.loans++;
    }
  }
  if (counts.loans) notes.push('Imported loans use the total loan as the balance. Please check and adjust the balance on the Loans page.');
  return { counts, notes };
}

module.exports = { importLegacyWorkbook, toDate, toTime, cellValue };
