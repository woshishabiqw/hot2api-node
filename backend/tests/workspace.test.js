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

describe('Workspace API', () => {
  let app;
  let userA;
  let userB;
  let tokenA;
  let tokenB;

  async function addMemberDirectly(workspaceId, userId, role = 'member') {
    const database = getDb();
    await database.run(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`,
      [workspaceId, userId, role]
    );
    // Mark any pending invite as accepted so it doesn't interfere with invite tests
    await database.run(
      `UPDATE workspace_invites SET status = 'accepted' WHERE workspace_id = ? AND invitee_id = ? AND status = 'pending'`,
      [workspaceId, userId]
    );
  }

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

  describe('POST /workspaces', () => {
    it('创建 workspace 返回 201', async () => {
      const res = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Test Workspace' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe('Test Workspace');
    });

    it('名称过短返回 400', async () => {
      const res = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'A' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /workspaces', () => {
    it('返回当前用户的 workspace 列表', async () => {
      const res = await request(app)
        .get('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /workspaces/:id', () => {
    it('返回 workspace 详情和成员列表', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Detail WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .get(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(wsId);
      expect(res.body.name).toBe('Detail WS');
      expect(Array.isArray(res.body.members)).toBe(true);
      expect(res.body.members.length).toBeGreaterThanOrEqual(1);
    });

    it('非成员访问返回 404', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Private Detail WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .get(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /workspaces/:id', () => {
    it('owner 可更新名称', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Update WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .put(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('非 owner 更新返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Protected WS' });

      const wsId = wsRes.body.id;

      // 邀请 userB 并直接加入（模拟接受邀请）
      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });
      await addMemberDirectly(wsId, userB.id, 'member');

      const res = await request(app)
        .put(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Hacked Name' });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /workspaces/:id/members', () => {
    it('邀请存在的用户返回 201 并创建 pending invite', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Member Test WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('userb');
      expect(res.body.role).toBe('member');
      expect(res.body.message).toMatch(/邀请已发送/);
    });

    it('邀请不存在的用户返回 404', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Ghost WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'nonexistentuser', role: 'member' });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/用户不存在/);
    });

    it('重复邀请返回 400', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Dup Invite WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      const res = await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/已存在待处理的邀请/);
    });

    it('非 owner/admin 邀请成员返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Private WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username: 'usera', role: 'member' });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /workspaces/:id/members/:userId', () => {
    it('owner 可移除成员', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Remove Member WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });
      await addMemberDirectly(wsId, userB.id, 'member');

      const res = await request(app)
        .delete(`/workspaces/${wsId}/members/${userB.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('不能移除自己', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Self Remove WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}/members/${userA.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });

    it('非 admin 移除成员返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'No Perms WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}/members/${userA.id}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /workspaces/:id', () => {
    it('owner 可删除 workspace', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Delete Me WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // 确认已软删除
      const listRes = await request(app)
        .get('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`);

      const deletedWs = listRes.body.find(w => w.id === wsId);
      expect(deletedWs).toBeUndefined();
    });

    it('非 owner 删除返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Protected Delete WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });
      await addMemberDirectly(wsId, userB.id, 'member');

      const res = await request(app)
        .delete(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /workspaces/:id/billing', () => {
    it('成员可查看计费记录', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Billing WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .get(`/workspaces/${wsId}/billing`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.records)).toBe(true);
    });

    it('非成员查看计费记录返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Private Billing WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .get(`/workspaces/${wsId}/billing`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /workspaces/:id/keys', () => {
    it('owner/admin 可创建 API Key', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Test Key' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.key).toBeDefined();
      expect(res.body.name).toBe('Test Key');
    });

    it('非 admin 创建 key 返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key Protected WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });
      await addMemberDirectly(wsId, userB.id, 'member');

      const res = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Hacked Key' });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /workspaces/:id/keys', () => {
    it('成员可查看 API Key 列表', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'List Key WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key One' });

      const res = await request(app)
        .get(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0].key_prefix).toBeDefined();
    });

    it('非成员查看 key 列表返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Private Key WS' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .get(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /workspaces/:id/keys/:keyId', () => {
    it('所有者可以删除 workspace API key', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Delete Key WS' });

      const wsId = wsRes.body.id;

      const keyRes = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key To Delete' });

      const keyId = keyRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}/keys/${keyId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app)
        .get(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(listRes.body.find(k => k.id === keyId)).toBeUndefined();
    });

    it('非管理员不能删除 key', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Delete Key WS 2' });

      const wsId = wsRes.body.id;

      const keyRes = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key To Delete 2' });

      const keyId = keyRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}/keys/${keyId}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
    });

    it('删除不存在的 key 返回 404', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Delete Key WS 3' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .delete(`/workspaces/${wsId}/keys/99999`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /workspaces/:id/keys/:keyId', () => {
    it('owner/admin 可更新 key 的并发与限流配置', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Update Key WS' });

      const wsId = wsRes.body.id;

      const keyRes = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key To Update' });

      const keyId = keyRes.body.id;

      const res = await request(app)
        .put(`/workspaces/${wsId}/keys/${keyId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ max_concurrent: 200, rate_limit: 30 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app)
        .get(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`);

      const updated = listRes.body.find(k => k.id === keyId);
      expect(updated.max_concurrent).toBe(200);
      expect(updated.rate_limit).toBe(30);
    });

    it('非管理员更新 key 返回 403', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Update Key WS 2' });

      const wsId = wsRes.body.id;
      await addMemberDirectly(wsId, userB.id, 'member');

      const keyRes = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key To Protect' });

      const keyId = keyRes.body.id;

      const res = await request(app)
        .put(`/workspaces/${wsId}/keys/${keyId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ max_concurrent: 200 });

      expect(res.status).toBe(403);
    });

    it('更新不存在的 key 返回 404', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Update Key WS 3' });

      const wsId = wsRes.body.id;

      const res = await request(app)
        .put(`/workspaces/${wsId}/keys/99999`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ max_concurrent: 200 });

      expect(res.status).toBe(404);
    });

    it('owner/admin 可启用/禁用 key', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Toggle Key WS' });

      const wsId = wsRes.body.id;

      const keyRes = await request(app)
        .post(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Key To Toggle' });

      const keyId = keyRes.body.id;

      const disableRes = await request(app)
        .put(`/workspaces/${wsId}/keys/${keyId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ is_active: 0 });

      expect(disableRes.status).toBe(200);

      const listRes = await request(app)
        .get(`/workspaces/${wsId}/keys`)
        .set('Authorization', `Bearer ${tokenA}`);

      const updated = listRes.body.find(k => k.id === keyId);
      expect(updated.is_active).toBeFalsy();
    });
  });

  describe('GET /workspaces/invites', () => {
    it('返回当前用户的待处理邀请', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Invite Notify WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      const res = await request(app)
        .get('/workspaces/invites')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const invite = res.body.find(i => i.workspace_name === 'Invite Notify WS');
      expect(invite).toBeDefined();
      expect(invite.inviter_name).toBe('usera');
      expect(invite.status).toBe('pending');
    });
  });

  describe('POST /workspaces/invites/:id/accept', () => {
    it('接受邀请后加入 workspace', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Accept Invite WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      const invitesRes = await request(app)
        .get('/workspaces/invites')
        .set('Authorization', `Bearer ${tokenB}`);

      const invite = invitesRes.body.find(i => i.workspace_name === 'Accept Invite WS');
      expect(invite).toBeDefined();

      const res = await request(app)
        .post(`/workspaces/invites/${invite.id}/accept`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // 确认已加入
      const listRes = await request(app)
        .get('/workspaces')
        .set('Authorization', `Bearer ${tokenB}`);

      const joined = listRes.body.find(w => w.id === wsId);
      expect(joined).toBeDefined();
    });

    it('重复接受邀请返回 400', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Dup Accept WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      const invitesRes = await request(app)
        .get('/workspaces/invites')
        .set('Authorization', `Bearer ${tokenB}`);

      const invite = invitesRes.body.find(i => i.workspace_name === 'Dup Accept WS');
      expect(invite).toBeDefined();

      await request(app)
        .post(`/workspaces/invites/${invite.id}/accept`)
        .set('Authorization', `Bearer ${tokenB}`);

      const res = await request(app)
        .post(`/workspaces/invites/${invite.id}/accept`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /workspaces/invites/:id/decline', () => {
    it('拒绝邀请后不再显示', async () => {
      const wsRes = await request(app)
        .post('/workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Decline Invite WS' });

      const wsId = wsRes.body.id;

      await request(app)
        .post(`/workspaces/${wsId}/members`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ username: 'userb', role: 'member' });

      const invitesRes = await request(app)
        .get('/workspaces/invites')
        .set('Authorization', `Bearer ${tokenB}`);

      const invite = invitesRes.body.find(i => i.workspace_name === 'Decline Invite WS');
      expect(invite).toBeDefined();

      const res = await request(app)
        .post(`/workspaces/invites/${invite.id}/decline`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // 确认邀请已消失
      const listRes = await request(app)
        .get('/workspaces/invites')
        .set('Authorization', `Bearer ${tokenB}`);

      const stillThere = listRes.body.find(i => i.id === invite.id);
      expect(stillThere).toBeUndefined();
    });
  });
});
