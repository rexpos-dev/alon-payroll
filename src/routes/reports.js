const express = require('express');
const { query, one } = require('../db');
const { fmtDate } = require('../middleware');

const router = express.Router();

async function payslipData(where, params) {
  const slips = await query(`SELECT s.*, e.emp_no, e.last_name, e.first_name, e.middle_name, e.tin, e.sss_no, e.philhealth_no, e.pagibig_no,
      d.name AS department, po.name AS position, p.date_from, p.date_to, p.pay_date, p.status AS period_status
    FROM payslips s JOIN employees e ON e.id = s.employee_id JOIN payroll_periods p ON p.id = s.period_id
    LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions po ON po.id = e.position_id
    WHERE ${where} ORDER BY e.last_name, e.first_name`, params);
  if (!slips.length) return [];
  const lines = await query(`SELECT * FROM payslip_lines WHERE payslip_id IN (${slips.map(() => '?').join(',')}) ORDER BY sort_order`, slips.map(s => s.id));
  for (const s of slips) s.lines = lines.filter(l => l.payslip_id === s.id);
  return slips;
}

router.get('/payslips/:id', async (req, res) => {
  const slips = await payslipData('s.id = ?', [req.params.id]);
  if (!slips.length) return res.redirect('/periods');
  const company = await one('SELECT * FROM company WHERE id = 1');
  res.render('payslips/print', { title: 'Payslip', slips, company, single: true });
});

router.get('/periods/:id/payslips', async (req, res) => {
  const params = [req.params.id];
  let where = 's.period_id = ?';
  if (req.query.department_id) { where += ' AND e.department_id = ?'; params.push(req.query.department_id); }
  const slips = await payslipData(where, params);
  const company = await one('SELECT * FROM company WHERE id = 1');
  res.render('payslips/print', { title: 'Payslips', slips, company, single: false });
});

async function registerRows(periodId, departmentId) {
  const params = [periodId];
  let where = 's.period_id = ?';
  if (departmentId) { where += ' AND e.department_id = ?'; params.push(departmentId); }
  return query(`SELECT s.*, e.emp_no, e.last_name, e.first_name, d.name AS department FROM payslips s
    JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id
    WHERE ${where} ORDER BY d.name, e.last_name, e.first_name`, params);
}

const COLS = [
  ['basic_pay', 'Basic'], ['gross_pay', 'Gross'], ['taxable_allowances', 'Tax. Allow'], ['nontaxable_allowances', 'Non-tax Allow'],
  ['sss_ee', 'SSS'], ['philhealth_ee', 'PhilHealth'], ['pagibig_ee', 'Pag-IBIG'], ['taxable_income', 'Taxable Inc'],
  ['withholding_tax', 'Tax'], ['other_deductions', 'Deductions'], ['loan_deductions', 'Loans'], ['net_pay', 'Net Pay'],
];

router.get('/periods/:id/register', async (req, res) => {
  const period = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  if (!period) return res.redirect('/periods');
  const departmentId = req.query.department_id || '';
  const rows = await registerRows(period.id, departmentId);
  const departments = await query('SELECT * FROM departments ORDER BY name');
  const totals = {};
  for (const [k] of COLS) totals[k] = rows.reduce((a, r) => a + Number(r[k]), 0);
  const contrib = ['sss_ee', 'sss_er', 'sss_ec', 'philhealth_ee', 'philhealth_er', 'pagibig_ee', 'pagibig_er']
    .reduce((o, k) => ({ ...o, [k]: rows.reduce((a, r) => a + Number(r[k]), 0) }), {});
  const company = await one('SELECT * FROM company WHERE id = 1');
  res.locals.crumbLabel = `${fmtDate(period.date_from)} – ${fmtDate(period.date_to)}`;
  res.render('reports/register', { title: 'Payroll Register', period, rows, totals, contrib, COLS, departments, departmentId, company });
});

router.get('/periods/:id/register.csv', async (req, res) => {
  const period = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  if (!period) return res.redirect('/periods');
  const rows = await registerRows(period.id, req.query.department_id || '');
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Emp No', 'Name', 'Department', ...COLS.map(c => c[1]), 'SSS ER', 'SSS EC', 'PhilHealth ER', 'Pag-IBIG ER'];
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    lines.push([r.emp_no, `${r.last_name}, ${r.first_name}`, r.department, ...COLS.map(c => Number(r[c[0]]).toFixed(2)),
      Number(r.sss_er).toFixed(2), Number(r.sss_ec).toFixed(2), Number(r.philhealth_er).toFixed(2), Number(r.pagibig_er).toFixed(2)].map(esc).join(','));
  }
  res.type('text/csv').attachment(`payroll-register-${period.date_from}-to-${period.date_to}.csv`).send('﻿' + lines.join('\r\n'));
});

module.exports = router;
