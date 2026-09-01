const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/database');
const { parseGroups } = require('../config/database');
const cacheService = require('../services/cache');

// ====== Redis-backed + memory fallback stats buffer ======
// High-concurrency: use Redis counters for total_requests and a Redis set to
// track dirty keys.  Fall back to in-memory aggregation if Redis is unavailable.
const pendingKeyStats = new Map(); // keyId -> count (fallback)
let keyStatsFlushTimer = null;
const KEY_STATS_FLUSH_INTERVAL_MS = 500;
const KEY_STATS_FLUSH_MAX_PENDING = 500;
const REDIS_PREFIX = 'apikey-stats:';
const REDIS_PENDING_SET = `${REDIS_PREFIX}pending`;

function redisTotalRequestsKey(keyId) { return `${REDIS_PREFIX}total_requests:${keyId}`; }
function redisLastUsedKey(keyId) { return `${REDIS_PREFIX}last_used:${keyId}`; }

function isRedisReady() {
  return cacheService.isHealthy && cacheService.isHealthy();
}

async function flushKeyStatsToRedis() {
  const client = cacheService.getRedisClient ? cacheService.getRedisClient() : null;
  if (!client) return;
  try {
    const keyIds = await client.sMembers(REDIS_PENDING_SET);
    if (keyIds.length === 0) return;

    const totalKeys = keyIds.map(redisTotalRequestsKey);
    const lastUsedKeys = keyIds.map(redisLastUsedKey);
    const totalValues = await client.mGet(totalKeys);
    const lastUsedValues = await client.mGet(lastUsedKeys);

    const casesTotal = [];
    const casesLastUsed = [];
    for (let i = 0; i < keyIds.length; i++) {
      const keyId = keyIds[i];
      const count = parseInt(totalValues[i] || '0', 10);
      const lastUsed = lastUsedValues[i];
      if (count > 0) casesTotal.push(`WHEN ${keyId} THEN total_requests + ${count}`);
      if (lastUsed) casesLastUsed.push(`WHEN ${keyId} THEN '${lastUsed}'::timestamp`);
    }

    const idList = keyIds.join(',');
    const setClauses = [];
    if (casesTotal.length > 0) {
      setClauses.push(`total_requests = CASE id ${casesTotal.join(' ')} ELSE total_requests END`);
    }
    if (casesLastUsed.length > 0) {
      setClauses.push(`last_used_at = CASE id ${casesLastUsed.join(' ')} ELSE last_used_at END`);
    }

    if (setClauses.length > 0) {
      await db.run(`UPDATE user_keys SET ${setClauses.join(', ')} WHERE id IN (${idList})`, []);
    }

    // Clean up flushed Redis keys
    const pipeline = client.multi();
    for (const k of totalKeys) pipeline.del(k);
    for (const k of lastUsedKeys) pipeline.del(k);
    pipeline.del(REDIS_PENDING_SET);
    await pipeline.exec();
  } catch (err) {
    console.error('[apikey] Redis stats flush failed:', err.message);
  }
}

async function flushKeyStatsMemory() {
  if (pendingKeyStats.size === 0) return;
  const batch = new Map(pendingKeyStats);
  pendingKeyStats.clear();
  try {
    const ids = Array.from(batch.keys());
    const counts = Array.from(batch.values());
    const idList = ids.join(',');
    const cases = ids.map((id, i) => `WHEN ${id} THEN ${counts[i]}`).join(' ');
    await db.run(
      `UPDATE user_keys SET total_requests = total_requests + CASE id ${cases} ELSE 0 END, last_used_at = NOW() WHERE id IN (${idList})`,
      []
    );
  } catch (err) {
    console.error('[apikey] memory stats flush failed:', err.message);
  }
}

async function flushKeyStats() {
  if (isRedisReady()) {
    await flushKeyStatsToRedis();
  }
  await flushKeyStatsMemory();
}

