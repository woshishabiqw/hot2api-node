const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { createAdminRateLimit } = require('../src/middleware/admin-rate-limit');

describe('Admin critical endpoint rate limiter', () => {
  let middleware;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // The middleware bypasses itself in NODE_ENV=test; use development for these tests.
    process.env.NODE_ENV = 'development';
    middleware = createAdminRateLimit({ perUser: 2, perIp: 3, windowMs: 60000 });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  function makeReq(userId, ip = '127.0.0.1') {
    return {
      user: userId ? { id: userId } : undefined,
      ip,
      connection: { remoteAddress: ip },
    };
  }

  async function call(ip, userId) {
    const req = makeReq(userId, ip);
    const result = { status: null, body: null, called: false };
    const res = {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    };
    await middleware(req, res, () => { result.called = true; });
    return result;
  }

  it('允许未超限请求通过', async () => {
    const r1 = await call('127.0.0.1', 1);
    expect(r1.called).toBe(true);
    const r2 = await call('127.0.0.1', 1);
    expect(r2.called).toBe(true);
  });

  it('同一用户超过 perUser 限制返回 429', async () => {
    await call('127.0.0.1', 1);
    await call('127.0.0.1', 1);
    const r3 = await call('127.0.0.1', 1);
    expect(r3.called).toBe(false);
    expect(r3.status).toBe(429);
  });

  it('同一 IP 超过 perIp 限制返回 429', async () => {
    await call('127.0.0.1', 1);
    await call('127.0.0.1', 2);
    await call('127.0.0.1', 3);
    const r4 = await call('127.0.0.1', 4);
    expect(r4.status).toBe(429);
  });
});
