const db = require('../config/database');
const cacheService = require('../services/cache');

// ====== Rate-limit state backed by Redis, with in-memory fallback ======
// Using Redis counters removes per-request DB writes from the hot path and
// makes the counters consistent across multiple gateway processes.
const concurrentCounts = new Map();       // keyId -> number (fallback)
const trackedKeys = new Set();            // keyIds that have Redis concurrent counters
const rateWindows = new Map();            // keyId -> Map(windowStart -> count) (fallback)
let flushPromise = null;

// Tunables
const FLUSH_INTERVAL_MS = parseInt(process.env.RATE_LIMIT_FLUSH_MS) || 5000;
const CLEANUP_INTERVAL_MS = 60000;
const RATE_WINDOW_MINUTES = 5;
const REDIS_KEY_PREFIX = 'rate-limit:';

function redisConcurrentKey(keyId) { return `${REDIS_KEY_PREFIX}concurrent:${keyId}`; }
function redisRateKey(keyId, windowStart) { return `${REDIS_KEY_PREFIX}rate:${keyId}:${windowStart}`; }

function isRedisReady() {
  return cacheService.isHealthy();
}

async function getConcurrent(keyId) {
  if (isRedisReady()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        const val = await client.get(redisConcurrentKey(keyId));
        return val ? parseInt(val, 10) : 0;
      }
    } catch (e) {
      // fall through to memory
    }
  }
  return concurrentCounts.get(keyId) || 0;
}

async function incrementConcurrent(keyId) {
  if (isRedisReady()) {
    try {
      trackedKeys.add(keyId);
      return await cacheService.increment(redisConcurrentKey(keyId), 1);
    } catch (e) {
      // fall through
    }
  }
  concurrentCounts.set(keyId, (concurrentCounts.get(keyId) || 0) + 1);
  return concurrentCounts.get(keyId);
}

async function decrementConcurrent(keyId) {
  if (isRedisReady()) {
    try {
      const val = await cacheService.decrement(redisConcurrentKey(keyId), 1);
      if (val <= 0) {
        await cacheService.del(redisConcurrentKey(keyId));
      }
      return val;
    } catch (e) {
      // fall through
    }
  }
  const next = (concurrentCounts.get(keyId) || 0) - 1;
  if (next <= 0) concurrentCounts.delete(keyId);
  else concurrentCounts.set(keyId, next);
  return next;
}

async function getRateCount(keyId, windowStart) {
  if (isRedisReady()) {
    try {
      const client = cacheService.getRedisClient();
      if (client) {
        const val = await client.get(redisRateKey(keyId, windowStart));
        return val ? parseInt(val, 10) : 0;
      }
    } catch (e) {
      // fall through
    }
  }
  const windows = rateWindows.get(keyId);
  return windows ? (windows.get(windowStart) || 0) : 0;
}

/**
 * Get live counters for a single key from memory/Redis (no DB read on hot path).
 * Used by admin concurrency dashboards and SSE push.
 */
async function getKeyCounters(keyId) {
  const windowStart = Math.floor(Date.now() / 60000);
  return {
    currentConcurrent: await getConcurrent(keyId),
    currentRate: await getRateCount(keyId, windowStart),
    windowStart
  };
}

async function incrementRateCount(keyId, windowStart) {
  if (isRedisReady()) {
    try {
      const newVal = await cacheService.increment(redisRateKey(keyId, windowStart), 1);
      // Expire window keys after the window plus a small buffer
      await cacheService.expire(redisRateKey(keyId, windowStart), (RATE_WINDOW_MINUTES + 1) * 60);
      return newVal;
    } catch (e) {
      // fall through
    }
  }
  let windows = rateWindows.get(keyId);
  if (!windows) {
    windows = new Map();
    rateWindows.set(keyId, windows);
  }
  windows.set(windowStart, (windows.get(windowStart) || 0) + 1);
  return windows.get(windowStart);
}

function cleanupOldWindows() {
  const cutoff = Math.floor(Date.now() / 60000) - RATE_WINDOW_MINUTES;
  for (const [keyId, windows] of rateWindows) {
    for (const ws of windows.keys()) {
      if (ws < cutoff) windows.delete(ws);
    }
    if (windows.size === 0) rateWindows.delete(keyId);
  }
}

