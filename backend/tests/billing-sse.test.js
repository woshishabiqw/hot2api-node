process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes!!';
process.env.REDIS_URL = '';

const http = require('http');
const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');
const request = require('supertest');
const {
  initTestDatabase,
  createTestApp,
  createTestUser,
  generateToken,
  cleanDatabase,
  getDb,
} = require('./utils');

describe('Billing pending orders SSE', () => {
  let app;
  let user;
  let token;
  let workspaceId;
  let server;
  let port;

  beforeAll(async () => {
    await initTestDatabase();
    app = createTestApp();

    user = await createTestUser('sseser', 'ssespass', 'user');
    token = generateToken(user);

    const db = getDb();
    const wsResult = await db.run(
      `INSERT INTO workspaces (name, slug, owner_id, balance) VALUES (?, ?, ?, ?)`,
      ['SSE WS', 'sse-ws-slug', user.id, 0]
    );
    workspaceId = wsResult.lastInsertRowid;
    await db.run(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`,
      [workspaceId, user.id]
    );

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  beforeEach(async () => {
    const db = getDb();
    await db.run(`UPDATE payment_orders SET status = 'expired' WHERE status = 'pending'`);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await cleanDatabase();
  });

  function fetchSSE(path, { stopAfterMs = 2500 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } },
        (res) => {
          let buffer = '';
          res.on('data', (chunk) => { buffer += chunk.toString(); });
          const timer = setTimeout(() => {
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body: buffer });
          }, stopAfterMs);
          res.on('error', (err) => { clearTimeout(timer); reject(err); });
        }
      );
      req.on('error', (err) => reject(err));
    });
  }

  it('SSE endpoint returns pending orders with expires_at', async () => {
    const orderRes = await request(app)
      .post('/billing/recharge')
      .set('Authorization', `Bearer ${token}`)
      .send({ workspace_id: workspaceId, amount: 99, channel: 'alipay' });
    expect(orderRes.status).toBe(201);

    const sse = await fetchSSE(`/billing/orders/pending-stream?token=${encodeURIComponent(token)}`);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toMatch(/text\/event-stream/);
    expect(sse.body).toContain('event: pending:orders');

    const snapshotMatch = sse.body.match(/event: pending:orders\ndata: ({.+?})\n\n/);
    expect(snapshotMatch).toBeTruthy();
    const snapshot = JSON.parse(snapshotMatch[1]);
    expect(snapshot.orders).toBeInstanceOf(Array);
    expect(snapshot.orders.length).toBe(1);
    expect(snapshot.orders[0].id).toBe(orderRes.body.id);
    expect(snapshot.orders[0].expires_at).toBeDefined();
  });

  it('SSE tick updates after order expires', async () => {
    const db = getDb();
    const orderRes = await request(app)
      .post('/billing/recharge')
      .set('Authorization', `Bearer ${token}`)
      .send({ workspace_id: workspaceId, amount: 50, channel: 'alipay' });
    expect(orderRes.status).toBe(201);

    await db.run(
      `UPDATE payment_orders SET expires_at = ? WHERE id = ?`,
      [new Date(Date.now() - 1000).toISOString(), orderRes.body.id]
    );

    const sse = await fetchSSE(`/billing/orders/pending-stream?token=${encodeURIComponent(token)}`, { stopAfterMs: 1500 });
    expect(sse.status).toBe(200);
    expect(sse.body).toContain('event: pending:tick');

    const events = [];
    const blocks = sse.body.split('\n\n');
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;
      const event = lines[0].replace('event: ', '');
      const data = lines.slice(1).join('\n').replace('data: ', '');
      try { events.push({ event, data: JSON.parse(data) }); } catch { /* ignore */ }
    }

    const lastTick = events.filter(e => e.event === 'pending:tick').pop();
    expect(lastTick).toBeDefined();
    expect(lastTick.data.orders.some(o => o.id === orderRes.body.id)).toBe(false);
  });

  it('GET /orders returns expires_at for pending orders', async () => {
    const orderRes = await request(app)
      .post('/billing/recharge')
      .set('Authorization', `Bearer ${token}`)
      .send({ workspace_id: workspaceId, amount: 55, channel: 'alipay' });
    expect(orderRes.status).toBe(201);

    const listRes = await request(app)
      .get('/billing/orders?status=pending')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    const order = listRes.body.orders.find(o => o.id === orderRes.body.id);
    expect(order).toBeDefined();
    expect(order.expires_at).toBeDefined();
    const expiresAt = new Date(order.expires_at).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});
