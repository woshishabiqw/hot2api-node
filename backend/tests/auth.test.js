const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');
const jwt = require('jsonwebtoken');

describe('Auth API', () => {
  let app;
  let adminUser;
  let regularUser;
  let adminToken;
  let userToken;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();

    adminUser = await createTestUser('adminuser', 'adminpass', 'admin');
    regularUser = await createTestUser('testuser', 'testpass', 'user');

    adminToken = generateToken(adminUser);
    userToken = generateToken(regularUser);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('POST /auth/login', () => {
    it('正确密码返回 token 和用户信息', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'testuser', password: 'testpass' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toMatchObject({
        id: regularUser.id,
        username: 'testuser',
        role: 'user',
      });
    });

    it('错误密码返回 401', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'testuser', password: 'wrongpass' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('不存在的用户返回 401', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'nosuchuser', password: 'somepass' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/register', () => {
    it('创建新用户并返回 201', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'newuser', password: 'newpass123' });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('newuser');
      expect(res.body.role).toBe('user');
    });

    it('重复用户名返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'testuser', password: 'anotherpass' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already exists/);
    });

    it('用户名过短返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'ab', password: 'password123' });

      expect(res.status).toBe(400);
    });

    it('密码过短返回 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: 'shortpassuser', password: '123' });

      expect(res.status).toBe(400);
    });
  });

  describe('Token 验证', () => {
    it('过期 token 返回 401', async () => {
      const expiredToken = jwt.sign(
        {
          id: regularUser.id,
          username: regularUser.username,
          role: regularUser.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: '-1s' }
      );

      const res = await request(app)
        .get('/user/profile')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    });

    it('无效 token 返回 401', async () => {
      const res = await request(app)
        .get('/user/profile')
        .set('Authorization', 'Bearer invalidtoken');

      expect(res.status).toBe(401);
    });

    it('不带 token 访问受保护路由返回 401', async () => {
      const res = await request(app).get('/user/profile');
      expect(res.status).toBe(401);
    });
  });
});
