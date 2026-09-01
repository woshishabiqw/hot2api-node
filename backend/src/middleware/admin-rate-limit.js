/**
 * Stricter rate limiting for high-impact admin endpoints.
 * Tracks both per-user and per-IP windows using the shared cache service
 * (Redis when available, in-memory fallback otherwise).
 */
const cacheService = require('../services/cache');

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function makeKey(prefix, identifier, windowStart) {
  return `admin-rl:${prefix}:${identifier}:${windowStart}`;
}

async function checkLimit(identifier, maxAttempts, windowMs) {
  const windowStart = Math.floor(Date.now() / windowMs);
  const key = makeKey('all', identifier, windowStart);
  const current = (await cacheService.get(key)) || 0;
  if (current >= maxAttempts) {
    const resetAt = (windowStart + 1) * windowMs;
    return { allowed: false, retryAfter: Math.ceil((resetAt - Date.now()) / 1000) };
  }
  await cacheService.set(key, current + 1, Math.ceil(windowMs / 1000));
  return { allowed: true };
}

function createAdminRateLimit(options = {}) {
  const {
    perUser = 5,
    perIp = 10,
    windowMs = 60000,
    message = '操作过于频繁，请稍后再试',
  } = options;

  return async (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();

    const ip = getClientIp(req);
    const userId = req.user?.id;

    if (userId) {
      const userResult = await checkLimit(`user:${userId}`, perUser, windowMs);
      if (!userResult.allowed) {
        return res.status(429).json({ error: message, retry_after: userResult.retryAfter });
      }
    }

    const ipResult = await checkLimit(`ip:${ip}`, perIp, windowMs);
    if (!ipResult.allowed) {
      return res.status(429).json({ error: message, retry_after: ipResult.retryAfter });
    }

    next();
  };
}

module.exports = { createAdminRateLimit };
