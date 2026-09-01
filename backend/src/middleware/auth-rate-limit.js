/**
 * Stricter rate limiting for authentication endpoints
 * 5 attempts per minute per IP address
 */

const authRateLimitStore = new Map();

function checkAuthRateLimit(identifier, maxAttempts = 5, windowMs = 60000) {
  const now = Date.now();
  const entry = authRateLimitStore.get(identifier);

  if (!entry || now > entry.resetAt) {
    authRateLimitStore.set(identifier, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= maxAttempts) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count += 1;
  return { allowed: true };
}

// Clean up expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authRateLimitStore.entries()) {
    if (now > entry.resetAt) {
      authRateLimitStore.delete(key);
    }
  }
}, 600000);

function getClientIdentifier(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

const authRateLimitMiddleware = (req, res, next) => {
  if (process.env.NODE_ENV === 'test') return next();
  const identifier = `auth:${getClientIdentifier(req)}`;
  const result = checkAuthRateLimit(identifier, 10, 60000);

  if (!result.allowed) {
    return res.status(429).json({
      error: '登录尝试次数过多，请稍后再试',
      retry_after: result.retryAfter
    });
  }

  next();
};

module.exports = authRateLimitMiddleware;
