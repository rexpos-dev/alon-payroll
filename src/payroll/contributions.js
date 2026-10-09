// SSS, PhilHealth, Pag-IBIG ug withholding tax. Ang rate tables gikan sa database.
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Monthly shares base sa monthly compensation
function sssMonthly(base, table) {
  if (!table || !table.length || base <= 0) return { ee: 0, er: 0, ec: 0, msc: 0 };
  const rows = [...table].sort((a, b) => Number(a.range_from) - Number(b.range_from));
  let row = rows[0];
  for (const r of rows) if (base >= Number(r.range_from)) row = r;
  return { ee: Number(row.ee), er: Number(row.er), ec: Number(row.ec), msc: Number(row.msc) };
}

function philhealthMonthly(base, rate) {
  if (!rate || base <= 0) return { ee: 0, er: 0 };
  const b = Math.min(Math.max(base, Number(rate.floor_salary)), Number(rate.ceiling_salary));
  const total = r2(b * Number(rate.rate));
  const ee = r2(total / 2);
  return { ee, er: r2(total - ee) };
}

function pagibigMonthly(base, rate) {
  if (!rate || base <= 0) return { ee: 0, er: 0 };
  const b = Math.min(base, Number(rate.max_fund_salary));
  const eeRate = base <= Number(rate.low_threshold) ? Number(rate.ee_rate_low) : Number(rate.ee_rate);
  return { ee: r2(b * eeRate), er: r2(b * Number(rate.er_rate)) };
}

/**
 * Pila ang ikaltas niining cut-off.
 * mode: 'split' (tunga kada cut-off), 'first', 'second'
 * prior: kantidad nga nakaltas na sa laing cut-off sa parehas nga bulan
 */
function cutoffShare(monthly, cutoff, mode, prior) {
  if (monthly <= 0) return 0;
  if (mode === 'split') {
    if (cutoff === '1st') return r2(monthly / 2);
    const already = prior === null || prior === undefined ? r2(monthly / 2) : Number(prior);
    return r2(Math.max(0, monthly - already));
  }
  const target = mode === 'first' ? '1st' : '2nd';
  if (cutoff !== target) return 0;
  return r2(Math.max(0, monthly - Number(prior || 0)));
}

// TRAIN withholding tax: fixed + rate x (taxable - range_from) sa bracket diin nahulog
function withholdingTax(taxable, rows) {
  if (!rows || !rows.length || taxable <= 0) return 0;
  const sorted = [...rows].sort((a, b) => Number(a.range_from) - Number(b.range_from));
  let row = sorted[0];
  for (const r of sorted) if (taxable > Number(r.range_from)) row = r;
  const tax = Number(row.fixed_tax) + Number(row.rate) * (taxable - Number(row.range_from));
  return r2(Math.max(0, tax));
}

module.exports = { sssMonthly, philhealthMonthly, pagibigMonthly, cutoffShare, withholdingTax, r2 };
