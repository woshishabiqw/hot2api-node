const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');

describe('Node Security', () => {
  let app;
  let adminUser;
  let adminToken;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();

    adminUser = await createTestUser('adminuser', 'adminpass', 'admin');
    adminToken = generateToken(adminUser);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('GET /admin/security/node-config', () => {
    it('返回默认 Node 安全配置', async () => {
      const res = await request(app)
        .get('/admin/security/node-config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ipRateLimit).toMatchObject({
        enabled: false,
        windowSeconds: 60,
        maxRequests: 100,
      });
      expect(res.body.bodyLimitMb).toBe(10);
    });
  });

  describe('PUT /admin/security/node-config', () => {
    it('保存并返回 Node 安全配置', async () => {
      const res = await request(app)
        .put('/admin/security/node-config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ipRateLimit: { enabled: true, windowSeconds: 30, maxRequests: 5 },
          bodyLimitMb: 5,
          corsOrigins: 'http://localhost:3001',
          requestTimeoutSeconds: 60,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.ipRateLimit).toMatchObject({
        enabled: true,
        windowSeconds: 30,
        maxRequests: 5,
      });
      expect(res.body.config.bodyLimitMb).toBe(5);
    });
  });

  describe('IP rate-limit middleware', () => {
    it('未启用时公共接口可正常访问', async () => {
      const res = await request(app).get('/auth/config');
      expect(res.status).toBe(200);
    });
  });
});
