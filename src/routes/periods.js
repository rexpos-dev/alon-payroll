const express = require('express');
const { query, one } = require('../db');
const { requireRole, flash, fmtDate } = require('../middleware');
const { audit } = require('../audit');
const { computePeriod, postPeriod } = require('../payroll/compute');

const router = express.Router();

const STATUS_LABEL = { draft: 'Draft', computed: 'Computed', approved: 'Approved', posted: 'Posted' };

router.get('/periods', async (req, res) => {
  const rows = await query(`SELECT p.*, COUNT(s.id) AS slips, COALESCE(SUM(s.net_pay),0) AS net
    FROM payroll_periods p LEFT JOIN payslips s ON s.period_id = p.id GROUP BY p.id ORDER BY p.date_from DESC`);
  // Sugyot sa sunod nga cut-off (1-15 o 16-katapusan)
  const last = rows[0];
  let next;
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0));
  if (last) {
    const [y, m, d] = last.date_to.split('-').map(Number);
    if (d <= 15) next = { date_from: `${last.date_to.slice(0, 8)}16`, date_to: ymd(endOfMonth(y, m - 1)), cutoff: '2nd' };
    else {
      const n = new Date(Date.UTC(y, m, 1));
      next = { date_from: ymd(n), date_to: ymd(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 15))), cutoff: '1st' };
    }
  } else {
    const y = today.getFullYear();
    const m = today.getMonth();
    next = { date_from: ymd(new Date(Date.UTC(y, m, 1))), date_to: ymd(new Date(Date.UTC(y, m, 15))), cutoff: '1st' };
  }
  next.pay_date = next.date_to;
  res.render('periods/index', { title: 'Payroll Periods', rows, next, STATUS_LABEL });
});

router.post('/periods', requireRole('payroll'), async (req, res) => {
  const { date_from, date_to, pay_date, cutoff } = req.body;
  const ok = [date_from, date_to, pay_date].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')) && date_from <= date_to && ['1st', '2nd'].includes(cutoff);
  if (!ok) {
    flash(req, 'error', 'Invalid dates or cut-off.');
    return res.redirect('/periods');
  }
  const overlap = await one('SELECT id FROM payroll_periods WHERE date_from <= ? AND date_to >= ?', [date_to, date_from]);
  if (overlap) {
    flash(req, 'error', 'A period already overlaps these dates.');
    return res.redirect('/periods');
  }
  const r = await query('INSERT INTO payroll_periods (date_from, date_to, pay_date, cutoff, created_by) VALUES (?,?,?,?,?)',
    [date_from, date_to, pay_date, cutoff, req.session.user.id]);
  await audit(req, 'create', 'period', r.insertId, { date_from, date_to, pay_date, cutoff });
  flash(req, 'success', 'Period created. Check the DTR and adjustments, then compute.');
  res.redirect(`/periods/${r.insertId}`);
});

async function loadPeriod(id) {
  return one(`SELECT p.*, ua.full_name AS approver_name, up.full_name AS poster_name FROM payroll_periods p
    LEFT JOIN users ua ON ua.id = p.approved_by LEFT JOIN users up ON up.id = p.posted_by WHERE p.id = ?`, [id]);
}

router.get('/periods/:id', async (req, res) => {
  const period = await loadPeriod(req.params.id);
  if (!period) return res.redirect('/periods');
  const slips = await query(`SELECT s.*, e.emp_no, e.last_name, e.first_name, d.name AS department FROM payslips s
    JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id
    WHERE s.period_id = ? ORDER BY e.last_name, e.first_name`, [period.id]);
  const adjCount = await one('SELECT COUNT(*) AS c FROM payroll_adjustments WHERE period_id = ?', [period.id]);
  const warnings = req.session.computeWarnings && req.session.computeWarnings.periodId === period.id ? req.session.computeWarnings.items : [];
  res.locals.crumbLabel = `${fmtDate(period.date_from)} – ${fmtDate(period.date_to)}`;
  res.render('periods/show', { title: 'Payroll Period', period, slips, adjCount: adjCount.c, warnings, STATUS_LABEL });
});

