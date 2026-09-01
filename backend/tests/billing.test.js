const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  generateSecondAuthToken,
  cleanDatabase,
  getDb,
} = require('./utils');

describe('Billing API', () => {
  let app;
  let user;
  let token;
  let workspaceId;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();

    user = await createTestUser('billinguser', 'billingpass', 'user');
    token = generateToken(user);

    // 手动创建一个 workspace 并绑定成员关系
    const db = getDb();
    const wsResult = await db.run(
      `INSERT INTO workspaces (name, slug, owner_id, balance) VALUES (?, ?, ?, ?)`,
      ['Billing WS', 'billing-ws-slug', user.id, 0]
    );
    workspaceId = wsResult.lastInsertRowid;

    await db.run(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`,
      [workspaceId, user.id]
    );
  });

  beforeEach(async () => {
    // Clean pending orders so each test can create fresh orders without
    // hitting the "one pending order per target" limit.
    const db = getDb();
    await db.run(`UPDATE payment_orders SET status = 'expired' WHERE status = 'pending'`);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('GET /billing/plans', () => {
    it('返回套餐列表', async () => {
      const res = await request(app)
        .get('/billing/plans')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /billing/recharge', () => {
    it('创建充值订单返回 201', async () => {
      const res = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 100, channel: 'alipay' });

      expect(res.status).toBe(201);
      expect(res.body.trade_no).toBeDefined();
      expect(res.body.amount).toBe(100);
      expect(res.body.status).toBe('pending');
    });

    it('无效渠道返回 400', async () => {
      const res = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 100, channel: 'bitcoin' });

      expect(res.status).toBe(400);
    });

    it('Workspace 充值缺少 workspace_id 返回 400', async () => {
      const res = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100, channel: 'alipay', target: 'workspace' });

      expect(res.status).toBe(400);
    });

    it('账户充值无需 workspace_id 返回 201', async () => {
      const res = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 50, channel: 'alipay', target: 'account' });

      expect(res.status).toBe(201);
      expect(res.body.trade_no).toBeDefined();
      expect(res.body.workspace_id).toBeUndefined();
    });

    it('创建订单时返回 expires_at', async () => {
      const res = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10, channel: 'alipay', target: 'account' });

      expect(res.status).toBe(201);
      expect(res.body.expires_at).toBeDefined();
      const expiresAt = new Date(res.body.expires_at).getTime();
      const now = Date.now();
      expect(expiresAt).toBeGreaterThan(now);
      expect(expiresAt).toBeLessThanOrEqual(now + 31 * 60 * 1000);
    });

    it('同类型未支付订单只能存在一个（workspace）', async () => {
      const first = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 10, channel: 'alipay' });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 20, channel: 'wechat' });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/未支付订单/);
      expect(second.body.existing_order_id).toBe(first.body.id);
    });

    it('同类型未支付订单只能存在一个（account）', async () => {
      const first = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10, channel: 'alipay', target: 'account' });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 20, channel: 'wechat', target: 'account' });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/未支付订单/);
    });

    it('不同类型未支付订单可以共存', async () => {
      const accountOrder = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10, channel: 'alipay', target: 'account' });
      expect(accountOrder.status).toBe(201);

      const workspaceOrder = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 20, channel: 'wechat' });
      expect(workspaceOrder.status).toBe(201);
    });

    it('过期后可以创建同类型新订单', async () => {
      const db = getDb();
      const first = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 10, channel: 'alipay' });
      expect(first.status).toBe(201);

      // Manually expire the order
      await db.run(
        `UPDATE payment_orders SET status = 'expired', expires_at = ? WHERE id = ?`,
        [new Date(Date.now() - 1000).toISOString(), first.body.id]
      );

      const second = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 20, channel: 'wechat' });
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('Mock 支付回调', () => {
    it('支付后余额正确更新', async () => {
      const orderRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 200, channel: 'wechat' });

      const { id, trade_no } = orderRes.body;

      const payRes = await request(app)
        .get(`/billing/pay-mock?order_id=${id}&trade_no=${trade_no}`)
        .set('Authorization', `Bearer ${token}`);

      expect(payRes.status).toBe(200);
      expect(payRes.body.success).toBe(true);
      expect(payRes.body.balance).toBe(200);

      // 数据库层面验证
      const db = getDb();
      const ws = await db.get('SELECT balance FROM workspaces WHERE id = ?', [workspaceId]);
      expect(ws.balance).toBe(200);
    });

    it('账户充值回调只更新用户余额', async () => {
      const orderRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 123, channel: 'alipay', target: 'account' });

      const { id, trade_no } = orderRes.body;

      const payRes = await request(app)
        .get(`/billing/pay-mock?order_id=${id}&trade_no=${trade_no}`)
        .set('Authorization', `Bearer ${token}`);

      expect(payRes.status).toBe(200);
      expect(payRes.body.success).toBe(true);
      expect(payRes.body.userBalance).toBe(123);

      const db = getDb();
      const userRow = await db.get('SELECT balance FROM users WHERE id = ?', [user.id]);
      expect(userRow.balance).toBe(123);
    });

    it('Workspace 充值回调只更新 workspace 余额，不污染用户余额', async () => {
      const db = getDb();
      const beforeUser = await db.get('SELECT balance FROM users WHERE id = ?', [user.id]);
      const beforeUserBalance = beforeUser?.balance || 0;
      const beforeWs = await db.get('SELECT balance FROM workspaces WHERE id = ?', [workspaceId]);
      const beforeWsBalance = beforeWs?.balance || 0;

      const orderRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 88, channel: 'alipay', target: 'workspace' });

      const { id, trade_no } = orderRes.body;

      const payRes = await request(app)
        .get(`/billing/pay-mock?order_id=${id}&trade_no=${trade_no}`)
        .set('Authorization', `Bearer ${token}`);

      expect(payRes.status).toBe(200);
      expect(payRes.body.success).toBe(true);
      expect(payRes.body.balance).toBe(beforeWsBalance + 88);
      expect(payRes.body.userBalance).toBe(beforeUserBalance);

      const ws = await db.get('SELECT balance FROM workspaces WHERE id = ?', [workspaceId]);
      expect(ws.balance).toBe(beforeWsBalance + 88);
      const afterUser = await db.get('SELECT balance FROM users WHERE id = ?', [user.id]);
      expect(afterUser.balance).toBe(beforeUserBalance);
    });

    it('重复支付通知不重复加余额（幂等）', async () => {
      const db = getDb();
      const beforeWs = await db.get('SELECT balance FROM workspaces WHERE id = ?', [workspaceId]);
      const beforeWsBalance = beforeWs?.balance || 0;

      const orderRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 150, channel: 'alipay' });

      const { id, trade_no } = orderRes.body;

      // 第一次支付
      const firstPay = await request(app)
        .get(`/billing/pay-mock?order_id=${id}&trade_no=${trade_no}`)
        .set('Authorization', `Bearer ${token}`);

      expect(firstPay.status).toBe(200);
      expect(firstPay.body.message).toMatch(/successful/i);

      // 第二次支付（幂等）
      const secondPay = await request(app)
        .get(`/billing/pay-mock?order_id=${id}&trade_no=${trade_no}`)
        .set('Authorization', `Bearer ${token}`);

      expect(secondPay.status).toBe(200);
      expect(secondPay.body.message).toMatch(/Already paid/i);

      // 余额只增加一次 150
      const ws = await db.get('SELECT balance FROM workspaces WHERE id = ?', [workspaceId]);
      expect(ws.balance).toBe(beforeWsBalance + 150);
    });
  });

  describe('GET /billing/balance/:workspaceId', () => {
    it('返回 workspace 余额', async () => {
      const res = await request(app)
        .get(`/billing/balance/${workspaceId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.balance).toBeDefined();
    });

    it('非成员访问返回 403', async () => {
      const otherUser = await createTestUser('otherbill', 'otherpass', 'user');
      const otherToken = generateToken(otherUser);

      const res = await request(app)
        .get(`/billing/balance/${workspaceId}`)
        .set('Authorization', `Bearer ${otherToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /billing/orders status filter', () => {
    it('按状态筛选订单', async () => {
      const db = getDb();
      // Workspace pending order
      const pendingRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspace_id: workspaceId, amount: 50, channel: 'alipay' });
      expect(pendingRes.status).toBe(201);
      const pendingOrderId = pendingRes.body.id;
      // 避免被过期任务误伤
      await db.run('UPDATE payment_orders SET created_at = ?, expires_at = ? WHERE id = ?', [new Date().toISOString(), new Date(Date.now() + 10 * 60 * 1000).toISOString(), pendingOrderId]);

      // Account order (different target, allowed) then pay it
      const paidRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 60, channel: 'wechat', target: 'account' });
      expect(paidRes.status).toBe(201);
      const paidOrderId = paidRes.body.id;

      const payRes = await request(app)
        .get(`/billing/pay-mock?order_id=${paidOrderId}&trade_no=${paidRes.body.trade_no}`)
        .set('Authorization', `Bearer ${token}`);
      expect(payRes.status).toBe(200);

      const pendingList = await request(app)
        .get('/billing/orders?status=pending')
        .set('Authorization', `Bearer ${token}`);
      expect(pendingList.status).toBe(200);
      const pendingIds = pendingList.body.orders.map(o => o.id);
      expect(pendingIds).toContain(pendingOrderId);
      expect(pendingIds).not.toContain(paidOrderId);

      const paidList = await request(app)
        .get('/billing/orders?status=paid')
        .set('Authorization', `Bearer ${token}`);
      expect(paidList.status).toBe(200);
      const paidIds = paidList.body.orders.map(o => o.id);
      expect(paidIds).toContain(paidOrderId);
      expect(paidIds).not.toContain(pendingOrderId);
    });

    it('默认按订单 ID 从大到小排序', async () => {
      const db = getDb();
      await db.run(`UPDATE payment_orders SET status = 'expired' WHERE status = 'pending'`);

      const first = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10, channel: 'alipay', target: 'account' });
      expect(first.status).toBe(201);

      // Expire first order so we can create a second one for the same target
      await db.run('UPDATE payment_orders SET status = ? WHERE id = ?', ['expired', first.body.id]);

      const second = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 20, channel: 'alipay', target: 'account' });
      expect(second.status).toBe(201);

      const sorted = await request(app)
        .get('/billing/orders?sort=id_desc')
        .set('Authorization', `Bearer ${token}`);
      expect(sorted.status).toBe(200);
      const ids = sorted.body.orders.map(o => o.id);
      expect(ids.indexOf(second.body.id)).toBeLessThan(ids.indexOf(first.body.id));
    });
  });

  describe('GET /billing/my-coupons/all', () => {
    it('返回当前用户全部优惠券及状态', async () => {
      const admin = await createTestUser('couponadmin', 'couponpass', 'admin');
      const adminToken = generateToken(admin);
      const adminSecondAuthToken = await generateSecondAuthToken(admin.id);

      const couponRes = await request(app)
        .post('/billing/admin/coupons')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({ name: '测试满减券', type: 'threshold_fixed', threshold: 50, discount_amount: 10 });
      expect(couponRes.status).toBe(201);
      const couponId = couponRes.body.id;

      await request(app)
        .post('/billing/admin/user-coupons/issue')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Second-Auth-Token', adminSecondAuthToken)
        .send({ coupon_id: couponId, usernames: ['billinguser'] });

      const allRes = await request(app)
        .get('/billing/my-coupons/all')
        .set('Authorization', `Bearer ${token}`);
      expect(allRes.status).toBe(200);
      expect(Array.isArray(allRes.body.coupons)).toBe(true);
      expect(allRes.body.coupons.length).toBeGreaterThanOrEqual(1);
      const issued = allRes.body.coupons.find(c => c.coupon_id === couponId);
      expect(issued).toBeDefined();
      expect(issued.effective_status).toBe('unused');

      const db = getDb();
      await db.run('UPDATE user_coupons SET status = ? WHERE user_id = ? AND coupon_id = ?', ['used', user.id, couponId]);

      const usedRes = await request(app)
        .get('/billing/my-coupons/all?status=used')
        .set('Authorization', `Bearer ${token}`);
      expect(usedRes.status).toBe(200);
      expect(usedRes.body.coupons.some(c => c.coupon_id === couponId)).toBe(true);
    });
  });

  describe('POST /billing/orders/:id/continue-pay validation', () => {
    it('订单不存在返回 404', async () => {
      const res = await request(app)
        .post('/billing/orders/999999/continue-pay')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/订单不存在/);
    });

    it('已支付订单继续支付返回 400', async () => {
      const orderRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 30, channel: 'alipay', target: 'account' });
      expect(orderRes.status).toBe(201);
      const { id, trade_no } = orderRes.body;

      // Mark as paid via mock callback
      const payRes = await request(app)
        .get(`/billing/pay-mock?order_id=${id}&trade_no=${trade_no}`)
        .set('Authorization', `Bearer ${token}`);
      expect(payRes.status).toBe(200);

      const res = await request(app)
        .post(`/billing/orders/${id}/continue-pay`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/订单状态不允许继续支付/);
    });

    it('过期订单继续支付返回 400', async () => {
      const orderRes = await request(app)
        .post('/billing/recharge')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 40, channel: 'alipay', target: 'account' });
      expect(orderRes.status).toBe(201);
      const { id } = orderRes.body;

      const db = getDb();
      await db.run(
        'UPDATE payment_orders SET expires_at = ? WHERE id = ?',
        [new Date(Date.now() - 1000).toISOString(), id]
      );

      const res = await request(app)
        .post(`/billing/orders/${id}/continue-pay`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/订单已过期/);
    });
  });

  describe('Alipay notify verification logging', () => {
    it('非法 notify 验签失败并记录日志', async () => {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.join(__dirname, '..', 'logs', 'alipay-notify.log');
      const beforeStat = fs.existsSync(logPath) ? fs.statSync(logPath) : { size: 0 };

      const res = await request(app)
        .post('/billing/notify')
        .type('form')
        .send({ out_trade_no: 'NONEXISTENT', trade_status: 'TRADE_SUCCESS', sign: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.text).toBe('fail');

      const afterContent = fs.readFileSync(logPath, 'utf8');
      const newLogs = afterContent.slice(beforeStat.size);
      expect(newLogs).toContain('notify_verify');
      expect(newLogs).toContain('"is_valid":false');
    });
  });
});
