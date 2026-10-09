// DTR: i-convert ang time in/out sa usa ka adlaw ngadto sa hours, late, undertime, OT ug night diff.
// Pure functions (walay database) aron ma-unit test.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toMin(t) {
  if (t === null || t === undefined || t === '') return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[4] ? m[4].toUpperCase() : null;
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fmtTime(min) {
  if (min === null || min === undefined) return null;
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
}

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

// Kung ang out mas gamay sa in (lapas tungang gabii), dugangi og 24 oras.
function interval(inMin, outMin) {
  if (inMin === null || outMin === null) return null;
  let o = outMin;
  if (o <= inMin) o += 1440;
  return [inMin, o];
}

// Minutes sa interval nga sulod sa 22:00-06:00
function nightMinutes(iv) {
  if (!iv) return 0;
  const [a, b] = iv;
  let total = 0;
  for (const base of [-1440, 0, 1440]) {
    total += overlap(a, b, base + 22 * 60, base + 30 * 60);
  }
  return total;
}

function dayName(dateStr) {
  const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

function isRestDay(dateStr, restDays) {
  const list = String(restDays || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(dayName(dateStr));
}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * @param {object} punches   { am_in, am_out, pm_in, pm_out } (strings 'HH:MM' o null)
 * @param {object} schedule  { am_in, am_out, pm_in, pm_out, rest_days }
 * @param {object} ctx       { date, holidayType: 'regular'|'special'|null, leaveType: 'VL'|'SL'|null }
 */
function summarizeDay(punches, schedule, ctx) {
  // Ang tanang oras i-ihap gikan sa "anchor" (6 ka oras una sa shift start), aron ang
  // night shift ug OT nga lapas tungang gabii mahimong sunod-sunod nga minutes.
  const schedStart = toMin(schedule.am_in);
  const anchor = schedStart - 360;
  const norm = t => (t === null ? null : (t < anchor ? t + 1440 : t));
  const s = {
    amIn: norm(schedStart), amOut: norm(toMin(schedule.am_out)),
    pmIn: norm(toMin(schedule.pm_in)), pmOut: norm(toMin(schedule.pm_out)),
  };
  const p = {
    amIn: norm(toMin(punches.am_in)), amOut: norm(toMin(punches.am_out)),
    pmIn: norm(toMin(punches.pm_in)), pmOut: norm(toMin(punches.pm_out)),
  };

  let dayType = 'regular';
  if (ctx.holidayType === 'regular') dayType = 'regular_holiday';
  else if (ctx.holidayType === 'special') dayType = 'special';
  else if (isRestDay(ctx.date, schedule.rest_days)) dayType = 'rest';

  // Mga worked intervals
  let amIv = null;
  let pmIv = null;
  const continuous = p.amIn !== null && p.pmOut !== null && p.amOut === null && p.pmIn === null;
  if (continuous) {
    // 2 ka punch lang (in ug out): ang break sumala sa schedule
    const full = interval(p.amIn, p.pmOut);
    amIv = [full[0], Math.min(full[1], s.amOut)];
    pmIv = [Math.max(full[0], s.pmIn), full[1]];
    if (amIv[1] <= amIv[0]) amIv = null;
    if (pmIv[1] <= pmIv[0]) pmIv = null;
  } else {
    amIv = interval(p.amIn, p.amOut);
    pmIv = interval(p.pmIn, p.pmOut);
  }

  const schedAm = [s.amIn, s.amOut];
  const schedPm = [s.pmIn, s.pmOut];
  const schedMinutes = (s.amOut - s.amIn) + (s.pmOut - s.pmIn);

  let regMin = 0;
  if (amIv) regMin += overlap(amIv[0], amIv[1], schedAm[0], schedAm[1]) + overlap(amIv[0], amIv[1], schedPm[0], schedPm[1]);
  if (pmIv) regMin += overlap(pmIv[0], pmIv[1], schedPm[0], schedPm[1]) + (continuous ? 0 : overlap(pmIv[0], pmIv[1], schedAm[0], schedAm[1]));
  regMin = Math.min(regMin, schedMinutes);

  const amWorked = !!amIv;
  const pmWorked = !!pmIv;
  const daysWorked = (amWorked ? 0.5 : 0) + (pmWorked ? 0.5 : 0);

  let lateMin = 0;
  let undertimeMin = 0;
  if (amWorked) {
    lateMin += Math.max(0, amIv[0] - s.amIn);
    if (!continuous) undertimeMin += Math.max(0, s.amOut - amIv[1]);
  }
  if (pmWorked) {
    if (!continuous) lateMin += Math.max(0, pmIv[0] - s.pmIn);
    undertimeMin += Math.max(0, s.pmOut - pmIv[1]);
  }

  const lastOut = pmIv ? pmIv[1] : (amIv ? amIv[1] : null);
  const otMin = lastOut !== null && pmWorked ? Math.max(0, lastOut - s.pmOut) : 0;
  const ndMin = nightMinutes(amIv) + nightMinutes(pmIv);

  let absentDays = 0;
  const leaveType = ctx.leaveType || null;
  if (dayType === 'regular' && !leaveType) absentDays = 1 - daysWorked;

  // Sa rest day ug holiday, walay late/undertime nga kaltas
  if (dayType !== 'regular') {
    lateMin = 0;
    undertimeMin = 0;
  }
  // Ang half-day absent dili na i-ihap og undertime/late sa absent nga tunga
  return {
    day_type: dayType,
    leave_type: leaveType,
    days_worked: daysWorked,
    absent_days: r2(absentDays),
    reg_hours: r2(regMin / 60),
    ot_hours: r2(otMin / 60),
    nd_hours: r2(ndMin / 60),
    late_min: Math.round(lateMin),
    undertime_min: Math.round(undertimeMin),
  };
}

module.exports = { toMin, fmtTime, summarizeDay, isRestDay, dayName, DAY_NAMES };
