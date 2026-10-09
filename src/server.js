const app = require('./app');
const { port } = require('./config');
const { pool } = require('./db');

async function start() {
  try {
    await pool.query('SELECT 1 FROM company LIMIT 1');
  } catch (err) {
    console.error('Cannot connect to the database, or the tables do not exist yet:', err.message);
    console.error('Check DATABASE_URL in .env and run "npm run migrate".');
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`Alon Payroll is running at: http://localhost:${port}`);
  });
}

start();
