const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  cleanDatabase,
} = require('./utils');

describe('Account login lockout', () => {
  let app;
  const username = 'lockoutuser';
  const password = 'Password123';

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();
    await createTestUser(username, password, 'user');
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('连续 5 次错误密码后账号锁定', async () => {
    // First 4 failures return 401; the 5th failure triggers the lock.
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/auth/login')
        .send({ username, password: 'WrongPassword123' });
      expect(res.status).toBe(401);
    }

    const lockRes = await request(app)
      .post('/auth/login')
      .send({ username, password: 'WrongPassword123' });
    expect(lockRes.status).toBe(403);
    expect(lockRes.body.code).toBe('ACCOUNT_LOCKED');

    const res = await request(app)
      .post('/auth/login')
      .send({ username, password: 'WrongPassword123' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('正确密码在锁定期间也无法登录', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username, password });

    expect(res.status).toBe(403);
  });
});
