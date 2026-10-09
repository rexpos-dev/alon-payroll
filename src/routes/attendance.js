const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { query, one, tx } = require('../db');
const { requireRole, flash, csrf } = require('../middleware');
const { audit } = require('../audit');
const { summarizeDay, toMin, fmtTime, dayName } = require('../payroll/dtr');
const { datesBetween, DEFAULT_SCHED } = require('../payroll/compute');
const { cellValue, toDate, toTime } = require('../legacyImport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const t5 = t => (t ? String(t).slice(0, 5) : '');

async function scheduleOf(employeeId) {
  return (await one('SELECT * FROM schedules WHERE employee_id = ?', [employeeId])) || DEFAULT_SCHED;
}

async function holidayMap(from, to) {
  const rows = await query('SELECT holiday_date, type, name FROM holidays WHERE holiday_date BETWEEN ? AND ?', [from, to]);
  return Object.fromEntries(rows.map(h => [h.holiday_date, h]));
}

// Upsert sa usa ka adlaw (gamiton sa manual save ug import)
async function saveDay(conn, employeeId, date, punches, leaveType, otApproved, remarks, sched, holidays, source, userId) {
  const s = summarizeDay(punches, sched, { date, holidayType: holidays[date] ? holidays[date].type : null, leaveType });
  await conn.q(`INSERT INTO attendance_days (employee_id, work_date, am_in, am_out, pm_in, pm_out, day_type, leave_type, days_worked,
      absent_days, reg_hours, ot_hours, ot_approved, nd_hours, late_min, undertime_min, remarks, source, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE am_in=VALUES(am_in), am_out=VALUES(am_out), pm_in=VALUES(pm_in), pm_out=VALUES(pm_out),
      day_type=VALUES(day_type), leave_type=VALUES(leave_type), days_worked=VALUES(days_worked), absent_days=VALUES(absent_days),
      reg_hours=VALUES(reg_hours), ot_hours=VALUES(ot_hours), ot_approved=VALUES(ot_approved), nd_hours=VALUES(nd_hours),
      late_min=VALUES(late_min), undertime_min=VALUES(undertime_min), remarks=VALUES(remarks), source=VALUES(source), updated_by=VALUES(updated_by)`,
  [employeeId, date, fmtTime(toMin(punches.am_in)), fmtTime(toMin(punches.am_out)), fmtTime(toMin(punches.pm_in)), fmtTime(toMin(punches.pm_out)),
    s.day_type, leaveType, s.days_worked, s.absent_days, s.reg_hours, s.ot_hours, otApproved ? 1 : 0, s.nd_hours, s.late_min,
    s.undertime_min, remarks || null, source, userId]);
  return s;
}

// Kung nausab ang DTR, ang computed nga period nga apektado mobalik sa Draft (kinahanglan i-recompute)
async function invalidatePeriods(from, to) {
  if (!from || !to) return;
  await query("UPDATE payroll_periods SET status = 'draft' WHERE status = 'computed' AND date_from <= ? AND date_to >= ?", [to, from]);
}

async function lockedPeriodFor(date) {
  return one("SELECT id FROM payroll_periods WHERE status IN ('approved','posted') AND ? BETWEEN date_from AND date_to LIMIT 1", [date]);
}

// ---------- DTR (per employee, per cut-off) ----------
router.get('/dtr', async (req, res) => {
  const employees = await query("SELECT id, emp_no, last_name, first_name FROM employees WHERE status = 'Active' ORDER BY last_name, first_name");
  const latest = await one('SELECT date_from, date_to FROM payroll_periods ORDER BY date_from DESC LIMIT 1');
  const from = req.query.from || (latest ? latest.date_from : new Date().toISOString().slice(0, 8) + '01');
  const to = req.query.to || (latest ? latest.date_to : new Date().toISOString().slice(0, 8) + '15');
  const employeeId = Number(req.query.employee_id || 0);
  let rows = [];
  let sched = null;
  let emp = null;
  let totals = null;
  if (employeeId && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
    emp = await one('SELECT * FROM employees WHERE id = ?', [employeeId]);
    sched = await scheduleOf(employeeId);
    const holidays = await holidayMap(from, to);
    const att = await query('SELECT * FROM attendance_days WHERE employee_id = ? AND work_date BETWEEN ? AND ?', [employeeId, from, to]);
    const byDate = Object.fromEntries(att.map(a => [a.work_date, a]));
    rows = datesBetween(from, to).slice(0, 62).map(date => {
      const a = byDate[date];
      const preview = a || summarizeDay({}, sched, { date, holidayType: holidays[date] ? holidays[date].type : null });
      return { date, day: dayName(date), holiday: holidays[date] || null, saved: !!a, a: a || {}, s: preview };
    });
    totals = rows.reduce((t, r) => {
      t.worked += Number(r.s.days_worked || 0);
      t.absent += Number(r.s.absent_days || 0);
      t.late += Number(r.s.late_min || 0);
      t.ut += Number(r.s.undertime_min || 0);
      t.ot += Number(r.s.ot_hours || 0);
      t.nd += Number(r.s.nd_hours || 0);
      return t;
    }, { worked: 0, absent: 0, late: 0, ut: 0, ot: 0, nd: 0 });
  }
  res.render('attendance/dtr', { title: 'Daily Time Record', employees, employeeId, from, to, rows, sched, emp, totals, t5 });
});

router.post('/dtr', requireRole('hr', 'payroll'), async (req, res) => {
  const employeeId = Number(req.body.employee_id);
  const dates = [].concat(req.body.date || []);
  const sched = await scheduleOf(employeeId);
  const from = req.body.from;
  const to = req.body.to;
  const holidays = await holidayMap(from, to);
  let saved = 0;
  let cleared = 0;
  const skipped = [];
  await tx(async conn => {
    for (const date of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (await lockedPeriodFor(date)) { skipped.push(date); continue; }
      const g = k => String(req.body[`${k}_${date}`] || '').trim();
      const punches = { am_in: g('am_in'), am_out: g('am_out'), pm_in: g('pm_in'), pm_out: g('pm_out') };
      const leave = ['VL', 'SL'].includes(g('leave')) ? g('leave') : null;
      const ot = !!req.body[`ot_${date}`];
      const remarks = g('remarks');
      const hasData = Object.values(punches).some(Boolean) || leave || remarks;
      if (hasData) {
        await saveDay(conn, employeeId, date, punches, leave, ot, remarks, sched, holidays, 'manual', req.session.user.id);
        saved++;
      } else {
        const r = await conn.q('DELETE FROM attendance_days WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
        cleared += r.affectedRows;
      }
    }
  });
  await invalidatePeriods(from, to);
  await audit(req, 'update', 'dtr', employeeId, { from, to, saved, cleared });
  if (skipped.length) flash(req, 'error', `${skipped.length} day(s) were not saved because they belong to an approved/posted period.`);
  flash(req, 'success', `DTR saved (${saved} day(s)).`);
  res.redirect(`/dtr?employee_id=${employeeId}&from=${from}&to=${to}`);
});

// ---------- DTR import (Excel o CSV) ----------
function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    rows.push(out.map(s => s.trim()));
  }
  return rows;
}

