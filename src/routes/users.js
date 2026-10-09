const express = require('express');
const bcrypt = require('bcryptjs');
const { query, one } = require('../db');
const { requireRole, flash } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();
const ROLES = ['admin', 'hr', 'payroll', 'approver'];

router.get('/users', requireRole('admin'), async (req, res) => {
  const rows = await query('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY username');
  res.render('users/index', { title: 'Users', rows, ROLES });
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const { username, full_name, role, password } = req.body;
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username || '') || !String(full_name || '').trim() || !ROLES.includes(role) || String(password || '').length < 8) {
    flash(req, 'error', 'Username (3+ letters/numbers), full name, role and password (8+ characters) are required.');
    return res.redirect('/users');
  }
  if (await one('SELECT id FROM users WHERE username = ?', [username])) {
    flash(req, 'error', 'A user with that username already exists.');
    return res.redirect('/users');
  }
  const r = await query('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)', [username, await bcrypt.hash(password, 10), full_name.trim(), role]);
  await audit(req, 'create', 'user', r.insertId, { username, role });
  flash(req, 'success', 'User created.');
  res.redirect('/users');
});

router.post('/users/:id', requireRole('admin'), async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.redirect('/users');
  const role = ROLES.includes(req.body.role) ? req.body.role : u.role;
  const active = req.body.active ? 1 : 0;
  if (u.id === req.session.user.id && (role !== 'admin' || !active)) {
    flash(req, 'error', 'You cannot remove your own admin access.');
    return res.redirect('/users');
  }
  await query('UPDATE users SET role = ?, active = ? WHERE id = ?', [role, active, u.id]);
  if (req.body.password) {
    if (String(req.body.password).length < 8) {
      flash(req, 'error', 'The password must be at least 8 characters.');
      return res.redirect('/users');
    }
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(req.body.password, 10), u.id]);
  }
  await audit(req, 'update', 'user', u.id, { role, active, password_reset: !!req.body.password });
  flash(req, 'success', `${u.username} updated.`);
  res.redirect('/users');
});

module.exports = router;
