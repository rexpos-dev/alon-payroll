// Default data: government rate tables, premiums, pay items, departments.
// Ang matag block mo-seed lang kung walay sulod ang table, busa safe dagan-on balik.

// SSS schedule effective 2025-01-01: 15% sa MSC (EE 5%, ER 10%),
// MSC 5,000 hangtod 35,000 sa 500 nga brackets; EC 10 (MSC < 15,000) o 30.
function sssRows2025() {
  const rows = [];
  for (let msc = 5000; msc <= 35000; msc += 500) {
    const from = msc === 5000 ? 0 : msc - 250;
    const to = msc === 35000 ? null : msc + 249.99;
    rows.push({
      effective_date: '2025-01-01',
      range_from: from,
      range_to: to,
      msc,
      ee: +(msc * 0.05).toFixed(2),
      er: +(msc * 0.10).toFixed(2),
      ec: msc < 15000 ? 10 : 30,
    });
  }
  return rows;
}

// BIR withholding tax (TRAIN, effective 2023-01-01)
const TAX_2023 = [
  // semi-monthly
  ['semi', 0, 0, 0],
  ['semi', 10417, 0, 0.15],
  ['semi', 16667, 937.5, 0.20],
  ['semi', 33333, 4270.7, 0.25],
  ['semi', 83333, 16770.7, 0.30],
  ['semi', 333333, 91770.7, 0.35],
  // monthly
  ['monthly', 0, 0, 0],
  ['monthly', 20833, 0, 0.15],
  ['monthly', 33333, 1875, 0.20],
  ['monthly', 66667, 8541.8, 0.25],
  ['monthly', 166667, 33541.8, 0.30],
  ['monthly', 666667, 183541.8, 0.35],
];

const PREMIUMS = [
  ['ot', 'Overtime (regular day)', 1.25],
  ['nd', 'Night differential (added to hourly rate)', 0.10],
  ['rest_day', 'Work on rest day', 1.30],
  ['special', 'Work on special holiday', 1.30],
  ['regular_holiday', 'Work on regular holiday', 2.00],
  ['holiday_ot', 'OT multiplier on holiday/rest day', 1.30],
];

const PAY_ITEMS = [
  ['F_MEAL', 'Meal', 'fixed'], ['F_TRANSPO', 'Transportation', 'fixed'], ['F_LAUNDRY', 'Laundry', 'fixed'],
  ['F_UNIFORM', 'Uniform', 'fixed'], ['F_MEDICAL', 'Medical', 'fixed'], ['F_RICE', 'Rice Subsidy', 'fixed'],
  ['F_RENT', 'Rent', 'fixed'], ['F_CASH', 'Cash', 'fixed'],
  ['V_MEAL', 'Meal', 'variable'], ['V_TRANSPO', 'Transportation', 'variable'], ['V_LAUNDRY', 'Laundry', 'variable'],
  ['V_UNIFORM', 'Uniform', 'variable'], ['V_MEDICAL', 'Medical', 'variable'], ['V_RICE', 'Rice Subsidy', 'variable'],
  ['V_RENT', 'Rent', 'variable'], ['V_CASH', 'Cash', 'variable'],
  ['D_CASHADV', 'Cash Advance', 'deduction'], ['D_VALE', 'Vale', 'deduction'],
  ['D_CARLOAN', 'Comp Car Loan', 'deduction'], ['D_CASHLOAN', 'Comp Cash Loan', 'deduction'],
  ['D_HOUSELOAN', 'Comp House Loan', 'deduction'], ['D_ADJ', 'Adjustment', 'deduction'],
];

const DEPARTMENTS = ['HR Department', 'Finance Department', 'Accounting Department', 'Tax Department'];
const POSITIONS = ['EMPLOYEE'];

async function isEmpty(conn, table) {
  const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${table}`);
  return rows[0].c === 0;
}

async function seed(conn) {
  const done = [];
  if (await isEmpty(conn, 'company')) {
    await conn.query("INSERT INTO company (id, name, address, contact, prepared_by, checked_by, approved_by) VALUES (1, 'COMPANY NAME', 'ADDRESS', 'CONTACT NO.', '', '', '')");
    done.push('company');
  }
  if (await isEmpty(conn, 'sss_table')) {
    for (const r of sssRows2025()) {
      await conn.query('INSERT INTO sss_table (effective_date, range_from, range_to, msc, ee, er, ec) VALUES (?,?,?,?,?,?,?)',
        [r.effective_date, r.range_from, r.range_to, r.msc, r.ee, r.er, r.ec]);
    }
    done.push('sss_table');
  }
  if (await isEmpty(conn, 'philhealth_rates')) {
    await conn.query("INSERT INTO philhealth_rates (effective_date, rate, floor_salary, ceiling_salary) VALUES ('2024-01-01', 0.05, 10000, 100000)");
    done.push('philhealth_rates');
  }
  if (await isEmpty(conn, 'pagibig_rates')) {
    await conn.query("INSERT INTO pagibig_rates (effective_date, low_threshold, ee_rate_low, ee_rate, er_rate, max_fund_salary) VALUES ('2024-02-01', 1500, 0.01, 0.02, 0.02, 10000)");
    done.push('pagibig_rates');
  }
  if (await isEmpty(conn, 'tax_table')) {
    for (const [period, from, fixed, rate] of TAX_2023) {
      await conn.query("INSERT INTO tax_table (effective_date, period, range_from, fixed_tax, rate) VALUES ('2023-01-01',?,?,?,?)", [period, from, fixed, rate]);
    }
    done.push('tax_table');
  }
  if (await isEmpty(conn, 'premium_rates')) {
    for (const p of PREMIUMS) await conn.query('INSERT INTO premium_rates (code, label, multiplier) VALUES (?,?,?)', p);
    done.push('premium_rates');
  }
  if (await isEmpty(conn, 'pay_items')) {
    let i = 0;
    for (const [code, name, kind] of PAY_ITEMS) {
      await conn.query('INSERT INTO pay_items (code, name, kind, taxable, sort_order) VALUES (?,?,?,0,?)', [code, name, kind, i++]);
    }
    done.push('pay_items');
  }
  if (await isEmpty(conn, 'departments')) {
    for (const d of DEPARTMENTS) await conn.query('INSERT INTO departments (name) VALUES (?)', [d]);
    done.push('departments');
  }
  if (await isEmpty(conn, 'positions')) {
    for (const p of POSITIONS) await conn.query('INSERT INTO positions (name) VALUES (?)', [p]);
    done.push('positions');
  }
  return done;
}

module.exports = { seed, sssRows2025 };
