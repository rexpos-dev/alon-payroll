const crypto = require('crypto');
const { query } = require('./db');

const { buildCrumbs } = require('./breadcrumbs');
const ROLE_LABELS = { admin: 'Admin', hr: 'HR', payroll: 'Payroll Officer', approver: 'Approver' };

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// requireRole('admin', 'hr') - ang admin kanunay makaagi
function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (u.role === 'admin' || roles.includes(u.role)) return next();
    res.status(403).render('error', { title: 'No access', message: 'You do not have permission to open this page.' });
  };
}

// CSRF token kada session; tanang POST kinahanglan mopasa sa _csrf
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
    if (!token || token !== req.session.csrf) {
      return res.status(403).render('error', { title: 'Form expired', message: 'Refresh the page and try again.' });
    }
  }
  next();
}

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

const money = n => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  if (!y) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${day}, ${y}`;
}

async function locals(req, res, next) {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.locals.money = money;
  res.locals.fmtDate = fmtDate;
  res.locals.ROLE_LABELS = ROLE_LABELS;
  res.locals.path = req.path;
  res.locals.crumbLabel = null;
  res.locals.crumbs = (title) => buildCrumbs(req.path, title, res.locals.crumbLabel);
  res.locals.can = (...roles) => {
    const u = req.session.user;
    return !!u && (u.role === 'admin' || roles.includes(u.role));
  };
  try {
    const rows = await query('SELECT name FROM company WHERE id = 1');
    res.locals.companyName = rows[0] ? rows[0].name : 'Alon Payroll';
  } catch {
    res.locals.companyName = 'Alon Payroll';
  }
  next();
}

module.exports = { requireLogin, requireRole, csrf, flash, locals, money, fmtDate, ROLE_LABELS };
