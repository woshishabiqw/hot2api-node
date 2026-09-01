const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware, adminMiddleware } = require('../src/middleware/auth');
const requireSecondAuthForMutations = require('../src/middleware/require-second-auth');

async function cleanDatabase() {
  const db = require('../src/config/database');
  try {
    const { current_database } = await db.get('SELECT current_database()');
    if (!current_database.endsWith('_test')) {
      throw new Error(`Refusing to truncate production database "${current_database}". Tests must use a database ending with "_test".`);
    }
    const tables = await db.all(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE 'pg_%'
        AND table_name NOT LIKE 'sql_%'
    `);
    if (tables.length > 0) {
      const tableNames = tables.map(t => `"${t.table_name}"`).join(', ');
      await db.run(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`);
    }
  } catch (e) {
    console.error('[test] cleanDatabase failed:', e.message);
    throw e;
  }
}

async function initTestDatabase() {
  // 清除模块缓存，确保 database 模块重新初始化
  jest.resetModules();
  await cleanDatabase();
  const { initDatabase } = require('../src/config/database');
  await initDatabase();
}

function createTestApp() {
  const app = express();

  // Stripe webhook needs raw body; skip global JSON parser for that path.
  const { router: billingRouter, callbackRouter, stripeWebhookRouter } = require('../src/routes/billing');
  const jsonParser = express.json({ limit: '10mb' });
  app.use((req, res, next) => {
    if (req.path === '/billing/stripe-webhook') return next();
    jsonParser(req, res, next);
  });

  // 挂载需要测试的路由
  app.use('/auth', require('../src/routes/user'));
  app.use('/admin', require('../src/routes/admin'));
  app.use('/workspaces', require('../src/routes/workspaces'));
  app.use('/billing', stripeWebhookRouter); // raw body, no auth
  app.use('/billing', callbackRouter);      // public callbacks
  app.use('/billing', billingRouter);       // authenticated billing APIs
  app.use('/user', require('../src/routes/user'));

  // 统一错误处理
  app.use((err, req, res, next) => {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message || 'Internal server error';
    res.status(500).json({ error: { message, type: 'internal_error' } });
  });

  return app;
}

async function createTestUser(username, password, role = 'user') {
  const db = require('../src/config/database');
  const passwordHash = bcrypt.hashSync(password, 10);
  const result = await db.run(
    `INSERT INTO users (username, password_hash, role, is_active, quota_limit) VALUES (?, ?, ?, true, 1000)`,
    [username, passwordHash, role]
  );
  return { id: result.lastInsertRowid, username, role };
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, jti: uuidv4() },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Returns a second-auth token for the given user.
 * The production twopass.json is expected to be initialized with the default PIN.
 * Signing directly avoids hitting the verify endpoint rate limit during test runs.
 */
function generateSecondAuthToken(userId) {
  return jwt.sign(
    { id: userId, type: 'second_auth_billing' },
    process.env.JWT_SECRET,
    { expiresIn: '32m' }
  );
}

/**
 * Test app that mirrors the production middleware mounting for /admin
 * (auth + admin role check + second-auth on mutations).
 */
function createSecureTestApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use('/auth', require('../src/routes/user'));
  app.use('/admin', authMiddleware, adminMiddleware, requireSecondAuthForMutations, require('../src/routes/admin'));
  app.use('/user', require('../src/routes/user'));

  app.use((err, req, res, next) => {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message || 'Internal server error';
    res.status(500).json({ error: { message, type: 'internal_error' } });
  });

  return app;
}

function getDb() {
  return require('../src/config/database');
}

module.exports = {
  cleanDatabase,
  initTestDatabase,
  createTestApp,
  createSecureTestApp,
  createTestUser,
  generateToken,
  generateSecondAuthToken,
  getDb,
};
