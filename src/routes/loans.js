const express = require('express');
const { query, one } = require('../db');
const { requireRole, flash } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();

router.get('/loans', async (req, res) => {
  const status = req.query.status || 'active';
  const params = [];
  let where = '1=1';
  if (status !== 'all') { where += ' AND l.status = ?'; params.push(status); }
  const rows = await query(`SELECT l.*, e.emp_no, e.last_name, e.first_name,
      (SELECT COALESCE(SUM(amount),0) FROM loan_payments lp WHERE lp.loan_id = l.id) AS paid
    FROM loans l JOIN employees e ON e.id = l.employee_id WHERE ${where} ORDER BY e.last_name, l.start_date`, params);
  const employees = await query("SELECT id, emp_no, last_name, first_name FROM employees WHERE status = 'Active' ORDER BY last_name, first_name");
  res.render('loans/index', { title: 'Loans', rows, employees, status });
});

router.post('/loans', requireRole('hr', 'payroll'), async (req, res) => {
  const b = req.body;
  const principal = Number(b.principal);
  const amort = Number(b.amortization);
  const balance = b.balance === '' || b.balance === undefined ? principal : Number(b.balance);
  if (!b.employee_id || !['SSS', 'Pag-IBIG', 'Company'].includes(b.loan_type) || !(principal > 0) || !(amort > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') || !(balance >= 0)) {
    flash(req, 'error', 'Complete the employee, type, principal, amortization and start date.');
    return res.redirect('/loans');
  }
  const r = await query(`INSERT INTO loans (employee_id, loan_type, reference_no, principal, amortization, start_date, balance, notes)
    VALUES (?,?,?,?,?,?,?,?)`, [b.employee_id, b.loan_type, b.reference_no || null, principal, amort, b.start_date, balance, b.notes || null]);
  await audit(req, 'create', 'loan', r.insertId, { employee_id: b.employee_id, type: b.loan_type, principal, amort, balance });
  flash(req, 'success', 'Loan saved.');
  res.redirect('/loans');
});

router.get('/loans/:id', async (req, res) => {
  const loan = await one(`SELECT l.*, e.emp_no, e.last_name, e.first_name FROM loans l JOIN employees e ON e.id = l.employee_id WHERE l.id = ?`, [req.params.id]);
  if (!loan) return res.redirect('/loans');
  const payments = await query(`SELECT lp.*, p.date_from, p.date_to, p.pay_date FROM loan_payments lp
    JOIN payroll_periods p ON p.id = lp.period_id WHERE lp.loan_id = ? ORDER BY p.pay_date`, [loan.id]);
  res.render('loans/show', { title: `${loan.loan_type} Loan`, loan, payments });
});

router.post('/loans/:id', requireRole('hr', 'payroll'), async (req, res) => {
  const before = await one('SELECT * FROM loans WHERE id = ?', [req.params.id]);
  if (!before) return res.redirect('/loans');
  const amort = Number(req.body.amortization);
  const balance = Number(req.body.balance);
  const status = ['active', 'paid', 'cancelled'].includes(req.body.status) ? req.body.status : before.status;
  if (!(amort > 0) || !(balance >= 0)) {
    flash(req, 'error', 'Invalid amortization or balance.');
    return res.redirect(`/loans/${before.id}`);
  }
  await query('UPDATE loans SET amortization = ?, balance = ?, status = ?, notes = ? WHERE id = ?', [amort, balance, status, req.body.notes || null, before.id]);
  await audit(req, 'update', 'loan', before.id, {
    amortization: { from: before.amortization, to: amort }, balance: { from: before.balance, to: balance }, status: { from: before.status, to: status },
  });
  flash(req, 'success', 'Loan updated.');
  res.redirect(`/loans/${before.id}`);
});

module.exports = router;
