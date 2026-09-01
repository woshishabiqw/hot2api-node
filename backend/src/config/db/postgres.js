require('dotenv').config();
const { Pool, types } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../settings');

// ========== PostgreSQL Date Parsing ==========
// Force timestamp/timestamptz to return ISO strings instead of Date objects
// This prevents 'Invalid Date' issues when frontend receives raw Date objects
const parseTimestamp = (val) => val; // Return raw string as-is
types.setTypeParser(1114, parseTimestamp); // TIMESTAMP
types.setTypeParser(1184, parseTimestamp); // TIMESTAMPTZ
types.setTypeParser(1082, parseTimestamp); // DATE

// ========== RSA Decryption from sql.json ==========
// Explicit DATABASE_URL takes precedence (used by tests / deployments);
// fall back to encrypted sql.json for the production default.
function getDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const sqlConfigPath = path.join(__dirname, '..', '..', '..', 'config', 'sql.json');
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

const DATABASE_URL = getDatabaseUrl();

// ========== AES Encryption ==========
const ENCRYPTION_KEY = config.encryption.key;
const ALGORITHM = 'aes-256-cbc';

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  if (!text) return text;
  const key = deriveKey(ENCRYPTION_KEY);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return 'enc:' + iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text || !text.startsWith('enc:')) return text;
  try {
    const key = deriveKey(ENCRYPTION_KEY);
    const parts = text.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Decryption failed:', e.message);
    return text;
  }
}

function parseGroups(str) {
  if (!str) return ['default'];
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) && arr.length > 0 ? arr : ['default'];
  } catch { return [str]; }
}

// ========== Type Parsing ==========
// Parse BIGINT as JavaScript number (not string) to avoid toFixed/toLocaleString errors
types.setTypeParser(20, val => parseInt(val, 10)); // OID 20 = BIGINT

// Parse NUMERIC/DECIMAL as JavaScript number to support decimal quota values
types.setTypeParser(1700, val => parseFloat(val)); // OID 1700 = NUMERIC/DECIMAL

// ========== Pool ==========
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX) || 100,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 15000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// ========== SQL Conversion ==========
function convertSql(sql) {
  let converted = sql;

  // Convert ? placeholders to $1, $2...
  let paramIndex = 0;
  converted = converted.replace(/\?/g, () => `$${++paramIndex}`);

  // Convert datetime('now', '-X minutes') -> NOW() - INTERVAL 'X minutes'
  // Convert datetime('now', '+X minutes') -> NOW() + INTERVAL 'X minutes'
  converted = converted.replace(
    /datetime\('now',\s*'([+-]?)(\d+\s+(?:second|seconds|minute|minutes|hour|hours|day|days))'\)/gi,
    (match, sign, interval) => {
      if (sign === '-') return `NOW() - INTERVAL '${interval}'`;
      return `NOW() + INTERVAL '${interval}'`;
    }
  );
  // Convert datetime('now') -> NOW()
  converted = converted.replace(/datetime\('now'\)/gi, 'NOW()');

  // Convert date('now') -> CURRENT_DATE
  converted = converted.replace(/date\('now'\)/gi, 'CURRENT_DATE');

  // Convert date(column) -> column::date (e.g. date(created_at))
  converted = converted.replace(/date\((\w+)\)/gi, '$1::date');

  // Convert strftime('%s', 'now') -> EXTRACT(EPOCH FROM NOW())
  converted = converted.replace(/strftime\('%s',\s*'now'\)/gi, 'EXTRACT(EPOCH FROM NOW())');

  // Convert strftime('%Y-%m-%d %H:%M', created_at) -> TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI')
  converted = converted.replace(
    /strftime\('%Y-%m-%d %H:%M',\s*(\w+)\)/gi,
    "TO_CHAR($1, 'YYYY-MM-DD HH24:MI')"
  );
  // Convert strftime('%Y-%m-%d %H:00', created_at) -> TO_CHAR(created_at, 'YYYY-MM-DD HH24:00')
  converted = converted.replace(
    /strftime\('%Y-%m-%d %H:00',\s*(\w+)\)/gi,
    "TO_CHAR($1, 'YYYY-MM-DD HH24:00')"
  );
  // Convert strftime('%Y-%m-%d', created_at) -> TO_CHAR(created_at, 'YYYY-MM-DD')
  converted = converted.replace(
    /strftime\('%Y-%m-%d',\s*(\w+)\)/gi,
    "TO_CHAR($1, 'YYYY-MM-DD')"
  );

  // Convert last_insert_rowid() -> lastval()
  converted = converted.replace(/SELECT\s+last_insert_rowid\(\)/gi, 'SELECT lastval()');

  // Convert MAX(0, expr) -> GREATEST(0, expr) for PostgreSQL
  // (SQLite supports MAX as scalar function, PostgreSQL only has GREATEST)
  converted = converted.replace(/\bMAX\s*\(\s*0\s*,\s*([^)]+)\s*\)/gi, 'GREATEST(0, $1)');

  return converted;
}

