const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  generateSecondAuthToken,
  cleanDatabase,
} = require('./utils');

const registrationConfig = require('../src/services/registration-config');

async function resetConfig() {
  await registrationConfig.setRegistrationConfig({
    registrationEnabled: true,
    captchaEnabled: false,
    emailVerificationEnabled: false,
    approvalMode: 'auto',
  });
}

describe('Registration Management', () => {
  let app;
  let adminUser;
  let adminToken;
  let adminSecondAuthToken;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();

    adminUser = await createTestUser('adminuser', 'adminpass', 'admin');
    adminToken = generateToken(adminUser);
    adminSecondAuthToken = await generateSecondAuthToken(adminUser.id);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanDatabase();
  });

  describe('GET /auth/captcha', () => {
    it('返回图形验证码 token 和 SVG', async () => {
      const res = await request(app).get('/auth/captcha');
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.svg).toContain('<svg');
    });
  });

  describe('GET /admin/registration/config', () => {
    beforeEach(resetConfig);

    it('返回默认注册配置', async () => {
      const res = await request(app)
        .get('/admin/registration/config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        registrationEnabled: true,
        captchaEnabled: false,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });
    });
  });

  describe('PUT /admin/registration/config', () => {
    beforeEach(resetConfig);

    it('支持 camelCase 字段更新配置', async () => {
      const res = await request(app)
        .put('/admin/registration/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({
          registrationEnabled: false,
          captchaEnabled: true,
          approvalMode: 'manual',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).toMatchObject({
        registrationEnabled: false,
        captchaEnabled: true,
        emailVerificationEnabled: false,
        approvalMode: 'manual',
      });
    });

    it('支持 snake_case 字段更新配置', async () => {
      const res = await request(app)
        .put('/admin/registration/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({
          registration_enabled: true,
          captcha_enabled: false,
          registration_approval_mode: 'auto',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).toMatchObject({
        registrationEnabled: true,
        captchaEnabled: false,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });
    });
  });

  describe('Registration disabled', () => {
    beforeEach(async () => {
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: false,
        captchaEnabled: false,
        approvalMode: 'auto',
      });
    });

    it('关闭注册后 POST /auth/register 返回 403', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'disabledreg', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/关闭/);
    });
  });

  describe('Captcha enabled', () => {
    beforeEach(async () => {
      await resetConfig();
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: true,
        approvalMode: 'auto',
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('缺少验证码时注册返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'nocaptcha', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/验证码/);
    });

    it('验证码错误时注册返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          username: 'wrongcaptcha',
          password: 'password123',
          captchaToken: 'token',
          captchaCode: 'wrong',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/验证码/);
    });

    it('验证码正确时注册成功', async () => {
      const captchaService = require('../src/services/captcha');
      jest.spyOn(captchaService, 'verify').mockResolvedValue(true);

      const res = await request(app)
        .post('/auth/register')
        .send({
          username: 'withcaptcha',
          password: 'password123',
          captchaToken: 'token',
          captchaCode: 'abcd',
        });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('withcaptcha');
    });
  });

  describe('Manual approval mode', () => {
    beforeEach(async () => {
      await resetConfig();
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: false,
        approvalMode: 'manual',
      });
    });

    it('人工审批模式下新用户为待审批状态', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'pendinguser', password: 'password123' });

      expect(res.status).toBe(201);
      expect(res.body.is_active).toBe(false);
      expect(res.body.pending_approval).toBe(true);
    });

    it('待审批用户出现在 pending 列表中', async () => {
      const res = await request(app)
        .get('/admin/registration/pending')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const pendingUser = res.body.find(u => u.username === 'pendinguser');
      expect(pendingUser).toBeDefined();
      expect(pendingUser.is_active).toBe(false);
    });

    it('通过待审批用户后变为激活状态', async () => {
      const db = require('../src/config/database');
      const row = await db.get("SELECT id FROM users WHERE username = 'pendinguser'");
      expect(row).toBeDefined();

      const res = await request(app)
        .post(`/admin/registration/${row.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const after = await db.get('SELECT is_active FROM users WHERE id = ?', [row.id]);
      expect(after.is_active).toBe(true);
    });

    it('拒绝待审批用户后用户被删除', async () => {
      const registerRes = await request(app)
        .post('/auth/register')
        .send({ username: 'rejectuser', password: 'password123' });
      expect(registerRes.status).toBe(201);

      const db = require('../src/config/database');
      const row = await db.get("SELECT id FROM users WHERE username = 'rejectuser'");
      expect(row).toBeDefined();

      const res = await request(app)
        .post(`/admin/registration/${row.id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const after = await db.get('SELECT id FROM users WHERE id = ?', [row.id]);
      expect(after).toBeNull();
    });
  });

  describe('GET /auth/config', () => {
    beforeEach(resetConfig);

    it('返回公开注册配置', async () => {
      const res = await request(app).get('/auth/config');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        registrationEnabled: true,
        captchaEnabled: false,
        emailVerificationEnabled: false,
        approvalMode: 'auto',
      });
    });
  });

  describe('Email verification enabled', () => {
    beforeEach(async () => {
      await resetConfig();
      await registrationConfig.setRegistrationConfig({
        registrationEnabled: true,
        captchaEnabled: false,
        emailVerificationEnabled: true,
        approvalMode: 'auto',
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('缺少邮箱验证码时注册返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'noemailcode', password: 'password123', email: 'test@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/邮箱验证码/);
    });

    it('邮箱验证码错误时注册返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          username: 'wrongemailcode',
          password: 'password123',
          email: 'test@example.com',
          emailCode: '000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/邮箱验证码/);
    });

    it('邮箱验证码正确时注册成功', async () => {
      const emailCodeService = require('../src/services/email-code');
      jest.spyOn(emailCodeService, 'verifyCode').mockResolvedValue(true);

      const res = await request(app)
        .post('/auth/register')
        .send({
          username: 'withemailcode',
          password: 'password123',
          email: 'test@example.com',
          emailCode: '123456',
        });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('withemailcode');
      expect(res.body.email).toBe('test@example.com');
    });

    it('POST /auth/send-email-code 在未配置 SMTP 时返回 500', async () => {
      const uniqueEmail = `test-${Date.now()}@example.com`;
      const res = await request(app)
        .post('/auth/send-email-code')
        .send({ email: uniqueEmail });

      expect(res.status).toBe(500);
    });
  });

  describe('SMTP config management', () => {
    it('GET /admin/mail/config 返回 SMTP 配置', async () => {
      const res = await request(app)
        .get('/admin/mail/config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('host');
      expect(res.body).toHaveProperty('pass');
    });

    it('PUT /admin/mail/config 保存 SMTP 配置', async () => {
      const res = await request(app)
        .put('/admin/mail/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          host: 'smtp.example.com',
          port: 465,
          secure: true,
          user: 'test@example.com',
          pass: 'secret',
          from: 'noreply@example.com',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.host).toBe('smtp.example.com');
      expect(res.body.config.pass).toBe('********');
    });
  });
});
