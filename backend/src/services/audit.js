const db = require('../config/database');

const VALID_ACTIONS = [
  'create', 'update', 'delete', 'login', 'logout',
  'test', 'import', 'batch_update', 'batch_delete', 'toggle',
  'admin_recharge', 'blocked'
];

const VALID_RESOURCES = [
  'source', 'model', 'model_group', 'user', 'key',
  'dispatch_rule', 'setting', 'system', 'billing', 'ip_blacklist'
];

/**
 * Log an audit event
 * @param {Object} params
 * @param {number} params.userId - Acting user ID
 * @param {string} params.username - Acting user username
 * @param {string} params.action - One of VALID_ACTIONS
 * @param {string} params.resourceType - One of VALID_RESOURCES
 * @param {number} [params.resourceId] - Affected resource ID
 * @param {string} [params.resourceName] - Affected resource name
 * @param {Object} [params.oldValue] - Previous state (will be JSON-stringified)
 * @param {Object} [params.newValue] - New state (will be JSON-stringified)
 * @param {Object} [params.req] - Express request object (for IP & UA)
 */
async function log({ userId, username, action, resourceType, resourceId, resourceName, oldValue, newValue, req }) {
  // 验证必需参数
  if (!action || !VALID_ACTIONS.includes(action)) {
    console.warn(`[Audit] Invalid or missing action: ${action}`);
    return;
  }
  if (!resourceType || !VALID_RESOURCES.includes(resourceType)) {
    console.warn(`[Audit] Invalid or missing resource_type: ${resourceType}`);
    return;
  }

  const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
  const userAgent = req?.headers?.['user-agent'] || null;

  try {
    await db.run(
      `INSERT INTO audit_logs
       (user_id, username, action, resource_type, resource_id, resource_name, old_value, new_value, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        username || null,
        action,
        resourceType,
        resourceId || null,
        resourceName || null,
        oldValue ? JSON.stringify(oldValue).slice(0, 10000) : null,
        newValue ? JSON.stringify(newValue).slice(0, 10000) : null,
        ipAddress,
        userAgent
      ]
    );
    if (process.env.LOG_LEVEL === 'debug') console.log(`[Audit] Logged: ${action} on ${resourceType} by ${username || 'unknown'}`);
  } catch (err) {
    console.error('[Audit] Log failed:', err.message);
  }
}

/**
 * Get audit logs with pagination and filtering
 */
async function getLogs({ page = 1, limit = 50, action, resourceType, userId, search, startDate, endDate }) {
  const conditions = [];
  const params = [];

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (resourceType) {
    conditions.push('resource_type = ?');
    params.push(resourceType);
  }
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (search) {
    conditions.push('(username LIKE ? OR resource_name LIKE ? OR new_value LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (startDate) {
    conditions.push('created_at >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('created_at <= ?');
    params.push(endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (Math.max(1, page) - 1) * limit;

  const logs = await db.all(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const countResult = await db.get(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);

  return {
    logs,
    total: countResult?.total || 0,
    page,
    limit,
    totalPages: Math.ceil((countResult?.total || 0) / limit)
  };
}

/**
 * Get audit statistics
 */
async function getStats() {
  const total = await db.get("SELECT COUNT(*) as count FROM audit_logs");
  const today = await db.get("SELECT COUNT(*) as count FROM audit_logs WHERE date(created_at) = date('now')");
  const byAction = await db.all("SELECT action, COUNT(*) as count FROM audit_logs GROUP BY action ORDER BY count DESC");
  const byResource = await db.all("SELECT resource_type, COUNT(*) as count FROM audit_logs GROUP BY resource_type ORDER BY count DESC");

  return {
    total: total?.count || 0,
    today: today?.count || 0,
    byAction,
    byResource
  };
}

/**
 * Clear all audit logs
 * @returns {Promise<number>} number of deleted rows
 */
async function clearLogs() {
  const result = await db.run('DELETE FROM audit_logs');
  return result.changes || 0;
}

module.exports = { log, getLogs, getStats, clearLogs, VALID_ACTIONS, VALID_RESOURCES };
