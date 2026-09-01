/**
 * Security middleware for Fuck Gateway
 * - Security headers
 * - Input sanitization (XSS prevention)
 * - SQL injection checks
 */

// HTML escape helper
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// Recursively sanitize object values
function sanitizeObject(obj, excludeKeys = []) {
  if (typeof obj === 'string') {
    return escapeHtml(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, excludeKeys));
  }
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (excludeKeys.includes(key)) {
        result[key] = value;
      } else {
        result[key] = sanitizeObject(value, excludeKeys);
      }
    }
    return result;
  }
  return obj;
}

// Keys that should NOT be HTML-escaped (functional data like API keys, URLs, JSON payloads)
const FUNCTIONAL_KEYS = [
  'api_key', 'api_keys', 'api_urls', 'base_url', 'key', 'encrypted_key',
  'password', 'old_password', 'password_hash', 'second_password_hash',
  'token', 'gateway_url', 'gateway_urls',
  'return_url', 'returnUrl', 'cancel_url', 'success_url', 'notifyUrl', 'notify_url',
  'admin_ip_allowlist',
  // Payment channel config contains PEM keys, URLs and secrets that must not be HTML-escaped.
  'config',
  // Web chat config contains URLs and API keys that must be stored verbatim.
  'webchat_search_provider',
  'webchat_searxng_url',
  'webchat_bing_api_key',
  'webchat_bing_endpoint',
  'webchat_default_model',
  'webchat_reasoning_default',
  'webchat_search_max_steps',
  'search_provider',
  'searxng_url',
  'bing_api_key',
  'bing_endpoint',
  'default_model',
  'reasoning_default',
  'search_max_steps',
  'search_api_key',
  'search_endpoint',
  'search_method',
  'search_query_param',
  'query',
];

// Security headers middleware
const securityHeaders = (req, res, next) => {
  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.alipay.com https://*.alipaydev.com;"
  );

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS Protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // HSTS (only in production)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()');

  next();
};

// Input sanitization middleware - escapes HTML in user-facing string fields
// while preserving functional data (API keys, URLs, passwords, etc.)
const sanitizeInput = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body, FUNCTIONAL_KEYS);
  }
  next();
};

// SQL injection detection middleware (lightweight heuristic)
// The codebase already uses parameterized queries; this is defense-in-depth.
const sqlInjectionGuard = (req, res, next) => {
  const dangerousPatterns = [
    /;\s*DROP\s+TABLE/i,
    /;\s*DELETE\s+FROM\s+\w+/i,
    /;\s*INSERT\s+INTO\s+\w+/i,
    /UNION\s+SELECT\s+/i,
    /EXEC\s*\(\s*.*\s*\)/i,
  ];

  function checkValue(value, path) {
    if (typeof value !== 'string') return false;
    for (const pattern of dangerousPatterns) {
      if (pattern.test(value)) {
        console.warn(`[SECURITY] Potential SQL injection detected at ${path}: ${value.substring(0, 100)}`);
        return true;
      }
    }
    return false;
  }

  function scanObject(obj, path = 'body') {
    if (typeof obj === 'string') {
      return checkValue(obj, path);
    }
    if (Array.isArray(obj)) {
      return obj.some((item, i) => scanObject(item, `${path}[${i}]`));
    }
    if (obj !== null && typeof obj === 'object') {
      return Object.entries(obj).some(([key, value]) => scanObject(value, `${path}.${key}`));
    }
    return false;
  }

  // Check query parameters
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (checkValue(value, `query.${key}`)) {
        return res.status(400).json({ error: '检测到无效输入' });
      }
    }
  }

  // Check body fields
  if (req.body && typeof req.body === 'object') {
    if (scanObject(req.body)) {
      return res.status(400).json({ error: '检测到无效输入' });
    }
  }

  next();
};

module.exports = {
  securityHeaders,
  sanitizeInput,
  sqlInjectionGuard,
  escapeHtml
};
