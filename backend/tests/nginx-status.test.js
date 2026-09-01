const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');

describe('Nginx Status API', () => {
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

  it('GET /admin/nginx-status 返回状态字段', async () => {
    const res = await request(app)
      .get('/admin/nginx-status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(typeof res.body.status).toBe('string');
    expect(res.body).toHaveProperty('controlled');
    expect(res.body).toHaveProperty('running');
    expect(res.body).toHaveProperty('managedCount');
    expect(res.body).toHaveProperty('externalCount');
    expect(res.body).toHaveProperty('processCount');
  });
});
