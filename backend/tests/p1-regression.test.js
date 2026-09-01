const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  generateSecondAuthToken,
  cleanDatabase,
  getDb,
} = require('./utils');

const registrationConfig = require('../src/services/registration-config');
const dispatcher = require('../src/services/dispatcher');
const captchaService = require('../src/services/captcha');
const cacheService = require('../src/services/cache');

describe('P1 Regression Tests', () => {
  let app;
  let user;
  let token;
  let adminUser;
  let adminToken;
  let adminSecondAuthToken;
  let workspaceId;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();
    app.use('/v1', require('../src/routes/openai'));

    user = await createTestUser('p1user', 'p1pass', 'user');
    token = generateToken(user);

    adminUser = await createTestUser('p1admin', 'p1adminpass', 'admin');
    adminToken = generateToken(adminUser);
    adminSecondAuthToken = await generateSecondAuthToken(adminUser.id);

    const db = getDb();
    const wsResult = await db.run(
      `INSERT INTO workspaces (name, slug, owner_id, balance) VALUES (?, ?, ?, ?)`,
      ['P1 WS', 'p1-ws-slug', user.id, 0]
    );
    workspaceId = wsResult.lastInsertRowid;

    await db.run(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`,
      [workspaceId, user.id]
    );
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('1. Disabled model must not be routable', () => {
    beforeAll(async () => {
      const db = getDb();
      // Clean any previous test source/model
      await db.run(`DELETE FROM models WHERE model_id LIKE 'p1-disabled-%'`);
      await db.run(`DELETE FROM sources WHERE name = 'P1 Disabled Source'`);

      const sourceResult = await db.run(
        `INSERT INTO sources (name, protocol, base_url, weight, max_concurrent, status, is_active, api_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['P1 Disabled Source', 'openai', 'http://localhost:9999', 100, 100, 'unknown', true, 'sk-test']
      );
      const sourceId = sourceResult.lastInsertRowid;

      await db.run(
        `INSERT INTO models (source_id, model_id, model_alias, is_active, input_price, output_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sourceId, 'p1-disabled-model', 'p1-disabled-alias', false, 1, 1]
      );
    });

    it('selectSource returns null for a disabled model', async () => {
      const source = await dispatcher.selectSource('p1-disabled-model', 'openai');
      expect(source).toBeNull();
    });

    it('chat/completions proxy returns 503 for a disabled model', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${token}`)
        .send({ model: 'p1-disabled-model', messages: [{ role: 'user', content: 'hi' }] });

      expect(res.status).toBe(503);
    });
  });

  describe('2. Captcha must work without Redis', () => {
    it('generate returns a token/svg and verify accepts the correct code', async () => {
      let storedCode = null;
      let storedKey = null;
      const originalSet = cacheService.set.bind(cacheService);
      jest.spyOn(cacheService, 'set').mockImplementation(async (key, value, ttl) => {
        if (key.startsWith('captcha:')) {
          storedKey = key;
          storedCode = value;
        }
        return originalSet(key, value, ttl);
      });

      const { token, svg } = await captchaService.generate();
      expect(token).toBeDefined();
      expect(svg).toContain('<svg');
      expect(storedKey).toBe(`captcha:${token}`);
      expect(storedCode).toBeTruthy();

      const valid = await captchaService.verify(token, storedCode);
      expect(valid).toBe(true);

      // Token is deleted after verification
      const second = await captchaService.verify(token, storedCode);
      expect(second).toBe(false);

      jest.restoreAllMocks();
    });
  });

  describe('3. Admin registration config must persist all fields', () => {
    beforeAll(async () => {
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: false,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });
    });

    it('PUT /admin/registration/config persists emailVerificationEnabled (camelCase)', async () => {
      const res = await request(app)
        .put('/admin/registration/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({
          registrationEnabled: true,
          captchaEnabled: true,
          emailVerificationEnabled: true,
          approvalMode: 'manual',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).toMatchObject({
        registrationEnabled: true,
        captchaEnabled: true,
        emailVerificationEnabled: true,
        approvalMode: 'manual',
      });

      // Re-read to confirm persistence
      const getRes = await request(app)
        .get('/admin/registration/config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(getRes.body.emailVerificationEnabled).toBe(true);
      expect(getRes.body.captchaEnabled).toBe(true);
    });

    it('PUT /admin/registration/config persists from snake_case like admin UI', async () => {
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: false,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });

      const res = await request(app)
        .put('/admin/registration/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({
          registration_enabled: true,
          captcha_enabled: true,
          email_verification_enabled: true,
          registration_approval_mode: 'manual',
        });

      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({
        registrationEnabled: true,
        captchaEnabled: true,
        emailVerificationEnabled: true,
        approvalMode: 'manual',
      });
    });
  });

  describe('4. Login must require captcha when enabled', () => {
    it('login without captcha fails when captcha is enabled', async () => {
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: true,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: 'p1pass' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/验证码/);
    });

    it('login with valid captcha succeeds when captcha is enabled', async () => {
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: true,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });

      const captchaService = require('../src/services/captcha');
      jest.spyOn(captchaService, 'verify').mockResolvedValue(true);

      const res = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: 'p1pass', captchaToken: 'token', captchaCode: 'code' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();

      jest.restoreAllMocks();
    });
  });

  describe('5. Recharge mock fallback must return a usable payment URL', () => {
    it('POST /billing/recharge with unconfigured channel returns a payment_url', async () => {
      const res = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 100, channel: 'wechat' });

      expect(res.status).toBe(201);
      expect(res.body.trade_no).toBeDefined();
      expect(res.body.payment_url || res.body.paymentUrl).toBeDefined();
      const url = res.body.payment_url || res.body.paymentUrl;
      // The URL returned by the backend is mounted at /billing internally.
      expect(url).toMatch(/^\/billing\/pay-mock/);
    });
  });

  describe('6. Stripe webhook development fallback', () => {
    it('accepts checkout.session.completed without webhookSecret for local dev', async () => {
      const db = getDb();
      // Insert an active Stripe channel without webhookSecret
      await db.run(
        `INSERT INTO payment_channels (name, type, config, env, is_active, is_primary, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['Stripe Dev', 'stripe', JSON.stringify({ secretKey: 'sk_test_dev', publishableKey: 'pk_test_dev' }), 'sandbox', true, true, 100]
      );

      const payload = {
        id: 'evt_test',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test',
            client_reference_id: 'ORD1234567890',
            metadata: { trade_no: 'ORD1234567890' },
          },
        },
      };

      const res = await request(app)
        .post('/billing/stripe-webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

});
