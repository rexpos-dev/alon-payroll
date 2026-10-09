const express = require('express');
const { query, one } = require('../db');

const router = express.Router();
const fmt = d => new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });

router.get('/', async (req, res) => {
  const emp = await one("SELECT COUNT(*) AS active FROM employees WHERE status = 'Active'");
  const loans = await one("SELECT COUNT(*) AS c, COALESCE(SUM(balance),0) AS bal FROM loans WHERE status = 'active'");
  const periods = await query(`SELECT p.*, COUNT(s.id) AS slips, COALESCE(SUM(s.net_pay),0) AS net
    FROM payroll_periods p LEFT JOIN payslips s ON s.period_id = p.id
    GROUP BY p.id ORDER BY p.date_from DESC LIMIT 6`);
  const pending = await one("SELECT COUNT(*) AS c FROM payroll_periods WHERE status = 'computed'");
  const trend = (await query(`SELECT p.id, p.date_from, p.date_to, SUM(s.gross_pay) AS gross, SUM(s.net_pay) AS net
    FROM payroll_periods p JOIN payslips s ON s.period_id = p.id
    GROUP BY p.id ORDER BY p.date_from DESC LIMIT 8`)).reverse();
  const byDept = await query(`SELECT COALESCE(d.name, 'No department') AS name, COUNT(*) AS c
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.status = 'Active' GROUP BY d.id, d.name ORDER BY c DESC`);
  const latest = await one(`SELECT p.id, p.date_from, p.date_to,
      COALESCE(SUM(s.sss_ee),0) AS sss, COALESCE(SUM(s.philhealth_ee),0) AS ph, COALESCE(SUM(s.pagibig_ee),0) AS pi,
      COALESCE(SUM(s.withholding_tax),0) AS tax, COALESCE(SUM(s.loan_deductions),0) AS loan, COALESCE(SUM(s.other_deductions),0) AS other
    FROM payroll_periods p JOIN payslips s ON s.period_id = p.id
    GROUP BY p.id ORDER BY p.date_from DESC LIMIT 1`);
  const charts = {
    trend: trend.map(t => ({ label: `${fmt(t.date_from)}–${fmt(t.date_to)}`, gross: Number(t.gross), net: Number(t.net) })),
    dept: byDept.map(d => ({ name: d.name, c: Number(d.c) })),
    deductions: latest ? {
      period: `${fmt(latest.date_from)}–${fmt(latest.date_to)}`,
      items: [['SSS', latest.sss], ['PhilHealth', latest.ph], ['Pag-IBIG', latest.pi], ['Tax', latest.tax], ['Loans', latest.loan], ['Other', latest.other]]
        .map(([name, v]) => ({ name, v: Number(v) })),
    } : null,
  };
  const grossTotal = trend.length ? Number(trend[trend.length - 1].gross) : 0;
  const prevGross = trend.length > 1 ? Number(trend[trend.length - 2].gross) : 0;
  res.render('dashboard', { title: 'Dashboard', emp, loans, periods, pending, charts, grossTotal, prevGross });
});

module.exports = router;
