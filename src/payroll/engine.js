// Payroll engine: mo-compute sa payslip sa usa ka employee para sa usa ka cut-off.
// Pure function: tanang data ihatag sa input, walay database dinhi.
const {
  sssMonthly, philhealthMonthly, pagibigMonthly, cutoffShare, withholdingTax, r2,
} = require('./contributions');

function rates(employee) {
  const daily = employee.pay_type === 'semi'
    ? Number(employee.monthly_basic) / 2 / Number(employee.days_per_cutoff || 13)
    : Number(employee.daily_rate);
  return { daily, hourly: daily / 8, perMinute: daily / 8 / 60 };
}

/**
 * input = {
 *   employee, period: { cutoff: '1st'|'2nd' },
 *   days: [{ day_type, leave_type, days_worked, absent_days, ot_hours, ot_approved, nd_hours, late_min, undertime_min }],
 *   unworkedRegularHolidays: number   // daily-paid: regular holidays sa workday nga wala nagtrabaho (bayad 100%)
 *   premiums: { ot, nd, rest_day, special, regular_holiday, holiday_ot },
 *   payItems: [{ pay_item_id, code, name, kind, taxable, amount }],   // recurring
 *   adjustments: [{ kind, label, qty, amount, taxable, pay_item_id }],
 *   loans: [{ id, loan_type, amortization, balance }],
 *   tables: { sss: [], philhealth: {}, pagibig: {}, taxSemi: [] },
 *   contribMode: 'split'|'first'|'second',
 *   prior: { sss_ee, philhealth_ee, pagibig_ee, sss_er, sss_ec, philhealth_er, pagibig_er } | null,
 *   otherCutoffBasic: number|null     // daily-paid: basic sa laing cut-off sa parehas nga bulan
 * }
 */
