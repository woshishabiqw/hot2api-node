const request = require('supertest');
const express = require('express');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  createTestUser,
  generateToken,
  cleanDatabase,
} = require('./utils');

function createPaymentGatewayApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const { authMiddleware } = require('../src/middleware/auth');
  app.use('/payment-gateway', authMiddleware, require('../src/routes/payment-gateway'));
  app.use((err, req, res, next) => {
    const message = process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';
    res.status(500).json({ error: { message, type: 'internal_error' } });
  });
  return app;
}

describe('PaymentGateway API', () => {
  let app;
  let adminUser;
  let adminToken;
  let normalUser;
  let normalToken;

  beforeAll(async () => {
    await initTestDatabase();
    app = createPaymentGatewayApp();
    adminUser = await createTestUser('pgadmin', 'pgadminpass', 'admin');
    adminToken = generateToken(adminUser);
    normalUser = await createTestUser('pguser', 'pguserpass', 'user');
    normalToken = generateToken(normalUser);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('POST /payment-gateway/payment-channels', () => {
    it('管理员创建支付宝通道并启用二维码支付', async () => {
      const res = await request(app)
        .post('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Alipay Sandbox QR',
          type: 'alipay',
          env: 'sandbox',
          priority: 10,
          config: {
            appId: '9021000162614057',
            alipayPublicKey: 'sandbox-public-key',
            privateKey: 'sandbox-private-key',
            gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
          },
          use_qrcode: true,
          qr_expire_seconds: 900,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();

      const list = await request(app)
        .get('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(list.status).toBe(200);
      const ch = list.body.find((c) => c.id === res.body.id);
      expect(ch).toBeDefined();
      expect(ch.use_qrcode).toBe(true);
      expect(ch.qr_expire_seconds).toBe(900);
      expect(ch.config.appId).toBe('9021000162614057');
    });

    it('普通用户无法创建支付通道', async () => {
      const res = await request(app)
        .post('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${normalToken}`)
        .send({
          name: 'User Alipay',
          type: 'alipay',
          env: 'sandbox',
          priority: 0,
          config: {},
        });

      expect(res.status).toBe(403);
    });

    it('创建通道时 use_qrcode 默认 false', async () => {
      const res = await request(app)
        .post('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Alipay Page',
          type: 'alipay',
          env: 'production',
          priority: 5,
          config: {},
        });

      expect(res.status).toBe(201);

      const list = await request(app)
        .get('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`);

      const ch = list.body.find((c) => c.id === res.body.id);
      expect(ch.use_qrcode).toBe(false);
      expect(ch.qr_expire_seconds).toBe(600);
    });
  });

  describe('PUT /payment-gateway/payment-channels/:id', () => {
    it('管理员更新二维码开关和过期时间', async () => {
      const create = await request(app)
        .post('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Update QR',
          type: 'alipay',
          env: 'sandbox',
          priority: 0,
          config: {},
        });

      const update = await request(app)
        .put(`/payment-gateway/payment-channels/${create.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          use_qrcode: true,
          qr_expire_seconds: 1200,
        });

      expect(update.status).toBe(200);
      expect(update.body.success).toBe(true);

      const list = await request(app)
        .get('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`);

      const ch = list.body.find((c) => c.id === create.body.id);
      expect(ch.use_qrcode).toBe(true);
      expect(ch.qr_expire_seconds).toBe(1200);
    });

    it('非法的 qr_expire_seconds 回退为默认值', async () => {
      const create = await request(app)
        .post('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Bad Expire',
          type: 'alipay',
          env: 'sandbox',
          priority: 0,
          config: {},
        });

      await request(app)
        .put(`/payment-gateway/payment-channels/${create.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ qr_expire_seconds: -10 });

      const list = await request(app)
        .get('/payment-gateway/payment-channels')
        .set('Authorization', `Bearer ${adminToken}`);

      const ch = list.body.find((c) => c.id === create.body.id);
      expect(ch.qr_expire_seconds).toBe(600);
    });
  });
});