async function readRows(file) {
  if (/\.csv$/i.test(file.originalname)) return parseCsv(file.buffer.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const vals = [];
    for (let c = 1; c <= row.cellCount; c++) vals.push(cellValue(row.getCell(c)));
    rows.push(vals);
  });
  return rows;
}

function splitDateTime(v) {
  if (v instanceof Date && !isNaN(v)) {
    const iso = v.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  const m = String(v || '').trim().match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})[ T]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)$/i);
  if (!m) return null;
  return { date: toDate(m[1]), time: m[2] };
}

router.get('/dtr/import', requireRole('hr', 'payroll'), (req, res) => {
  res.render('attendance/import', { title: 'Import DTR', result: null });
});

router.get('/dtr/template.csv', (req, res) => {
  res.type('text/csv').attachment('dtr-template.csv')
    .send('emp_no,date,am_in,am_out,pm_in,pm_out\n1,2026-10-01,08:00,12:00,13:00,17:00\n');
});

router.post('/dtr/import', requireRole('hr', 'payroll'), upload.single('file'), csrf, async (req, res) => {
  if (!req.file) {
    flash(req, 'error', 'Choose a file.');
    return res.redirect('/dtr/import');
  }
  const rows = await readRows(req.file);
  if (rows.length < 2) {
    flash(req, 'error', 'The file is empty.');
    return res.redirect('/dtr/import');
  }
  const header = rows[0].map(h => String(h || '').toLowerCase().replace(/[^a-z_]/g, ''));
  const idx = names => header.findIndex(h => names.includes(h));
  const iEmp = idx(['emp_no', 'empno', 'empid', 'employeeno', 'acno', 'id', 'userid']);
  const iDate = idx(['date', 'workdate']);
  const iDT = idx(['datetime', 'time', 'checktime', 'timestamp', 'punch']);
  const iAmIn = idx(['am_in', 'amin', 'timein']);
  if (iEmp < 0) {
    flash(req, 'error', 'The file has no "emp_no" column.');
    return res.redirect('/dtr/import');
  }

  const employees = await query('SELECT id, emp_no FROM employees');
  const empByNo = Object.fromEntries(employees.map(e => [String(e.emp_no).trim(), e.id]));
  const days = {}; // key empId|date -> punches
  const unknown = new Set();
  const bad = [];

  if (iAmIn >= 0 && iDate >= 0) {
    // Format A: usa ka row kada adlaw (emp_no, date, am_in, am_out, pm_in, pm_out)
    for (const r of rows.slice(1)) {
      const empId = empByNo[String(r[iEmp] ?? '').trim()];
      if (!empId) { if (r[iEmp]) unknown.add(String(r[iEmp])); continue; }
      const date = toDate(r[iDate]);
      if (!date) { bad.push(String(r[iDate])); continue; }
      days[`${empId}|${date}`] = {
        am_in: toTime(r[iAmIn]), am_out: toTime(r[iAmIn + 1]), pm_in: toTime(r[iAmIn + 2]), pm_out: toTime(r[iAmIn + 3]),
      };
    }
  } else if (iDT >= 0) {
    // Format B: biometric punch log (emp_no, datetime) - usa ka row kada punch
    const punches = {};
    for (const r of rows.slice(1)) {
      const empId = empByNo[String(r[iEmp] ?? '').trim()];
      if (!empId) { if (r[iEmp]) unknown.add(String(r[iEmp])); continue; }
      const dt = splitDateTime(r[iDT]);
      if (!dt || !dt.date || toMin(dt.time) === null) { bad.push(String(r[iDT])); continue; }
      const key = `${empId}|${dt.date}`;
      (punches[key] = punches[key] || []).push(toMin(dt.time));
    }
    for (const [key, list] of Object.entries(punches)) {
      const p = [...new Set(list)].sort((a, b) => a - b).map(fmtTime);
      if (p.length === 1) days[key] = { am_in: p[0] };
      else if (p.length === 2) days[key] = { am_in: p[0], pm_out: p[1] };
      else if (p.length === 3) days[key] = { am_in: p[0], am_out: p[1], pm_out: p[2] };
      else days[key] = { am_in: p[0], am_out: p[1], pm_in: p[2], pm_out: p[p.length - 1] };
    }
  } else {
    flash(req, 'error', 'Unrecognized format. Use the template (emp_no, date, am_in, am_out, pm_in, pm_out) or a punch log (emp_no, datetime).');
    return res.redirect('/dtr/import');
  }

  const keys = Object.keys(days);
  const allDates = keys.map(k => k.split('|')[1]).sort();
  const holidays = allDates.length ? await holidayMap(allDates[0], allDates[allDates.length - 1]) : {};
  const schedCache = {};
  let saved = 0;
  let locked = 0;
  await tx(async conn => {
    for (const key of keys) {
      const [empIdStr, date] = key.split('|');
      const empId = Number(empIdStr);
      if (await lockedPeriodFor(date)) { locked++; continue; }
      schedCache[empId] = schedCache[empId] || await scheduleOf(empId);
      const [existing] = await conn.q('SELECT leave_type, ot_approved, remarks FROM attendance_days WHERE employee_id = ? AND work_date = ?', [empId, date]);
      await saveDay(conn, empId, date, days[key], existing ? existing.leave_type : null, existing ? existing.ot_approved : 0,
        existing ? existing.remarks : null, schedCache[empId], holidays, 'import', req.session.user.id);
      saved++;
    }
  });
  if (allDates.length) await invalidatePeriods(allDates[0], allDates[allDates.length - 1]);
  const result = { saved, locked, unknown: [...unknown].slice(0, 30), bad: bad.slice(0, 10), badCount: bad.length };
  await audit(req, 'import', 'dtr', null, { file: req.file.originalname, saved, locked, unknown: result.unknown.length });
  res.render('attendance/import', { title: 'Import DTR', result });
});

