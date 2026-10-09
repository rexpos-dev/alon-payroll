const express = require('express');
const { query, one, tx } = require('../db');
const { requireRole, flash } = require('../middleware');
const { audit, diff } = require('../audit');

const router = express.Router();

// ---------- Company ----------
router.get('/settings', requireRole('admin'), async (req, res) => {
  const company = await one('SELECT * FROM company WHERE id = 1');
  const premiums = await query('SELECT * FROM premium_rates ORDER BY code');
  res.render('settings/company', { title: 'Settings', company, premiums });
});

router.post('/settings/company', requireRole('admin'), async (req, res) => {
  const before = await one('SELECT * FROM company WHERE id = 1');
  const f = ['name', 'address', 'contact', 'prepared_by', 'checked_by', 'approved_by', 'contrib_mode'];
  const v = Object.fromEntries(f.map(k => [k, String(req.body[k] || '').trim()]));
  if (!['split', 'first', 'second'].includes(v.contrib_mode)) v.contrib_mode = 'split';
  if (!v.name) v.name = 'COMPANY NAME';
  await query(`UPDATE company SET ${f.map(k => `${k} = ?`).join(', ')} WHERE id = 1`, f.map(k => v[k]));
  await audit(req, 'update', 'company', 1, diff(before, v, f));
  flash(req, 'success', 'Company settings saved.');
  res.redirect('/settings');
});

router.post('/settings/premiums', requireRole('admin'), async (req, res) => {
  const rows = await query('SELECT * FROM premium_rates');
  const changes = {};
  for (const p of rows) {
    const v = Number(req.body[`p_${p.code}`]);
    if (Number.isFinite(v) && v >= 0 && v !== Number(p.multiplier)) {
      await query('UPDATE premium_rates SET multiplier = ? WHERE code = ?', [v, p.code]);
      changes[p.code] = { from: p.multiplier, to: v };
    }
  }
  if (Object.keys(changes).length) await audit(req, 'update', 'premium_rates', null, changes);
  flash(req, 'success', 'OT/holiday multipliers saved.');
  res.redirect('/settings');
});

// ---------- Departments ug positions ----------
const LISTS = { departments: 'Departments', positions: 'Positions' };

router.get('/settings/lists', requireRole('admin', 'hr'), async (req, res) => {
  const data = {};
  for (const t of Object.keys(LISTS)) data[t] = await query(`SELECT * FROM ${t} ORDER BY active DESC, name`);
  res.render('settings/lists', { title: 'Departments and Positions', data, LISTS });
});

router.post('/settings/lists/:table', requireRole('admin', 'hr'), async (req, res) => {
  const t = req.params.table;
  if (!LISTS[t]) return res.redirect('/settings/lists');
  const name = String(req.body.name || '').trim();
  if (name) {
    await query(`INSERT INTO ${t} (name) VALUES (?) ON DUPLICATE KEY UPDATE active = 1`, [name]);
    await audit(req, 'create', t, null, { name });
  }
  res.redirect('/settings/lists');
});

router.post('/settings/lists/:table/:id/toggle', requireRole('admin', 'hr'), async (req, res) => {
  const t = req.params.table;
  if (LISTS[t]) {
    await query(`UPDATE ${t} SET active = 1 - active WHERE id = ?`, [req.params.id]);
    await audit(req, 'toggle', t, req.params.id);
  }
  res.redirect('/settings/lists');
});

// ---------- Pay items ----------
router.get('/settings/pay-items', requireRole('admin'), async (req, res) => {
  const rows = await query("SELECT * FROM pay_items ORDER BY FIELD(kind,'fixed','variable','deduction'), sort_order, name");
  res.render('settings/pay_items', { title: 'Allowances and Deductions', rows });
});

