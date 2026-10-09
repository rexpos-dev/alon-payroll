const express = require('express');
const multer = require('multer');
const { query, one, tx } = require('../db');
const { requireRole, flash, csrf } = require('../middleware');
const { audit, diff } = require('../audit');
const { importLegacyWorkbook } = require('../legacyImport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const FIELDS = ['emp_no', 'status', 'last_name', 'first_name', 'middle_name', 'department_id', 'position_id', 'pay_type',
  'monthly_basic', 'daily_rate', 'days_per_cutoff', 'tax_class', 'track_dtr', 'sss_enabled', 'philhealth_enabled',
  'pagibig_enabled', 'tin', 'sss_no', 'philhealth_no', 'pagibig_no', 'contact', 'address', 'birth_date', 'civil_status', 'date_hired'];
const CHECKBOXES = ['track_dtr', 'sss_enabled', 'philhealth_enabled', 'pagibig_enabled'];

function readForm(body) {
  const e = {};
  for (const f of FIELDS) {
    let v = body[f];
    if (CHECKBOXES.includes(f)) v = v ? 1 : 0;
    else if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    e[f] = v;
  }
  e.last_name = e.last_name ? e.last_name.toUpperCase() : e.last_name;
  e.first_name = e.first_name ? e.first_name.toUpperCase() : e.first_name;
  e.middle_name = e.middle_name ? e.middle_name.toUpperCase() : e.middle_name;
  for (const n of ['monthly_basic', 'daily_rate']) e[n] = Number(e[n] || 0);
  e.days_per_cutoff = Number(e.days_per_cutoff || 13);
  return e;
}

function validate(e) {
  const errs = [];
  if (!e.emp_no) errs.push('Employee No is required.');
  if (!e.last_name || !e.first_name) errs.push('Last Name and First Name are required.');
  if (!['semi', 'daily'].includes(e.pay_type)) errs.push('Choose a Pay Type.');
  if (e.pay_type === 'semi' && !(e.monthly_basic > 0)) errs.push('Monthly Basic is required for semi-monthly pay.');
  if (e.pay_type === 'daily' && !(e.daily_rate > 0)) errs.push('Daily Rate is required for daily-paid employees.');
  if (!(e.days_per_cutoff > 0)) errs.push('Days per Cut-off must be greater than 0.');
  return errs;
}

async function lists() {
  return {
    departments: await query('SELECT * FROM departments WHERE active = 1 ORDER BY name'),
    positions: await query('SELECT * FROM positions WHERE active = 1 ORDER BY name'),
  };
}

