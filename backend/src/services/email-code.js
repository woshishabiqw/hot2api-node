/**
 * Email verification code service.
 * Generates short numeric codes, stores them in Redis with a TTL, and verifies them.
 */
const crypto = require('crypto');
const { getRedis } = require('../config/redis');

const CODE_TTL_SECONDS = 300; // 5 minutes
const REDIS_KEY_PREFIX = 'email_code:';
const SEND_COOLDOWN_SECONDS = 60; // 1 minute cooldown per email
const COOLDOWN_PREFIX = 'email_code_cooldown:';

function buildCodeKey(email) {
  return `${REDIS_KEY_PREFIX}${email.toLowerCase().trim()}`;
}

function buildCooldownKey(email) {
  return `${COOLDOWN_PREFIX}${email.toLowerCase().trim()}`;
}

function getRedisClient() {
  return getRedis();
}

function generateCode(length = 6) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return String(Math.floor(min + crypto.randomInt(max - min + 1)));
}

async function canSend(email) {
  const redis = getRedisClient();
  if (!redis) {
    // Let sendCode handle the Redis unavailable error as a 500.
    return { ok: true };
  }

  const key = buildCooldownKey(email);
  const exists = await redis.exists(key);
  if (exists) {
    const ttl = await redis.ttl(key);
    return { ok: false, reason: `发送过于频繁，请 ${Math.max(ttl, 1)} 秒后再试` };
  }
  return { ok: true };
}

async function sendCode(email) {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis 不可用，无法发送邮箱验证码');
  }

  const cooldown = await canSend(email);
  if (!cooldown.ok) {
    throw new Error(cooldown.reason);
  }

  const code = generateCode(6);
  await redis.set(buildCodeKey(email), code, { EX: CODE_TTL_SECONDS });
  await redis.set(buildCooldownKey(email), '1', { EX: SEND_COOLDOWN_SECONDS });

  return { code, ttl: CODE_TTL_SECONDS };
}

async function verifyCode(email, code) {
  if (!email || !code) return false;

  const redis = getRedisClient();
  if (!redis) return false;

  const key = buildCodeKey(email);
  const stored = await redis.get(key);
  if (!stored) return false;

  const valid = stored === String(code).trim();
  if (valid) {
    await redis.del(key);
  }
  return valid;
}

async function clearCode(email) {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.del(buildCodeKey(email));
}

module.exports = {
  sendCode,
  verifyCode,
  canSend,
  clearCode,
  generateCode,
};
