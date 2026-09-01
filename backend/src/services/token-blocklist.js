/**
 * Token revocation service.
 *
 * Supports both per-token (jti) and per-user (token_revoked_before) revocation.
 * Uses Redis/memory cache for fast jti lookups and PostgreSQL as persistent fallback.
 */
const { v4: uuidv4 } = require('uuid');
const cacheService = require('./cache');
const db = require('../config/database');

const BLOCKLIST_PREFIX = 'blocklist:jti:';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mark a decoded token as revoked.
 * Also updates the user's token_revoked_before so that any token issued
 * before this timestamp becomes invalid, even if it lacks a jti.
 */
async function revokeToken(decoded) {
  if (!decoded || !decoded.id) return;

  const revokeBefore = Math.max(decoded.iat || nowSeconds(), nowSeconds());
  try {
    await db.run(
      `UPDATE users
       SET token_revoked_before = ?
       WHERE id = ?
         AND (token_revoked_before IS NULL OR token_revoked_before < ?)`,
      [revokeBefore, decoded.id, revokeBefore]
    );
  } catch (e) {
    console.error('[TokenBlocklist] Failed to update user token_revoked_before:', e.message);
  }

  if (decoded.jti && decoded.exp) {
    const ttlSeconds = Math.max(1, Math.ceil(decoded.exp - nowSeconds()));
    try {
      await cacheService.set(`${BLOCKLIST_PREFIX}${decoded.jti}`, 1, ttlSeconds);
    } catch (e) {
      console.error('[TokenBlocklist] Failed to cache jti blocklist:', e.message);
    }
    try {
      await db.run(
        `INSERT INTO token_blocklist (jti, expires_at)
         VALUES (?, to_timestamp(?))
         ON CONFLICT(jti) DO NOTHING`,
        [decoded.jti, decoded.exp]
      );
    } catch (e) {
      console.error('[TokenBlocklist] Failed to persist jti blocklist:', e.message);
    }
  }
}

/**
 * Check whether a decoded token has been revoked.
 */
async function isTokenRevoked(decoded) {
  if (!decoded || !decoded.id) return true;

  const user = await db.get('SELECT token_revoked_before FROM users WHERE id = ?', [decoded.id]);
  if (user?.token_revoked_before && decoded.iat < user.token_revoked_before) {
    return true;
  }

  if (decoded.jti) {
    const cached = await cacheService.get(`${BLOCKLIST_PREFIX}${decoded.jti}`);
    if (cached) return true;

    try {
      const row = await db.get(
        'SELECT 1 FROM token_blocklist WHERE jti = ? AND expires_at > NOW()',
        [decoded.jti]
      );
      if (row) return true;
    } catch (e) {
      console.error('[TokenBlocklist] Failed to query jti blocklist:', e.message);
    }
  }

  return false;
}

/**
 * Revoke every token issued for a user up to now.
 * Called when an admin disables a user or resets their password.
 */
async function revokeAllUserTokens(userId) {
  // Use +1 to ensure tokens issued in the current second are also revoked.
  const before = nowSeconds() + 1;
  await db.run(
    `UPDATE users
     SET token_revoked_before = ?
     WHERE id = ?
       AND (token_revoked_before IS NULL OR token_revoked_before < ?)`,
    [before, userId, before]
  );
}

/**
 * Extra claims to include when signing a new JWT.
 */
function getTokenClaims() {
  return { jti: uuidv4() };
}

module.exports = {
  revokeToken,
  isTokenRevoked,
  revokeAllUserTokens,
  getTokenClaims,
};
