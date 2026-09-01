const db = require('../config/database');
const audit = require('../services/audit');

let cachedList = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function ipToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return (
    (parseInt(parts[0], 10) << 24) |
    (parseInt(parts[1], 10) << 16) |
    (parseInt(parts[2], 10) << 8) |
    parseInt(parts[3], 10)
  ) >>> 0;
}

function cidrToRange(cidr) {
  const [ip, prefix] = cidr.split('/');
  const long = ipToLong(ip);
  if (long === null) return null;
  const bits = parseInt(prefix, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  const start = (long & mask) >>> 0;
  const end = (start + ((1 << (32 - bits)) - 1)) >>> 0;
  return { start, end };
}

function isIpBlocked(ip, rules) {
  const long = ipToLong(ip);
  if (long === null) return false;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.expires_at && new Date(rule.expires_at) < new Date()) continue;
    const range = cidrToRange(rule.ip);
    if (!range) continue;
    if (long >= range.start && long <= range.end) return true;
  }
  return false;
}

async function getBlacklist() {
  const now = Date.now();
  if (cachedList && cachedAt + CACHE_TTL_MS > now) return cachedList;
  cachedList = await db.all('SELECT ip, enabled, expires_at FROM ip_blacklists');
  cachedAt = now;
  return cachedList;
}

function invalidateCache() {
  cachedList = null;
  cachedAt = 0;
}

async function ipBlacklistMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || '';
  // Skip health checks so load balancers/watchdogs stay healthy
  if (req.path.startsWith('/health')) return next();

  try {
    const list = await getBlacklist();
    if (isIpBlocked(ip, list)) {
      try {
        await audit.log({
          userId: null,
          username: `ip:${ip}`,
          action: 'blocked',
          resourceType: 'ip_blacklist',
          resourceName: ip,
          newValue: { ip, path: req.path, method: req.method },
          req
        });
      } catch (e) {
        // Audit failure should not unblock the request
        console.error('[IPBlacklist] audit log failed:', e.message);
      }
      return res.status(403).json({ error: 'Access denied' });
    }
  } catch (err) {
    console.error('[IPBlacklist] check failed:', err.message);
  }
  next();
}

module.exports = { ipBlacklistMiddleware, invalidateCache, getBlacklist };
