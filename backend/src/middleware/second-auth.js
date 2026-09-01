const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const config = require('../config/settings');
const twopass = require('../config/twopass');

const SECOND_AUTH_SECRET = config.secondAuth?.secret || config.jwt.secret;
const TOKEN_EXPIRES_MINUTES = 32;
const TOKEN_EXPIRES_IN = `${TOKEN_EXPIRES_MINUTES}m`;
const TOKEN_EXPIRES_SECONDS = TOKEN_EXPIRES_MINUTES * 60;
const MAX_FAILED_ATTEMPTS = 10;
const LOCK_DURATION_HOURS = 24;

// In-memory rate limit store for second-password endpoints
const rateLimitStore = new Map();

function checkRateLimit(identifier, maxAttempts = 5, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(identifier, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= maxAttempts) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count += 1;
  return { allowed: true };
}

// Clean up expired rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 600000);

function getClientIdentifier(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// ========== PIN Helpers (user_pins table) for payment password ==========

async function getPin(userId, pinType) {
  return await db.get('SELECT * FROM user_pins WHERE user_id = ? AND pin_type = ?', [userId, pinType]);
}

async function setPin(userId, pinType, hash) {
  await db.run(
    'INSERT INTO user_pins (user_id, pin_type, password_hash, failed_attempts, locked_until) VALUES (?, ?, ?, 0, NULL) ON CONFLICT(user_id, pin_type) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL',
    [userId, pinType, hash]
  );
}

async function clearPin(userId, pinType) {
  await db.run('DELETE FROM user_pins WHERE user_id = ? AND pin_type = ?', [userId, pinType]);
}

async function incrementFailed(userId, pinType) {
  const pin = await getPin(userId, pinType);
  if (!pin) {
    await db.run('INSERT INTO user_pins (user_id, pin_type, password_hash, failed_attempts, locked_until) VALUES (?, ?, NULL, 1, NULL)', [userId, pinType]);
    return 1;
  }
  const newCount = (pin.failed_attempts || 0) + 1;
  let lockedUntil = pin.locked_until;
  if (newCount >= MAX_FAILED_ATTEMPTS) {
    const lockUntil = new Date();
    lockUntil.setHours(lockUntil.getHours() + LOCK_DURATION_HOURS);
    lockedUntil = lockUntil.toISOString();
  }
  await db.run('UPDATE user_pins SET failed_attempts = ?, locked_until = ? WHERE user_id = ? AND pin_type = ?', [newCount, lockedUntil, userId, pinType]);
  return newCount;
}

async function resetFailed(userId, pinType) {
  await db.run('UPDATE user_pins SET failed_attempts = 0, locked_until = NULL WHERE user_id = ? AND pin_type = ?', [userId, pinType]);
}

async function isLocked(userId, pinType) {
  const pin = await getPin(userId, pinType);
  if (!pin || !pin.locked_until) return { locked: false };
  const lockedUntil = new Date(pin.locked_until);
  if (lockedUntil > new Date()) {
    const retryAfter = Math.ceil((lockedUntil - new Date()) / 1000);
    return { locked: true, retryAfter };
  }
  return { locked: false };
}

// ========== Billing second password: file-based twopass.json ==========

function createBillingAuthMiddleware(tokenType, headerName) {
  return async (req, res, next) => {
    const token = req.headers[headerName];

    if (!token) {
      return res.status(401).json({ error: '需要进行二次验证', code: 'SECOND_AUTH_REQUIRED' });
    }

    try {
      const decoded = jwt.verify(token, SECOND_AUTH_SECRET);
      if (decoded.type !== tokenType) {
        return res.status(401).json({ error: '验证令牌无效', code: 'SECOND_AUTH_INVALID' });
      }
      if (!twopass.isInitialized()) {
        return res.status(401).json({ error: '密码已重置，请重新设置', code: 'SECOND_AUTH_RESET' });
      }
      req.secondAuth = { id: decoded.id, pinType: 'billing', verifiedAt: decoded.iat };
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: '验证已过期，请重新输入', code: 'SECOND_AUTH_EXPIRED' });
      }
      return res.status(401).json({ error: '验证令牌无效', code: 'SECOND_AUTH_INVALID' });
    }
  };
}

const secondAuthMiddleware = createBillingAuthMiddleware('second_auth_billing', 'x-second-auth-token');

function createBillingSetupHandler() {
  return async (req, res) => {
    const { password, confirm_password } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const identifier = `setup:billing:${getClientIdentifier(req)}`;
    const rateLimit = checkRateLimit(identifier, 5, 60000);
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', retry_after: rateLimit.retryAfter });
    }

    if (!password || !confirm_password) {
      return res.status(400).json({ error: '请输入密码并确认' });
    }

    if (password !== confirm_password) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }

    if (!/^\d{6}$/.test(password)) {
      return res.status(400).json({ error: '密码必须为6位数字' });
    }

    try {
      twopass.initializePassword(password);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const token = jwt.sign({ id: userId, type: 'second_auth_billing' }, SECOND_AUTH_SECRET, { expiresIn: TOKEN_EXPIRES_IN });

    res.json({ success: true, second_token: token, expires_in: TOKEN_EXPIRES_SECONDS });
  };
}

