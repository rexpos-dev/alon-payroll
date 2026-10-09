// Basaha ang database settings: DATABASE_URL (una) o DB_HOST/DB_USER/... nga fallback.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function dbConfig() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const u = new URL(url);
    if (!/^mysql2?:$/.test(u.protocol)) throw new Error('DATABASE_URL must start with mysql://');
    return {
      // Sa Windows, ang "localhost" usahay mo-resolve sa IPv6 (::1) nga dili gipaminawan sa MySQL
      host: !u.hostname || u.hostname === 'localhost' ? '127.0.0.1' : u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username || 'root'),
      password: decodeURIComponent(u.password || ''),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'alon_payroll',
    };
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'alon_payroll',
  };
}

module.exports = {
  dbConfig,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'alon-payroll-change-this-secret',
};