function scheduleKeyStatsFlush() {
  if (keyStatsFlushTimer) return;
  keyStatsFlushTimer = setTimeout(() => {
    keyStatsFlushTimer = null;
    flushKeyStats().catch(e => console.error('[apikey] flushKeyStats error:', e.message));
  }, KEY_STATS_FLUSH_INTERVAL_MS);
}

async function updateKeyStatsAsync(keyId) {
  if (isRedisReady()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        const pipeline = client.multi();
        pipeline.incr(redisTotalRequestsKey(keyId));
        pipeline.set(redisLastUsedKey(keyId), new Date().toISOString());
        pipeline.sAdd(REDIS_PENDING_SET, String(keyId));
        await pipeline.exec();
        scheduleKeyStatsFlush();
        return;
      }
    } catch (err) {
      // fall through to memory
    }
  }
  pendingKeyStats.set(keyId, (pendingKeyStats.get(keyId) || 0) + 1);
  if (pendingKeyStats.size >= KEY_STATS_FLUSH_MAX_PENDING) {
    if (keyStatsFlushTimer) { clearTimeout(keyStatsFlushTimer); keyStatsFlushTimer = null; }
    flushKeyStats().catch(e => console.error('[apikey] immediate flushKeyStats error:', e.message));
  } else {
    scheduleKeyStatsFlush();
  }
}

// ====== API Key Cache ======
let keyCache = null;
let keyCacheTimestamp = 0;
let keyCachePromise = null;
const KEY_CACHE_TTL_MS = 30000; // 30 seconds

async function refreshKeyCache() {
  keyCache = await db.all(
    `SELECT k.*, u.username, u.role, u.quota_limit as quota_limit_user, u.quota_used as quota_used_user, u.balance as balance_user, u.currency as user_currency, u.is_active as user_active
     FROM user_keys k
     LEFT JOIN users u ON k.user_id = u.id
     WHERE k.is_active = true`
  );
  keyCacheTimestamp = Date.now();
  return keyCache;
}

async function getCachedKeys() {
  const now = Date.now();
  if (!keyCache || (now - keyCacheTimestamp) > KEY_CACHE_TTL_MS) {
    // Prevent thundering herd: all concurrent requests share the same refresh promise
    if (!keyCachePromise) {
      keyCachePromise = refreshKeyCache().finally(() => {
        keyCachePromise = null;
      });
    }
    return keyCachePromise;
  }
  return keyCache;
}

// ====== Authenticated Key Cache ======
// bcrypt.compare is CPU/IO expensive and becomes an event-loop bottleneck under
// high concurrency.  Cache the result of a successful key validation keyed by a
// SHA-256 of the raw key.  In-flight validations for the same raw key are
// deduplicated so a thundering herd of concurrent requests only performs one
// bcrypt loop.  The cache TTL matches the key cache TTL so that deactivated keys
// naturally fall out of the fast path.
const authCache = new Map();
const authInflight = new Map();
const AUTH_CACHE_TTL_MS = KEY_CACHE_TTL_MS;
const MAX_AUTH_CACHE_SIZE = 5000;

function hashRawKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function getCachedAuth(keyHash) {
  const entry = authCache.get(keyHash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(keyHash);
    return null;
  }
  return entry.keyId;
}

