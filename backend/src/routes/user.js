/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication and user management
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const cacheService = require('../services/cache');
const cacheManager = require('../services/cache-manager');
const probeService = require('../services/probe');
const { authMiddleware, login, register, logout, getProfile, revokeAllUserTokens } = require('../middleware/auth');
const { validatePassword } = require('../utils/password-policy');
const { getRegistrationConfig } = require('../services/registration-config');
const { setupSecondPassword, verifySecondPassword, getSecondPasswordStatus, resetSecondPassword, refreshSecondToken,
        setupPaymentPassword, verifyPaymentPassword, getPaymentPasswordStatus, resetPaymentPassword, refreshPaymentToken } = require('../middleware/second-auth');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const apiKeyMiddleware = require('../middleware/apikey');

function unescapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Convert a numeric value between stored currency and display currency.
 * Model prices/costs are stored in USD; user balance/quota are stored in the user's currency.
 * @param {number} value
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {number} rate
 * @returns {number}
 */
function convertCurrency(value, fromCurrency, toCurrency, rate) {
  if (fromCurrency === toCurrency) return value || 0;
  if (!rate || !isFinite(rate) || rate <= 0) return value || 0;
  const from = (fromCurrency || 'CNY').toUpperCase();
  const to = (toCurrency || 'CNY').toUpperCase();
  if (from === 'USD' && to !== 'USD') return (value || 0) * rate;
  if (from !== 'USD' && to === 'USD') return (value || 0) / rate;
  // Unknown cross-currency: no conversion
  return value || 0;
}

/**
 * Normalize a request log cost into the display currency.
 * Prefer the already-converted cost_local when the stored currency matches the display currency.
 * @param {object} log
 * @param {string} storedCurrency
 * @param {string} displayCurrency
 * @param {number} rate
 * @returns {number}
 */
function normalizeLogCost(log, storedCurrency, displayCurrency, rate) {
  const hasLocal = log.cost_local != null && isFinite(Number(log.cost_local));
  if (displayCurrency === (storedCurrency || 'CNY')) {
    return hasLocal ? Number(log.cost_local) : convertCurrency(log.cost, 'USD', displayCurrency, rate);
  }
  if (displayCurrency === 'USD') {
    return log.cost != null ? Number(log.cost) : (hasLocal ? convertCurrency(log.cost_local, storedCurrency, 'USD', rate) : 0);
  }
  return convertCurrency(hasLocal ? log.cost_local : log.cost, hasLocal ? storedCurrency : 'USD', displayCurrency, rate);
}

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', login);
/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: User registration
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Registration successful
 */
router.post('/register', register);

/**
 * @swagger
 * /auth/config:
 *   get:
 *     summary: Get public registration configuration
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Public registration settings
 */
router.get('/config', async (req, res) => {
  try {
    const config = await getRegistrationConfig();
    res.json({
      registrationEnabled: config.registrationEnabled,
      captchaEnabled: config.captchaEnabled,
      emailVerificationEnabled: config.emailVerificationEnabled,
      approvalMode: config.approvalMode,
    });
  } catch (err) {
    console.error('[Auth] Failed to read public config:', err.message);
    res.status(500).json({ error: '读取配置失败' });
  }
});

/**
 * @swagger
 * /auth/captcha:
 *   get:
 *     summary: Get a graphical captcha
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: SVG captcha image and token
 */
const captchaService = require('../services/captcha');
router.get('/captcha', async (req, res) => {
  try {
    const { token, svg } = await captchaService.generate();
    res.setHeader('Content-Type', 'application/json');
    res.json({ token, svg });
  } catch (err) {
    console.error('[Auth] Failed to generate captcha:', err.message);
    res.status(500).json({ error: '验证码生成失败' });
  }
});

/**
 * @swagger
 * /auth/send-email-code:
 *   post:
 *     summary: Send an email verification code
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Code sent
 */
