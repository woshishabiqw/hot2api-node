/**
 * One-time migration: backfill request_logs.cost_local from cost * exchange_rate.
 *
 * This is split out from the normal startup path because it may need to scan
 * millions of rows and should not be constrained by the normal statement timeout.
 */
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function getDatabaseUrl() {
  const sqlConfigPath = path.join(__dirname, '..', 'config', 'sql.json');
  if (fs.existsSync(sqlConfigPath)) {
    try {
      const sqlConfig = JSON.parse(fs.readFileSync(sqlConfigPath, 'utf8'));
      if (sqlConfig.encrypted_database_url && sqlConfig.private_key) {
        const decrypted = crypto.privateDecrypt(
          { key: sqlConfig.private_key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
          Buffer.from(sqlConfig.encrypted_database_url, 'base64')
        );
        return decrypted.toString('utf8');
      }
    } catch (e) {
      console.error('Failed to decrypt database URL from sql.json:', e.message);
    }
  }
  return process.env.DATABASE_URL;
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    max: 2,
    statement_timeout: 0,
    connectionTimeoutMillis: 30000
  });

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '0'");

    const rateRow = await client.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
    const exchangeRate = parseFloat(rateRow.rows[0]?.value) || 7.25;
    console.log(`Using exchange rate: ${exchangeRate}`);

    await client.query(`
      ALTER TABLE request_logs
      ADD COLUMN IF NOT EXISTS cost_local NUMERIC(18, 8) DEFAULT 0
    `);

    const idRange = await client.query(`SELECT COALESCE(MIN(id), 0) as min_id, COALESCE(MAX(id), 0) as max_id FROM request_logs`);
    const minId = Number(idRange.rows[0].min_id);
    const maxId = Number(idRange.rows[0].max_id);
    console.log(`request_logs id range: ${minId} - ${maxId}`);

    const BATCH_SIZE = 10000;
    let backfilled = 0;
    const startTime = Date.now();

    if (minId > 0 && maxId >= minId) {
      for (let start = minId; start <= maxId; start += BATCH_SIZE) {
        const end = start + BATCH_SIZE;
        const result = await client.query(`
          UPDATE request_logs
          SET cost_local = cost * $1
          WHERE id >= $2 AND id < $3 AND cost_local = 0 AND cost <> 0
        `, [exchangeRate, start, end]);
        backfilled += result.rowCount || 0;
        if ((start - minId) % 500000 < BATCH_SIZE) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  migrated ${backfilled} rows in ${elapsed}s (up to id ${end})`);
        }
      }
    }

    console.log(`Backfill complete: ${backfilled} rows updated in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
