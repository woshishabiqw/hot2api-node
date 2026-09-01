/**
 * Log Management System
 *
 * Enforces per-user request log retention limits. Each user keeps at most
 * `log_retention_limit` rows in `request_logs`; older rows are deleted when the
 * limit is exceeded ("覆盖历史").
 */

const db = require('../config/database');

const DEFAULT_LIMIT = 100000;
const SETTINGS_KEY = 'default_log_retention_limit';

async function getDefaultLimit() {
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY]);
    const parsed = parseInt(row?.value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch (e) {
    console.error('[LogManagement] Failed to load default limit:', e?.message);
  }
  return DEFAULT_LIMIT;
}

async function setDefaultLimit(limit) {
  const value = parseInt(limit, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('limit must be a positive integer');
  }
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTINGS_KEY, String(value)]
  );
  return value;
}

async function getUserLimit(userId) {
  const row = await db.get('SELECT log_retention_limit FROM users WHERE id = ?', [userId]);
  if (row?.log_retention_limit != null) return Number(row.log_retention_limit);
  return getDefaultLimit();
}

async function setUserLimit(userId, limit) {
  const value = parseInt(limit, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('limit must be a positive integer');
  }
  await db.run('UPDATE users SET log_retention_limit = ? WHERE id = ?', [value, userId]);
  return value;
}

/**
 * Trim a single user's request_logs down to their retention limit.
 * Deletes oldest rows first.
 * @param {number} userId
 * @param {number} [batchSize]
 * @returns {Promise<number>} number of rows deleted
 */
async function trimUserLogs(userId, batchSize = 10000) {
  const limit = await getUserLimit(userId);
  let deleted = 0;

  while (true) {
    const countRow = await db.get('SELECT COUNT(*) as c FROM request_logs WHERE user_id = ?', [userId]);
    const total = Number(countRow?.c) || 0;
    if (total <= limit) break;

    const toDelete = Math.min(batchSize, total - limit);

    const result = await db.run(`
      DELETE FROM request_logs
      WHERE id IN (
        SELECT id FROM request_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        OFFSET $2
        LIMIT $3
      )
    `, [userId, limit, toDelete]);
    deleted += result.changes || 0;
  }

  return deleted;
}

/**
 * Trim all users whose request_logs exceed their retention limit.
 * @returns {Promise<{deletedTotal: number, usersProcessed: number}>}
 */
async function trimAllUsers() {
  const users = await db.all(`
    SELECT u.id, COALESCE(u.log_retention_limit, $1) as limit_value
    FROM users u
    WHERE EXISTS (
      SELECT 1 FROM request_logs r WHERE r.user_id = u.id
    )
  `, [await getDefaultLimit()]);

  let deletedTotal = 0;
  for (const user of users) {
    try {
      const deleted = await trimUserLogs(user.id);
      deletedTotal += deleted;
    } catch (e) {
      console.error(`[LogManagement] Failed to trim user ${user.id}:`, e?.message);
    }
  }
  return { deletedTotal, usersProcessed: users.length };
}

async function getUsersWithCounts({ page = 1, pageSize = 20, search = '' } = {}) {
  const offset = Math.max(0, (page - 1) * pageSize);
  const hasSearch = Boolean(search);
  const pattern = hasSearch ? `%${search}%` : null;

  const defaultLimit = await getDefaultLimit();

  let countSql = 'SELECT COUNT(*) as c FROM users';
  let countParams = [];
  if (hasSearch) {
    countSql += ' WHERE LOWER(username) LIKE LOWER(?)';
    countParams.push(pattern);
  }
  const countRow = await db.get(countSql, countParams);
  const total = Number(countRow?.c) || 0;

  let usersSql = `
    SELECT
      u.id,
      u.username,
      u.role,
      u.is_active,
      COALESCE(u.log_retention_limit, ?) as log_retention_limit,
      (SELECT COUNT(*) FROM request_logs r WHERE r.user_id = u.id) as log_count
    FROM users u
  `;
  const usersParams = [defaultLimit];
  if (hasSearch) {
    usersSql += ' WHERE LOWER(u.username) LIKE LOWER(?)';
    usersParams.push(pattern);
  }
  usersSql += ' ORDER BY log_count DESC, u.id DESC LIMIT ? OFFSET ?';
  usersParams.push(pageSize, offset);

  const users = await db.all(usersSql, usersParams);

  return {
    users,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}

async function getStats() {
  const [totalLogs, totalUsers, defaultLimit] = await Promise.all([
    db.get('SELECT COUNT(*) as c FROM request_logs'),
    db.get('SELECT COUNT(*) as c FROM users'),
    getDefaultLimit()
  ]);

  const overLimit = await db.get(`
    SELECT COUNT(*) as c FROM users u
    WHERE (
      SELECT COUNT(*) FROM request_logs r WHERE r.user_id = u.id
    ) > COALESCE(u.log_retention_limit, ?)
  `, [defaultLimit]);

  return {
    total_logs: Number(totalLogs?.c) || 0,
    total_users: Number(totalUsers?.c) || 0,
    users_over_limit: Number(overLimit?.c) || 0,
    default_limit: defaultLimit
  };
}

function startPeriodicTrim(intervalMs = 60 * 60 * 1000) {
  console.log(`[LogManagement] Periodic trim scheduled every ${intervalMs / 60000} minutes`);
  const run = async () => {
    try {
      const { deletedTotal, usersProcessed } = await trimAllUsers();
      if (deletedTotal > 0) {
        console.log(`[LogManagement] Trimmed ${deletedTotal} old logs across ${usersProcessed} users`);
      }
    } catch (e) {
      console.error('[LogManagement] Periodic trim failed:', e?.message);
    }
  };
  setInterval(run, intervalMs);
  // Run once shortly after startup, but not blocking
  setTimeout(run, 30 * 1000);
}

module.exports = {
  DEFAULT_LIMIT,
  SETTINGS_KEY,
  getDefaultLimit,
  setDefaultLimit,
  getUserLimit,
  setUserLimit,
  trimUserLogs,
  trimAllUsers,
  getUsersWithCounts,
  getStats,
  startPeriodicTrim
};