const emailCodeService = require('../services/email-code');
const mailSender = require('../services/mail-sender');
router.post('/send-email-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }

    const { getRegistrationConfig } = require('../services/registration-config');
    const regConfig = await getRegistrationConfig();
    if (!regConfig.emailVerificationEnabled) {
      return res.status(403).json({ error: '当前未启用邮箱验证' });
    }

    const cooldown = await emailCodeService.canSend(email);
    if (!cooldown.ok) {
      return res.status(429).json({ error: cooldown.reason });
    }

    const { code } = await emailCodeService.sendCode(email);
    await mailSender.sendVerificationCode(email, code);
    res.json({ success: true, message: '验证码已发送' });
  } catch (err) {
    console.error('[Auth] Failed to send email code:', err.message);
    res.status(500).json({ error: err.message || '验证码发送失败' });
  }
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout and revoke current token
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out
 */
router.post('/logout', authMiddleware, logout);

router.use(authMiddleware);

/**
 * @swagger
 * /auth/profile:
 *   get:
 *     summary: Get user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 */
router.get('/profile', getProfile);

/**
 * @swagger
 * /user/models:
 *   get:
 *     summary: List available models
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of models
 */
router.get('/models', async (req, res) => {
  const models = await db.all(`
    SELECT m.*, s.name as source_name, s.protocol, s.status as source_status
    FROM models m
    LEFT JOIN sources s ON m.source_id = s.id
    WHERE m.is_active = true AND s.is_active = true
    ORDER BY m.model_group, m.priority DESC, m.model_id
  `);
  res.json(models);
});

router.get('/sources/latency', async (req, res) => {
  const results = await probeService.getResults();
  const out = {};
  for (const [sourceId, probeData] of Object.entries(results)) {
    out[sourceId] = {};
    for (const [proto, info] of Object.entries(probeData || {})) {
      out[sourceId][proto] = { latencyMs: info.latencyMs || 0, status: info.status };
    }
  }
  res.json(out);
});

router.get('/models/health', async (req, res) => {
  const models = await db.all('SELECT model_id FROM models WHERE is_active = true');
  const modelIds = models.map(m => m.model_id);
  if (modelIds.length === 0) return res.json({});

  const placeholders = modelIds.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT model, latency_ms FROM request_logs
     WHERE model IN (${placeholders})
       AND created_at > datetime('now', '-5 minutes')
       AND latency_ms IS NOT NULL
     ORDER BY model, created_at DESC`,
    modelIds
  );

  const health = {};
  for (const row of rows) {
    if (!health[row.model]) health[row.model] = [];
    health[row.model].push(row.latency_ms);
  }

  const result = {};
  for (const [modelId, latencies] of Object.entries(health)) {
    const sparkline = latencies.slice(0, 20).reverse();
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    result[modelId] = {
      sparkline,
      avgLatency: Math.round(avg),
      healthy: true
    };
  }

  res.json(result);
});

router.get('/model-groups', async (req, res) => {
  const groups = await db.all('SELECT id, name, description, rate_multiplier FROM model_groups WHERE is_active = true ORDER BY name');
  res.json(groups);
});

router.put('/profile', async (req, res) => {
  const { password } = req.body;
  
  if (password) {
    const policy = validatePassword(password);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.error });
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);
    await revokeAllUserTokens(req.user.id);
  }

  res.json({ success: true });
});

/**
 * @swagger
 * /user/keys:
 *   get:
 *     summary: List user API keys
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of API keys
 */
router.get('/keys', async (req, res) => {
  const keys = await db.all(`
    SELECT id, key_prefix, encrypted_key, name, is_active, last_used_at, created_at,
           max_concurrent, current_concurrent, total_requests, total_tokens,
           rate_limit, model_limit, group_limit, expires_at, quota_limit, quota_used, currency, quota_type
    FROM user_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [req.user.id]);

  const result = keys.map(k => ({
    ...k,
    key: k.encrypted_key ? db.decrypt(k.encrypted_key) : null
  }));

  res.json(result);
});