const setupSecondPassword = createBillingSetupHandler();

function createBillingVerifyHandler() {
  return async (req, res) => {
    const { password } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const identifier = `verify:billing:${getClientIdentifier(req)}`;
    const rateLimit = checkRateLimit(identifier, 5, 60000);
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', retry_after: rateLimit.retryAfter });
    }

    if (!password) {
      return res.status(400).json({ error: '请输入密码' });
    }

    if (!twopass.isInitialized()) {
      return res.status(400).json({ error: '尚未设置密码', need_setup: true });
    }

    if (!twopass.verifyPassword(password)) {
      return res.status(401).json({ error: '密码错误' });
    }

    const token = jwt.sign({ id: userId, type: 'second_auth_billing' }, SECOND_AUTH_SECRET, { expiresIn: TOKEN_EXPIRES_IN });

    res.json({ success: true, second_token: token, expires_in: TOKEN_EXPIRES_SECONDS });
  };
}

const verifySecondPassword = createBillingVerifyHandler();

function createBillingStatusHandler() {
  return async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const initialized = twopass.isInitialized();

    res.json({
      need_setup: !initialized,
      has_password: initialized,
      locked: false,
      failed_attempts: 0
    });
  };
}

const getSecondPasswordStatus = createBillingStatusHandler();

function createBillingResetHandler() {
  return async (req, res) => {
    return res.status(400).json({ error: '二级密码文件已锁定，禁止重置' });
  };
}

const resetSecondPassword = createBillingResetHandler();

function createBillingRefreshHandler(tokenType, headerName) {
  return async (req, res) => {
    const token = req.headers[headerName];
    if (!token) {
      return res.status(401).json({ error: '需要进行二次验证', code: 'SECOND_AUTH_REQUIRED' });
    }
    try {
      const decoded = jwt.verify(token, SECOND_AUTH_SECRET);
      if (decoded.type !== tokenType) {
        return res.status(401).json({ error: '验证令牌无效', code: 'SECOND_AUTH_INVALID' });
      }
      if (!twopass.isInitialized()) {
        return res.status(401).json({ error: '密码已重置，请重新设置', code: 'SECOND_AUTH_RESET' });
      }
      const newToken = jwt.sign({ id: decoded.id, type: tokenType }, SECOND_AUTH_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
      res.json({ success: true, second_token: newToken, expires_in: TOKEN_EXPIRES_SECONDS });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: '验证已过期，请重新输入', code: 'SECOND_AUTH_EXPIRED' });
      }
      return res.status(401).json({ error: '验证令牌无效', code: 'SECOND_AUTH_INVALID' });
    }
  };
}

const refreshSecondToken = createBillingRefreshHandler('second_auth_billing', 'x-second-auth-token');

// ========== Payment gateway password: database-based user_pins ==========

function createPaymentAuthMiddleware(pinType, tokenType, headerName) {
  return async (req, res, next) => {
    const token = req.headers[headerName];

    if (!token) {
      return res.status(401).json({ error: '需要进行二次验证', code: 'PAYMENT_AUTH_REQUIRED' });
    }

    try {
      const decoded = jwt.verify(token, SECOND_AUTH_SECRET);
      if (decoded.type !== tokenType) {
        return res.status(401).json({ error: '验证令牌无效', code: 'PAYMENT_AUTH_INVALID' });
      }
      const pin = await getPin(decoded.id, pinType);
      if (!pin || !pin.password_hash) {
        return res.status(401).json({ error: '密码已重置，请重新设置', code: 'PAYMENT_AUTH_RESET' });
      }
      req.secondAuth = { id: decoded.id, pinType, verifiedAt: decoded.iat };
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: '验证已过期，请重新输入', code: 'PAYMENT_AUTH_EXPIRED' });
      }
      return res.status(401).json({ error: '验证令牌无效', code: 'PAYMENT_AUTH_INVALID' });
    }
  };
}

const paymentAuthMiddleware = createPaymentAuthMiddleware('payment_gateway', 'second_auth_payment', 'x-payment-auth-token');

function createPaymentSetupHandler(pinType) {
  return async (req, res) => {
    const { password, confirm_password } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const identifier = `setup:${pinType}:${getClientIdentifier(req)}`;
    const rateLimit = checkRateLimit(identifier, 5, 60000);
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', retry_after: rateLimit.retryAfter });
    }

    if (!password || !confirm_password) {
      return res.status(400).json({ error: '请输入密码并确认' });
    }

    if (password !== confirm_password) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }

    if (!/^\d{6}$/.test(password)) {
      return res.status(400).json({ error: '密码必须为6位数字' });
    }

    const hash = bcrypt.hashSync(password, 10);
    await setPin(userId, pinType, hash);

    const tokenType = 'second_auth_payment';
    const token = jwt.sign({ id: userId, type: tokenType }, SECOND_AUTH_SECRET, { expiresIn: TOKEN_EXPIRES_IN });

    res.json({ success: true, second_token: token, expires_in: TOKEN_EXPIRES_SECONDS });
  };
}

