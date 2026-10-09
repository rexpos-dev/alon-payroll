// Mo-load sa data gikan sa database ug mo-compute sa tanang payslip sa usa ka period.
const { query, one, tx } = require('../db');
const { computePayslip } = require('./engine');
const { summarizeDay, isRestDay } = require('./dtr');

function datesBetween(from, to) {
  const out = [];
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  const end = Date.UTC(y2, m2 - 1, d2);
  for (let t = Date.UTC(y1, m1 - 1, d1); t <= end; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const DEFAULT_SCHED = { am_in: '08:00:00', am_out: '12:00:00', pm_in: '13:00:00', pm_out: '17:00:00', rest_days: 'Sun' };

async function loadTables(asOf) {
  const sssDate = await one('SELECT MAX(effective_date) AS d FROM sss_table WHERE effective_date <= ?', [asOf]);
  const sss = sssDate && sssDate.d ? await query('SELECT * FROM sss_table WHERE effective_date = ? ORDER BY range_from', [sssDate.d]) : [];
  const philhealth = await one('SELECT * FROM philhealth_rates WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1', [asOf]);
  const pagibig = await one('SELECT * FROM pagibig_rates WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1', [asOf]);
  const taxDate = await one("SELECT MAX(effective_date) AS d FROM tax_table WHERE period = 'semi' AND effective_date <= ?", [asOf]);
  const taxSemi = taxDate && taxDate.d ? await query("SELECT * FROM tax_table WHERE period = 'semi' AND effective_date = ? ORDER BY range_from", [taxDate.d]) : [];
  const prem = {};
  for (const p of await query('SELECT code, multiplier FROM premium_rates')) prem[p.code] = Number(p.multiplier);
  const missing = [];
  if (!sss.length) missing.push('SSS table');
  if (!philhealth) missing.push('PhilHealth rate');
  if (!pagibig) missing.push('Pag-IBIG rate');
  if (!taxSemi.length) missing.push('semi-monthly tax table');
  return { tables: { sss, philhealth, pagibig, taxSemi }, premiums: prem, missing };
}

// Ang laing cut-off sa parehas nga bulan (base sa pay date)
async function siblingPeriod(period) {
  const other = period.cutoff === '1st' ? '2nd' : '1st';
  return one(`SELECT * FROM payroll_periods WHERE cutoff = ? AND id <> ?
    AND YEAR(pay_date) = YEAR(?) AND MONTH(pay_date) = MONTH(?) LIMIT 1`, [other, period.id, period.pay_date, period.pay_date]);
}

/**
 * Build the per-day attendance list for an employee: stored DTR rows plus generated rows for missing days.
 */
function buildDays(emp, dates, attByDate, holidayByDate, sched) {
  const days = [];
  let missing = 0;
  let unworkedRegHol = 0;
  for (const date of dates) {
    if (emp.date_hired && date < emp.date_hired) continue;
    const rec = attByDate[date];
    const holidayType = holidayByDate[date] || null;
    if (rec) {
      // I-summarize balik gikan sa punches aron magamit ang bag-ong holidays/schedule
      const s = summarizeDay(rec, sched, { date, holidayType, leaveType: rec.leave_type });
      days.push({ ...s, ot_approved: rec.ot_approved });
      continue;
    }
    // Walay DTR record niini nga adlaw
    const s = summarizeDay({}, sched, { date, holidayType });
    if (s.day_type === 'regular') missing += 1;
    days.push({ ...s, ot_approved: 0 });
  }
  // Regular holiday nga wala nagtrabaho ug dili rest day (bayad sa daily-paid)
  for (const date of dates) {
    if (holidayByDate[date] !== 'regular') continue;
    if (isRestDay(date, sched.rest_days)) continue;
    const rec = attByDate[date];
    if (!rec || Number(rec.days_worked) === 0) unworkedRegHol += 1;
  }
  return { days, missing, unworkedRegHol };
}

async function computePeriod(periodId) {
  const period = await one('SELECT * FROM payroll_periods WHERE id = ?', [periodId]);
  if (!period) throw new Error('Period not found.');
  if (['approved', 'posted'].includes(period.status)) throw new Error('The period is already approved or posted and cannot be recomputed.');

  const { tables, premiums, missing } = await loadTables(period.date_to);
  if (missing.length) throw new Error('Missing rate tables: ' + missing.join(', '));
  const company = await one('SELECT * FROM company WHERE id = 1');
  const contribMode = company ? company.contrib_mode : 'split';
  const sibling = await siblingPeriod(period);

  const employees = await query(`SELECT e.*, s.am_in AS s_am_in, s.am_out AS s_am_out, s.pm_in AS s_pm_in, s.pm_out AS s_pm_out, s.rest_days AS s_rest
    FROM employees e LEFT JOIN schedules s ON s.employee_id = e.id
    WHERE e.status = 'Active' AND (e.date_hired IS NULL OR e.date_hired <= ?) ORDER BY e.last_name, e.first_name`, [period.date_to]);

  const holidays = await query('SELECT holiday_date, type FROM holidays WHERE holiday_date BETWEEN ? AND ?', [period.date_from, period.date_to]);
  const holidayByDate = Object.fromEntries(holidays.map(h => [h.holiday_date, h.type]));
  const dates = datesBetween(period.date_from, period.date_to);

  const allAtt = await query('SELECT * FROM attendance_days WHERE work_date BETWEEN ? AND ?', [period.date_from, period.date_to]);
  const allItems = await query(`SELECT epi.employee_id, epi.pay_item_id, epi.amount, p.code, p.name, p.kind, p.taxable
    FROM employee_pay_items epi JOIN pay_items p ON p.id = epi.pay_item_id WHERE p.active = 1 ORDER BY p.sort_order`);
  const allAdj = await query('SELECT * FROM payroll_adjustments WHERE period_id = ?', [period.id]);
  const allLoans = await query("SELECT * FROM loans WHERE status = 'active' AND balance > 0 AND start_date <= ?", [period.pay_date]);
  const siblingSlips = sibling ? await query('SELECT * FROM payslips WHERE period_id = ?', [sibling.id]) : [];

  const results = [];
  for (const emp of employees) {
    const sched = emp.s_am_in
      ? { am_in: emp.s_am_in, am_out: emp.s_am_out, pm_in: emp.s_pm_in, pm_out: emp.s_pm_out, rest_days: emp.s_rest }
      : DEFAULT_SCHED;
    const attByDate = {};
    for (const a of allAtt.filter(x => x.employee_id === emp.id)) attByDate[a.work_date] = a;

    let days = [];
    let missingDays = 0;
    let unworkedRegHol = 0;
    if (Number(emp.track_dtr) || emp.pay_type === 'daily') {
      const b = buildDays(emp, dates, attByDate, holidayByDate, sched);
      days = b.days;
      missingDays = b.missing;
      unworkedRegHol = b.unworkedRegHol;
    }

    const sib = siblingSlips.find(s => s.employee_id === emp.id) || null;
    const prior = sib || null;
    const result = computePayslip({
      employee: emp,
      period,
      days,
      unworkedRegularHolidays: emp.pay_type === 'daily' ? unworkedRegHol : 0,
      premiums,
      payItems: allItems.filter(i => i.employee_id === emp.id),
      adjustments: allAdj.filter(a => a.employee_id === emp.id),
      loans: allLoans.filter(l => l.employee_id === emp.id),
      tables,
      contribMode,
      prior,
      otherCutoffBasic: sib ? Number(sib.basic_pay) : null,
    });
    if (missingDays > 0 && (Number(emp.track_dtr) || emp.pay_type === 'daily')) {
      result.warnings.push(`${missingDays} workday(s) with no DTR (counted as absent).`);
    }
    results.push({ emp, result });
  }

  await tx(async conn => {
    await conn.q('DELETE FROM payslips WHERE period_id = ?', [period.id]);
    for (const { emp, result } of results) {
      const t = result.totals;
      const ins = await conn.q(`INSERT INTO payslips (period_id, employee_id, basic_pay, gross_pay, taxable_allowances, nontaxable_allowances,
        sss_ee, sss_er, sss_ec, philhealth_ee, philhealth_er, pagibig_ee, pagibig_er, taxable_income, withholding_tax,
        other_deductions, loan_deductions, net_pay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [period.id, emp.id, t.basic_pay, t.gross_pay, t.taxable_allowances, t.nontaxable_allowances,
        t.sss_ee, t.sss_er, t.sss_ec, t.philhealth_ee, t.philhealth_er, t.pagibig_ee, t.pagibig_er, t.taxable_income,
        t.withholding_tax, t.other_deductions, t.loan_deductions, t.net_pay]);
      for (const l of result.lines) {
        await conn.q(`INSERT INTO payslip_lines (payslip_id, section, code, label, qty, unit, rate, amount, taxable, ref_id, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [ins.insertId, l.section, l.code, l.label, l.qty, l.unit, l.rate, l.amount, l.taxable, l.ref_id, l.sort_order]);
      }
    }
    await conn.q("UPDATE payroll_periods SET status = 'computed', computed_at = NOW(), approved_by = NULL, approved_at = NULL WHERE id = ?", [period.id]);
  });

  return results.map(({ emp, result }) => ({
    employee_id: emp.id,
    name: `${emp.last_name}, ${emp.first_name}`,
    net_pay: result.totals.net_pay,
    warnings: result.warnings,
  }));
}

// I-post: i-lock ang period ug ibawas ang loan payments sa balance
async function postPeriod(periodId, userId) {
  return tx(async conn => {
    const [period] = await conn.q('SELECT * FROM payroll_periods WHERE id = ? FOR UPDATE', [periodId]);
    if (!period) throw new Error('Period not found.');
    if (period.status !== 'approved') throw new Error('The period must be approved before it can be posted.');
    const loanLines = await conn.q(`SELECT pl.ref_id AS loan_id, pl.amount FROM payslip_lines pl
      JOIN payslips p ON p.id = pl.payslip_id WHERE p.period_id = ? AND pl.section = 'loan' AND pl.ref_id IS NOT NULL`, [periodId]);
    for (const l of loanLines) {
      await conn.q('INSERT INTO loan_payments (loan_id, period_id, amount) VALUES (?,?,?)', [l.loan_id, periodId, l.amount]);
      await conn.q("UPDATE loans SET balance = GREATEST(0, balance - ?), status = IF(balance <= 0, 'paid', status) WHERE id = ?", [l.amount, l.loan_id]);
    }
    await conn.q("UPDATE payroll_periods SET status = 'posted', posted_by = ?, posted_at = NOW() WHERE id = ?", [userId, periodId]);
    return loanLines.length;
  });
}

module.exports = { computePeriod, postPeriod, loadTables, datesBetween, DEFAULT_SCHED };