router.post('/periods/:id/compute', requireRole('payroll'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const results = await computePeriod(id);
    const items = results.filter(r => r.warnings.length);
    req.session.computeWarnings = { periodId: id, items };
    await audit(req, 'compute', 'period', id, { employees: results.length, warnings: items.length });
    flash(req, 'success', `Computed ${results.length} payslip(s).`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect(`/periods/${id}`);
});

router.post('/periods/:id/approve', requireRole('approver'), async (req, res) => {
  const p = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  if (!p || p.status !== 'computed') {
    flash(req, 'error', 'Only a computed period can be approved.');
  } else {
    await query("UPDATE payroll_periods SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?", [req.session.user.id, p.id]);
    await audit(req, 'approve', 'period', p.id);
    flash(req, 'success', 'Payroll approved.');
  }
  res.redirect(`/periods/${req.params.id}`);
});

router.post('/periods/:id/reject', requireRole('approver'), async (req, res) => {
  const p = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  if (!p || !['computed', 'approved'].includes(p.status)) {
    flash(req, 'error', 'This period cannot be rejected.');
  } else {
    const reason = String(req.body.reason || '').trim().slice(0, 250);
    await query("UPDATE payroll_periods SET status = 'draft', approved_by = NULL, approved_at = NULL, notes = ? WHERE id = ?", [reason || null, p.id]);
    await audit(req, 'reject', 'period', p.id, { reason });
    flash(req, 'success', 'The period was returned to Draft for adjustment.');
  }
  res.redirect(`/periods/${req.params.id}`);
});

router.post('/periods/:id/post', requireRole('payroll', 'approver'), async (req, res) => {
  try {
    const n = await postPeriod(Number(req.params.id), req.session.user.id);
    await audit(req, 'post', 'period', req.params.id, { loan_payments: n });
    flash(req, 'success', 'Payroll posted and locked. Loan balances updated.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  res.redirect(`/periods/${req.params.id}`);
});

router.post('/periods/:id/delete', requireRole('payroll'), async (req, res) => {
  const p = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  if (!p || !['draft', 'computed'].includes(p.status)) {
    flash(req, 'error', 'Only a Draft or Computed period can be deleted.');
    return res.redirect(`/periods/${req.params.id}`);
  }
  await query('DELETE FROM payroll_periods WHERE id = ?', [p.id]);
  await audit(req, 'delete', 'period', p.id, p);
  flash(req, 'success', 'Period deleted.');
  res.redirect('/periods');
});

// ---------- Adjustments (variable allowance qty, one-time deductions, adjustments) ----------
router.get('/periods/:id/adjustments', async (req, res) => {
  const period = await loadPeriod(req.params.id);
  if (!period) return res.redirect('/periods');
  const rows = await query(`SELECT a.*, e.emp_no, e.last_name, e.first_name FROM payroll_adjustments a
    JOIN employees e ON e.id = a.employee_id WHERE a.period_id = ? ORDER BY e.last_name, a.id`, [period.id]);
  const employees = await query("SELECT id, emp_no, last_name, first_name FROM employees WHERE status = 'Active' ORDER BY last_name, first_name");
  const items = await query("SELECT * FROM pay_items WHERE active = 1 AND kind IN ('variable','deduction') ORDER BY kind, sort_order");
  const rates = await query(`SELECT epi.employee_id, epi.pay_item_id, epi.amount FROM employee_pay_items epi
    JOIN pay_items p ON p.id = epi.pay_item_id WHERE p.kind = 'variable'`);
  res.locals.crumbLabel = `${fmtDate(period.date_from)} – ${fmtDate(period.date_to)}`;
  res.render('periods/adjustments', { title: 'Adjustments', period, rows, employees, items, rates });
});

router.post('/periods/:id/adjustments', requireRole('payroll'), async (req, res) => {
  const period = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  if (!period || !['draft', 'computed'].includes(period.status)) {
    flash(req, 'error', 'Adjustments for this period can no longer be changed.');
    return res.redirect(`/periods/${req.params.id}/adjustments`);
  }
  const b = req.body;
  const qty = Number(b.qty || 1);
  const amount = Number(b.amount);
  let kind = b.kind;
  let label = String(b.label || '').trim();
  let taxable = b.taxable ? 1 : 0;
  let itemId = null;
  if (b.pay_item_id) {
    const it = await one('SELECT * FROM pay_items WHERE id = ?', [b.pay_item_id]);
    if (it) { itemId = it.id; kind = it.kind; label = label || it.name; taxable = it.taxable; }
  }
  if (!b.employee_id || !['variable', 'deduction', 'earning_adj', 'deduction_adj'].includes(kind) || !label || !Number.isFinite(amount) || !(qty > 0)) {
    flash(req, 'error', 'Complete the employee, item/type, label, qty and amount.');
    return res.redirect(`/periods/${period.id}/adjustments`);
  }
  const r = await query(`INSERT INTO payroll_adjustments (period_id, employee_id, pay_item_id, kind, label, qty, amount, taxable, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`, [period.id, b.employee_id, itemId, kind, label, qty, amount, taxable, req.session.user.id]);
  if (period.status === 'computed') await query("UPDATE payroll_periods SET status = 'draft' WHERE id = ?", [period.id]);
  await audit(req, 'create', 'adjustment', r.insertId, { period: period.id, employee_id: b.employee_id, kind, label, qty, amount });
  flash(req, 'success', 'Adjustment added. Recompute the period.');
  res.redirect(`/periods/${period.id}/adjustments`);
});

router.post('/periods/:id/adjustments/:adjId/delete', requireRole('payroll'), async (req, res) => {
  const period = await one('SELECT * FROM payroll_periods WHERE id = ?', [req.params.id]);
  const adj = await one('SELECT * FROM payroll_adjustments WHERE id = ? AND period_id = ?', [req.params.adjId, req.params.id]);
  if (period && adj && ['draft', 'computed'].includes(period.status)) {
    await query('DELETE FROM payroll_adjustments WHERE id = ?', [adj.id]);
    if (period.status === 'computed') await query("UPDATE payroll_periods SET status = 'draft' WHERE id = ?", [period.id]);
    await audit(req, 'delete', 'adjustment', adj.id, adj);
    flash(req, 'success', 'Adjustment deleted.');
  }
  res.redirect(`/periods/${req.params.id}/adjustments`);
});

module.exports = router;