router.post('/keys', async (req, res) => {
  const { name, model_limit, group_limit, expires_at, quota_limit, currency, quota_type } = req.body;
  const rawKey = `sk-${uuidv4().replace(/-/g, '').substring(0, 32)}`;
  const keyHash = bcrypt.hashSync(rawKey, 10);
  const keyPrefix = rawKey.substring(0, 12) + '...';
  const encryptedKey = db.encrypt(rawKey);

  const result = await db.run(
    `INSERT INTO user_keys (user_id, key_hash, key_prefix, encrypted_key, name, model_limit, group_limit, expires_at, quota_limit, currency, quota_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id, keyHash, keyPrefix, encryptedKey, name || 'API Key',
      model_limit || 'all', group_limit || 'all',
      expires_at || null, quota_limit || 0,
      currency || 'CNY', quota_type || 'tokens'
    ]
  );

  apiKeyMiddleware.invalidateCache();

  res.status(201).json({
    id: result.lastInsertRowid,
    key: rawKey,
    key_prefix: keyPrefix,
    name: name || 'API Key'
  });
});

router.put('/keys/:id', async (req, res) => {
  const { id } = req.params;
  const { name, model_limit, group_limit, expires_at, quota_limit, quota_type, is_active, rate_limit, max_concurrent } = req.body;

  const key = await db.get('SELECT * FROM user_keys WHERE id = ? AND user_id = ?', [parseInt(id), req.user.id]);
  if (!key) return res.status(404).json({ error: 'Key not found' });

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (model_limit !== undefined) { fields.push('model_limit = ?'); params.push(model_limit); }
  if (group_limit !== undefined) { fields.push('group_limit = ?'); params.push(group_limit); }
  if (expires_at !== undefined) { fields.push('expires_at = ?'); params.push(expires_at || null); }
  if (quota_limit !== undefined) {
    const ql = parseFloat(quota_limit);
    if (!isFinite(ql) || ql > 999999999999 || ql < 0) {
      return res.status(400).json({ error: { message: 'quota_limit out of range (max 999999999999.99999999)', type: 'invalid_request_error' } });
    }
    fields.push('quota_limit = ?'); params.push(ql);
  }
  if (quota_type !== undefined) { fields.push('quota_type = ?'); params.push(quota_type); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active === true || is_active === 'true' || is_active === 1); }
  if (rate_limit !== undefined) { fields.push('rate_limit = ?'); params.push(parseInt(rate_limit)); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(parseInt(max_concurrent)); }

  if (fields.length === 0) return res.json({ success: true, no_changes: true });

  params.push(parseInt(id));
  await db.run(`UPDATE user_keys SET ${fields.join(', ')} WHERE id = ?`, params);
  apiKeyMiddleware.invalidateCache();
  res.json({ success: true });
});

router.delete('/keys/:id', async (req, res) => {
  const { id } = req.params;

  const key = await db.get('SELECT * FROM user_keys WHERE id = ? AND user_id = ?', [parseInt(id), req.user.id]);
  if (!key) return res.status(404).json({ error: 'Key not found' });

  await db.run('DELETE FROM user_keys WHERE id = ?', [parseInt(id)]);
  apiKeyMiddleware.invalidateCache();
  res.json({ success: true });
});

// Per-user in-flight promises for stats cache stampede protection
const _userStatsPromises = new Map();
// Track users whose cumulative stats are being backfilled asynchronously
const _cumulativeBackfillInFlight = new Set();

router.get('/stats', async (req, res) => {
  const range = req.query.range || '30d';

  // Fetch user first to determine currency and cumulative stats
  const user = await db.get('SELECT balance, quota_limit, quota_used, currency, total_tokens, total_requests, total_cost FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const displayCurrency = req.query.currency || user.currency || 'CNY';
  const storedCurrency = user.currency || 'CNY';
  const cacheKey = `user:stats:${req.user.id}:${range}:${displayCurrency}`;
  // Dashboard data freshness vs. query cost trade-off:
  // short ranges reflect real-time traffic -> shorter TTL;
  // 7d/30d are aggregated and expensive -> longer TTL.
  const cacheTTL =
    range === '5m' || range === '1h' || range === '6h' ? 30 :
    range === '24h' ? 60 :
    300; // 7d / 30d

  try {
    const cached = await cacheService.get(cacheKey);
    if (cached) return res.json(cached);
  } catch (e) {
    // ignore cache read error
  }

  // Cache stampede protection per user/range/currency
  const promiseKey = cacheKey;
  const existingPromise = _userStatsPromises.get(promiseKey);
  if (existingPromise) {
    try {
      const result = await existingPromise;
      return res.json(result);
    } catch (e) {
      // fall through to compute ourselves
    }
  }

  const currentPromise = (async () => {
    const exchangeRateSettingP = db.get("SELECT value FROM settings WHERE key = 'exchange_rate'");

    // Prefer pre-aggregated daily stats for today to avoid scanning huge request_logs.
    // If the write path has not yet flushed today's row, we accept a transient 0
    // rather than triggering a heavy request_logs scan on every dashboard load.
    const todayP = (async () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const agg = await db.get(`
        SELECT SUM(requests) as requests, SUM(tokens) as tokens, SUM(cost) as cost,
               COALESCE(SUM(latency_ms_sum) / NULLIF(SUM(latency_ms_count), 0), 0) as avg_latency
        FROM user_daily_model_stats
        WHERE user_id = ? AND date = ?
      `, [req.user.id, todayStr]);
      return {
        requests: agg?.requests || 0,
        tokens: agg?.tokens || 0,
        cost: agg?.cost || 0,
        avg_latency: agg?.avg_latency || 0
      };
    })();

    // Cumulative stats are maintained in users table for O(1) reads; backfill from request_logs once if empty.
    const cumulativeP = (async () => {
      let totalTokens = Number(user.total_tokens) || 0;
      let totalRequests = Number(user.total_requests) || 0;
      let totalCost = Number(user.total_cost) || 0;

      if (totalRequests === 0) {
        const hasLogs = await db.get('SELECT COUNT(*) as count FROM request_logs WHERE user_id = ?', [req.user.id]);
        if (hasLogs.count > 0) {
          const rateRow = await db.get("SELECT value FROM settings WHERE key = 'exchange_rate'");
          const localRate = parseFloat(rateRow?.value) || 7.25;
          const isUsdUser = storedCurrency === 'USD';

          // For huge historical users, don't block the dashboard request with a full table scan.
          // Use the pre-aggregated daily table for a fast approximate answer, then correct it in the background.
          const HEAVY_LOG_THRESHOLD = 50000;
          if (hasLogs.count > HEAVY_LOG_THRESHOLD) {
            const fast = await db.get(`
              SELECT SUM(tokens) as total_tokens, SUM(requests) as total_requests, SUM(cost) as total_cost
              FROM user_daily_model_stats
              WHERE user_id = ?
            `, [req.user.id]);
            totalTokens = Number(fast?.total_tokens) || 0;
            totalRequests = Number(fast?.total_requests) || 0;
            // Aggregated daily cost is stored in USD; convert to the user's billing currency
            totalCost = convertCurrency(Number(fast?.total_cost) || 0, 'USD', storedCurrency, localRate);

            if (!_cumulativeBackfillInFlight.has(req.user.id)) {
              _cumulativeBackfillInFlight.add(req.user.id);
              setImmediate(async () => {
                try {
                  const computed = await db.get(`
                    SELECT SUM(total_tokens) as total_tokens, COUNT(*) as total_requests,
                           SUM(COALESCE(cost_local, CASE WHEN $2 = 'USD' THEN cost ELSE cost * $3 END)) as total_cost
                    FROM request_logs
                    WHERE user_id = $1
                  `, [req.user.id, storedCurrency, localRate]);
                  const t = Number(computed?.total_tokens) || 0;
                  const r = Number(computed?.total_requests) || 0;
                  const c = Number(computed?.total_cost) || 0;
                  await db.run('UPDATE users SET total_tokens = ?, total_requests = ?, total_cost = ? WHERE id = ?', [t, r, c, req.user.id]);
                } catch (e) {
                  console.error('[user/stats] background cumulative backfill failed:', e?.message);
                } finally {
                  _cumulativeBackfillInFlight.delete(req.user.id);
                }
              });
            }
          } else {
            const computed = await db.get(`
              SELECT SUM(total_tokens) as total_tokens, COUNT(*) as total_requests,
                     SUM(COALESCE(cost_local, CASE WHEN $2 = 'USD' THEN cost ELSE cost * $3 END)) as total_cost
              FROM request_logs
              WHERE user_id = $1
            `, [req.user.id, storedCurrency, localRate]);
            totalTokens = Number(computed?.total_tokens) || 0;
            totalRequests = Number(computed?.total_requests) || 0;
            totalCost = Number(computed?.total_cost) || 0;
            try {
              await db.run('UPDATE users SET total_tokens = ?, total_requests = ?, total_cost = ? WHERE id = ?', [totalTokens, totalRequests, totalCost, req.user.id]);
            } catch (e) {
              console.error('[user/stats] failed to backfill cumulative:', e?.message);
            }
          }
        }
      }
      return { total_tokens: totalTokens, total_requests: totalRequests, total_cost: totalCost };
    })();

    const activeKeysP = db.get(`
      SELECT COUNT(*) as count FROM user_keys WHERE user_id = ? AND is_active = true
    `, [req.user.id]);

    // For 1h/6h/24h/7d/30d read from pre-aggregated table to avoid scanning huge request_logs.
    // 5m still scans request_logs (data volume is normally small for that short window).
    const useAggregation = range === '1h' || range === '6h' || range === '24h' || range === '7d' || range === '30d';

    let timeFilter, groupBy, orderBy, limit;
    if (range === '5m') {
      timeFilter = "datetime('now', '-5 minutes')";
      groupBy = "strftime('%Y-%m-%d %H:%M', created_at)";
      orderBy = 'date ASC';
      limit = 100;
    } else if (range === '1h') {
      timeFilter = "datetime('now', '-1 hour')";
      groupBy = "strftime('%Y-%m-%d %H:%M', created_at)";
      orderBy = 'date ASC';
      limit = 100;
    } else if (range === '6h') {
      timeFilter = "datetime('now', '-6 hours')";
      groupBy = "strftime('%Y-%m-%d %H:00', created_at)";
      orderBy = 'date ASC';
      limit = 100;
    } else if (range === '24h') {
      timeFilter = "datetime('now', '-24 hours')";
      groupBy = "strftime('%Y-%m-%d %H:00', created_at)";
      orderBy = 'date ASC';
      limit = 100;
    } else if (range === '7d') {
      timeFilter = "datetime('now', '-7 days')";
      groupBy = "date(created_at)";
      orderBy = 'date ASC';
      limit = 100;
    } else {
      timeFilter = "datetime('now', '-30 days')";
      groupBy = "date(created_at)";
      orderBy = 'date ASC';
      limit = 100;
    }

    const modelDistributionP = useAggregation
      ? (async () => {
          let rows = [];
          if (range === '6h' || range === '24h') {
            const startHour = new Date();
            startHour.setHours(startHour.getHours() - (range === '6h' ? 6 : 24));
            const startHourStr = `${startHour.toISOString().slice(0, 10)} ${String(startHour.getUTCHours()).padStart(2, '0')}:00`;
            rows = await db.all(`
              SELECT model, SUM(requests) as count, SUM(tokens) as tokens
              FROM user_hourly_model_stats
              WHERE user_id = ? AND hour >= ?
              GROUP BY model
              ORDER BY tokens DESC
              LIMIT 10
            `, [req.user.id, startHourStr]);
          } else {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - (range === '7d' ? 7 : 30));
            const startDateStr = startDate.toISOString().slice(0, 10);
            rows = await db.all(`
              SELECT model, SUM(requests) as count, SUM(tokens) as tokens
              FROM user_daily_model_stats
              WHERE user_id = ? AND date >= ?
              GROUP BY model
              ORDER BY tokens DESC
              LIMIT 10
            `, [req.user.id, startDateStr]);
          }
          // Fallback to request_logs if aggregation table is not yet backfilled
          if (rows.length === 0) {
            return db.all(`
              SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens
              FROM request_logs
              WHERE user_id = ? AND created_at > ${timeFilter}
              GROUP BY model
              ORDER BY tokens DESC
              LIMIT 10
            `, [req.user.id]);
          }
          return rows;
        })()
      : db.all(`
          SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens
          FROM request_logs
          WHERE user_id = ? AND created_at > ${timeFilter}
          GROUP BY model
          ORDER BY tokens DESC
          LIMIT 10
        `, [req.user.id]);

    const dailyP = useAggregation
      ? (async () => {
          let rows = [];
          if (range === '6h' || range === '24h') {
            const startHour = new Date();
            startHour.setHours(startHour.getHours() - (range === '6h' ? 6 : 24));
            const startHourStr = `${startHour.toISOString().slice(0, 10)} ${String(startHour.getUTCHours()).padStart(2, '0')}:00`;
            rows = await db.all(`
              SELECT hour as date, SUM(requests) as requests, SUM(tokens) as tokens, SUM(cost) as cost
              FROM user_hourly_model_stats
              WHERE user_id = ? AND hour >= ?
              GROUP BY hour
              ORDER BY hour ASC
              LIMIT 100
            `, [req.user.id, startHourStr]);
          } else {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - (range === '7d' ? 7 : 30));
            const startDateStr = startDate.toISOString().slice(0, 10);
            rows = await db.all(`
              SELECT date as date, SUM(requests) as requests, SUM(tokens) as tokens, SUM(cost) as cost
              FROM user_daily_model_stats
              WHERE user_id = ? AND date >= ?
              GROUP BY date
              ORDER BY date ASC
              LIMIT 100
            `, [req.user.id, startDateStr]);
          }
          if (rows.length === 0) {
            return db.all(`
              SELECT ${groupBy} as date, COUNT(*) as requests, SUM(total_tokens) as tokens, SUM(cost) as cost
              FROM request_logs
              WHERE user_id = ? AND created_at > ${timeFilter}
              GROUP BY ${groupBy}
              ORDER BY ${orderBy}
              LIMIT ${limit}
            `, [req.user.id]);
          }
          return rows;
        })()
      : db.all(`
          SELECT ${groupBy} as date, COUNT(*) as requests, SUM(total_tokens) as tokens, SUM(cost) as cost
          FROM request_logs
          WHERE user_id = ? AND created_at > ${timeFilter}
          GROUP BY ${groupBy}
          ORDER BY ${orderBy}
          LIMIT ${limit}
        `, [req.user.id]);

    // Use a subquery to force the DB to pick the top-10 rows by index before joining sources.
    const recentLogsP = db.all(`
      SELECT r.id, r.model, r.total_tokens, r.input_tokens, r.output_tokens,
             r.cached_tokens, r.uncached_tokens, r.latency_ms, r.status_code,
             r.cost, r.cost_local, r.created_at, s.name as source_name
      FROM request_logs r
      LEFT JOIN sources s ON r.source_id = s.id
      WHERE r.id IN (
        SELECT id FROM request_logs
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      )
      ORDER BY r.created_at DESC
      LIMIT 10
    `, [req.user.id]);

    const [exchangeRateSetting, today, cumulative, activeKeys, modelDistribution, daily, recentLogs] = await Promise.all([
      exchangeRateSettingP, todayP, cumulativeP, activeKeysP, modelDistributionP, dailyP, recentLogsP
    ]);

    const exchangeRate = parseFloat(exchangeRateSetting?.value) || 7.25;

    // Personal balance is unified to users.balance (account independent balance).
    const personalBalance = convertCurrency(user.balance, storedCurrency, displayCurrency, exchangeRate);
    const quotaLimit = convertCurrency(user.quota_limit, storedCurrency, displayCurrency, exchangeRate);
    const quotaUsed = convertCurrency(user.quota_used, storedCurrency, displayCurrency, exchangeRate);

    // Convert aggregated daily/hourly costs (stored in USD) to display currency
    const todayCost = convertCurrency(today?.cost || 0, 'USD', displayCurrency, exchangeRate);
    const cumulativeCost = convertCurrency(cumulative?.total_cost || 0, storedCurrency, displayCurrency, exchangeRate);
    const dailyConverted = (daily || []).map(d => ({
      ...d,
      cost: convertCurrency(d.cost, 'USD', displayCurrency, exchangeRate)
    }));
    const recentLogsConverted = (recentLogs || []).map(log => ({
      ...log,
      cost: normalizeLogCost(log, storedCurrency, displayCurrency, exchangeRate),
      cost_usd: log.cost != null ? Number(log.cost) : undefined
    }));

    return {
      personal_balance: personalBalance,
      balance: personalBalance,
      quota_limit: quotaLimit,
      quota_used: quotaUsed,
      quota_remaining: quotaLimit !== 0 ? quotaLimit - quotaUsed : null,
      currency: displayCurrency,
      today: {
        requests: today?.requests || 0,
        tokens: today?.tokens || 0,
        cost: todayCost,
        avg_latency: Math.round(today?.avg_latency || 0)
      },
      active_keys: activeKeys?.count || 0,
      cumulative_tokens: cumulative?.total_tokens || 0,
      cumulative_requests: cumulative?.total_requests || 0,
      cumulative_cost: cumulativeCost,
      model_distribution: modelDistribution,
      daily: dailyConverted,
      recent_logs: recentLogsConverted
    };
  })();
  _userStatsPromises.set(promiseKey, currentPromise);

  try {
    const result = await currentPromise;
    try {
      await cacheManager.set(cacheKey, result, cacheTTL, { tags: ['user:stats', `user:${req.user.id}`] });
    } catch (e) {
      // ignore cache write error
    }
    res.json(result);
  } catch (e) {
    console.error('[user/stats] failed:', e?.message);
    res.status(500).json({ error: 'Failed to compute user stats' });
  } finally {
    if (_userStatsPromises.get(promiseKey) === currentPromise) {
      _userStatsPromises.delete(promiseKey);
    }
  }
});

router.get('/logs', async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const p = Math.max(1, parseInt(page));
  const ps = Math.min(100, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  const user = await db.get('SELECT currency FROM users WHERE id = ?', [req.user.id]);
  const storedCurrency = user?.currency || 'CNY';
  const displayCurrency = req.query.currency || storedCurrency;
  const exchangeRateSetting = await db.get("SELECT value FROM settings WHERE key = 'exchange_rate'");
  const exchangeRate = parseFloat(exchangeRateSetting?.value) || 7.25;

  const countResult = await db.get(`SELECT COUNT(*) as total FROM request_logs WHERE user_id = ?`, [req.user.id]);
  const total = countResult?.total || 0;

  const logs = await db.all(`
    SELECT r.*, s.name as source_name, s.source_group, uk.name as key_name,
           w.id as workspace_id, w.name as workspace_name, u.username as username,
           ts.id as transit_scan_id, ts.result as transit_result, ts.matched_rules as transit_matched_rules,
           ts.details as transit_details, ts.payload_sample as transit_payload_sample
    FROM request_logs r
    LEFT JOIN sources s ON r.source_id = s.id
    LEFT JOIN user_keys uk ON r.user_key_id = uk.id
    LEFT JOIN workspaces w ON r.workspace_id = w.id
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN transit_scans ts ON ts.request_uuid = r.request_uuid
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `, [req.user.id, ps, offset]);

  const convertedLogs = logs.map(log => ({
    ...log,
    owner_type: log.workspace_id ? 'Workspace' : '个人',
    owner_name: log.workspace_id ? (log.workspace_name || '-') : (log.username || '-'),
    cost: normalizeLogCost(log, storedCurrency, displayCurrency, exchangeRate),
    cost_usd: log.cost != null ? Number(log.cost) : undefined
  }));

  res.json({ logs: convertedLogs, total, page: p, pageSize: ps, totalPages: Math.ceil(total / ps), currency: displayCurrency });
});

// Public settings (for frontend display)
router.get('/settings', async (req, res) => {
  const settings = await db.all('SELECT key, value FROM settings');
  const result = {};
  for (const s of settings) {
    result[s.key] = unescapeHtml(s.value);
  }
  // Only expose public settings
  res.json({
    gateway_urls: result.gateway_urls || '[]',
    gateway_url: result.gateway_url || '',
    banner_text: result.banner_text || '',
    banner_enabled: result.banner_enabled === 'true'
  });
});

// Second-password routes (billing PIN)
router.post('/second-password/setup', setupSecondPassword);
router.post('/second-password/verify', verifySecondPassword);
router.get('/second-password/status', getSecondPasswordStatus);
router.post('/second-password/reset', resetSecondPassword);
router.post('/second-password/refresh', refreshSecondToken);

// Payment-password routes (payment gateway PIN)
router.post('/payment-password/setup', setupPaymentPassword);
router.post('/payment-password/verify', verifyPaymentPassword);
router.get('/payment-password/status', getPaymentPasswordStatus);
router.post('/payment-password/reset', resetPaymentPassword);
router.post('/payment-password/refresh', refreshPaymentToken);

module.exports = router;
