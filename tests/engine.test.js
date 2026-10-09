const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDay, toMin } = require('../src/payroll/dtr');
const { sssMonthly, philhealthMonthly, pagibigMonthly, cutoffShare, withholdingTax } = require('../src/payroll/contributions');
const { computePayslip } = require('../src/payroll/engine');
const { sssRows2025 } = require('../db/seed');

const sched = { am_in: '08:00', am_out: '12:00', pm_in: '13:00', pm_out: '17:00', rest_days: 'Sun' };
const taxSemi = [
  { range_from: 0, fixed_tax: 0, rate: 0 }, { range_from: 10417, fixed_tax: 0, rate: 0.15 },
  { range_from: 16667, fixed_tax: 937.5, rate: 0.2 }, { range_from: 33333, fixed_tax: 4270.7, rate: 0.25 },
  { range_from: 83333, fixed_tax: 16770.7, rate: 0.3 }, { range_from: 333333, fixed_tax: 91770.7, rate: 0.35 },
];
const tables = {
  sss: sssRows2025(),
  philhealth: { rate: 0.05, floor_salary: 10000, ceiling_salary: 100000 },
  pagibig: { low_threshold: 1500, ee_rate_low: 0.01, ee_rate: 0.02, er_rate: 0.02, max_fund_salary: 10000 },
  taxSemi,
};
const premiums = { ot: 1.25, nd: 0.1, rest_day: 1.3, special: 1.3, regular_holiday: 2, holiday_ot: 1.3 };

test('toMin parses 24h and AM/PM', () => {
  assert.equal(toMin('08:30'), 510);
  assert.equal(toMin('5:00 PM'), 1020);
  assert.equal(toMin('12:15 AM'), 15);
  assert.equal(toMin(''), null);
});

test('full regular day', () => {
  const d = summarizeDay({ am_in: '08:00', am_out: '12:00', pm_in: '13:00', pm_out: '17:00' }, sched, { date: '2026-10-05' });
  assert.equal(d.day_type, 'regular');
  assert.equal(d.days_worked, 1);
  assert.equal(d.absent_days, 0);
  assert.equal(d.reg_hours, 8);
  assert.equal(d.late_min, 0);
  assert.equal(d.ot_hours, 0);
});

test('late, undertime and OT', () => {
  const d = summarizeDay({ am_in: '08:15', am_out: '12:00', pm_in: '13:05', pm_out: '19:00' }, sched, { date: '2026-10-05' });
  assert.equal(d.late_min, 20);
  assert.equal(d.undertime_min, 0);
  assert.equal(d.ot_hours, 2);
  const u = summarizeDay({ am_in: '08:00', am_out: '12:00', pm_in: '13:00', pm_out: '16:30' }, sched, { date: '2026-10-05' });
  assert.equal(u.undertime_min, 30);
});

test('two punches only (continuous) counts whole day', () => {
  const d = summarizeDay({ am_in: '07:55', pm_out: '17:00' }, sched, { date: '2026-10-05' });
  assert.equal(d.days_worked, 1);
  assert.equal(d.reg_hours, 8);
  assert.equal(d.late_min, 0);
});

test('half day absent, whole day absent, rest day, holiday, leave', () => {
  assert.equal(summarizeDay({ pm_in: '13:00', pm_out: '17:00' }, sched, { date: '2026-10-05' }).absent_days, 0.5);
  assert.equal(summarizeDay({}, sched, { date: '2026-10-05' }).absent_days, 1);
  assert.equal(summarizeDay({}, sched, { date: '2026-10-04' }).day_type, 'rest'); // Sunday
  assert.equal(summarizeDay({}, sched, { date: '2026-10-04' }).absent_days, 0);
  assert.equal(summarizeDay({}, sched, { date: '2026-11-30', holidayType: 'regular' }).absent_days, 0);
  assert.equal(summarizeDay({}, sched, { date: '2026-10-05', leaveType: 'VL' }).absent_days, 0);
});

test('night differential across midnight', () => {
  const night = { am_in: '22:00', am_out: '02:00', pm_in: '03:00', pm_out: '07:00', rest_days: 'Sun' };
  const d = summarizeDay({ am_in: '22:00', am_out: '02:00', pm_in: '03:00', pm_out: '07:00' }, night, { date: '2026-10-05' });
  assert.equal(d.nd_hours, 7); // 22-02 = 4, 03-06 = 3
  assert.equal(d.reg_hours, 8);
});

test('SSS 2025 brackets', () => {
  assert.deepEqual(sssMonthly(4000, tables.sss), { ee: 250, er: 500, ec: 10, msc: 5000 });
  assert.equal(sssMonthly(20000, tables.sss).ee, 1000);
  assert.equal(sssMonthly(20240, tables.sss).ee, 1000);
  assert.equal(sssMonthly(20250, tables.sss).ee, 1025);
  assert.equal(sssMonthly(80000, tables.sss).ee, 1750);
  assert.equal(sssMonthly(15000, tables.sss).ec, 30);
});

