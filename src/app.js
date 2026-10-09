const path = require('path');
const express = require('express');
const session = require('express-session');
const { sessionSecret } = require('./config');
const { requireLogin, csrf, locals } = require('./middleware');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.get('/vendor/chart.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 60 * 1000 },
}));
app.use(locals);

// Ang file uploads (multipart) mo-check sa CSRF sulod sa ilang route human ma-parse ang form
const MULTIPART_ROUTES = ['/employees/import', '/dtr/import'];
app.use((req, res, next) => {
  if (!req.is('multipart/form-data')) return csrf(req, res, next);
  if (req.method === 'POST' && MULTIPART_ROUTES.includes(req.path)) return next();
  res.status(400).send('Bad request');
});

app.use(require('./routes/auth'));
app.use(requireLogin);
app.use(require('./routes/dashboard'));
app.use(require('./routes/employees'));
app.use(require('./routes/attendance'));
app.use(require('./routes/loans'));
app.use(require('./routes/periods'));
app.use(require('./routes/reports'));
app.use(require('./routes/settings'));
app.use(require('./routes/users'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const message = err.code === 'ER_DUP_ENTRY' ? 'A record with the same value already exists (duplicate).' : err.message;
  res.status(500).render('error', { title: 'Something went wrong', message });
});

module.exports = app;
