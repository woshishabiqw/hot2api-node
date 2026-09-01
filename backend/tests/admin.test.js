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

describe('Admin API', () => {
  let app;
  let adminUser;
  let moderatorUser;
  let regularUser;
  let adminToken;
  let moderatorToken;
  let userToken;
  let adminSecondAuthToken;
  let moderatorSecondAuthToken;

  let probeService;

  beforeAll(async () => {
    await initTestDatabase();

    // 必须在 initTestDatabase (jest.resetModules) 之后加载 probeService，
    // 确保 admin route 拿到的是同一个对象，从而可以 mock 探测行为。
    probeService = require('../src/services/probe');
    jest.spyOn(probeService, 'probeSource').mockResolvedValue({
      openai: { status: 'ok', latencyMs: 100, timestamp: new Date().toISOString() },
    });
    jest.spyOn(probeService, 'probeAndUpdate').mockResolvedValue();

    app = createTestApp();

    adminUser = await createTestUser('adminuser', 'adminpass', 'admin');
    moderatorUser = await createTestUser('moduser', 'modpass', 'moderator');
    regularUser = await createTestUser('testuser', 'testpass', 'user');

    adminToken = generateToken(adminUser);
    moderatorToken = generateToken(moderatorUser);
    userToken = generateToken(regularUser);

    adminSecondAuthToken = await generateSecondAuthToken(adminUser.id);
    moderatorSecondAuthToken = await generateSecondAuthToken(moderatorUser.id);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanDatabase();
  });

  describe('GET /admin/sources', () => {
    it('admin 能访问', async () => {
      const res = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('普通用户返回 403', async () => {
      const res = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/sources', () => {
    it('创建源站返回 201', async () => {
      const res = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Test Source',
          base_url: 'https://api.test.com',
          protocol: 'openai',
          api_key: 'sk-test123',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe('Test Source');
    });

    it('缺少必填字段返回 400', async () => {
      const res = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Incomplete' });

      expect(res.status).toBe(400);
    });

    it('重复名称返回 400', async () => {
      await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Dup Source',
          base_url: 'https://api.dup.com',
          protocol: 'openai',
          api_key: 'sk-dup',
        });

      const res = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Dup Source',
          base_url: 'https://api.dup2.com',
          protocol: 'openai',
          api_key: 'sk-dup2',
        });

      expect(res.status).toBe(400);
    });

    it('创建源站后自动触发探测（P4 修复）', async () => {
      probeService.probeSource.mockClear();
      probeService.probeAndUpdate.mockClear();

      const res = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Auto Probe Source',
          base_url: 'https://api.autoprobe.com',
          protocol: 'openai',
          api_key: 'sk-autoprobe',
        });

      expect(res.status).toBe(201);
      // 等待创建后的异步 IIFE 探测完成
      await new Promise(r => setTimeout(r, 200));

      expect(probeService.probeSource).toHaveBeenCalledTimes(1);
      expect(probeService.probeAndUpdate).toHaveBeenCalledTimes(1);

      const calledSource = probeService.probeSource.mock.calls[0][0];
      expect(calledSource.id).toBe(res.body.id);
      expect(calledSource.name).toBe('Auto Probe Source');
    });
  });

  describe('PUT /admin/sources/:id', () => {
    it('更新源站返回 200', async () => {
      const createRes = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Update Source',
          base_url: 'https://api.update.com',
          protocol: 'openai',
          api_key: 'sk-update123',
        });

      const id = createRes.body.id;

      const res = await request(app)
        .put(`/admin/sources/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Updated Source Name', weight: 5 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('更新不存在的源站返回 404', async () => {
      const res = await request(app)
        .put('/admin/sources/99999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Ghost' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /admin/sources/:id', () => {
    it('删除源站返回 200', async () => {
      const createRes = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Delete Source',
          base_url: 'https://api.delete.com',
          protocol: 'openai',
          api_key: 'sk-delete123',
        });

      const id = createRes.body.id;

      const res = await request(app)
        .delete(`/admin/sources/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /admin/keys/concurrency', () => {
    it('admin 可查看 key 级实时并发状态', async () => {
      const res = await request(app)
        .get('/admin/keys/concurrency')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });

    it('普通用户返回 403', async () => {
      const res = await request(app)
        .get('/admin/keys/concurrency')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/users/defaults', () => {
    it('admin 可查看新用户默认配置', async () => {
      const res = await request(app)
        .get('/admin/users/defaults')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tpm).toBeDefined();
      expect(res.body.rpm).toBeDefined();
      expect(res.body.tpd).toBeDefined();
      expect(res.body.max_concurrent).toBeDefined();
    });

    it('普通用户返回 403', async () => {
      const res = await request(app)
        .get('/admin/users/defaults')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('PUT /admin/users/defaults', () => {
    it('admin 可更新新用户默认配置', async () => {
      const res = await request(app)
        .put('/admin/users/defaults')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({ tpm: 20000000, rpm: 200, tpd: 20000000, max_concurrent: 200 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const getRes = await request(app)
        .get('/admin/users/defaults')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(getRes.body.tpm).toBe(20000000);
      expect(getRes.body.rpm).toBe(200);
      expect(getRes.body.tpd).toBe(20000000);
      expect(getRes.body.max_concurrent).toBe(200);
    });
  });

  describe('Moderator 权限边界', () => {
    it('moderator 能访问 /admin/sources', async () => {
      const res = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${moderatorToken}`);

      expect(res.status).toBe(200);
    });

    it('moderator 不能通过 POST /admin/users 创建用户（返回 403）', async () => {
      const res = await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .set('X-Second-Auth-Token', moderatorSecondAuthToken)
        .send({ username: 'modcreated', password: 'password123' });

      expect(res.status).toBe(403);
    });
  });
});
