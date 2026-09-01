const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');

describe('Security', () => {
  let app;
  let userA;
  let userB;
  let tokenA;
  let tokenB;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();

    userA = await createTestUser('usera', 'passa', 'user');
    userB = await createTestUser('userb', 'passb', 'user');

    tokenA = generateToken(userA);
    tokenB = generateToken(userB);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('SQL 注入', () => {
    it('登录时 SQL 注入尝试不会绕过认证', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: "' OR 1=1 --", password: 'anything' });

      expect(res.status).toBe(401);
    });

    it('注册时 SQL 注入尝试被安全处理', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ username: "'; DROP TABLE users; --", password: 'password123' });

      // 参数化查询不会被注入破坏；用户名格式非法会被拒绝
      expect([201, 400]).toContain(res.status);
      if (res.status === 201) {
        // 确认表没有被删
        const db = require('../src/config/database');
        const tables = await db.all(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'"
        );
        expect(tables.length).toBe(1);
      }
    });
  });

  describe('XSS', () => {
    it('script 标签在 JSON 响应中不会执行', async () => {
      const xssPayload = '<script>alert(1)</script>';

      // workspace 名称允许更多字符，适合测试 XSS payload 的返回
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: xssPayload });

      expect(wsRes.status).toBe(201);
      expect(wsRes.body.name).toBe(xssPayload);
      // Content-Type 应为 application/json，浏览器不会执行脚本
      expect(wsRes.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('未授权访问', () => {
    it('不带 token 访问 /user/profile 返回 401', async () => {
      const res = await request(app).get('/user/profile');
      expect(res.status).toBe(401);
    });

    it('不带 token 访问 /admin/sources 返回 401', async () => {
      const res = await request(app).get('/admin/sources');
      expect(res.status).toBe(401);
    });

    it('不带 token 访问 /workspaces 返回 401', async () => {
      const res = await request(app).get('/workspaces');
      expect(res.status).toBe(401);
    });

    it('不带 token 访问 /billing/plans 返回 401', async () => {
      const res = await request(app).get('/billing/plans');
      expect(res.status).toBe(401);
    });
  });

  describe('越权访问', () => {
    it('userA 不能通过 /user/profile 获取 userB 的信息', async () => {
      // /user/profile 永远返回当前 token 对应用户
      const resA = await request(app)
        .get('/user/profile')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(resA.status).toBe(200);
      expect(resA.body.username).toBe('usera');

      const resB = await request(app)
        .get('/user/profile')
        .set('Authorization', `Bearer ${tokenB}`);
      expect(resB.status).toBe(200);
      expect(resB.body.username).toBe('userb');
    });

    it('userA 不能访问 userB 创建的 workspace billing', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'UserB Private WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .get(`/workspaces/${wsId}/billing`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(403);
    });

    it('userA 不能更新 userB 的 workspace', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'UserB Another WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .put(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Hacked Name' });

      expect(res.status).toBe(403);
    });

    it('userA 不能删除 userB 的 workspace 成员', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'UserB Member WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}/members/${userB.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(403);
    });
  });
});