function isInsertSql(sql) {
  return /^\s*INSERT\s+/i.test(sql);
}

// ========== Query Helpers ==========
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 50;

function isConnectionError(error) {
  const msg = error?.message || '';
  const code = error?.code || '';
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('Connection terminated unexpectedly') ||
    msg.includes('server closed the connection unexpectedly');
}

async function withRetry(operation, label, sql) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isConnectionError(error) || attempt === MAX_RETRIES) {
        console.error(`PostgreSQL ${label} error:`, error?.message, '\nSQL:', sql);
        throw error;
      }
      console.warn(`PostgreSQL ${label} retry ${attempt}/${MAX_RETRIES}:`, error?.message);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError;
}

const query = async (sql, params = []) => {
  const convertedSql = convertSql(sql);
  return withRetry(async () => {
    const result = await pool.query(convertedSql, params);
    return result.rows;
  }, 'query', convertedSql);
};

const run = async (sql, params = []) => {
  const convertedSql = convertSql(sql);
  return withRetry(async () => {
    let finalSql = convertedSql;
    let needsReturningId = false;

    // For INSERT without RETURNING, add RETURNING *
    if (isInsertSql(convertedSql) && !/RETURNING\s+/i.test(convertedSql)) {
      finalSql = convertedSql + ' RETURNING *';
      needsReturningId = true;
    }

    const result = await pool.query(finalSql, params);

    let lastInsertRowid = 0;
    if (needsReturningId && result.rows.length > 0) {
      lastInsertRowid = result.rows[0]?.id || 0;
    }

    return { lastInsertRowid, changes: result.rowCount || 0 };
  }, 'run', convertedSql);
};

const get = async (sql, params = []) => {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
};

const all = async (sql, params = []) => {
  return query(sql, params);
};

const batchRun = async (operations) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const { sql, params } of operations) {
      const convertedSql = convertSql(sql);
      let finalSql = convertedSql;
      let needsReturningId = false;

      if (isInsertSql(convertedSql) && !/RETURNING\s+/i.test(convertedSql)) {
        finalSql = convertedSql + ' RETURNING *';
        needsReturningId = true;
      }

      const result = await client.query(finalSql, params);
      let lastInsertRowid = 0;
      if (needsReturningId && result.rows.length > 0) {
        lastInsertRowid = result.rows[0]?.id || 0;
      }
      results.push({ lastInsertRowid });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('PostgreSQL batch run error:', error);
    throw error;
  } finally {
    client.release();
  }
};