router.post('/settings/pay-items', requireRole('admin'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const kind = req.body.kind;
  if (!name || !['fixed', 'variable', 'deduction'].includes(kind)) {
    flash(req, 'error', 'Name and type are required.');
    return res.redirect('/settings/pay-items');
  }
  const prefix = { fixed: 'F_', variable: 'V_', deduction: 'D_' }[kind];
  let code = (prefix + name.toUpperCase().replace(/[^A-Z0-9]+/g, '')).slice(0, 26);
  if (await one('SELECT id FROM pay_items WHERE code = ?', [code])) code = `${code}_${Date.now() % 1000}`;
  const r = await query('INSERT INTO pay_items (code, name, kind, taxable, sort_order) VALUES (?,?,?,?,99)', [code, name, kind, req.body.taxable ? 1 : 0]);
  await audit(req, 'create', 'pay_item', r.insertId, { code, name, kind });
  flash(req, 'success', 'Item added.');
  res.redirect('/settings/pay-items');
});

router.post('/settings/pay-items/:id', requireRole('admin'), async (req, res) => {
  const before = await one('SELECT * FROM pay_items WHERE id = ?', [req.params.id]);
  if (!before) return res.redirect('/settings/pay-items');
  const v = {
    name: String(req.body.name || before.name).trim(),
    taxable: req.body.taxable ? 1 : 0,
    active: req.body.active ? 1 : 0,
    sort_order: Number(req.body.sort_order || 0),
  };
  await query('UPDATE pay_items SET name = ?, taxable = ?, active = ?, sort_order = ? WHERE id = ?', [v.name, v.taxable, v.active, v.sort_order, before.id]);
  await audit(req, 'update', 'pay_item', before.id, diff(before, v, Object.keys(v)));
  flash(req, 'success', `${v.name} updated.`);
  res.redirect('/settings/pay-items');
});

// ---------- Government rate tables ----------
router.get('/settings/rates', requireRole('admin'), async (req, res) => {
  const sssDates = await query('SELECT effective_date, COUNT(*) AS n FROM sss_table GROUP BY effective_date ORDER BY effective_date DESC');
  const sssDate = req.query.sss || (sssDates[0] ? sssDates[0].effective_date : null);
  const sss = sssDate ? await query('SELECT * FROM sss_table WHERE effective_date = ? ORDER BY range_from', [sssDate]) : [];
  const philhealth = await query('SELECT * FROM philhealth_rates ORDER BY effective_date DESC');
  const pagibig = await query('SELECT * FROM pagibig_rates ORDER BY effective_date DESC');
  const tax = await query('SELECT * FROM tax_table ORDER BY effective_date DESC, period, range_from');
  res.render('settings/rates', { title: 'Government Rates', sssDates, sssDate, sss, philhealth, pagibig, tax });
});

router.post('/settings/rates/philhealth', requireRole('admin'), async (req, res) => {
  const b = req.body;
  const v = [b.effective_date, Number(b.rate), Number(b.floor_salary), Number(b.ceiling_salary)];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effective_date || '') || !(v[1] > 0 && v[1] < 1) || !(v[2] > 0) || !(v[3] > v[2])) {
    flash(req, 'error', 'Invalid PhilHealth values (enter the rate as a decimal, for example 0.05).');
  } else {
    await query('INSERT INTO philhealth_rates (effective_date, rate, floor_salary, ceiling_salary) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE rate=VALUES(rate), floor_salary=VALUES(floor_salary), ceiling_salary=VALUES(ceiling_salary)', v);
    await audit(req, 'update', 'philhealth_rates', b.effective_date, v);
    flash(req, 'success', 'PhilHealth rate saved.');
  }
  res.redirect('/settings/rates');
});