async function flushToDatabase() {
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    try {
      // Collect current_concurrent values from Redis + memory fallback
      const concurrentUpdates = new Map();

      if (isRedisReady() && trackedKeys.size > 0) {
        try {
          const client = cacheService.getRedisClient();
          if (client) {
            const keys = Array.from(trackedKeys).map(redisConcurrentKey);
            const values = await client.mGet(keys);
            let i = 0;
            for (const keyId of trackedKeys) {
              concurrentUpdates.set(keyId, parseInt(values[i] || '0', 10));
              i++;
            }
          }
        } catch (e) {
          console.error('[rate-limit] Redis concurrent mget failed:', e.message);
        }
      }

      // Merge memory fallback counters
      for (const [keyId, count] of concurrentCounts) {
        concurrentUpdates.set(keyId, (concurrentUpdates.get(keyId) || 0) + count);
      }

      // Batch flush current_concurrent
      if (concurrentUpdates.size > 0) {
        const ids = Array.from(concurrentUpdates.keys()).join(',');
        const cases = Array.from(concurrentUpdates.entries())
          .map(([id, count]) => `WHEN ${id} THEN ${Math.max(0, count)}`)
          .join(' ');
        try {
          await db.run(
            `UPDATE user_keys SET current_concurrent = CASE id ${cases} ELSE current_concurrent END WHERE id IN (${ids})`,
            []
          );
        } catch (err) {
          console.error('[rate-limit] batch flush concurrent failed:', err.message);
        }
      }

      // Flush per-window request counts from memory fallback only.
      // Redis windows use TTL so we don't need to persist them continuously.
      for (const [keyId, windows] of rateWindows) {
        for (const [windowStart, count] of windows) {
          try {
            await db.run(
              `INSERT INTO rate_limit_tracker (key_id, window_start, request_count)
               VALUES (?, ?, ?)
               ON CONFLICT (key_id, window_start) DO UPDATE SET request_count = EXCLUDED.request_count`,
              [keyId, windowStart, Math.max(0, count)]
            );
          } catch (err) {
            console.error(`[rate-limit] flush window failed for key ${keyId} window ${windowStart}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[rate-limit] flush error:', err.message);
    }
  })().finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

// Periodically flush in-memory counters to DB and clean up old windows.
const flushInterval = setInterval(() => {
  cleanupOldWindows();
  flushToDatabase().catch(() => {});
}, FLUSH_INTERVAL_MS);

// Prevent the interval from keeping the process alive if everything else is done.
flushInterval.unref?.();

// Best-effort flush on graceful shutdown.
async function shutdownFlush() {
  clearInterval(flushInterval);
  try {
    await flushToDatabase();
  } catch (e) {
    // ignore
  }
}
process.on('SIGINT', shutdownFlush);
process.on('SIGTERM', shutdownFlush);

// Reset stale current_concurrent from a previous crashed process on startup.
(async function resetStaleCounters() {
  try {
    await db.run('UPDATE user_keys SET current_concurrent = 0');
  } catch (err) {
    console.error('[rate-limit] failed to reset stale current_concurrent:', err.message);
  }
})();

const rateLimitMiddleware = async (req, res, next) => {
  if (!req.apiKey) return next();

  const keyId = req.apiKey.id;
  const rateLimit = Number(req.apiKey.rateLimit) || 0;
  const maxConcurrent = Number(req.apiKey.maxConcurrent) || 500;

  // Fully unlimited: skip all tracking and DB work.
  if (rateLimit <= 0 && maxConcurrent <= 0) {
    return next();
  }

  let didIncrementConcurrent = false;

  // Max-concurrent check
  if (maxConcurrent > 0) {
    const current = await getConcurrent(keyId);
    if (current >= maxConcurrent) {
      console.warn(`[rate-limit] concurrent limit hit for key ${keyId}: ${current}/${maxConcurrent}`);
      return res.status(429).json({
        error: {
          message: `Rate limit: max ${maxConcurrent} concurrent requests`,
          type: 'rate_limit_error'
        }
      });
    }
    await incrementConcurrent(keyId);
    didIncrementConcurrent = true;
  }

  // Per-minute rate check
  if (rateLimit > 0) {
    const windowStart = Math.floor(Date.now() / 60000);
    const count = await getRateCount(keyId, windowStart);
    if (count >= rateLimit) {
      if (didIncrementConcurrent) await decrementConcurrent(keyId);
      return res.status(429).json({
        error: {
          message: `Rate limit exceeded: ${rateLimit} requests per minute`,
          type: 'rate_limit_error',
          retry_after: 60 - (Math.floor(Date.now() / 1000) % 60)
        }
      });
    }
    await incrementRateCount(keyId, windowStart);
  }

  const release = async () => {
    if (didIncrementConcurrent) await decrementConcurrent(keyId);
  };

  res.on('finish', release);
  res.on('close', release);

  next();
};

const cleanupOldTrackers = async () => {
  const cutoff = Math.floor(Date.now() / 60000) - RATE_WINDOW_MINUTES;
  try {
    await db.run('DELETE FROM rate_limit_tracker WHERE window_start < ?', [cutoff]);
  } catch (err) {
    console.error('[rate-limit] cleanup old trackers failed:', err.message);
  }
};

let cleanupInterval;
if (process.env.NODE_ENV !== 'test') {
  cleanupInterval = setInterval(cleanupOldTrackers, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref?.();
}

module.exports = rateLimitMiddleware;
module.exports.getKeyCounters = getKeyCounters;
