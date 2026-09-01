const db = require('../config/database');
const cacheService = require('../services/cache');

const REDIS_PREFIX = 'user-rate:';
const STATS_TTL_SECONDS = 10;

// In-memory per-minute request counters for user-level RPM.
// These are independent of request_logs so failed/successful requests both count.
const rpmWindows = new Map();

function redisStatsKey(userId) {
  return `${REDIS_PREFIX}stats:${userId}`;
}

function redisRpmKey(userId, windowStart) {
  return `${REDIS_PREFIX}rpm:${userId}:${windowStart}`;
}

function getCurrentWindow() {
  return Math.floor(Date.now() / 60000);
}

async function getUserLimits(userId) {
  return await db.get(
    'SELECT tpm, rpm, tpd, max_concurrent FROM users WHERE id = ?',
    [userId]
  );
}

async function computeUserTokenStats(userId) {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const minuteRow = await db.get(
    `SELECT COALESCE(SUM(total_tokens), 0) as tokens
     FROM request_logs WHERE user_id = ? AND created_at > ?`,
    [userId, oneMinuteAgo]
  );
  const dayRow = await db.get(
    `SELECT COALESCE(SUM(total_tokens), 0) as tokens
     FROM request_logs WHERE user_id = ? AND created_at > ?`,
    [userId, oneDayAgo]
  );

  return {
    tpm: parseInt(minuteRow?.tokens || 0, 10),
    tpd: parseInt(dayRow?.tokens || 0, 10)
  };
}

async function getCachedTokenStats(userId) {
  const key = redisStatsKey(userId);
  if (cacheService.isHealthy()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        const cached = await client.get(key);
        if (cached) return JSON.parse(cached);
      }
    } catch (e) {
      // fall through
    }
  }

  const stats = await computeUserTokenStats(userId);

  if (cacheService.isHealthy()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        await client.setEx(key, STATS_TTL_SECONDS, JSON.stringify(stats));
      }
    } catch (e) {
      // ignore
    }
  }

  return stats;
}

async function getRpmCount(userId, windowStart) {
  if (cacheService.isHealthy()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        const val = await client.get(redisRpmKey(userId, windowStart));
        return val ? parseInt(val, 10) : 0;
      }
    } catch (e) {
      // fall through
    }
  }
  const windows = rpmWindows.get(userId);
  return windows ? (windows.get(windowStart) || 0) : 0;
}

async function incrementRpmCount(userId, windowStart) {
  if (cacheService.isHealthy()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        const newVal = await client.incr(redisRpmKey(userId, windowStart));
        await client.expire(redisRpmKey(userId, windowStart), 120);
        return newVal;
      }
    } catch (e) {
      // fall through
    }
  }
  let windows = rpmWindows.get(userId);
  if (!windows) {
    windows = new Map();
    rpmWindows.set(userId, windows);
  }
  windows.set(windowStart, (windows.get(windowStart) || 0) + 1);
  return windows.get(windowStart);
}

function cleanupOldRpmWindows() {
  const cutoff = getCurrentWindow() - 5;
  for (const [userId, windows] of rpmWindows) {
    for (const ws of windows.keys()) {
      if (ws < cutoff) windows.delete(ws);
    }
    if (windows.size === 0) rpmWindows.delete(userId);
  }
}

// Periodically clean up old in-memory RPM windows.
setInterval(cleanupOldRpmWindows, 60000).unref?.();

async function userRateLimitMiddleware(req, res, next) {
  if (!req.apiKey || !req.apiKey.userId) return next();

  const userId = req.apiKey.userId;
  const limits = await getUserLimits(userId);
  if (!limits) return next();

  // 0 means unlimited for these user-level limits.
  const tpmLimit = parseInt(limits.tpm, 10) || 0;
  const rpmLimit = parseInt(limits.rpm, 10) || 0;
  const tpdLimit = parseInt(limits.tpd, 10) || 0;

  if (tpmLimit === 0 && rpmLimit === 0 && tpdLimit === 0) return next();

  const windowStart = getCurrentWindow();
  const currentRpm = await getRpmCount(userId, windowStart);

  if (rpmLimit > 0 && currentRpm >= rpmLimit) {
    return res.status(429).json({ error: `User rate limit exceeded: ${rpmLimit} requests per minute` });
  }

  const tokenStats = await getCachedTokenStats(userId);

  if (tpmLimit > 0 && tokenStats.tpm >= tpmLimit) {
    return res.status(429).json({ error: `User rate limit exceeded: ${tpmLimit} tokens per minute` });
  }
  if (tpdLimit > 0 && tokenStats.tpd >= tpdLimit) {
    return res.status(429).json({ error: `User rate limit exceeded: ${tpdLimit} tokens per day` });
  }

  // Increment RPM counter for this request.
  await incrementRpmCount(userId, windowStart);

  next();
}

module.exports = userRateLimitMiddleware;
