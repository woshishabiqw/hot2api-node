const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');

describe('Gateway Status API', () => {
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

  it('GET /admin/gateway-status 返回网关状态结构', async () => {
    const res = await request(app)
      .get('/admin/gateway-status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.urls)).toBe(true);
    expect(res.body).toHaveProperty('timestamp');
  });
});
