/**
 * Global IP-based rate limit middleware for the Node.js API layer.
 * Acts as a defense-in-depth fallback when Nginx limit_req is unavailable.
 * Configuration is read from the settings table key 'node_security'.
 */
const { getRedis } = require('../config/redis');

const REDIS_PREFIX = 'ip-rate-limit:';
const MEMORY = new Map();
const CLEANUP_INTERVAL_MS = 60000;

function getRedisClient() {
  return getRedis();
}

function memoryKey(ip, windowStart) {
  return `${ip}:${windowStart}`;
}

function cleanupMemory() {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  for (const key of MEMORY.keys()) {
    const windowStart = parseInt(key.split(':').pop(), 10);
    if (windowStart < cutoff) MEMORY.delete(key);
  }
}

if (process.env.NODE_ENV !== 'test') {
  const interval = setInterval(cleanupMemory, CLEANUP_INTERVAL_MS);
  interval.unref?.();
}

async function isEnabled() {
  try {
    const db = require('../config/database');
    const row = await db.get("SELECT value FROM settings WHERE key = 'node_security'");
    if (!row || !row.value) return false;
    const cfg = JSON.parse(row.value);
    return cfg?.ipRateLimit?.enabled === true;
  } catch (err) {
    console.error('[IPRateLimit] Failed to read config:', err.message);
    return false;
  }
}

async function getConfig() {
  try {
    const db = require('../config/database');
    const row = await db.get("SELECT value FROM settings WHERE key = 'node_security'");
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch (err) {
    console.error('[IPRateLimit] Failed to read config:', err.message);
    return null;
  }
}

async function getCount(ip, windowStart) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const val = await redis.get(`${REDIS_PREFIX}${ip}:${windowStart}`);
      return val ? parseInt(val, 10) : 0;
    } catch (e) {
      // fall through to memory
    }
  }
  return MEMORY.get(memoryKey(ip, windowStart)) || 0;
}

async function incrementCount(ip, windowStart, windowSeconds) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = `${REDIS_PREFIX}${ip}:${windowStart}`;
      const newVal = await redis.incr(key);
      await redis.expire(key, windowSeconds + 1);
      return newVal;
    } catch (e) {
      // fall through to memory
    }
  }
  const key = memoryKey(ip, windowStart);
  const newVal = (MEMORY.get(key) || 0) + 1;
  MEMORY.set(key, newVal);
  return newVal;
}

function getClientIp(req) {
  const trustProxy = req.app.get('trust proxy');
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || 'unknown';
}

const ipRateLimitMiddleware = async (req, res, next) => {
  const cfg = await getConfig();
  const ipRateLimit = cfg?.ipRateLimit;
  if (!ipRateLimit || ipRateLimit.enabled !== true) {
    return next();
  }

  const windowSeconds = Math.max(1, parseInt(ipRateLimit.windowSeconds, 10) || 60);
  const maxRequests = Math.max(1, parseInt(ipRateLimit.maxRequests, 10) || 100);

  const ip = getClientIp(req);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;

  const count = await getCount(ip, windowStart);
  if (count >= maxRequests) {
    return res.status(429).json({
      error: {
        message: `请求过于频繁，请 ${windowSeconds - (now - windowStart)} 秒后再试`,
        type: 'rate_limit_error',
      },
    });
  }

  await incrementCount(ip, windowStart, windowSeconds);
  next();
};

module.exports = ipRateLimitMiddleware;
module.exports.getConfig = getConfig;
