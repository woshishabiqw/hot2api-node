const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const config = require('../config/settings');
const { isTokenRevoked, revokeToken, revokeAllUserTokens, getTokenClaims } = require('../services/token-blocklist');
const { validatePassword, isRegistrationAllowed } = require('../utils/password-policy');
const { getRegistrationConfig } = require('../services/registration-config');
const captchaService = require('../services/captcha');
const emailCodeService = require('../services/email-code');
const loginLockout = require('../services/login-lockout');

const authMiddleware = async (req, res, next) => {
  // Support both header Bearer token and query string token (for SSE/EventSource)
  let token = null;
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.token) {
    token = req.query.token;
  }
  
  if (!token) {
    if (process.env.LOG_LEVEL === 'debug') console.log('[AuthMiddleware] No Bearer token for', req.method, req.path);
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    // Verify the user is still active and role has not changed.
    const user = await db.get('SELECT id, username, role, is_active FROM users WHERE id = ?', [decoded.id]);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: '用户已被禁用或不存在' });
    }
    if (user.role !== decoded.role || user.username !== decoded.username) {
      return res.status(401).json({ error: 'Token 已过期，请重新登录' });
    }
    if (await isTokenRevoked(decoded)) {
      return res.status(401).json({ error: 'Token 已失效，请重新登录', code: 'TOKEN_REVOKED' });
    }
    req.user = decoded;
    if (process.env.LOG_LEVEL === 'debug') console.log('[AuthMiddleware] Valid token for', req.method, req.path, 'user=', decoded.username);
    next();
  } catch (error) {
    if (process.env.LOG_LEVEL === 'debug') console.log('[AuthMiddleware] Invalid token for', req.method, req.path, 'prefix=', token.substring(0, 20));
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user?.role === 'admin') {
    return next();
  }
  // Moderators have read-only access to the sources list.
  if (req.user?.role === 'moderator' && req.method === 'GET' && req.path === '/sources') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
};

const login = async (req, res) => {
  const { username, password, captchaToken, captchaCode } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (process.env.LOG_LEVEL === 'debug') console.log(`[Auth] Login attempt - Username: ${username}, IP: ${ip}, UserAgent: ${userAgent}`);

  if (!username || !password) {
    if (process.env.LOG_LEVEL === 'debug') console.log(`[Auth] Login failed - Missing credentials for ${username}`);
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const regConfig = await getRegistrationConfig();
  if (regConfig.captchaEnabled) {
    if (!captchaToken || !captchaCode) {
      return res.status(400).json({ error: '请输入图形验证码' });
    }
    const valid = await captchaService.verify(captchaToken, captchaCode);
    if (!valid) {
      return res.status(400).json({ error: '图形验证码错误或已过期' });
    }
  }

  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);

  if (!user || !user.is_active) {
    if (process.env.LOG_LEVEL === 'debug') console.log(`[Auth] Login failed - User not found or inactive: ${username}`);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const lockStatus = await loginLockout.isLocked(user.id);
  if (lockStatus.locked) {
    const minutes = Math.ceil(lockStatus.retryAfter / 60);
    return res.status(403).json({ error: `登录失败次数过多，账号已锁定，请 ${minutes} 分钟后重试`, code: 'ACCOUNT_LOCKED', retry_after: lockStatus.retryAfter });
  }

  const isValid = bcrypt.compareSync(password, user.password_hash);

  if (!isValid) {
    if (process.env.LOG_LEVEL === 'debug') console.log(`[Auth] Login failed - Invalid password for ${username}`);
    const result = await loginLockout.recordFailure(user.id);
    if (result.locked) {
      return res.status(403).json({ error: '登录失败次数过多，账号已锁定 30 分钟', code: 'ACCOUNT_LOCKED', retry_after: result.retryAfter });
    }
    return res.status(401).json({ error: `用户名或密码错误，还剩 ${result.remaining} 次机会` });
  }

  await loginLockout.reset(user.id);

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, ...getTokenClaims() },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  if (process.env.LOG_LEVEL === 'debug') console.log(`[Auth] Login successful - Username: ${username}, Role: ${user.role}, IP: ${ip}`);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      quota_limit: user.quota_limit,
      quota_used: user.quota_used
    }
  });
};

const register = async (req, res) => {
  const { username, password, email, emailCode, captchaToken, captchaCode } = req.body;

  if (!(await isRegistrationAllowed())) {
    return res.status(403).json({ error: '当前已关闭自助注册，请联系管理员' });
  }

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  if (String(username).length < 3) {
    return res.status(400).json({ error: '用户名至少 3 个字符' });
  }

  const regConfig = await getRegistrationConfig();

  if (regConfig.captchaEnabled) {
    if (!captchaToken || !captchaCode) {
      return res.status(400).json({ error: '请输入图形验证码' });
    }
    const valid = await captchaService.verify(captchaToken, captchaCode);
    if (!valid) {
      return res.status(400).json({ error: '图形验证码错误或已过期' });
    }
  }

  if (regConfig.emailVerificationEnabled) {
    if (!email || !emailCode) {
      return res.status(400).json({ error: '请输入邮箱和邮箱验证码' });
    }
    const emailValid = await emailCodeService.verifyCode(email, emailCode);
    if (!emailValid) {
      return res.status(400).json({ error: '邮箱验证码错误或已过期' });
    }
  }

  const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);

  if (existing) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  if (email) {
    const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }
  }

  const policy = validatePassword(password);
  if (!policy.valid) {
    return res.status(400).json({ error: policy.error });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const isActive = regConfig.approvalMode === 'auto';

  const result = await db.run(
    `INSERT INTO users (username, email, password_hash, role, quota_limit, is_active) VALUES (?, ?, ?, 'user', 0, ?)`,
    [username, email || null, passwordHash, isActive]
  );

  res.status(201).json({
    id: result.lastInsertRowid,
    username,
    email: email || null,
    role: 'user',
    is_active: isActive,
    pending_approval: !isActive,
  });
};

const logout = async (req, res) => {
  try {
    await revokeToken(req.user);
    res.json({ success: true, message: '已退出登录' });
  } catch (e) {
    console.error('[Auth] Logout error:', e.message);
    res.status(500).json({ error: '退出登录失败' });
  }
};

const getProfile = async (req, res) => {
  const user = await db.get(
    'SELECT id, username, role, quota_limit, quota_used, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  login,
  register,
  logout,
  getProfile,
  revokeAllUserTokens,
};