router.post('/settings/rates/pagibig', requireRole('admin'), async (req, res) => {
  const b = req.body;
  const v = [b.effective_date, Number(b.low_threshold), Number(b.ee_rate_low), Number(b.ee_rate), Number(b.er_rate), Number(b.max_fund_salary)];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effective_date || '') || v.slice(1).some(x => !Number.isFinite(x) || x < 0)) {
    flash(req, 'error', 'Invalid Pag-IBIG values.');
  } else {
    await query(`INSERT INTO pagibig_rates (effective_date, low_threshold, ee_rate_low, ee_rate, er_rate, max_fund_salary) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE low_threshold=VALUES(low_threshold), ee_rate_low=VALUES(ee_rate_low), ee_rate=VALUES(ee_rate), er_rate=VALUES(er_rate), max_fund_salary=VALUES(max_fund_salary)`, v);
    await audit(req, 'update', 'pagibig_rates', b.effective_date, v);
    flash(req, 'success', 'Pag-IBIG rate saved.');
  }
  res.redirect('/settings/rates');
});

// Bag-ong SSS schedule: usa ka linya kada bracket "range_from,range_to,msc,ee,er,ec"
router.post('/settings/rates/sss', requireRole('admin'), async (req, res) => {
  const date = req.body.effective_date;
  const lines = String(req.body.rows || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const l of lines) {
    const p = l.split(/[,\t]/).map(x => x.trim().replace(/,/g, ''));
    const n = p.map(x => (x === '' ? null : Number(x)));
    if (p.length < 6 || [n[0], n[2], n[3], n[4], n[5]].some(x => !Number.isFinite(x))) {
      flash(req, 'error', `Invalid line: "${l}"`);
      return res.redirect('/settings/rates');
    }
    rows.push(n.slice(0, 6));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !rows.length) {
    flash(req, 'error', 'Effective date and brackets are required.');
    return res.redirect('/settings/rates');
  }
  await tx(async conn => {
    await conn.q('DELETE FROM sss_table WHERE effective_date = ?', [date]);
    for (const r of rows) await conn.q('INSERT INTO sss_table (effective_date, range_from, range_to, msc, ee, er, ec) VALUES (?,?,?,?,?,?,?)', [date, ...r]);
  });
  await audit(req, 'update', 'sss_table', date, { brackets: rows.length });
  flash(req, 'success', `SSS schedule saved (${rows.length} brackets).`);
  res.redirect(`/settings/rates?sss=${date}`);
});

// Bag-ong tax table: "period,range_from,fixed_tax,rate"
router.post('/settings/rates/tax', requireRole('admin'), async (req, res) => {
  const date = req.body.effective_date;
  const lines = String(req.body.rows || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const l of lines) {
    const p = l.split(/[,\t]/).map(x => x.trim());
    const n = p.slice(1).map(Number);
    if (!['semi', 'monthly'].includes(p[0]) || n.length < 3 || n.some(x => !Number.isFinite(x))) {
      flash(req, 'error', `Invalid line: "${l}"`);
      return res.redirect('/settings/rates');
    }
    rows.push([p[0], ...n.slice(0, 3)]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !rows.length) {
    flash(req, 'error', 'Effective date and brackets are required.');
    return res.redirect('/settings/rates');
  }
  await tx(async conn => {
    await conn.q('DELETE FROM tax_table WHERE effective_date = ?', [date]);
    for (const r of rows) await conn.q('INSERT INTO tax_table (effective_date, period, range_from, fixed_tax, rate) VALUES (?,?,?,?,?)', [date, ...r]);
  });
  await audit(req, 'update', 'tax_table', date, { brackets: rows.length });
  flash(req, 'success', `Tax table saved (${rows.length} brackets).`);
  res.redirect('/settings/rates');
});

// ---------- Audit log ----------
router.get('/audit', requireRole('admin', 'approver'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const entity = String(req.query.entity || '');
  const params = [];
  let where = '1=1';
  if (entity) { where += ' AND a.entity = ?'; params.push(entity); }
  const rows = await query(`SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where} ORDER BY a.id DESC LIMIT 100 OFFSET ?`, [...params, (page - 1) * 100]);
  const entities = await query('SELECT DISTINCT entity FROM audit_logs ORDER BY entity');
  res.render('settings/audit', { title: 'Audit Log', rows, page, entity, entities });
});

module.exports = router;
