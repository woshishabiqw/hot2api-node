process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes!!';
process.env.REDIS_URL = '';

const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
  getDb,
} = require('./utils');

describe('Admin status & balance display', () => {
  let app;
  let adminUser;
  let adminToken;
  let db;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();
    adminUser = await createTestUser('adminstatus', 'adminpass', 'admin');
    adminToken = generateToken(adminUser);
    db = getDb();
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  async function createSource(overrides = {}) {
    const res = await request(app)
      .post('/admin/sources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Source-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        base_url: 'https://api.test.com',
        protocol: 'openai',
        api_key: 'sk-test',
        ...overrides
      });
    if (res.status !== 201) throw new Error(`createSource failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async function createModel(sourceId, overrides = {}) {
    const name = `Model-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await request(app)
      .post('/admin/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        source_id: sourceId,
        model_id: name,
        source_model_id: name,
        ...overrides
      });
    if (res.status !== 201) throw new Error(`createModel failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  describe('GET /admin/sources effective_status', () => {
    it('返回源站综合状态，包含最近 HTTP 状态码与详情', async () => {
      const source = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_status_code = ?, last_check_detail = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['insufficient', 429, 'Rate limit exceeded: too many requests', source.id]
      );

      const res = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const found = res.body.find(s => s.id === source.id);
      expect(found).toBeDefined();
      expect(found.effective_status).toBeDefined();
      expect(found.effective_status.effective_status).toBe('insufficient');
      expect(found.effective_status.status_code).toBe(429);
      expect(found.effective_status.detail).toContain('Rate limit');
      expect(found.effective_status.reason).toContain('余额不足或触发限速');
      expect(found.effective_status.reason).toContain('HTTP 429');
    });

    it('200 正常状态包含状态码 200', async () => {
      const source = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_status_code = ?, last_check_detail = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['valid', 200, 'Key/网络检测正常', source.id]
      );

      const res = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(s => s.id === source.id);
      expect(found.effective_status.status_code).toBe(200);
      expect(found.effective_status.effective_status).toBe('valid');
    });
  });

  describe('GET /admin/models routing_status & balance_status', () => {
    it('可用模型返回 active + 直连', async () => {
      const source = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['valid', source.id]
      );
      const model = await createModel(source.id);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const found = res.body.find(m => m.id === model.id);
      expect(found.routing_status.status).toBe('active');
      expect(found.routing_status.label).toBe('可用');
      expect(found.balance_status.mode).toBe('direct');
      expect(found.balance_status.label).toBe('直连');
    });

    it('源站禁用时模型状态为 source_inactive', async () => {
      const source = await createSource();
      const model = await createModel(source.id);
      await db.run(`UPDATE sources SET is_active = false WHERE id = ?`, [source.id]);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === model.id);
      expect(found.routing_status.status).toBe('source_inactive');
      expect(found.routing_status.label).toBe('源站已禁用');
      expect(found.balance_status.mode).toBe('source_inactive');
    });

    it('源站额度耗尽时模型状态为 quota_exceeded', async () => {
      const source = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, quota_limit = ?, quota_used = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['valid', 100, 100, source.id]
      );
      const model = await createModel(source.id);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === model.id);
      expect(found.routing_status.status).toBe('quota_exceeded');
      expect(found.routing_status.label).toBe('额度耗尽');
    });

    it('路由禁用时模型状态为 direct_disabled', async () => {
      const source = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, direct_status = ?, direct_disabled_until = datetime('now', '+1 hour'), last_check_at = datetime('now') WHERE id = ?`,
        ['valid', 'disabled', source.id]
      );
      const model = await createModel(source.id);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === model.id);
      expect(found.routing_status.status).toBe('direct_disabled');
      expect(found.balance_status.mode).toBe('direct_disabled');
    });

    it('属于 source_group 的模型显示负载均衡/主备切换', async () => {
      const source = await createSource({ source_group: 'group-a', stack_mode: 'merged' });
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['valid', source.id]
      );
      const model = await createModel(source.id);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === model.id);
      expect(found.balance_status.mode).toBe('source_group');
      expect(found.balance_status.stack_mode).toBe('merged');
      expect(found.balance_status.label).toBe('负载均衡');
      expect(found.balance_status.group_name).toBe('group-a');
    });

    it('属于实例的模型显示均衡中及成员数量', async () => {
      const inboundSource = await createSource();
      const memberSource = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now') WHERE id IN (?, ?)`,
        ['valid', inboundSource.id, memberSource.id]
      );
      const inboundModel = await createModel(inboundSource.id);

      const instRes = await request(app)
        .post('/admin/instances')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'test-instance',
          inbound_model_id: inboundModel.model_id,
          inbound_source_id: inboundSource.id,
          stack_mode: 'merged',
          member_source_ids: [memberSource.id]
        });
      expect(instRes.status).toBe(201);
      const instanceId = instRes.body.id;

      // 让模型指向实例（与 instances 创建逻辑一致）
      await db.run(`UPDATE models SET instance_id = ? WHERE id = ?`, [instanceId, inboundModel.id]);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === inboundModel.id);
      expect(found.balance_status.mode).toBe('instance');
      expect(found.balance_status.label).toBe('均衡中');
      expect(found.balance_status.stack_mode).toBe('merged');
      // 实例默认把入站源站也作为成员，因此总数为 2
      expect(found.balance_status.total_members).toBe(2);
      expect(found.balance_status.active_members).toBe(2);
      expect(found.balance_status.instance_name).toBe('test-instance');
    });

    it('实例被禁用时模型均衡状态为 instance_inactive', async () => {
      const inboundSource = await createSource();
      const memberSource = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now') WHERE id IN (?, ?)`,
        ['valid', inboundSource.id, memberSource.id]
      );
      const inboundModel = await createModel(inboundSource.id);

      const instRes = await request(app)
        .post('/admin/instances')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'inactive-instance',
          inbound_model_id: inboundModel.model_id,
          inbound_source_id: inboundSource.id,
          stack_mode: 'merged',
          member_source_ids: [memberSource.id]
        });
      const instanceId = instRes.body.id;
      await db.run(`UPDATE models SET instance_id = ? WHERE id = ?`, [instanceId, inboundModel.id]);
      await db.run(`UPDATE instances SET is_active = false WHERE id = ?`, [instanceId]);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === inboundModel.id);
      expect(found.balance_status.mode).toBe('instance_inactive');
      expect(found.balance_status.label).toBe('实例已禁用');
    });

    it('源站检测失败（unknown 且有检测记录）时路由状态显示 unhealthy', async () => {
      const source = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now'), last_check_detail = ? WHERE id = ?`,
        ['unknown', 'Request failed', source.id]
      );
      const model = await createModel(source.id);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === model.id);
      expect(found.routing_status.status).toBe('unhealthy');
      expect(found.routing_status.label).toBe('未知');
      expect(found.balance_status.mode).toBe('unhealthy');
    });

    it('实例入站源站异常时路由状态显示 unhealthy', async () => {
      const inboundSource = await createSource();
      const memberSource = await createSource();
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['invalid', inboundSource.id]
      );
      await db.run(
        `UPDATE sources SET status = ?, last_check_at = datetime('now') WHERE id = ?`,
        ['valid', memberSource.id]
      );
      const inboundModel = await createModel(inboundSource.id);

      const instRes = await request(app)
        .post('/admin/instances')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'unhealthy-instance',
          inbound_model_id: inboundModel.model_id,
          inbound_source_id: inboundSource.id,
          stack_mode: 'merged',
          member_source_ids: [memberSource.id]
        });
      const instanceId = instRes.body.id;
      await db.run(`UPDATE models SET instance_id = ? WHERE id = ?`, [instanceId, inboundModel.id]);

      const res = await request(app)
        .get('/admin/models')
        .set('Authorization', `Bearer ${adminToken}`);

      const found = res.body.find(m => m.id === inboundModel.id);
      expect(found.routing_status.status).toBe('unhealthy');
      expect(found.routing_status.label).toBe('停用');
      // 路由状态异常时，均衡状态同步显示异常原因
      expect(found.balance_status.mode).toBe('unhealthy');
    });
  });
});
