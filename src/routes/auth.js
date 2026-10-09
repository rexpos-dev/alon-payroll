const express = require('express');
const bcrypt = require('bcryptjs');
const { one, query } = require('../db');
const { flash, requireLogin } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Login', error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const u = await one('SELECT * FROM users WHERE username = ? AND active = 1', [String(username || '').trim()]);
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) {
    return res.status(401).render('login', { title: 'Login', error: 'Incorrect username or password.' });
  }
  await new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));
  req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
  await audit(req, 'login', 'user', u.id);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account/password', requireLogin, (req, res) => {
  res.render('users/password', { title: 'Change password' });
});

router.post('/account/password', requireLogin, async (req, res) => {
  const { current, next1, next2 } = req.body;
  const u = await one('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) {
    flash(req, 'error', 'Current password is incorrect.');
  } else if (!next1 || next1.length < 8) {
    flash(req, 'error', 'The new password must be at least 8 characters.');
  } else if (next1 !== next2) {
    flash(req, 'error', 'The new passwords do not match.');
  } else {
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(next1, 10), u.id]);
    await audit(req, 'password_change', 'user', u.id);
    flash(req, 'success', 'Password changed.');
    return res.redirect('/');
  }
  res.redirect('/account/password');
});

module.exports = router;