function computePayslip(input) {
  const emp = input.employee;
  const prem = input.premiums;
  const { daily, hourly, perMinute } = rates(emp);
  const days = input.days || [];
  const trackDtr = !!Number(emp.track_dtr);
  const lines = [];
  const warnings = [];
  let sort = 0;
  const add = (section, code, label, qty, unit, rate, amount, extra = {}) => {
    const amt = r2(amount);
    if (amt === 0 && !extra.keepZero) return;
    lines.push({ section, code, label, qty: qty === null ? null : r2(qty), unit, rate: rate === null ? null : Math.round(rate * 10000) / 10000, amount: amt, taxable: extra.taxable ? 1 : 0, ref_id: extra.ref_id || null, sort_order: sort++ });
  };

  const sum = (pred, field) => days.filter(pred).reduce((a, d) => a + Number(d[field] || 0), 0);
  const isReg = d => d.day_type === 'regular';

  // ---------- Earnings ----------
  if (emp.pay_type === 'semi') {
    add('earning', 'BASIC', 'Basic Pay (semi-monthly)', 1, 'cut-off', Number(emp.monthly_basic) / 2, Number(emp.monthly_basic) / 2, { keepZero: true });
    if (trackDtr) {
      const absent = sum(isReg, 'absent_days');
      add('earning', 'ABSENT', 'Absences', absent, 'day', daily, -absent * daily);
    }
  } else {
    const regDays = sum(isReg, 'days_worked');
    add('earning', 'BASIC', 'Regular Days', regDays, 'day', daily, regDays * daily, { keepZero: true });
    const leaveDays = days.filter(d => d.leave_type && isReg(d)).length;
    add('earning', 'LEAVE', 'Paid Leave (VL/SL)', leaveDays, 'day', daily, leaveDays * daily);
    const unworked = Number(input.unworkedRegularHolidays || 0);
    add('earning', 'REGHOL_UNWORKED', 'Regular Holiday (not worked)', unworked, 'day', daily, unworked * daily);
  }

  if (trackDtr) {
    const late = sum(() => true, 'late_min');
    const ut = sum(() => true, 'undertime_min');
    add('earning', 'LATE', 'Tardiness', late, 'min', perMinute, -late * perMinute);
    add('earning', 'UNDERTIME', 'Undertime', ut, 'min', perMinute, -ut * perMinute);

    // Trabaho sa rest day ug holidays. Para sa monthly-paid (semi), ang regular ug special holiday
    // naa na sa basic, busa ang premium (multiplier - 1) ra ang idugang. Ang rest day bayaran og tibuok.
    const semi = emp.pay_type === 'semi';
    const restDays = sum(d => d.day_type === 'rest', 'days_worked');
    add('earning', 'RESTDAY', 'Rest Day Work', restDays, 'day', daily * prem.rest_day, restDays * daily * prem.rest_day);
    const specDays = sum(d => d.day_type === 'special', 'days_worked');
    const specMult = semi ? prem.special - 1 : prem.special;
    add('earning', 'SPECHOL', 'Special Holiday Work', specDays, 'day', daily * specMult, specDays * daily * specMult);
    const regHolDays = sum(d => d.day_type === 'regular_holiday', 'days_worked');
    const regMult = semi ? prem.regular_holiday - 1 : prem.regular_holiday;
    add('earning', 'REGHOL', 'Regular Holiday Work', regHolDays, 'day', daily * regMult, regHolDays * daily * regMult);

    // OT (approved lang)
    const otOf = type => days.filter(d => d.day_type === type && Number(d.ot_approved)).reduce((a, d) => a + Number(d.ot_hours || 0), 0);
    const otReg = otOf('regular');
    add('earning', 'OT', 'Regular O.T', otReg, 'hr', hourly * prem.ot, otReg * hourly * prem.ot);
    const otRest = otOf('rest');
    const rateRest = hourly * prem.rest_day * prem.holiday_ot;
    add('earning', 'OT_REST', 'Rest Day O.T', otRest, 'hr', rateRest, otRest * rateRest);
    const otSpec = otOf('special');
    const rateSpec = hourly * prem.special * prem.holiday_ot;
    add('earning', 'OT_SPECHOL', 'Spec. Hol. O.T', otSpec, 'hr', rateSpec, otSpec * rateSpec);
    const otRegHol = otOf('regular_holiday');
    const rateRegHol = hourly * prem.regular_holiday * prem.holiday_ot;
    add('earning', 'OT_REGHOL', 'Reg. Hol. O.T', otRegHol, 'hr', rateRegHol, otRegHol * rateRegHol);

    const nd = sum(() => true, 'nd_hours');
    add('earning', 'ND', 'Night Differential', nd, 'hr', hourly * prem.nd, nd * hourly * prem.nd);
  }

  // Earning adjustments
  for (const a of (input.adjustments || []).filter(x => x.kind === 'earning_adj')) {
    const amt = Number(a.qty) * Number(a.amount);
    if (a.taxable) add('earning', 'ADJ_EARN', a.label, a.qty, null, Number(a.amount), amt, { taxable: true });
    else add('allowance', 'ADJ_EARN_NT', a.label, a.qty, null, Number(a.amount), amt);
  }

  const earningLines = lines.filter(l => l.section === 'earning');
  const grossPay = r2(earningLines.reduce((a, l) => a + l.amount, 0));
  const basicPay = r2(earningLines.filter(l => ['BASIC', 'ABSENT', 'LEAVE', 'REGHOL_UNWORKED', 'LATE', 'UNDERTIME'].includes(l.code)).reduce((a, l) => a + l.amount, 0));

  // ---------- Allowances ----------
  for (const it of (input.payItems || []).filter(p => p.kind === 'fixed' && Number(p.amount) !== 0)) {
    add('allowance', it.code, it.name, 1, null, Number(it.amount), Number(it.amount), { taxable: !!Number(it.taxable), ref_id: it.pay_item_id });
  }
  for (const a of (input.adjustments || []).filter(x => x.kind === 'variable')) {
    add('allowance', 'VAR', a.label, a.qty, null, Number(a.amount), Number(a.qty) * Number(a.amount), { taxable: !!Number(a.taxable), ref_id: a.pay_item_id });
  }
  const allowanceLines = lines.filter(l => l.section === 'allowance');
  const taxableAllow = r2(allowanceLines.filter(l => l.taxable).reduce((a, l) => a + l.amount, 0));
  const nontaxAllow = r2(allowanceLines.filter(l => !l.taxable).reduce((a, l) => a + l.amount, 0));

  // ---------- Contributions ----------
  let monthlyBase;
  if (emp.pay_type === 'semi') monthlyBase = Number(emp.monthly_basic);
  else if (input.otherCutoffBasic !== null && input.otherCutoffBasic !== undefined) monthlyBase = basicPay + Number(input.otherCutoffBasic);
  else monthlyBase = basicPay * 2;

  const mode = input.contribMode || 'split';
  const cutoff = input.period.cutoff;
  const prior = input.prior || null;
  const pv = k => (prior ? prior[k] : null);
  const t = input.tables;

  const sssM = Number(emp.sss_enabled) ? sssMonthly(monthlyBase, t.sss) : { ee: 0, er: 0, ec: 0 };
  const phM = Number(emp.philhealth_enabled) ? philhealthMonthly(monthlyBase, t.philhealth) : { ee: 0, er: 0 };
  const piM = Number(emp.pagibig_enabled) ? pagibigMonthly(monthlyBase, t.pagibig) : { ee: 0, er: 0 };

  const contrib = {
    sss_ee: cutoffShare(sssM.ee, cutoff, mode, pv('sss_ee')),
    sss_er: cutoffShare(sssM.er, cutoff, mode, pv('sss_er')),
    sss_ec: cutoffShare(sssM.ec, cutoff, mode, pv('sss_ec')),
    philhealth_ee: cutoffShare(phM.ee, cutoff, mode, pv('philhealth_ee')),
    philhealth_er: cutoffShare(phM.er, cutoff, mode, pv('philhealth_er')),
    pagibig_ee: cutoffShare(piM.ee, cutoff, mode, pv('pagibig_ee')),
    pagibig_er: cutoffShare(piM.er, cutoff, mode, pv('pagibig_er')),
  };
  add('contribution', 'SSS', 'SSS Contribution', null, null, null, contrib.sss_ee);
  add('contribution', 'PHILHEALTH', 'PhilHealth Contribution', null, null, null, contrib.philhealth_ee);
  add('contribution', 'PAGIBIG', 'Pag-IBIG Contribution', null, null, null, contrib.pagibig_ee);
  const eeContrib = r2(contrib.sss_ee + contrib.philhealth_ee + contrib.pagibig_ee);

  // ---------- Tax ----------
  const taxableIncome = r2(Math.max(0, grossPay + taxableAllow - eeContrib));
  const tax = emp.tax_class === 'mwe' ? 0 : withholdingTax(taxableIncome, t.taxSemi);
  add('tax', 'WTAX', 'Withholding Tax', null, null, null, tax);

  // ---------- Deductions ----------
  for (const it of (input.payItems || []).filter(p => p.kind === 'deduction' && Number(p.amount) !== 0)) {
    add('deduction', it.code, it.name, 1, null, Number(it.amount), Number(it.amount), { ref_id: it.pay_item_id });
  }
  for (const a of (input.adjustments || []).filter(x => x.kind === 'deduction' || x.kind === 'deduction_adj')) {
    add('deduction', 'DED', a.label, a.qty, null, Number(a.amount), Number(a.qty) * Number(a.amount), { ref_id: a.pay_item_id });
  }
  const otherDeductions = r2(lines.filter(l => l.section === 'deduction').reduce((a, l) => a + l.amount, 0));

  // ---------- Loans ----------
  for (const loan of input.loans || []) {
    const amt = Math.min(Number(loan.amortization), Number(loan.balance));
    if (amt > 0) add('loan', `LOAN_${loan.loan_type}`, `${loan.loan_type} Loan${loan.reference_no ? ' #' + loan.reference_no : ''}`, null, null, null, amt, { ref_id: loan.id });
  }
  const loanDeductions = r2(lines.filter(l => l.section === 'loan').reduce((a, l) => a + l.amount, 0));

  const netPay = r2(grossPay + taxableAllow + nontaxAllow - eeContrib - tax - otherDeductions - loanDeductions);
  if (netPay < 0) warnings.push('Net pay is negative. Check the deductions and loans.');
  if (grossPay <= 0) warnings.push('Gross pay is zero or negative.');

  return {
    lines,
    warnings,
    totals: {
      basic_pay: basicPay,
      gross_pay: grossPay,
      taxable_allowances: taxableAllow,
      nontaxable_allowances: nontaxAllow,
      ...contrib,
      taxable_income: taxableIncome,
      withholding_tax: tax,
      other_deductions: otherDeductions,
      loan_deductions: loanDeductions,
      net_pay: netPay,
    },
  };
}

module.exports = { computePayslip, rates };