router.get('/employees', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = req.query.status || 'Active';
  const params = [];
  let where = '1=1';
  if (status !== 'all') { where += ' AND e.status = ?'; params.push(status); }
  if (q) {
    where += ' AND (e.emp_no LIKE ? OR e.last_name LIKE ? OR e.first_name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = await query(`SELECT e.*, d.name AS department, p.name AS position FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id
    WHERE ${where} ORDER BY e.last_name, e.first_name`, params);
  res.render('employees/index', { title: 'Employees', rows, q, status });
});

// Import gikan sa daan nga PAYROLL Excel (.xlsm/.xlsx): 201FILE, Fixed Allowance, Deductions, Schedule
router.get('/employees/import', requireRole('hr'), (req, res) => {
  res.render('employees/import', { title: 'Import from Excel', result: null });
});

router.post('/employees/import', requireRole('hr'), upload.single('file'), csrf, async (req, res) => {
  if (!req.file) {
    flash(req, 'error', 'Choose an Excel file.');
    return res.redirect('/employees/import');
  }
  const result = await importLegacyWorkbook(req.file.buffer);
  await audit(req, 'import', 'employee', null, { file: req.file.originalname, ...result.counts });
  res.render('employees/import', { title: 'Import from Excel', result });
});

router.get('/employees/new', requireRole('hr'), async (req, res) => {
  res.render('employees/form', {
    title: 'New Employee', e: { status: 'Active', pay_type: 'semi', days_per_cutoff: 13, tax_class: 'above_min', track_dtr: 1, sss_enabled: 1, philhealth_enabled: 1, pagibig_enabled: 1 },
    errors: [], ...(await lists()), isNew: true,
  });
});

router.post('/employees', requireRole('hr'), async (req, res) => {
  const e = readForm(req.body);
  const errors = validate(e);
  if (errors.length) return res.render('employees/form', { title: 'New Employee', e, errors, ...(await lists()), isNew: true });
  const id = await tx(async conn => {
    const r = await conn.q(`INSERT INTO employees (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})`, FIELDS.map(f => e[f]));
    await conn.q('INSERT INTO schedules (employee_id) VALUES (?)', [r.insertId]);
    return r.insertId;
  });
  await audit(req, 'create', 'employee', id, { emp_no: e.emp_no, name: `${e.last_name}, ${e.first_name}` });
  flash(req, 'success', 'Employee saved. You can now set the allowances and schedule below.');
  res.redirect(`/employees/${id}/edit`);
});

async function editData(id) {
  const e = await one('SELECT * FROM employees WHERE id = ?', [id]);
  if (!e) return null;
  const sched = (await one('SELECT * FROM schedules WHERE employee_id = ?', [id])) || { am_in: '08:00', am_out: '12:00', pm_in: '13:00', pm_out: '17:00', rest_days: 'Sun' };
  const items = await query(`SELECT p.*, epi.amount FROM pay_items p
    LEFT JOIN employee_pay_items epi ON epi.pay_item_id = p.id AND epi.employee_id = ?
    WHERE p.active = 1 ORDER BY FIELD(p.kind,'fixed','variable','deduction'), p.sort_order`, [id]);
  const year = new Date().getFullYear();
  const credits = (await one('SELECT * FROM leave_credits WHERE employee_id = ? AND year = ?', [id, year])) || { vl_days: 0, sl_days: 0 };
  const used = await one(`SELECT COALESCE(SUM(leave_type='VL'),0) AS vl, COALESCE(SUM(leave_type='SL'),0) AS sl
    FROM attendance_days WHERE employee_id = ? AND YEAR(work_date) = ?`, [id, year]);
  const loans = await query('SELECT * FROM loans WHERE employee_id = ? ORDER BY created_at DESC', [id]);
  return { e, sched, items, credits, used, year, loans };
}

router.get('/employees/:id/edit', async (req, res) => {
  const data = await editData(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Employee not found.' });
  res.render('employees/form', { title: `${data.e.last_name}, ${data.e.first_name}`, errors: [], ...(await lists()), isNew: false, ...data });
});

router.post('/employees/:id', requireRole('hr'), async (req, res) => {
  const before = await one('SELECT * FROM employees WHERE id = ?', [req.params.id]);
  if (!before) return res.redirect('/employees');
  const e = readForm(req.body);
  const errors = validate(e);
  if (errors.length) {
    const data = await editData(req.params.id);
    return res.render('employees/form', { title: 'Edit Employee', errors, ...(await lists()), isNew: false, ...data, e: { ...e, id: before.id } });
  }
  await query(`UPDATE employees SET ${FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`, [...FIELDS.map(f => e[f]), req.params.id]);
  await audit(req, 'update', 'employee', req.params.id, diff(before, e, FIELDS));
  flash(req, 'success', 'Employee updated.');
  res.redirect(`/employees/${req.params.id}/edit`);
});

router.post('/employees/:id/pay-items', requireRole('hr', 'payroll'), async (req, res) => {
  const id = Number(req.params.id);
  const items = await query('SELECT id, name, kind FROM pay_items WHERE active = 1');
  const changes = {};
  await tx(async conn => {
    for (const it of items) {
      const raw = req.body[`item_${it.id}`];
      if (raw === undefined) continue;
      const amount = Number(String(raw).replace(/,/g, '') || 0);
      if (!Number.isFinite(amount) || amount < 0) continue;
      const [old] = await conn.q('SELECT amount FROM employee_pay_items WHERE employee_id = ? AND pay_item_id = ?', [id, it.id]);
      if (amount === 0) {
        if (old) await conn.q('DELETE FROM employee_pay_items WHERE employee_id = ? AND pay_item_id = ?', [id, it.id]);
      } else {
        await conn.q('INSERT INTO employee_pay_items (employee_id, pay_item_id, amount) VALUES (?,?,?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)', [id, it.id, amount]);
      }
      if (Number(old ? old.amount : 0) !== amount) changes[`${it.kind}:${it.name}`] = { from: old ? Number(old.amount) : 0, to: amount };
    }
  });
  if (Object.keys(changes).length) await audit(req, 'update', 'employee_pay_items', id, changes);
  flash(req, 'success', 'Allowances and deductions saved.');
  res.redirect(`/employees/${id}/edit#payitems`);
});

router.post('/employees/:id/schedule', requireRole('hr'), async (req, res) => {
  const id = Number(req.params.id);
  const days = [].concat(req.body.rest_days || []).filter(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(d));
  const v = { am_in: req.body.am_in, am_out: req.body.am_out, pm_in: req.body.pm_in, pm_out: req.body.pm_out, rest_days: days.join(',') };
  if (![v.am_in, v.am_out, v.pm_in, v.pm_out].every(t => /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(t || '')))) {
    flash(req, 'error', 'Invalid time format (HH:MM).');
    return res.redirect(`/employees/${id}/edit#schedule`);
  }
  await query(`INSERT INTO schedules (employee_id, am_in, am_out, pm_in, pm_out, rest_days) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE am_in=VALUES(am_in), am_out=VALUES(am_out), pm_in=VALUES(pm_in), pm_out=VALUES(pm_out), rest_days=VALUES(rest_days)`,
  [id, v.am_in, v.am_out, v.pm_in, v.pm_out, v.rest_days]);
  await audit(req, 'update', 'schedule', id, v);
  flash(req, 'success', 'Schedule saved.');
  res.redirect(`/employees/${id}/edit#schedule`);
});

router.post('/employees/:id/leave-credits', requireRole('hr'), async (req, res) => {
  const id = Number(req.params.id);
  const year = Number(req.body.year);
  const vl = Number(req.body.vl_days || 0);
  const sl = Number(req.body.sl_days || 0);
  await query(`INSERT INTO leave_credits (employee_id, year, vl_days, sl_days) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE vl_days = VALUES(vl_days), sl_days = VALUES(sl_days)`, [id, year, vl, sl]);
  await audit(req, 'update', 'leave_credits', id, { year, vl, sl });
  flash(req, 'success', 'Leave credits saved.');
  res.redirect(`/employees/${id}/edit#leaves`);
});

module.exports = router;