const setupPaymentPassword = createPaymentSetupHandler('payment_gateway');

function createPaymentVerifyHandler(pinType) {
  return async (req, res) => {
    const { password } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const lockStatus = await isLocked(userId, pinType);
    if (lockStatus.locked) {
      const hours = Math.ceil(lockStatus.retryAfter / 3600);
      return res.status(403).json({ error: `密码错误次数过多，账号已锁定，请${hours}小时后重试`, code: 'ACCOUNT_LOCKED', retry_after: lockStatus.retryAfter });
    }

    const identifier = `verify:${pinType}:${userId}:${getClientIdentifier(req)}`;
    const rateLimit = checkRateLimit(identifier, 5, 60000);
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', retry_after: rateLimit.retryAfter });
    }

    if (!password) {
      return res.status(400).json({ error: '请输入密码' });
    }

    const pin = await getPin(userId, pinType);
    if (!pin || !pin.password_hash) {
      return res.status(400).json({ error: '尚未设置密码', need_setup: true });
    }

    const isValid = bcrypt.compareSync(password, pin.password_hash);
    if (!isValid) {
      const failedCount = await incrementFailed(userId, pinType);
      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - failedCount);
      return res.status(401).json({ error: `密码错误，还剩 ${remaining} 次机会`, remaining_attempts: remaining });
    }

    await resetFailed(userId, pinType);

    const tokenType = 'second_auth_payment';
    const token = jwt.sign({ id: userId, type: tokenType }, SECOND_AUTH_SECRET, { expiresIn: TOKEN_EXPIRES_IN });

    res.json({ success: true, second_token: token, expires_in: TOKEN_EXPIRES_SECONDS });
  };
}

const verifyPaymentPassword = createPaymentVerifyHandler('payment_gateway');

function createPaymentResetHandler(pinType) {
  return async (req, res) => {
    const currentUser = req.user;
    if (!currentUser) {
      return res.status(401).json({ error: '请先登录' });
    }

    const { user_id } = req.body;
    const targetUserId = user_id ? parseInt(user_id) : currentUser.id;

    // Regular users can only reset their own PIN; admins can reset any user's PIN.
    if (targetUserId !== currentUser.id && currentUser.role !== 'admin') {
      return res.status(403).json({ error: '只能重置自己的 PIN' });
    }

    const targetUser = await db.get('SELECT id, username FROM users WHERE id = ?', [targetUserId]);
    if (!targetUser) {
      return res.status(404).json({ error: '用户不存在' });
    }

    await clearPin(targetUserId, pinType);

    res.json({ success: true, message: 'Password reset. User will need to set it again on next login.' });
  };
}

const resetPaymentPassword = createPaymentResetHandler('payment_gateway');

function createPaymentStatusHandler(pinType) {
  return async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: '请先登录' });
    }

    const pin = await getPin(userId, pinType);
    const lockStatus = await isLocked(userId, pinType);

    res.json({
      need_setup: !pin || !pin.password_hash,
      has_password: !!(pin && pin.password_hash),
      locked: lockStatus.locked,
      failed_attempts: pin ? (pin.failed_attempts || 0) : 0
    });
  };
}

const getPaymentPasswordStatus = createPaymentStatusHandler('payment_gateway');

function createPaymentRefreshHandler(pinType, tokenType, headerName) {
  return async (req, res) => {
    const token = req.headers[headerName];
    if (!token) {
      return res.status(401).json({ error: '需要进行二次验证', code: 'PAYMENT_AUTH_REQUIRED' });
    }
    try {
      const decoded = jwt.verify(token, SECOND_AUTH_SECRET);
      if (decoded.type !== tokenType) {
        return res.status(401).json({ error: '验证令牌无效', code: 'PAYMENT_AUTH_INVALID' });
      }
      const pin = await getPin(decoded.id, pinType);
      if (!pin || !pin.password_hash) {
        return res.status(401).json({ error: '用户无效', code: 'PAYMENT_AUTH_INVALID' });
      }
      const newToken = jwt.sign({ id: decoded.id, type: tokenType }, SECOND_AUTH_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
      res.json({ success: true, second_token: newToken, expires_in: TOKEN_EXPIRES_SECONDS });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: '验证已过期，请重新输入', code: 'PAYMENT_AUTH_EXPIRED' });
      }
      return res.status(401).json({ error: '验证令牌无效', code: 'PAYMENT_AUTH_INVALID' });
    }
  };
}

const refreshPaymentToken = createPaymentRefreshHandler('payment_gateway', 'second_auth_payment', 'x-payment-auth-token');

module.exports = {
  secondAuthMiddleware,
  paymentAuthMiddleware,
  setupSecondPassword,
  setupPaymentPassword,
  verifySecondPassword,
  verifyPaymentPassword,
  resetSecondPassword,
  resetPaymentPassword,
  getSecondPasswordStatus,
  getPaymentPasswordStatus,
  refreshSecondToken,
  refreshPaymentToken
};