// ---------- Holidays ----------
router.get('/holidays', async (req, res) => {
  const year = Number(req.query.year || new Date().getFullYear());
  const rows = await query('SELECT * FROM holidays WHERE YEAR(holiday_date) = ? ORDER BY holiday_date', [year]);
  res.render('attendance/holidays', { title: 'Holidays', rows, year });
});

router.post('/holidays', requireRole('hr'), async (req, res) => {
  const { holiday_date, type, name } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday_date || '') || !['regular', 'special'].includes(type) || !String(name || '').trim()) {
    flash(req, 'error', 'Complete the date, type and name.');
  } else {
    await query('INSERT INTO holidays (holiday_date, type, name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE type = VALUES(type), name = VALUES(name)', [holiday_date, type, name.trim()]);
    await audit(req, 'create', 'holiday', holiday_date, { type, name });
    flash(req, 'success', 'Holiday saved.');
  }
  res.redirect(`/holidays?year=${String(holiday_date || '').slice(0, 4) || new Date().getFullYear()}`);
});

router.post('/holidays/:id/delete', requireRole('hr'), async (req, res) => {
  const h = await one('SELECT * FROM holidays WHERE id = ?', [req.params.id]);
  if (h) {
    await query('DELETE FROM holidays WHERE id = ?', [h.id]);
    await audit(req, 'delete', 'holiday', h.holiday_date, h);
    flash(req, 'success', 'Holiday deleted.');
  }
  res.redirect(`/holidays?year=${h ? h.holiday_date.slice(0, 4) : ''}`);
});

module.exports = router;
