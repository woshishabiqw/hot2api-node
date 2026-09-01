const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');

describe('Token revocation', () => {
  let app;
  let user;
  let token;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();
    user = await createTestUser('tokentest', 'Password123', 'user');
    // Login to obtain a token with jti
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'tokentest', password: 'Password123' });
    token = loginRes.body.token;
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('登录后 token 可访问受保护接口', async () => {
    const res = await request(app)
      .get('/user/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('tokentest');
  });

  it('调用 /auth/logout 后 token 失效', async () => {
    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(logoutRes.status).toBe(200);

    const profileRes = await request(app)
      .get('/user/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(profileRes.status).toBe(401);
  });

  it('修改密码后旧 token 失效', async () => {
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'tokentest', password: 'Password123' });
    const oldToken = loginRes.body.token;

    await request(app)
      .put('/user/profile')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ password: 'NewPassword123' });

    const profileRes = await request(app)
      .get('/user/profile')
      .set('Authorization', `Bearer ${oldToken}`);

    expect(profileRes.status).toBe(401);
  });
});
