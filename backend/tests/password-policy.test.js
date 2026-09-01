const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  generateSecondAuthToken,
  cleanDatabase,
} = require('./utils');
const registrationConfig = require('../src/services/registration-config');

describe('Password policy and registration switch', () => {
  let app;
  let adminUser;
  let adminToken;
  let adminSecondAuthToken;
  const originalAllowRegistration = process.env.ALLOW_REGISTRATION;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();
    adminUser = await createTestUser('policyadmin', 'Password123', 'admin');
    adminToken = generateToken(adminUser);
    adminSecondAuthToken = await generateSecondAuthToken(adminUser.id);
  });

  afterAll(async () => {
    process.env.ALLOW_REGISTRATION = originalAllowRegistration;
    await cleanDatabase();
  });

  it('密码小于 8 位注册失败', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'shortpw', password: 'a1' });

    expect(res.status).toBe(400);
  });

  it('纯字母密码注册失败', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'lettersonly', password: 'abcdefgh' });

    expect(res.status).toBe(400);
  });

  it('符合策略的密码注册成功', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'gooduser', password: 'GoodPass123' });

    expect(res.status).toBe(201);
  });

  it('管理员创建用户时弱密码被拒绝', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Second-Auth-Token', adminSecondAuthToken)
      .send({ username: 'weakadmin', password: '1234567', role: 'user' });

    expect(res.status).toBe(400);
  });

  it('关闭自助注册后普通用户无法注册', async () => {
    await registrationConfig.setRegistrationConfig({ registrationEnabled: false });

    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'closedreg', password: 'ClosedReg123' });

    expect(res.status).toBe(403);

    // 恢复默认配置，避免影响其他测试
    await registrationConfig.setRegistrationConfig({ registrationEnabled: true });
  });
});
