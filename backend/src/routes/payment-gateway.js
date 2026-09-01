/**
 * @swagger
 * tags:
 *   name: PaymentGateway
 *   description: Payment channel configuration management
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const audit = require('../services/audit');
const { adminMiddleware } = require('../middleware/auth');

/**
 * @swagger
 * /admin/payment-channels:
 *   get:
 *     summary: List all payment channels
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of payment channels
 */
router.get('/payment-channels', async (req, res) => {
  const channels = await db.all('SELECT * FROM payment_channels ORDER BY priority DESC, created_at DESC');
  const isAdmin = req.user?.role === 'admin';
  res.json(channels.map(c => {
    const base = {
      id: c.id,
      name: c.name,
      type: c.type,
      env: c.env,
      priority: c.priority,
      is_active: c.is_active,
      is_primary: c.is_primary,
      use_qrcode: c.use_qrcode,
      qr_expire_seconds: c.qr_expire_seconds,
      created_at: c.created_at,
    };
    if (isAdmin) {
      base.config = JSON.parse(c.config || '{}');
    }
    return base;
  }));
});

/**
 * @swagger
 * /admin/payment-channels/meta:
 *   get:
 *     summary: Get payment channel metadata (types, envs)
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Channel metadata
 */
router.get('/payment-channels/meta', async (req, res) => {
  // Get unique types and envs from existing channels
  const types = await db.all('SELECT DISTINCT type FROM payment_channels');
  const envs = await db.all('SELECT DISTINCT env FROM payment_channels');
  
  // Default types and envs if none exist
  const typeList = types.length > 0 ? types.map(t => t.type) : ['alipay', 'wechat', 'stripe'];
  const envList = envs.length > 0 ? envs.map(e => e.env) : ['production', 'sandbox'];
  
  res.json({
    types: typeList,
    envs: envList
  });
});

/**
 * @swagger
 * /admin/payment-channels:
 *   post:
 *     summary: Create a payment channel
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               type: { type: string }
 *               config: { type: object }
 *               env: { type: string }
 *               priority: { type: number }
 */
router.post('/payment-channels', adminMiddleware, async (req, res) => {
  const { name, type, config, env, priority } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!['alipay', 'wechat', 'stripe'].includes(type)) {
    return res.status(400).json({ error: 'type must be alipay, wechat or stripe' });
  }

  const configStr = JSON.stringify(config || {});
  const useQrcode = req.body.use_qrcode === true || req.body.use_qrcode === 'true' || req.body.use_qrcode === 1;
  const qrExpireSeconds = parseInt(req.body.qr_expire_seconds, 10);
  const result = await db.run(
    `INSERT INTO payment_channels (name, type, config, env, priority, use_qrcode, qr_expire_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, type, configStr, env || 'production', priority || 0, useQrcode, Number.isFinite(qrExpireSeconds) && qrExpireSeconds > 0 ? qrExpireSeconds : 600]
  );

  res.status(201).json({ id: result.lastInsertRowid, name, type });
});

/**
 * @swagger
 * /admin/payment-channels/{id}:
 *   put:
 *     summary: Update a payment channel
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 */
router.put('/payment-channels/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, type, config, env, is_active, is_primary, priority, use_qrcode, qr_expire_seconds } = req.body;

  const fields = [];
  const params = [];

  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (type !== undefined) { fields.push('type = ?'); params.push(type); }
  if (config !== undefined) { fields.push('config = ?'); params.push(JSON.stringify(config)); }
  if (env !== undefined) { fields.push('env = ?'); params.push(env); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active ? true : false); }
  if (is_primary !== undefined) { fields.push('is_primary = ?'); params.push(is_primary ? true : false); }
  if (priority !== undefined) { fields.push('priority = ?'); params.push(priority); }
  if (use_qrcode !== undefined) { fields.push('use_qrcode = ?'); params.push(use_qrcode ? true : false); }
  if (qr_expire_seconds !== undefined) {
    const secs = parseInt(qr_expire_seconds, 10);
    fields.push('qr_expire_seconds = ?');
    params.push(Number.isFinite(secs) && secs > 0 ? secs : 600);
  }

  if (fields.length === 0) return res.json({ success: true, no_changes: true });

  params.push(parseInt(id));
  await db.run(`UPDATE payment_channels SET ${fields.join(', ')} WHERE id = ?`, params);

  res.json({ success: true });
});

/**
 * @swagger
 * /admin/payment-channels/{id}:
 *   delete:
 *     summary: Delete a payment channel
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/payment-channels/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  await db.run('DELETE FROM payment_channels WHERE id = ?', [parseInt(id)]);
  res.json({ success: true });
});

/**
 * @swagger
 * /admin/payment-channels/{id}/test:
 *   post:
 *     summary: Test a payment channel connection
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 */
router.post('/payment-channels/:id/test', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const channel = await db.get('SELECT * FROM payment_channels WHERE id = ?', [parseInt(id)]);

  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const config = JSON.parse(channel.config || '{}');

  if (channel.type === 'alipay') {
    if (!config.appId) {
      return res.json({ success: false, message: 'Alipay appId not configured in channel' });
    }
    return res.json({ success: true, message: 'Alipay configuration looks valid', env: channel.env });
  }

  if (channel.type === 'wechat') {
    if (!config.mchid) {
      return res.json({ success: false, message: 'WeChat mchid not configured in channel' });
    }
    return res.json({ success: true, message: 'WeChat Pay configuration looks valid', env: channel.env });
  }

  res.json({ success: false, message: 'Unknown channel type' });
});

/**
 * @swagger
 * /admin/payment-channels/{id}/toggle:
 *   post:
 *     summary: Toggle active state
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 */
router.post('/payment-channels/:id/toggle', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const channel = await db.get('SELECT is_active FROM payment_channels WHERE id = ?', [parseInt(id)]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const next = !channel.is_active;
  await db.run('UPDATE payment_channels SET is_active = ? WHERE id = ?', [next, parseInt(id)]);
  res.json({ success: true, is_active: next });
});

/**
 * @swagger
 * /admin/payment-channels/{id}/set-primary:
 *   post:
 *     summary: Set as primary channel for its type
 *     tags: [PaymentGateway]
 *     security:
 *       - bearerAuth: []
 */
router.post('/payment-channels/:id/set-primary', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const channel = await db.get('SELECT type FROM payment_channels WHERE id = ?', [parseInt(id)]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  // Clear primary for same type
  await db.run('UPDATE payment_channels SET is_primary = false WHERE type = ?', [channel.type]);
  // Set this as primary
  await db.run('UPDATE payment_channels SET is_primary = true WHERE id = ?', [parseInt(id)]);

  res.json({ success: true });
});

module.exports = router;