test('PhilHealth floor/ceiling and Pag-IBIG cap', () => {
  assert.equal(philhealthMonthly(8000, tables.philhealth).ee, 250);
  assert.equal(philhealthMonthly(30000, tables.philhealth).ee, 750);
  assert.equal(philhealthMonthly(150000, tables.philhealth).ee, 2500);
  assert.equal(pagibigMonthly(30000, tables.pagibig).ee, 200);
  assert.equal(pagibigMonthly(1500, tables.pagibig).ee, 15);
});

test('cut-off split', () => {
  assert.equal(cutoffShare(1500, '1st', 'split', null), 750);
  assert.equal(cutoffShare(1501, '2nd', 'split', 750.5), 750.5);
  assert.equal(cutoffShare(1500, '1st', 'second', 0), 0);
  assert.equal(cutoffShare(1500, '2nd', 'second', 0), 1500);
});

test('withholding tax semi-monthly incl. 30% bracket (Excel bug #1)', () => {
  assert.equal(withholdingTax(10000, taxSemi), 0);
  assert.equal(withholdingTax(15000, taxSemi), 687.45);
  assert.equal(withholdingTax(20000, taxSemi), 1604.1);
  assert.equal(withholdingTax(100000, taxSemi), 21770.8);
});

const baseEmp = {
  pay_type: 'semi', monthly_basic: 30000, daily_rate: 0, days_per_cutoff: 13, tax_class: 'above_min',
  track_dtr: 1, sss_enabled: 1, philhealth_enabled: 1, pagibig_enabled: 1,
};

test('semi-monthly payslip end to end', () => {
  const days = [
    { day_type: 'regular', days_worked: 0, absent_days: 1, ot_hours: 0, nd_hours: 0, late_min: 0, undertime_min: 0 },
    { day_type: 'regular', days_worked: 1, absent_days: 0, ot_hours: 2, ot_approved: 1, nd_hours: 0, late_min: 15, undertime_min: 0 },
    { day_type: 'regular', days_worked: 1, absent_days: 0, ot_hours: 3, ot_approved: 0, nd_hours: 0, late_min: 0, undertime_min: 0 },
  ];
  const r = computePayslip({
    employee: baseEmp, period: { cutoff: '1st' }, days, premiums, tables, contribMode: 'split',
    payItems: [
      { pay_item_id: 1, code: 'F_MEAL', name: 'Meal', kind: 'fixed', taxable: 0, amount: 500 },
      { pay_item_id: 2, code: 'D_CASHADV', name: 'Cash Advance', kind: 'deduction', taxable: 0, amount: 100 },
    ],
    adjustments: [], loans: [{ id: 9, loan_type: 'SSS', amortization: 850, balance: 600 }],
  });
  const daily = 15000 / 13;
  const t = r.totals;
  // basic 15000 - 1 day absent - 15 min late; OT 2h approved only
  const expectedGross = 15000 - daily - 15 * daily / 480 + 2 * (daily / 8) * 1.25;
  assert.ok(Math.abs(t.gross_pay - expectedGross) < 0.02, `gross ${t.gross_pay} vs ${expectedGross}`);
  assert.equal(t.sss_ee, 750);       // 1500/2
  assert.equal(t.philhealth_ee, 375); // 750/2
  assert.equal(t.pagibig_ee, 100);
  assert.equal(t.nontaxable_allowances, 500);
  assert.equal(t.other_deductions, 100);
  assert.equal(t.loan_deductions, 600); // only the remaining balance is deducted
  const expectedTax = withholdingTax(t.gross_pay - 1225, taxSemi);
  assert.equal(t.withholding_tax, expectedTax);
  const net = t.gross_pay + 500 - 1225 - expectedTax - 100 - 600;
  assert.ok(Math.abs(t.net_pay - net) < 0.011);
});

test('minimum wage earner has no tax; disabled contributions are zero', () => {
  const r = computePayslip({
    employee: { ...baseEmp, tax_class: 'mwe', sss_enabled: 0, track_dtr: 0 }, period: { cutoff: '2nd' }, days: [],
    premiums, tables, contribMode: 'split', payItems: [], adjustments: [], loans: [],
  });
  assert.equal(r.totals.withholding_tax, 0);
  assert.equal(r.totals.sss_ee, 0);
  assert.equal(r.totals.gross_pay, 15000);
});

test('daily-paid employee: days worked, paid holiday, holiday work premium', () => {
  const emp = { ...baseEmp, pay_type: 'daily', daily_rate: 800 };
  const days = [
    { day_type: 'regular', days_worked: 1, absent_days: 0 },
    { day_type: 'regular', days_worked: 0.5, absent_days: 0.5 },
    { day_type: 'regular_holiday', days_worked: 1, absent_days: 0 },
    { day_type: 'special', days_worked: 1, absent_days: 0 },
  ];
  const r = computePayslip({
    employee: emp, period: { cutoff: '1st' }, days, unworkedRegularHolidays: 1, premiums, tables,
    contribMode: 'split', payItems: [], adjustments: [], loans: [],
  });
  // 1.5 days x 800 + unworked reg hol 800 + reg hol worked 1600 + special worked 1040
  assert.equal(r.totals.gross_pay, 1200 + 800 + 1600 + 1040);
});
