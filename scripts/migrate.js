// Himoon ang database, mga table, default data, ug ang unang admin user.
// Dagan: npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { dbConfig } = require('../src/config');
const { seed } = require('../db/seed');

async function main() {
  const cfg = dbConfig();
  const dbName = cfg.database;
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error('Database name: only letters, numbers and _ are allowed.');

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${dbName}\``);

  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const st of statements) await conn.query(st);
  console.log(`Tables OK (${statements.length} statements) in database "${dbName}".`);

  const seeded = await seed(conn);
  if (seeded.length) console.log('Default data seeded:', seeded.join(', '));

  const [users] = await conn.query('SELECT COUNT(*) AS c FROM users');
  if (users[0].c === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);
    await conn.query("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, 'Administrator', 'admin')", [username, hash]);
    console.log(`Admin user created: ${username} (change the password right after logging in).`);
  }
  await conn.end();
  console.log('Migration complete.');
}

main().catch(err => {
  console.error('Migration napakyas:', err.message);
  process.exit(1);
});
