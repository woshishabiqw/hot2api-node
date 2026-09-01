/**
 * Per-account login brute-force lockout.
 *
 * Tracks failed login attempts per user. After MAX_FAILED failures within
 * WINDOW_SECONDS, the account is locked for LOCK_SECONDS.
 */
const db = require('../config/database');

const WINDOW_SECONDS = 15 * 60;   // 15 minutes
const MAX_FAILED = 5;             // failures per window
const LOCK_SECONDS = 30 * 60;     // 30 minutes

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function getRecord(userId) {
  return db.get('SELECT * FROM login_attempts WHERE user_id = ?', [userId]);
}

async function reset(userId) {
  await db.run('DELETE FROM login_attempts WHERE user_id = ?', [userId]);
}

async function recordFailure(userId) {
  const now = nowSeconds();
  const record = await getRecord(userId);

  if (!record) {
    await db.run(
      `INSERT INTO login_attempts (user_id, failed_count, window_start, locked_until)
       VALUES (?, 1, ?, NULL)`,
      [userId, now]
    );
    return { locked: false, remaining: MAX_FAILED - 1 };
  }

  // If currently locked, keep it until expiry
  if (record.locked_until && record.locked_until > now) {
    return { locked: true, retryAfter: record.locked_until - now };
  }

  // If the window has expired, start a new one
  if (record.window_start + WINDOW_SECONDS < now) {
    await db.run(
      `UPDATE login_attempts
       SET failed_count = 1, window_start = ?, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [now, userId]
    );
    return { locked: false, remaining: MAX_FAILED - 1 };
  }

  const newCount = (record.failed_count || 0) + 1;
  const lockedUntil = newCount >= MAX_FAILED ? now + LOCK_SECONDS : record.locked_until;
  await db.run(
    `UPDATE login_attempts
     SET failed_count = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [newCount, lockedUntil || null, userId]
  );

  if (lockedUntil) {
    return { locked: true, retryAfter: lockedUntil - now };
  }
  return { locked: false, remaining: Math.max(0, MAX_FAILED - newCount) };
}

async function isLocked(userId) {
  const record = await getRecord(userId);
  const now = nowSeconds();
  if (record && record.locked_until && record.locked_until > now) {
    return { locked: true, retryAfter: record.locked_until - now };
  }
  return { locked: false };
}

module.exports = {
  recordFailure,
  reset,
  isLocked,
  WINDOW_SECONDS,
  MAX_FAILED,
  LOCK_SECONDS,
};