// ========== Initialization ==========
// For PostgreSQL, schema is managed by Prisma migrations.
// We just verify connection and seed defaults.
const initDatabase = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected successfully');

    // Seed default admin if not exists.
    // For security, a default admin is only created when DEFAULT_ADMIN_PASSWORD is provided.
    const existingAdmin = await get("SELECT id FROM users WHERE role = 'admin'");
    if (!existingAdmin) {
      const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD;
      if (!adminPassword) {
        console.warn('[Security] DEFAULT_ADMIN_PASSWORD is not set. No default admin user will be created. Set the environment variable and restart to create one.');
      } else {
        const bcrypt = require('bcryptjs');
        const passwordHash = bcrypt.hashSync(adminPassword, 10);
        const adminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
        await run(
          "INSERT INTO users (username, password_hash, role, quota_limit) VALUES ($1, $2, 'admin', 0)",
          [adminUsername, passwordHash]
        );
        console.log('Default admin user created in PostgreSQL');
      }
    }

    // Default settings
    // Ensure users table has email column
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE
    `).catch(() => {});

    const defaultSettings = {
      currency: 'CNY',
      exchange_rate: '7.25',
      dispatch_strategy: 'round_robin',
      banner_text: '',
      banner_enabled: 'false',
      invoice_review_mode: 'auto',
      transit_scan_enabled: 'true',
      registration_enabled: 'true',
      captcha_enabled: 'false',
      email_verification_enabled: 'false',
      registration_approval_mode: 'auto'
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
      const existing = await get("SELECT value FROM settings WHERE key = $1", [key]);
      if (!existing) {
        await run("INSERT INTO settings (key, value) VALUES ($1, $2)", [key, value]);
      }
    }

    // Ensure request_logs table exists
    await pool.query(`
      ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS request_uuid TEXT
    `).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        user_key_id INTEGER,
        source_id INTEGER,
        model TEXT,
        protocol TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        uncached_tokens INTEGER DEFAULT 0,
        status_code INTEGER,
        latency_ms INTEGER,
        error_message TEXT,
        cost NUMERIC(18, 8) DEFAULT 0,
        cost_local NUMERIC(18, 8) DEFAULT 0,
        has_thinking BOOLEAN DEFAULT false,
        request_uuid TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Ensure audit_logs table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id INTEGER,
        resource_name TEXT,
        old_value TEXT,
        new_value TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const logIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_source_id ON request_logs(source_id)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_model_created_at ON request_logs(model, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_source_id_created_at ON request_logs(source_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_user_id_created_at ON request_logs(user_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_user_id_created_at_covering ON request_logs(user_id, created_at, total_tokens, cost)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_request_uuid ON request_logs(request_uuid)',
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)',
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type)',
    ];
    for (const sql of logIndexes) {
      try { await pool.query(sql); } catch (e) { /* ignore */ }
    }

    // Per-user per-day per-model aggregation table for fast dashboard reads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_daily_model_stats (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        date VARCHAR(10) NOT NULL,
        model TEXT NOT NULL,
        requests BIGINT NOT NULL DEFAULT 0,
        tokens BIGINT NOT NULL DEFAULT 0,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        latency_ms_sum BIGINT NOT NULL DEFAULT 0,
        latency_ms_count BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date, model)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_daily_model_stats_user_date ON user_daily_model_stats(user_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_daily_model_stats_user_model ON user_daily_model_stats(user_id, model)`);
    await pool.query(`ALTER TABLE user_daily_model_stats ADD COLUMN IF NOT EXISTS latency_ms_sum BIGINT NOT NULL DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE user_daily_model_stats ADD COLUMN IF NOT EXISTS latency_ms_count BIGINT NOT NULL DEFAULT 0`).catch(() => {});

    // Per-user per-hour per-model aggregation table for fast sub-day dashboard reads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_hourly_model_stats (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        hour VARCHAR(16) NOT NULL,
        model TEXT NOT NULL,
        requests BIGINT NOT NULL DEFAULT 0,
        tokens BIGINT NOT NULL DEFAULT 0,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        latency_ms_sum BIGINT NOT NULL DEFAULT 0,
        latency_ms_count BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, hour, model)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_hourly_model_stats_user_hour ON user_hourly_model_stats(user_id, hour)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_hourly_model_stats_user_model ON user_hourly_model_stats(user_id, model)`);
    // Widen legacy hour column that may have been created as VARCHAR(13)
    await pool.query(`ALTER TABLE user_hourly_model_stats ALTER COLUMN hour TYPE VARCHAR(16)`).catch(() => {});
    await pool.query(`ALTER TABLE user_hourly_model_stats ADD COLUMN IF NOT EXISTS latency_ms_sum BIGINT NOT NULL DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE user_hourly_model_stats ADD COLUMN IF NOT EXISTS latency_ms_count BIGINT NOT NULL DEFAULT 0`).catch(() => {});

    // Per-source per-day per-model aggregation table for fast admin dashboard reads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS source_daily_model_stats (
        id SERIAL PRIMARY KEY,
        source_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        model TEXT NOT NULL,
        requests BIGINT NOT NULL DEFAULT 0,
        tokens BIGINT NOT NULL DEFAULT 0,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        latency_ms_sum BIGINT NOT NULL DEFAULT 0,
        latency_ms_count BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_id, date, model)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_source_daily_model_stats_source_date ON source_daily_model_stats(source_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_source_daily_model_stats_source_model ON source_daily_model_stats(source_id, model)`);
    await pool.query(`ALTER TABLE source_daily_model_stats ADD COLUMN IF NOT EXISTS latency_ms_sum BIGINT NOT NULL DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE source_daily_model_stats ADD COLUMN IF NOT EXISTS latency_ms_count BIGINT NOT NULL DEFAULT 0`).catch(() => {});

    // Per-source per-hour per-model aggregation table for fast admin sub-day dashboard reads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS source_hourly_model_stats (
        id SERIAL PRIMARY KEY,
        source_id INTEGER NOT NULL,
        hour VARCHAR(16) NOT NULL,
        model TEXT NOT NULL,
        requests BIGINT NOT NULL DEFAULT 0,
        tokens BIGINT NOT NULL DEFAULT 0,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        latency_ms_sum BIGINT NOT NULL DEFAULT 0,
        latency_ms_count BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_id, hour, model)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_source_hourly_model_stats_source_hour ON source_hourly_model_stats(source_id, hour)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_source_hourly_model_stats_source_model ON source_hourly_model_stats(source_id, model)`);
    await pool.query(`ALTER TABLE source_hourly_model_stats ADD COLUMN IF NOT EXISTS latency_ms_sum BIGINT NOT NULL DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE source_hourly_model_stats ADD COLUMN IF NOT EXISTS latency_ms_count BIGINT NOT NULL DEFAULT 0`).catch(() => {});

    // Ensure Workspace & Billing tables exist (originally in sqlite.js Phase 3)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        owner_id INTEGER NOT NULL,
        plan_id INTEGER,
        balance REAL DEFAULT 0,
        quota_limit BIGINT DEFAULT 0,
        quota_used NUMERIC(20, 8) DEFAULT 0,
        token_quota_limit BIGINT DEFAULT 0,
        token_quota_used NUMERIC(20, 8) DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS token_quota_limit BIGINT DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS token_quota_used NUMERIC(20, 8) DEFAULT 0`).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id INTEGER,
        user_id INTEGER,
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        inviter_id INTEGER NOT NULL,
        invitee_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace_id, invitee_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_plans (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price_monthly REAL DEFAULT 0,
        price_yearly REAL DEFAULT 0,
        quota_limit BIGINT DEFAULT 0,
        features TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_records (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance_after REAL DEFAULT 0,
        description TEXT,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER,
        user_id INTEGER,
        amount REAL NOT NULL,
        channel TEXT NOT NULL,
        channel_config_id INTEGER,
        status TEXT DEFAULT 'pending',
        trade_no TEXT,
        description TEXT,
        metadata TEXT,
        paid_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        refunded_at TIMESTAMP,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate: add missing columns if table was created before this change
    const orderMigrations = [
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS channel_config_id INTEGER',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS user_id INTEGER',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS description TEXT',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS metadata TEXT',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ',
      `ALTER TABLE payment_orders ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC'`,
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS coupon_id INTEGER',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS original_amount REAL',
      'ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS discount_amount REAL',
      'ALTER TABLE payment_orders ALTER COLUMN workspace_id DROP NOT NULL',
    ];
    for (const sql of orderMigrations) {
      try { await pool.query(sql); } catch (e) { /* ignore */ }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'threshold_fixed',
        threshold REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        discount_rate REAL DEFAULT 0,
        max_uses INTEGER DEFAULT 0,
        used_count INTEGER DEFAULT 0,
        valid_start TIMESTAMP,
        valid_end TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_coupons (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        coupon_id INTEGER NOT NULL,
        status TEXT DEFAULT 'unused',
        order_id INTEGER,
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP,
        expires_at TIMESTAMP
      )
    `);

    // Default configuration applied to new users / keys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_defaults (
        id SERIAL PRIMARY KEY,
        tpm INTEGER DEFAULT 10000000,
        rpm INTEGER DEFAULT 100,
        tpd INTEGER DEFAULT 1000000000,
        max_concurrent INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try {
      await pool.query(`
        INSERT INTO user_defaults (id, tpm, rpm, tpd, max_concurrent)
        VALUES (1, 10000000, 100, 1000000000, 100)
        ON CONFLICT (id) DO NOTHING
      `);
    } catch (e) { /* ignore */ }

    // Ensure users table has per-account balance (independent of workspace balance)
    // and per-user rate limits (0 means unlimited).
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance REAL DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_tokens BIGINT DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_requests BIGINT DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_cost REAL DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tpm INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rpm INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tpd INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS max_concurrent INTEGER DEFAULT 0`);
    } catch (e) { /* ignore */ }

    // Ensure billing_records also tracks per-user balance
    const billingRecordMigrations = [
      'ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS user_id INTEGER',
      'ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS user_balance_after REAL DEFAULT 0',
      'ALTER TABLE billing_records ALTER COLUMN workspace_id DROP NOT NULL',
      'ALTER TABLE billing_records ALTER COLUMN balance_after SET DEFAULT 0',
    ];
    for (const sql of billingRecordMigrations) {
      try { await pool.query(sql); } catch (e) { /* ignore */ }
    }

    // Ensure invoices table exists (mirrors invoiceService.ensureTable)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        order_id INTEGER,
        workspace_id INTEGER,
        user_id INTEGER,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(32) DEFAULT 'pending',
        review_status VARCHAR(32) DEFAULT 'pending',
        invoice_no VARCHAR(64),
        title VARCHAR(255),
        email VARCHAR(255),
        tax_number VARCHAR(50),
        invoice_url TEXT,
        rejected_reason TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        issued_at TIMESTAMP,
        reviewed_at TIMESTAMP,
        failed_at TIMESTAMP
      )
    `);
    const invoiceIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id)',
      'CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)',
      'CREATE INDEX IF NOT EXISTS idx_invoices_review_status ON invoices(review_status)',
    ];
    for (const sql of invoiceIndexes) {
      try { await pool.query(sql); } catch (e) { /* ignore */ }
    }
    const invoiceMigrations = [
      "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS review_status VARCHAR(32) DEFAULT 'pending'",
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_url TEXT',
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rejected_reason TEXT',
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email VARCHAR(255)',
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_number VARCHAR(50)',
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP',
    ];
    for (const sql of invoiceMigrations) {
      try { await pool.query(sql); } catch (e) { /* ignore */ }
    }

    // PIN table for dual-password system (billing + payment gateway)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_pins (
        user_id INTEGER NOT NULL,
        pin_type TEXT NOT NULL,
        password_hash TEXT,
        failed_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, pin_type)
      )
    `);

    // Token revocation: per-token jti blocklist + per-user token_revoked_before watermark
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_blocklist (
        jti TEXT PRIMARY KEY,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_blocklist_expires ON token_blocklist(expires_at)`);
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_revoked_before INTEGER`);
    } catch (e) { /* ignore */ }

    // Account-level login attempt tracking for brute-force protection
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        failed_count INTEGER DEFAULT 0,
        window_start INTEGER NOT NULL,
        locked_until INTEGER,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Payment channels for modular gateway config
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_channels (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        env TEXT NOT NULL DEFAULT 'production',
        priority INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        is_primary BOOLEAN DEFAULT false,
        use_qrcode BOOLEAN DEFAULT false,
        qr_expire_seconds INTEGER DEFAULT 600,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate existing payment_channels to add QR code support columns
    for (const colDef of ['use_qrcode BOOLEAN DEFAULT false', 'qr_expire_seconds INTEGER DEFAULT 600']) {
      const colName = colDef.split(' ')[0];
      try {
        const colExists = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'payment_channels' AND column_name = $1
        `, [colName]);
        if (colExists.rows.length === 0) {
          await pool.query(`ALTER TABLE payment_channels ADD COLUMN ${colDef}`);
          console.log(`[PostgreSQL] Added column ${colName} to payment_channels`);
        }
      } catch (e) {
        console.log(`[PostgreSQL] Column ${colName} check/add failed:`, e.message);
      }
    }

    // IP blacklist for access control
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ip_blacklists (
        id SERIAL PRIMARY KEY,
        ip CIDR NOT NULL,
        reason TEXT,
        enabled BOOLEAN DEFAULT true,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      )
    `);

    // Migrate existing billing_plans.is_active from INTEGER to BOOLEAN if needed
    try {
      // Drop incompatible default first, then alter type, then set a boolean default.
      await pool.query(`ALTER TABLE billing_plans ALTER COLUMN is_active DROP DEFAULT`);
      await pool.query(`ALTER TABLE billing_plans ALTER COLUMN is_active TYPE BOOLEAN USING (is_active::int::boolean)`);
      await pool.query(`ALTER TABLE billing_plans ALTER COLUMN is_active SET DEFAULT true`);
    } catch (e) { /* Column already boolean or table doesn't exist yet */ }

    // Seed default billing plans if empty
    const plansExist = await get("SELECT id FROM billing_plans LIMIT 1");
    if (!plansExist) {
      await run(`INSERT INTO billing_plans (name, description, price_monthly, price_yearly, quota_limit, features, is_active) VALUES
        ('免费版', '个人开发者入门', 0, 0, 100000, '{"models":"all","support":"community","rate":60}', true)`);
      await run(`INSERT INTO billing_plans (name, description, price_monthly, price_yearly, quota_limit, features, is_active) VALUES
        ('专业版', '小型团队适用', 99, 999, 1000000, '{"models":"all","support":"email","rate":300,"analytics":true}', true)`);
      await run(`INSERT INTO billing_plans (name, description, price_monthly, price_yearly, quota_limit, features, is_active) VALUES
        ('企业版', '大型企业定制', 999, 9999, 10000000, '{"models":"all","support":"dedicated","rate":3000,"analytics":true,"sso":true,"sla":true}', true)`);
      console.log('Default billing plans created in PostgreSQL');
    }

    // Ensure default model group exists
    const defaultGroup = await get("SELECT id FROM model_groups WHERE name = 'default'");
    if (!defaultGroup) {
      await run("INSERT INTO model_groups (name, is_system, rate_multiplier) VALUES ('default', true, 1)");
      console.log('Default model group created in PostgreSQL');
    }

    // Reset concurrent counters on startup
    await run("UPDATE sources SET current_concurrent = 0");
    await run("UPDATE user_keys SET current_concurrent = 0");
    await run("UPDATE model_concurrent_tracker SET current_concurrent = 0");

    // Fix INTEGER overflow: upgrade total_tokens / total_requests to BIGINT
    const bigintUpgrades = [
      { table: 'sources', columns: ['total_tokens', 'total_requests'] },
      { table: 'user_keys', columns: ['total_tokens', 'total_requests'] },
      { table: 'request_logs', columns: ['total_tokens'] }
    ];
    for (const { table, columns } of bigintUpgrades) {
      for (const col of columns) {
        try {
          const typeRes = await pool.query(`
            SELECT data_type FROM information_schema.columns
            WHERE table_name = $1 AND column_name = $2
          `, [table, col]);
          if (typeRes.rows.length > 0 && typeRes.rows[0].data_type === 'integer') {
            await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE BIGINT`);
            console.log(`[PostgreSQL] Upgraded ${table}.${col} from INTEGER to BIGINT`);
          }
        } catch (e) {
          console.log(`[PostgreSQL] BIGINT upgrade for ${table}.${col} failed:`, e.message);
        }
      }
    }

    // Currency precision upgrade: ensure local-cost fields are wide enough for small USD->CNY conversions
    try {
      const rateRow = await get("SELECT value FROM settings WHERE key = 'exchange_rate'");
      const exchangeRate = parseFloat(rateRow?.value) || 7.25;

      // request_logs: store original USD cost and local currency cost separately
      await pool.query(`
        ALTER TABLE request_logs
        ADD COLUMN IF NOT EXISTS cost_local NUMERIC(18, 8) DEFAULT 0
      `);
      // Backfill historical logs in id-range batches to avoid long statement timeouts on large tables.
      // Assume old cost was USD and convert to the user's billing currency (CNY by default).
      const idRange = await pool.query(`SELECT COALESCE(MIN(id), 0) as min_id, COALESCE(MAX(id), 0) as max_id FROM request_logs`);
      const minId = Number(idRange.rows[0].min_id);
      const maxId = Number(idRange.rows[0].max_id);
      const BATCH_SIZE = 10000;
      let backfilled = 0;
      if (minId > 0 && maxId >= minId) {
        for (let start = minId; start <= maxId; start += BATCH_SIZE) {
          const end = start + BATCH_SIZE;
          const result = await pool.query(`
            UPDATE request_logs
            SET cost_local = cost * $1
            WHERE id >= $2 AND id < $3 AND cost_local = 0 AND cost <> 0
          `, [exchangeRate, start, end]);
          backfilled += result.rowCount || 0;
        }
      }
      if (backfilled > 0) {
        console.log(`[PostgreSQL] Backfilled cost_local for ${backfilled} historical request_logs`);
      }

      // Widen balance columns to avoid precision loss for tiny costs and large balances
      const precisionUpgrades = [
        { table: 'users', column: 'balance', type: 'NUMERIC(18, 4)' },
        { table: 'users', column: 'total_cost', type: 'NUMERIC(18, 4)' },
        { table: 'workspaces', column: 'balance', type: 'NUMERIC(18, 4)' }
      ];
      for (const { table, column, type } of precisionUpgrades) {
        try {
          await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type}`);
          console.log(`[PostgreSQL] Upgraded ${table}.${column} to ${type}`);
        } catch (e) {
          console.log(`[PostgreSQL] Precision upgrade for ${table}.${column} failed:`, e.message);
        }
      }
      // Add per-user log retention limit (for the log management system)
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS log_retention_limit INTEGER DEFAULT 100000`);
        await pool.query(`UPDATE users SET log_retention_limit = 100000 WHERE log_retention_limit IS NULL`);
      } catch (e) {
        console.log('[PostgreSQL] log_retention_limit upgrade failed:', e.message);
      }
    } catch (e) {
      console.log('[PostgreSQL] Currency precision upgrade failed:', e.message);
    }

    // Add last-check status detail columns to sources table
    const statusDetailColumns = [
      'last_check_status_code INTEGER',
      'last_check_detail TEXT'
    ];
    for (const colDef of statusDetailColumns) {
      const colName = colDef.split(' ')[0];
      try {
        const checkResult = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'sources' AND column_name = '${colName}'
        `);
        if (checkResult.rows.length === 0) {
          await pool.query(`ALTER TABLE sources ADD COLUMN ${colDef}`);
          console.log(`[PostgreSQL] Added column ${colName} to sources table`);
        }
      } catch (e) {
        console.log(`[PostgreSQL] Column ${colName} check/add failed:`, e.message);
      }
    }

    // Add smart routing columns to sources table
    const columnsToAdd = [
      'balance_group TEXT',
      'direct_status TEXT DEFAULT \'enabled\'',
      'direct_disabled_until TIMESTAMP',
      'direct_latency_ms INTEGER',
      'direct_last_check TIMESTAMP',
      'direct_fail_count INTEGER DEFAULT 0',
      'direct_success_count INTEGER DEFAULT 0',
      'direct_flap_count INTEGER DEFAULT 0'
    ];

    for (const colDef of columnsToAdd) {
      const colName = colDef.split(' ')[0];
      try {
        // 先检查列是否存在
        const checkResult = await pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'sources' AND column_name = '${colName}'
        `);
        if (checkResult.rows.length === 0) {
          await pool.query(`ALTER TABLE sources ADD COLUMN ${colDef}`);
          console.log(`[PostgreSQL] Added column ${colName} to sources table`);
        }
      } catch (e) {
        console.log(`[PostgreSQL] Column ${colName} check/add failed:`, e.message);
      }
    }

    // Initialize smart routing settings (except routing_mode to preserve user choice)
    const routingSettings = [
      // { key: 'routing_mode', value: 'auto' }, // 不在此初始化，保留用户选择
      { key: 'direct_latency_multiplier', value: '2' },
      { key: 'direct_latency_threshold_ms', value: '300' },
      { key: 'direct_disable_duration_hours', value: '24' },
      { key: 'routing_strategy', value: 'balanced' },
      { key: 'direct_check_interval_enabled', value: '15' },
      { key: 'direct_check_interval_disabled', value: '2' },
      { key: 'direct_check_interval_pending', value: '1' },
      { key: 'direct_check_interval_flapping', value: '30' }
    ];

    for (const setting of routingSettings) {
      const existing = await get("SELECT value FROM settings WHERE key = ?", [setting.key]);
      if (!existing) {
        await run("INSERT INTO settings (key, value) VALUES (?, ?)", [setting.key, setting.value]);
      }
    }

    // 只在 routing_mode 完全不存在时才设置默认值
    const routingModeExists = await get("SELECT value FROM settings WHERE key = 'routing_mode'");
    if (!routingModeExists) {
      await run("INSERT INTO settings (key, value) VALUES ('routing_mode', 'auto')");
    }

    // 添加 relay_source_id 列到 sources 表
    try {
      const relaySourceCol = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sources' AND column_name = 'relay_source_id'
      `);
      if (relaySourceCol.rows.length === 0) {
        await pool.query("ALTER TABLE sources ADD COLUMN relay_source_id INTEGER");
        console.log('[PostgreSQL] Added column relay_source_id to sources table');
      }
    } catch (e) {
      console.log('[PostgreSQL] Column relay_source_id check/add failed:', e.message);
    }

    // 创建配置版本管理表
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS routing_config_versions (
          id SERIAL PRIMARY KEY,
          version INTEGER NOT NULL UNIQUE,
          config_data JSONB NOT NULL,
          is_active BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('[PostgreSQL] routing_config_versions table ready');
    } catch (e) {
      console.log('[PostgreSQL] routing_config_versions table creation failed:', e.message);
    }

    // 创建会话追踪表
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS routing_sessions (
          session_id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64),
          config_version INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('[PostgreSQL] routing_sessions table ready');
    } catch (e) {
      console.log('[PostgreSQL] routing_sessions table creation failed:', e.message);
    }

    // 创建索引
    try {
      await pool.query("CREATE INDEX IF NOT EXISTS idx_routing_sessions_config_version ON routing_sessions(config_version)");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_routing_sessions_last_activity ON routing_sessions(last_activity)");
    } catch (e) {
      console.log('[PostgreSQL] Index creation failed:', e.message);
    }

    console.log('PostgreSQL database initialized successfully');
  } catch (error) {
    console.error('PostgreSQL init error:', error);
    throw error;
  }
};

// ========== Graceful shutdown ==========
process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

function getApiKey(source, protocol) {
  if (source.api_keys) {
    try {
      const keys = typeof source.api_keys === 'string' ? JSON.parse(source.api_keys) : source.api_keys;
      const key = keys[protocol];
      if (key) return decrypt(key);
    } catch (e) {}
  }
  return decrypt(source.api_key);
}

function getApiUrl(source, protocol) {
  if (source.api_urls) {
    try {
      const urls = typeof source.api_urls === 'string' ? JSON.parse(source.api_urls) : source.api_urls;
      const url = urls[protocol];
      if (url) return url;
    } catch (e) {}
  }
  return source.base_url;
}

// No-op for PostgreSQL (data is persisted automatically)
const saveDatabase = () => {};
const scheduleSave = () => {};

module.exports = {
  type: 'postgres',
  initDatabase,
  query,
  run,
  get,
  all,
  batchRun,
  saveDatabase,
  scheduleSave,
  encrypt,
  decrypt,
  parseGroups,
  getApiKey,
  getApiUrl,
  pool,
};
