process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes!!';
process.env.REDIS_URL = '';

const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestUser,
  cleanDatabase,
  getDb,
} = require('./utils');

describe('Proxy balance deduction', () => {
  let user;
  let workspaceId;
  let statsBuffer;
  let addQuotaCalls;
  let originalAddQuota;

  beforeAll(async () => {
    await initTestDatabase();
    const db = getDb();

    user = await createTestUser('proxyuser', 'proxypass', 'user');

    const wsResult = await db.run(
      `INSERT INTO workspaces (name, slug, owner_id, balance) VALUES (?, ?, ?, ?)`,
      ['Proxy WS', 'proxy-ws-slug', user.id, 100]
    );
    workspaceId = wsResult.lastInsertRowid;

    await db.run(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`,
      [workspaceId, user.id]
    );

    await db.run(`UPDATE users SET balance = ? WHERE id = ?`, [100, user.id]);

    statsBuffer = require('../src/services/stats-buffer');
    originalAddQuota = statsBuffer.addQuota.bind(statsBuffer);
    addQuotaCalls = [];
    statsBuffer.addQuota = jest.fn((table, id, fields) => {
      addQuotaCalls.push({ table, id, fields });
    });
  });

  afterAll(async () => {
    if (statsBuffer && originalAddQuota) {
      statsBuffer.addQuota = originalAddQuota;
    }
    await cleanDatabase();
  });

  it('workspace API key request only deducts workspace balance, not user balance', async () => {
    const ProxyBase = require('../src/services/proxy-base');
    const proxy = new ProxyBase();

    // Simulate a completed request from a workspace-bound key
    await proxy._doLogRequest({
      userId: user.id,
      userKeyId: 1,
      sourceId: 1,
      model: 'gpt-4',
      protocol: 'openai',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      statusCode: 200,
      latencyMs: 100,
      workspaceId: workspaceId,
      userCurrency: 'CNY',
      keyCurrency: 'CNY',
    });

    const workspaceQuotaCalls = addQuotaCalls.filter(c => c.table === 'workspaces' && c.id === workspaceId);
    const userQuotaCalls = addQuotaCalls.filter(c => c.table === 'users' && c.id === user.id);

    expect(workspaceQuotaCalls.length).toBeGreaterThanOrEqual(1);
    const wsBalanceDelta = workspaceQuotaCalls.reduce((sum, c) => sum + (c.fields.balance || 0), 0);
    expect(wsBalanceDelta).toBeLessThan(0);

    // Users table should only receive dashboard stats (total_*/requests), never balance/quota_used deductions
    const userBalanceDelta = userQuotaCalls.reduce((sum, c) => sum + (c.fields.balance || 0), 0);
    const userQuotaDelta = userQuotaCalls.reduce((sum, c) => sum + (c.fields.quota_used || 0), 0);
    expect(userBalanceDelta).toBe(0);
    expect(userQuotaDelta).toBe(0);

    // Dashboard stats should still be recorded
    const userStatCalls = userQuotaCalls.filter(c => c.fields.total_requests || c.fields.total_tokens || c.fields.total_cost);
    expect(userStatCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('personal API key request only deducts user balance', async () => {
    addQuotaCalls.length = 0;
    const ProxyBase = require('../src/services/proxy-base');
    const proxy = new ProxyBase();

    await proxy._doLogRequest({
      userId: user.id,
      userKeyId: 2,
      sourceId: 1,
      model: 'gpt-4',
      protocol: 'openai',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      statusCode: 200,
      latencyMs: 100,
      // no workspaceId -> personal key
      userCurrency: 'CNY',
      keyCurrency: 'CNY',
    });

    const workspaceQuotaCalls = addQuotaCalls.filter(c => c.table === 'workspaces');
    const userQuotaCalls = addQuotaCalls.filter(c => c.table === 'users' && c.id === user.id);

    expect(workspaceQuotaCalls.length).toBe(0);

    const userBalanceDelta = userQuotaCalls.reduce((sum, c) => sum + (c.fields.balance || 0), 0);
    const userQuotaDelta = userQuotaCalls.reduce((sum, c) => sum + (c.fields.quota_used || 0), 0);
    expect(userBalanceDelta).toBeLessThan(0);
    expect(userQuotaDelta).toBeGreaterThan(0);
  });
});
