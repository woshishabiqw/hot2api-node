/**
 * Graphical captcha service using svg-captcha.
 * Token/code pairs are stored via cacheService (Redis + memory fallback).
 */
const svgCaptcha = require('svg-captcha');
const crypto = require('crypto');
const cacheService = require('./cache');

const CAPTCHA_TTL_SECONDS = 300; // 5 minutes
const REDIS_KEY_PREFIX = 'captcha:';

function buildKey(token) {
  return `${REDIS_KEY_PREFIX}${token}`;
}

async function generate() {
  const captcha = svgCaptcha.create({
    size: 4,
    noise: 3,
    color: true,
    background: '#f0f0f0',
    width: 120,
    height: 40,
    fontSize: 40,
  });

  const token = crypto.randomBytes(16).toString('hex');

  try {
    await cacheService.set(buildKey(token), captcha.text.toLowerCase(), CAPTCHA_TTL_SECONDS);
  } catch (err) {
    console.error('[Captcha] Failed to store captcha:', err.message);
  }

  return { token, svg: captcha.data };
}

async function verify(token, code) {
  if (!token || !code) return false;

  try {
    const stored = await cacheService.get(buildKey(token));
    if (!stored) return false;

    await cacheService.del(buildKey(token));
    return stored === String(code).toLowerCase().trim();
  } catch (err) {
    console.error('[Captcha] Failed to verify captcha:', err.message);
    return false;
  }
}

module.exports = { generate, verify };
