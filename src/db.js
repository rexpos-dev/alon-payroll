const mysql = require('mysql2/promise');
const { dbConfig } = require('./config');

const pool = mysql.createPool({
  ...dbConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,          // DATE/DATETIME isip string (walay timezone shift)
  decimalNumbers: true,       // DECIMAL isip number
});

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Transaction helper: fn(conn) diin conn.q(sql, params) mo-return sa rows
async function tx(fn) {
  const conn = await pool.getConnection();
  conn.q = async (sql, params = []) => (await conn.query(sql, params))[0];
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, one, tx };
