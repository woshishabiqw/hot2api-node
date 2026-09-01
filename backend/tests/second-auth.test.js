const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createSecureTestApp,
  createTestUser,
  generateToken,
  generateSecondAuthToken,
  cleanDatabase,
} = require('./utils');

describe('Second-auth PIN enforcement on admin routes', () => {
  let app;
  let adminUser;
  let adminToken;
  let secondAuthToken;

  beforeAll(async () => {
    await initTestDatabase();
    app = createSecureTestApp();
    adminUser = await createTestUser('pinadmin', 'Password123', 'admin');
    adminToken = generateToken(adminUser);
    secondAuthToken = await generateSecondAuthToken(adminUser.id, '123456');
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('GET /admin/users 不需要 PIN', async () => {
    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });

  it('POST /admin/users 无 PIN Token 返回 SECOND_AUTH_REQUIRED', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'nopinuser', password: 'Password123', role: 'user' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_AUTH_REQUIRED');
  });

  it('POST /admin/users 携带正确 PIN Token 成功', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Second-Auth-Token', secondAuthToken)
      .send({ username: 'withpinuser', password: 'Password123', role: 'user' });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe('withpinuser');
  });

  it('PUT /admin/users/:id 无 PIN Token 被拦截', async () => {
    const res = await request(app)
      .put(`/admin/users/${adminUser.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tpm: 100 });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SECOND_AUTH_REQUIRED');
  });

  it('POST /admin/users 携带无效 PIN Token 返回 401', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Second-Auth-Token', 'invalid-token')
      .send({ username: 'badpinuser', password: 'Password123', role: 'user' });

    expect(res.status).toBe(401);
  });
});