function setCachedAuth(keyHash, keyId) {
  if (authCache.size >= MAX_AUTH_CACHE_SIZE) {
    const oldest = authCache.keys().next().value;
    authCache.delete(oldest);
  }
  authCache.set(keyHash, { keyId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

async function findKeyByRawKey(rawKey, keys) {
  const rawKeyHash = hashRawKey(rawKey);

  // Fast path: already validated recently
  const cachedKeyId = getCachedAuth(rawKeyHash);
  if (cachedKeyId) {
    const matchedKey = keys.find(k => k.id === cachedKeyId);
    if (matchedKey) return matchedKey;
  }

  // Deduplicate concurrent validations for the same raw key
  let inflight = authInflight.get(rawKeyHash);
  if (!inflight) {
    inflight = (async () => {
      for (const key of keys) {
        if (await bcrypt.compare(rawKey, key.key_hash)) {
          setCachedAuth(rawKeyHash, key.id);
          return key;
        }
      }
      return null;
    })().finally(() => {
      authInflight.delete(rawKeyHash);
    });
    authInflight.set(rawKeyHash, inflight);
  }

  return inflight;
}

// ====== Exchange Rate Cache ======
let exchangeRateCache = null;
let exchangeRateCacheTimestamp = 0;
const EXCHANGE_RATE_CACHE_TTL_MS = 60000; // 60 seconds

async function getCachedExchangeRate() {
  const now = Date.now();
  if (!exchangeRateCache || (now - exchangeRateCacheTimestamp) > EXCHANGE_RATE_CACHE_TTL_MS) {
    const row = await db.get("SELECT value FROM settings WHERE key = 'exchange_rate'");
    exchangeRateCache = parseFloat(row?.value) || 7.25;
    exchangeRateCacheTimestamp = now;
  }
  return exchangeRateCache;
}

// ====== Model Group Cache ======
let modelGroupCache = {};
let modelGroupCacheTimestamp = 0;
const MODEL_GROUP_CACHE_TTL_MS = 60000; // 60 seconds

async function getCachedModelGroup(model) {
  const now = Date.now();
  if ((now - modelGroupCacheTimestamp) > MODEL_GROUP_CACHE_TTL_MS) {
    modelGroupCache = {};
    modelGroupCacheTimestamp = now;
  }
  if (!modelGroupCache[model]) {
    const row = await db.get('SELECT model_group FROM models WHERE model_id = ? AND is_active = true LIMIT 1', [model]);
    modelGroupCache[model] = row?.model_group || null;
  }
  return modelGroupCache[model];
}



const apiKeyMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];
  const xGoogApiKey = req.headers['x-goog-api-key'];
  const queryKey = req.query?.key;

  let rawKey = null;
  let keySource = 'none';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawKey = authHeader.substring(7).trim();
    keySource = 'Bearer';
  } else if (xApiKey) {
    rawKey = xApiKey.trim();
    keySource = 'x-api-key';
  } else if (xGoogApiKey) {
    rawKey = xGoogApiKey.trim();
    keySource = 'x-goog-api-key';
  } else if (queryKey) {
    rawKey = queryKey.trim();
    keySource = 'query';
  }

  // Debug: log what we received (mask the key for safety)
  const mask = (s) => s ? `${s.slice(0, 6)}...${s.slice(-4)} (len=${s.length})` : 'null';
  if (process.env.LOG_LEVEL === 'debug') console.log(`[AuthDebug] ${req.method} ${req.path} | source=${keySource} | authHeader=${mask(authHeader)} | xApiKey=${mask(xApiKey)} | rawKey=${mask(rawKey)}`);

  if (!rawKey) {
    return res.status(401).json({
      error: {
        message: 'Missing API key. Supported: Authorization: Bearer sk-xxx, x-api-key, x-goog-api-key, or ?key=sk-xxx',
        type: 'authentication_error'
      }
    });
  }

  if (!rawKey || rawKey.length < 10) {
    return res.status(401).json({
      error: {
        message: 'Invalid API key format',
        type: 'authentication_error'
      }
    });
  }

  const keys = await getCachedKeys();

  const matchedKey = await findKeyByRawKey(rawKey, keys);

  if (!matchedKey) {
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'authentication_error'
      }
    });
  }

  if (matchedKey.user_active === false) {
    return res.status(403).json({
      error: {
        message: 'User account is disabled',
        type: 'authentication_error'
      }
    });
  }

  // A non-workspace key whose owning user no longer exists is treated as invalid.
  if (matchedKey.user_active === null && !matchedKey.workspace_id) {
    console.warn(`[apikey] key ${matchedKey.id} (user_id=${matchedKey.user_id}) has no associated user and is not a workspace key; rejecting.`);
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'authentication_error'
      }
    });
  }

  // Check key expiration
  if (matchedKey.expires_at && new Date(matchedKey.expires_at) < new Date()) {
    return res.status(403).json({
      error: {
        message: 'API key has expired',
        type: 'key_expired'
      }
    });
  }

  // Check quota with overdraft (fixed 10 CNY, convert to user currency)
  const OVERDRAFT_CNY = 10;
  const userCurrency = matchedKey.user_currency || 'CNY';
  const symbol = userCurrency === 'USD' ? '$' : '¥';
  const exchangeRate = await getCachedExchangeRate();
  const overdraftLimit = userCurrency === 'USD' ? OVERDRAFT_CNY / exchangeRate : OVERDRAFT_CNY;
  const userLimit = Number(matchedKey.quota_limit_user) || 0;
  const keyLimit = Number(matchedKey.quota_limit) || 0;
  const quotaUsedUser = Number(matchedKey.quota_used_user) || 0;
  const quotaUsed = Number(matchedKey.quota_used) || 0;

  // 1. User-level quota check (highest priority - blocks ALL keys if user balance exhausted)
  if (userLimit !== 0 && quotaUsedUser >= userLimit + overdraftLimit) {
    return res.status(429).json({
      error: {
        message: `账户余额已用尽（含透支${symbol}${overdraftLimit.toFixed(2)}），当前已用 ${symbol}${quotaUsedUser.toFixed(4)} / 余额 ${symbol}${userLimit.toFixed(4)}`,
        type: 'quota_exceeded'
      }
    });
  }

  // 2. Key-level quota check (only if key has its own limit)
  if (keyLimit !== 0 && quotaUsed >= keyLimit + overdraftLimit) {
    return res.status(429).json({
      error: {
        message: `密钥额度已用尽（含透支${symbol}${overdraftLimit.toFixed(2)}），当前已用 ${symbol}${quotaUsed.toFixed(4)} / 余额 ${symbol}${keyLimit.toFixed(4)}`,
        type: 'quota_exceeded'
      }
    });
  }

  // 3. Balance check for balance-based billing (users.balance / workspaces.balance)
  // In balance mode, quota_limit is typically 0/unlimited; we must block when balance is exhausted.
  if (matchedKey.workspace_id) {
    const workspace = await db.get('SELECT balance, token_quota_limit, token_quota_used FROM workspaces WHERE id = ?', [matchedKey.workspace_id]);
    const workspaceBalance = Number(workspace?.balance) || 0;
    const tokenQuotaLimit = Number(workspace?.token_quota_limit) || 0;
    const tokenQuotaUsed = Number(workspace?.token_quota_used) || 0;

    if (workspaceBalance + overdraftLimit <= 0) {
      return res.status(429).json({
        error: {
          message: `工作空间余额不足（含透支${symbol}${overdraftLimit.toFixed(2)}），当前余额 ${symbol}${workspaceBalance.toFixed(4)}`,
          type: 'insufficient_balance'
        }
      });
    }

    // Workspace-level monetary quota check
    const wsQuotaLimit = Number(workspace?.quota_limit) || 0;
    const wsQuotaUsed = Number(workspace?.quota_used) || 0;
    if (wsQuotaLimit > 0 && wsQuotaUsed >= wsQuotaLimit) {
      return res.status(429).json({
        error: {
          message: `工作空间额度已用尽，当前已用 ${symbol}${wsQuotaUsed.toFixed(4)} / ${symbol}${wsQuotaLimit.toFixed(4)}`,
          type: 'workspace_quota_exceeded'
        }
      });
    }

    // Workspace-level token usage quota check
    if (tokenQuotaLimit > 0 && tokenQuotaUsed >= tokenQuotaLimit) {
      return res.status(429).json({
        error: {
          message: `工作空间 Token 配额已用尽，当前已用 ${tokenQuotaUsed.toLocaleString()} / ${tokenQuotaLimit.toLocaleString()} tokens`,
          type: 'workspace_token_quota_exceeded'
        }
      });
    }
  } else {
    const userBalance = Number(matchedKey.balance_user) || 0;
    if (userBalance + overdraftLimit <= 0) {
      return res.status(429).json({
        error: {
          message: `账户独立余额不足（含透支${symbol}${overdraftLimit.toFixed(2)}），当前余额 ${symbol}${userBalance.toFixed(4)}`,
          type: 'insufficient_balance'
        }
      });
    }
  }

  // Check model and group limits (deferred to request time when model is known)
  const modelLimit = matchedKey.model_limit || 'all';
  const groupLimit = matchedKey.group_limit || 'all';

  // Fire-and-forget: don't let per-request stats write block the gateway
  updateKeyStatsAsync(matchedKey.id);

  req.apiKey = {
    id: matchedKey.id,
    userId: matchedKey.user_id,
    username: matchedKey.username,
    role: matchedKey.role,
    quotaLimit: Number(matchedKey.quota_limit) || 0,
    quotaUsed: Number(matchedKey.quota_used) || 0,
    keyQuotaLimit: Number(matchedKey.quota_limit) || 0,
    keyQuotaUsed: Number(matchedKey.quota_used) || 0,
    quotaType: matchedKey.quota_type || 'tokens',
    rateLimit: Number.isFinite(Number(matchedKey.rate_limit)) ? Number(matchedKey.rate_limit) : 60,
    maxConcurrent: Number.isFinite(Number(matchedKey.max_concurrent)) ? Number(matchedKey.max_concurrent) : 500,
    currentConcurrent: matchedKey.current_concurrent || 0,
    modelLimit: modelLimit,
    groupLimit: groupLimit,
    workspaceId: matchedKey.workspace_id || null,
    currency: matchedKey.currency || matchedKey.user_currency || 'CNY',
    userCurrency: matchedKey.user_currency || matchedKey.currency || 'CNY',
    clientType: 'apikey'
  };

  // Validate model access if model is in request body
  if (req.body?.model) {
    const model = req.body.model;
    const baseModel = model.replace(/_\d+$/, ''); // strip auto-suffix for matching
    if (modelLimit !== 'all') {
      try {
        const allowed = JSON.parse(modelLimit);
        if (Array.isArray(allowed) && !allowed.includes(model) && !allowed.includes(baseModel)) {
          return res.status(403).json({
            error: {
              message: `Model "${model}" is not allowed for this API key`,
              type: 'model_not_allowed'
            }
          });
        }
      } catch (e) {
        // model_limit is not JSON, treat as single model name
        if (modelLimit !== model && modelLimit !== baseModel) {
          return res.status(403).json({
            error: {
              message: `Model "${model}" is not allowed for this API key`,
              type: 'model_not_allowed'
            }
          });
        }
      }
    }

    if (groupLimit !== 'all') {
      const modelGroup = await getCachedModelGroup(model);
      if (modelGroup) {
        const modelGroups = parseGroups(modelGroup);
        let allowedGroups;
        try {
          allowedGroups = JSON.parse(groupLimit);
          if (!Array.isArray(allowedGroups)) allowedGroups = [groupLimit];
        } catch (e) {
          allowedGroups = [groupLimit];
        }
        const hasAllowed = modelGroups.some(g => allowedGroups.includes(g));
        if (!hasAllowed) {
          return res.status(403).json({
            error: {
              message: `Model groups [${modelGroups.join(', ')}] not allowed for this API key. Allowed: [${allowedGroups.join(', ')}]`,
              type: 'group_not_allowed'
            }
          });
        }
      }
    }
  }

  next();
};

// Expose cache invalidation for key management routes
apiKeyMiddleware.invalidateCache = () => {
  keyCache = null;
  keyCacheTimestamp = 0;
  authCache.clear();
  authInflight.clear();
  exchangeRateCache = null;
  exchangeRateCacheTimestamp = 0;
  modelGroupCache = {};
  modelGroupCacheTimestamp = 0;
};

module.exports = apiKeyMiddleware;
