/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: Billing and payment APIs
 */
const express = require('express');
const router = express.Router();
const callbackRouter = express.Router();
const db = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const crypto = require('crypto');
const alipay = require('../services/alipay');
const { normalizeBalance } = require('../utils/balance');
const stripeService = require('../services/stripe');
const QRCode = require('qrcode');
const config = require('../config/settings');
const invoiceService = require('../services/invoice');
const audit = require('../services/audit');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const requireSecondAuthForMutations = require('../middleware/require-second-auth');

// Log billing operations
async function logBilling(action, data) {
  try {
    await db.run(
      `INSERT INTO billing_logs (action, data, created_at) VALUES (?, ?, datetime('now'))`,
      [action, JSON.stringify(data)]
    );
  } catch (e) {
    console.error('[Billing] Log failed:', e.message);
  }
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes';
  return !!v;
}

// Pending recharge order timeout and per-target limit (must match invoiceService)
const ORDER_TIMEOUT_MINUTES = 30;
const ORDER_TIMEOUT_MINUTES_QR = 10;

// Emitter for order lifecycle events (used by SSE and other real-time features)
const billingEmitter = new EventEmitter();

router.use(authMiddleware);

// 二级密码仅对财务管理 /billing/admin 下的写操作生效
router.use('/admin', requireSecondAuthForMutations);

// Stripe webhook needs raw body before urlencoded parser
const stripeWebhookRouter = express.Router();
stripeWebhookRouter.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const channel = await db.get(
    `SELECT * FROM payment_channels WHERE type = 'stripe' AND is_active = true ORDER BY priority DESC, id ASC LIMIT 1`
  );
  const stripeConfig = channel ? JSON.parse(channel.config || '{}') : null;
  const webhookSecret = stripeConfig?.webhookSecret;

  let event;
  if (webhookSecret) {
    // Production / properly configured: verify Stripe signature.
    try {
      event = stripeService.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('[billing] Stripe webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // Development fallback: no webhook secret configured, accept event without signature verification.
    // This is safe locally because the success_url callback already fulfills orders synchronously.
    try {
      if (Buffer.isBuffer(req.body)) {
        event = JSON.parse(req.body.toString());
      } else if (typeof req.body === 'string') {
        event = JSON.parse(req.body);
      } else if (req.body && typeof req.body === 'object') {
        event = req.body;
      } else {
        throw new Error('Unexpected webhook body');
      }
      console.warn('[billing] Stripe webhook accepted without signature verification (webhookSecret not configured). Use only in development.');
    } catch (err) {
      console.error('[billing] Stripe webhook JSON parse failed:', err.message);
      return res.status(400).send('Invalid JSON');
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const tradeNo = session.client_reference_id || session.metadata?.trade_no;
    if (tradeNo) {
      await fulfillOrder(tradeNo);
      await logBilling('stripe_webhook_fulfilled', { trade_no: tradeNo, session_id: session.id });
    }
  }

  res.json({ received: true });
});

// Parse Alipay async notify form data (only for callback routes)
callbackRouter.use(express.urlencoded({ extended: true }));

// ========== Helpers ==========

function resolveOrderTarget(order, opts = {}) {
  let metaTarget = null;
  try {
    const parsed = JSON.parse(order.metadata || '{}');
    metaTarget = parsed.target;
  } catch { /* ignore */ }
  const defaultTarget = order.workspace_id ? 'workspace' : 'account';
  return ['workspace', 'account'].includes(opts.target)
    ? opts.target
    : (['workspace', 'account'].includes(metaTarget) ? metaTarget : defaultTarget);
}

async function fulfillOrder(tradeNo, opts = {}) {
  const order = await db.get('SELECT * FROM payment_orders WHERE trade_no = ?', [tradeNo]);
  if (!order) {
    await logBilling('fulfill_order_failed', { tradeNo, reason: 'not_found' });
    return { success: false, error: '订单不存在' };
  }

  // Resolve target: explicit opts > order metadata > default based on workspace_id presence
  const target = resolveOrderTarget(order, opts);
  const updateWorkspace = target === 'workspace';
  const updateAccount = target === 'account';

  if (order.status === 'paid') {
    const workspace = await db.get('SELECT balance FROM workspaces WHERE id = ?', [order.workspace_id]);
    const user = await db.get('SELECT balance FROM users WHERE id = ?', [order.user_id]);
    await logBilling('fulfill_order_duplicate', { tradeNo, order_id: order.id });
    return { success: true, message: 'Already paid', balance: workspace?.balance || 0, userBalance: user?.balance || 0 };
  }

  // Update order status
  await db.run(
    `UPDATE payment_orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?`,
    [order.id]
  );

  // Update workspace balance
  let newBalance = 0;
  const creditAmount = order.original_amount || order.amount;
  if (updateWorkspace) {
    const workspace = await db.get('SELECT balance FROM workspaces WHERE id = ?', [order.workspace_id]);
    newBalance = normalizeBalance((workspace?.balance || 0) + creditAmount);
    await db.run(`UPDATE workspaces SET balance = ? WHERE id = ?`, [newBalance, order.workspace_id]);
  } else if (order.workspace_id) {
    const workspace = await db.get('SELECT balance FROM workspaces WHERE id = ?', [order.workspace_id]);
    newBalance = workspace?.balance || 0;
  }

  // Update per-account balance (independent of workspace balance)
  let newUserBalance = 0;
  if (updateAccount) {
    const user = await db.get('SELECT balance FROM users WHERE id = ?', [order.user_id]);
    newUserBalance = normalizeBalance((user?.balance || 0) + creditAmount);
    await db.run(`UPDATE users SET balance = ? WHERE id = ?`, [newUserBalance, order.user_id]);
  } else {
    const user = await db.get('SELECT balance FROM users WHERE id = ?', [order.user_id]);
    newUserBalance = user?.balance || 0;
  }

  // Create billing record
  await db.run(
    `INSERT INTO billing_records (workspace_id, user_id, type, amount, balance_after, user_balance_after, description, metadata)
     VALUES (?, ?, 'recharge', ?, ?, ?, ?, ?)`,
    [
      order.workspace_id || null,
      order.user_id,
      order.amount,
      newBalance,
      newUserBalance,
      `${order.channel} recharge`,
      JSON.stringify({ order_id: order.id, trade_no: order.trade_no, target }),
    ]
  );

  await logBilling('fulfill_order_success', { tradeNo, order_id: order.id, amount: order.amount, original_amount: order.original_amount, discount_amount: order.discount_amount, coupon_id: order.coupon_id, newBalance, newUserBalance, target });

  // Log admin增值 when this is an admin quick recharge
  if (opts.isAdminRecharge) {
    await logBilling('admin_recharge', { tradeNo, order_id: order.id, amount: order.amount, original_amount: order.original_amount, discount_amount: order.discount_amount, coupon_id: order.coupon_id, workspace_id: order.workspace_id, user_id: order.user_id, newBalance, newUserBalance, target });
  }

  // Note: invoices are no longer auto-created on recharge; users/admins must request them explicitly.
  return { success: true, balance: newBalance, userBalance: newUserBalance };
}

// ========== Routes ==========

// Get billing plans
/**
 * @swagger
 * /billing/plans:
 *   get:
 *     summary: List billing plans
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of billing plans
 */
router.get('/plans', async (req, res) => {
  const plans = await db.all('SELECT * FROM billing_plans WHERE is_active = true ORDER BY price_monthly');
  res.json(plans);
});

// Create recharge order
/**
 * @swagger
 * /billing/recharge:
 *   post:
 *     summary: Create recharge order
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount: { type: number }
 *               channel: { type: string }
 *     responses:
 *       200:
 *         description: Order created
 */
// Helper: find active channel config for a given type
async function findChannelConfig(channelType) {
  // Prefer primary active config
  let config = await db.get(
    `SELECT * FROM payment_channels WHERE type = ? AND is_active = true AND is_primary = true ORDER BY priority DESC LIMIT 1`,
    [channelType]
  );
  if (config) return config;

  // Fallback to highest priority active config
  config = await db.get(
    `SELECT * FROM payment_channels WHERE type = ? AND is_active = true ORDER BY priority DESC, id ASC LIMIT 1`,
    [channelType]
  );
  return config;
}

// ========== Coupon helpers ==========

async function validateUserCoupon(userCouponId, userId, originalAmount) {
  if (!userCouponId) return { valid: true, discount: 0, payable: originalAmount, userCoupon: null, coupon: null };

  const userCoupon = await db.get(
    `SELECT uc.*, c.* FROM user_coupons uc
     JOIN coupons c ON c.id = uc.coupon_id
     WHERE uc.id = ? AND uc.user_id = ?`,
    [userCouponId, userId]
  );
  if (!userCoupon) return { valid: false, error: '优惠券不存在' };
  if (userCoupon.status !== 'unused') return { valid: false, error: '优惠券已被使用或不可用' };
  if (!userCoupon.is_active || userCoupon.is_active === 0 || userCoupon.is_active === 'false') return { valid: false, error: '优惠券已停用' };

  const now = new Date();
  if (userCoupon.valid_start && new Date(userCoupon.valid_start) > now) return { valid: false, error: '优惠券未生效' };
  if (userCoupon.valid_end && new Date(userCoupon.valid_end) < now) return { valid: false, error: '优惠券已过期' };
  if (userCoupon.expires_at && new Date(userCoupon.expires_at) < now) return { valid: false, error: '优惠券已过期' };

  const maxUses = parseInt(userCoupon.max_uses) || 0;
  if (maxUses > 0 && (userCoupon.used_count || 0) >= maxUses) return { valid: false, error: '优惠券已达使用上限' };

  const threshold = parseFloat(userCoupon.threshold) || 0;
  if (originalAmount < threshold) return { valid: false, error: `订单金额未满 ¥${threshold.toFixed(2)}，无法使用该优惠券` };

  let discount = 0;
  const type = userCoupon.type || 'threshold_fixed';
  if (type === 'threshold_fixed') {
    discount = Math.min(parseFloat(userCoupon.discount_amount) || 0, originalAmount);
  } else if (type === 'percentage') {
    discount = originalAmount * (parseFloat(userCoupon.discount_rate) || 0);
  }
  discount = Math.round(discount * 100) / 100;
  const payable = Math.max(0, Math.round((originalAmount - discount) * 100) / 100);

  return { valid: true, discount, payable, userCoupon, coupon: userCoupon };
}

async function applyCoupon(userCouponId, orderId) {
  if (!userCouponId) return;
  const now = new Date().toISOString();
  await db.run(
    `UPDATE user_coupons SET status = 'used', order_id = ?, used_at = ? WHERE id = ?`,
    [orderId, now, userCouponId]
  );
  await db.run(
    `UPDATE coupons SET used_count = used_count + 1 WHERE id = (SELECT coupon_id FROM user_coupons WHERE id = ?)`,
    [userCouponId]
  );
}

async function restoreCoupon(order) {
  if (!order || !order.coupon_id) return;
  const userCoupon = await db.get('SELECT * FROM user_coupons WHERE id = ?', [order.coupon_id]);
  if (!userCoupon) return;
  await db.run(
    `UPDATE user_coupons SET status = 'unused', order_id = NULL, used_at = NULL WHERE id = ?`,
    [order.coupon_id]
  );
  await db.run(
    `UPDATE coupons SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END WHERE id = ?`,
    [userCoupon.coupon_id]
  );
}

router.post('/recharge', async (req, res) => {
  const { workspace_id, amount: rawAmount, channel, return_url, target } = req.body;
  const rechargeTarget = ['workspace', 'account'].includes(target) ? target : 'workspace';

  // Workspace recharge requires a workspace; account recharge can be independent.
  if (rechargeTarget === 'workspace' && !workspace_id) {
    await logBilling('recharge_failed', { reason: 'invalid_workspace', body: req.body });
    return res.status(400).json({ error: 'Workspace 充值必须选择 Workspace' });
  }

  const parsedAmount = parseFloat(rawAmount);
  if (Number.isNaN(parsedAmount) || parsedAmount < 1 || parsedAmount > 1000) {
    await logBilling('recharge_failed', { reason: 'invalid_amount', body: req.body });
    return res.status(400).json({ error: '充值金额必须在 ¥1.00 ~ ¥1000.00 之间' });
  }
  const originalAmount = Math.round(parsedAmount * 100) / 100;
  if (Math.abs(originalAmount - parsedAmount) > 1e-9) {
    await logBilling('recharge_failed', { reason: 'invalid_decimal_places', body: req.body });
    return res.status(400).json({ error: '充值金额最多保留两位小数' });
  }

  if (!channel) {
    await logBilling('recharge_failed', { reason: 'no_channel', body: req.body });
    return res.status(400).json({ error: 'channel is required' });
  }

  // Validate workspace membership when a workspace is involved.
  if (workspace_id) {
    const membership = await db.get(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      [workspace_id, req.user.id]
    );
    if (!membership) {
      await logBilling('recharge_failed', { reason: 'no_permission', workspace_id, user_id: req.user.id });
      return res.status(403).json({ error: '没有该工作空间的访问权限' });
    }
  }

  // Validate coupon and compute payable amount
  const couponCheck = await validateUserCoupon(req.body.coupon_id, req.user.id, originalAmount);
  if (!couponCheck.valid) {
    await logBilling('recharge_failed', { reason: 'invalid_coupon', error: couponCheck.error, body: req.body });
    return res.status(400).json({ error: couponCheck.error });
  }
  const { discount, payable, userCoupon } = couponCheck;

  // Validate supported channels
  const supportedChannels = ['alipay', 'wechat', 'stripe'];
  if (!supportedChannels.includes(channel)) {
    await logBilling('recharge_failed', { reason: 'invalid_channel', channel, body: req.body });
    return res.status(400).json({ error: '不支持的支付渠道' });
  }

  // Enforce one pending order per target (workspace/account) per user.
  // This prevents users from stacking unlimited unpaid orders.
  let existingPending;
  if (workspace_id) {
    existingPending = await db.get(
      `SELECT * FROM payment_orders WHERE user_id = ? AND status = 'pending' AND workspace_id = ? LIMIT 1`,
      [req.user.id, workspace_id]
    );
  } else {
    existingPending = await db.get(
      `SELECT * FROM payment_orders WHERE user_id = ? AND status = 'pending' AND workspace_id IS NULL LIMIT 1`,
      [req.user.id]
    );
  }
  if (existingPending) {
    await logBilling('recharge_failed', { reason: 'pending_order_exists', existing_order_id: existingPending.id, target: rechargeTarget, body: req.body });
    return res.status(409).json({
      error: `${rechargeTarget === 'workspace' ? 'Workspace' : '账户'}已存在未支付订单，请先取消或等待过期后再创建新订单`,
      existing_order_id: existingPending.id,
      expires_at: existingPending.expires_at,
    });
  }

  // Find channel config (P0 redundancy: primary + fallback)
  const channelConfig = await findChannelConfig(channel);

  const tradeNo = `ORD${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const expiresAt = new Date(Date.now() + ORDER_TIMEOUT_MINUTES * 60 * 1000).toISOString();

  const result = await db.run(
    `INSERT INTO payment_orders (workspace_id, user_id, amount, original_amount, discount_amount, coupon_id, channel, channel_config_id, status, trade_no, description, metadata, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      workspace_id,
      req.user.id,
      payable,
      originalAmount,
      discount,
      userCoupon ? userCoupon.id : null,
      channel,
      channelConfig ? channelConfig.id : null,
      tradeNo,
      req.body.description || `${channel} recharge`,
      JSON.stringify({ payment_method: req.body.payment_method || 'default', return_url: req.body.return_url || '', target: rechargeTarget }),
      expiresAt
    ]
  );

  const orderId = result.lastInsertRowid;
  if (userCoupon) {
    await applyCoupon(userCoupon.id, orderId);
  }

  await logBilling('recharge_order_created', { order_id: orderId, tradeNo, original_amount: originalAmount, discount, amount: payable, channel, workspace_id, channel_config_id: channelConfig?.id, coupon_id: userCoupon?.id });

  // Use Stripe when configured
  if (channel === 'stripe') {
    const stripeConfig = channelConfig ? JSON.parse(channelConfig.config || '{}') : null;
    if (!stripeService.isConfigured(stripeConfig)) {
      await db.run(`UPDATE payment_orders SET status = 'failed' WHERE id = ?`, [result.lastInsertRowid]);
      await restoreCoupon({ coupon_id: userCoupon ? userCoupon.id : null });
      await logBilling('stripe_not_configured', { tradeNo, order_id: result.lastInsertRowid });
      return res.status(400).json({ error: 'Stripe 未配置或密钥无效' });
    }

    try {
      // Stripe callbacks must hit the API server, not the frontend static server.
      // Prefer the explicit API_BASE_URL env var; otherwise derive from the request host
      // (works behind reverse proxies that set X-Forwarded-* headers).
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const apiBaseUrl = process.env.API_BASE_URL || `${protocol}://${host}`;
      const successUrl = `${apiBaseUrl}/billing/stripe-callback?session_id={CHECKOUT_SESSION_ID}&return_url=${encodeURIComponent(return_url || '')}`;
      const cancelUrl = `${apiBaseUrl}/billing/stripe-callback?trade_no=${tradeNo}&status=cancel&return_url=${encodeURIComponent(return_url || '')}`;

      const session = await stripeService.createCheckoutSession(tradeNo, payable, successUrl, cancelUrl, stripeConfig);

      await logBilling('stripe_session_created', { tradeNo, amount: payable, original_amount: originalAmount, discount_amount: discount, session_id: session.sessionId });

      // Store Stripe session id in order metadata for callback lookup
      await db.run(
        `UPDATE payment_orders SET metadata = ? WHERE id = ?`,
        [JSON.stringify({ payment_method: req.body.payment_method || 'default', return_url: req.body.return_url || '', target: rechargeTarget, session_id: session.sessionId }), result.lastInsertRowid]
      );

      return res.status(201).json({
        id: result.lastInsertRowid,
        trade_no: tradeNo,
        amount: payable,
        original_amount: originalAmount,
        discount_amount: discount,
        channel,
        status: 'pending',
        expires_at: expiresAt,
        payment_url: session.url,
        paymentUrl: session.url,
        session_id: session.sessionId,
      });
    } catch (err) {
      const msg = err.message || '';
      const stripeCode = err.code || err.type || '';
      console.error('[billing] Stripe create session failed:', { code: stripeCode, message: msg, raw: err });
      await db.run(`UPDATE payment_orders SET status = 'failed' WHERE id = ?`, [result.lastInsertRowid]);
      await restoreCoupon({ coupon_id: userCoupon ? userCoupon.id : null });
      await logBilling('stripe_session_failed', { tradeNo, order_id: result.lastInsertRowid, error: msg, code: stripeCode });

      let userError = 'Stripe 支付创建失败，请检查密钥配置';
      if (msg.includes('must convert to at least') || (msg.includes('amount') && msg.includes('minimum'))) {
        userError = 'Stripe 最低充值金额不能低于 ¥3.50';
      } else if (msg.includes('Invalid API Key')) {
        userError = 'Stripe 密钥无效，请检查 Secret Key';
      } else if (msg.includes('currency') || msg.includes('Currency')) {
        userError = 'Stripe 不支持当前货币或账户未启用该货币';
      } else if (msg.includes('payment_method_type') || msg.includes('payment method type') || stripeCode === 'payment_method_not_available') {
        userError = 'Stripe 账户未启用该支付方式，请在渠道配置中调整 paymentMethodTypes（建议先用 ["card"]）';
      } else if (process.env.NODE_ENV !== 'production') {
        userError = `Stripe 错误: ${msg}`;
      }

      return res.status(400).json({ error: userError });
    }
  }

  // Use real Alipay when configured
  if (channel === 'alipay') {
    const alipayConfig = channelConfig ? JSON.parse(channelConfig.config || '{}') : null;
    if (alipay.isConfigured(alipayConfig)) {
      try {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const baseUrl = process.env.API_BASE_URL || `${protocol}://${host}`;
        const notifyUrl = alipayConfig.notifyUrl || `${baseUrl}/billing/notify`;
        const subject = rechargeTarget === 'account' ? '账户余额充值' : 'Workspace 余额充值';
        // 是否使用二维码由渠道配置决定（不再依赖前端 payment_method）
        const useQrcode = asBool(channelConfig?.use_qrcode);
        const qrExpireSeconds = Number(channelConfig?.qr_expire_seconds) || 600;

        await logBilling('alipay_order_created', {
          tradeNo,
          amount: payable,
          original_amount: originalAmount,
          discount_amount: discount,
          config_has_appid: !!alipayConfig.appId,
          use_qrcode: useQrcode
        });

        const baseReturnUrl = alipayConfig.returnUrl || `${baseUrl}/billing/pay-callback`;
        const separator = baseReturnUrl.includes('?') ? '&' : '?';
        const alipayReturnUrl = `${baseReturnUrl}${separator}return_url=${encodeURIComponent(return_url || '')}`;

        if (useQrcode) {
          // Face-to-face precreate -> QR code only
          // Do NOT create page-pay for the same out_trade_no; the two APIs conflict
          // and Alipay may report "订单不存在" when the user tries to pay.
          const { qrCode } = await alipay.createQrOrder(tradeNo, payable, subject, notifyUrl, alipayConfig);
          const qrDataUrl = await QRCode.toDataURL(qrCode, { width: 300, margin: 2 });
          // 防劫持安全令牌：仅持有 qr_token 的前端才能轮询该订单状态
          const qrToken = crypto.randomBytes(32).toString('hex');
          const qrExpireAt = new Date(Date.now() + qrExpireSeconds * 1000).toISOString();
          // QR orders expire sooner than page-pay orders.
          const qrOrderExpiresAt = new Date(Date.now() + ORDER_TIMEOUT_MINUTES_QR * 60 * 1000).toISOString();

          await db.run(
            `UPDATE payment_orders SET metadata = ?, expires_at = ? WHERE id = ?`,
            [JSON.stringify({
              payment_method: 'qrcode',
              return_url: return_url || '',
              target: rechargeTarget,
              qr_token: qrToken,
              qr_expire_at: qrExpireAt,
              qr_code: qrCode,
              use_qrcode: true
            }), qrOrderExpiresAt, result.lastInsertRowid]
          );

          return res.status(201).json({
            id: result.lastInsertRowid,
            trade_no: tradeNo,
            amount: payable,
            original_amount: originalAmount,
            discount_amount: discount,
            channel,
            status: 'pending',
            expires_at: qrOrderExpiresAt,
            use_qrcode: true,
            qr_code: qrCode,
            qr_data_url: qrDataUrl,
            qr_token: qrToken,
            qr_expire_at: qrExpireAt,
            // camelCase aliases for frontend convenience
            qrCode,
            qrDataUrl,
          });
        }

        // Page pay (browser redirect/form) fallback
        const paymentForm = await alipay.createOrder(tradeNo, payable, subject, alipayReturnUrl, notifyUrl, alipayConfig);
        await db.run(
          `UPDATE payment_orders SET metadata = ? WHERE id = ?`,
          [JSON.stringify({
            payment_method: 'page',
            return_url: return_url || '',
            target: rechargeTarget,
            use_qrcode: false
          }), result.lastInsertRowid]
        );

        return res.status(201).json({
          id: result.lastInsertRowid,
          trade_no: tradeNo,
          amount: payable,
          original_amount: originalAmount,
          discount_amount: discount,
          channel,
          status: 'pending',
          expires_at: expiresAt,
          use_qrcode: false,
          payment_form: paymentForm,
          form: paymentForm,
        });
      } catch (err) {
        console.error('[billing] Alipay create order failed:', err.message);
        await logBilling('alipay_order_failed', { tradeNo, error: err.message });
        await db.run(`UPDATE payment_orders SET status = 'failed' WHERE id = ?`, [result.lastInsertRowid]);
        await restoreCoupon({ coupon_id: userCoupon ? userCoupon.id : null });
        return res.status(400).json({ error: `支付宝订单创建失败: ${err.message}` });
      }
    }
    // If Alipay is not configured, fall through so test fallback can be used.
    // In production this will end at the final 400 below.
  }

  // Test-only fallback so the existing test suite can still verify balance update logic.
  // This route is NOT registered in production and must never be used for real payments.
  if (process.env.NODE_ENV === 'test') {
    const mockPaymentUrl = `/billing/pay-mock?order_id=${result.lastInsertRowid}&trade_no=${tradeNo}`;
    await logBilling('mock_payment_url', { tradeNo, mock_url: mockPaymentUrl });
    return res.status(201).json({
      id: result.lastInsertRowid,
      trade_no: tradeNo,
      amount: payable,
      original_amount: originalAmount,
      discount_amount: discount,
      channel,
      status: 'pending',
      expires_at: expiresAt,
      payment_url: mockPaymentUrl,
      paymentUrl: mockPaymentUrl,
    });
  }

  // No fallback: unsupported or unconfigured channels fail immediately
  await db.run(`UPDATE payment_orders SET status = 'failed' WHERE id = ?`, [result.lastInsertRowid]);
  await restoreCoupon({ coupon_id: userCoupon ? userCoupon.id : null });
  return res.status(400).json({ error: '支付渠道未配置或创建订单失败' });
});

// Alipay sync callback (return_url)
callbackRouter.get('/pay-callback', async (req, res) => {
  const signData = req.query;

  // Diagnostic logging: record every incoming sync callback.
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '..', '..', 'logs', 'alipay-notify.log');
  const logEntry = JSON.stringify({
    time: new Date().toISOString(),
    source: 'pay-callback',
    ip: req.ip,
    'x-forwarded-for': req.headers['x-forwarded-for'],
    'user-agent': req.headers['user-agent'],
    trade_no: signData?.out_trade_no,
    trade_status: signData?.trade_status,
    query_keys: Object.keys(signData || {}),
  }) + '\n';
  fs.appendFileSync(logPath, logEntry);

  // Load order to get channel config
  const tradeNo = signData.out_trade_no;
  const order = tradeNo ? await db.get('SELECT channel_config_id FROM payment_orders WHERE trade_no = ?', [tradeNo]) : null;
  let alipayConfig = null;
  let configSource = 'none';
  if (order && order.channel_config_id) {
    const ch = await db.get('SELECT config FROM payment_channels WHERE id = ?', [order.channel_config_id]);
    if (ch) {
      alipayConfig = JSON.parse(ch.config || '{}');
      configSource = `order_channel_${order.channel_config_id}`;
    }
  }
  if (!alipayConfig && tradeNo) {
    const primary = await db.get("SELECT config FROM payment_channels WHERE type = 'alipay' AND is_primary = true LIMIT 1");
    if (primary) {
      alipayConfig = JSON.parse(primary.config || '{}');
      configSource = 'primary_channel';
    }
  }

  let isValid = false;
  let verifyError = null;
  try {
    isValid = alipay.verifyNotify(signData, alipayConfig);
  } catch (err) {
    verifyError = err.message;
  }

  const verifyLogEntry = JSON.stringify({
    time: new Date().toISOString(),
    source: 'pay-callback_verify',
    trade_no: tradeNo,
    order_found: !!order,
    config_source: configSource,
    has_alipay_public_key: !!(alipayConfig && alipayConfig.alipayPublicKey),
    sign_type: signData?.sign_type,
    is_valid: isValid,
    verify_error: verifyError,
  }) + '\n';
  fs.appendFileSync(logPath, verifyLogEntry);

  if (!isValid) {
    console.error('[billing] Alipay callback sign verification failed', { tradeNo, configSource, verifyError });
    const redirectUrl = decodeURIComponent(req.query.return_url || '') || '/';
    return res.redirect(`${redirectUrl}?payment=failed&reason=invalid_sign`);
  }

  if (!tradeNo) {
    const redirectUrl = decodeURIComponent(req.query.return_url || '') || '/';
    return res.redirect(`${redirectUrl}?payment=failed&reason=no_trade_no`);
  }

  const result = await fulfillOrder(tradeNo);
  const redirectUrl = decodeURIComponent(req.query.return_url || '') || '/';

  if (result.success) {
    return res.redirect(`${redirectUrl}?payment=success`);
  } else {
    return res.redirect(`${redirectUrl}?payment=failed&reason=${encodeURIComponent(result.error || 'unknown')}`);
  }
});

// Test-only mock payment callback (NOT registered in production)
if (process.env.NODE_ENV === 'test') {
  callbackRouter.get('/pay-mock', async (req, res) => {
    const { order_id, trade_no } = req.query;

    const order = await db.get('SELECT * FROM payment_orders WHERE id = ? AND trade_no = ?', [parseInt(order_id), trade_no]);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const result = await fulfillOrder(trade_no);
    if (result.success) {
      res.json({
        success: true,
        message: result.message || 'Payment successful',
        balance: result.balance,
        userBalance: result.userBalance,
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  });
}

// Stripe sync callback (return_url)
// Stripe docs: use {CHECKOUT_SESSION_ID} in success_url, then retrieve the Session
// and check payment_status before fulfilling the order.
callbackRouter.get('/stripe-callback', async (req, res) => {
  const { session_id, trade_no, status, return_url } = req.query;
  const redirectUrl = decodeURIComponent(return_url || '') || '/';

  // Cancel URL branch
  if (status === 'cancel' || !session_id) {
    return res.redirect(`${redirectUrl}?payment=failed&reason=cancelled${trade_no ? `&trade_no=${trade_no}` : ''}`);
  }

  // Retrieve Checkout Session from Stripe.
  // success_url only contains session_id, so we use the first active Stripe channel
  // config to retrieve the session, then read trade_no from its metadata.
  const fallbackChannel = await db.get(
    `SELECT config FROM payment_channels WHERE type = 'stripe' AND is_active = true ORDER BY priority DESC, id ASC LIMIT 1`
  );
  let stripeConfig = fallbackChannel ? JSON.parse(fallbackChannel.config || '{}') : null;

  if (!stripeConfig || !stripeConfig.secretKey) {
    console.error('[billing] Stripe callback: missing active stripe config');
    return res.redirect(`${redirectUrl}?payment=failed&reason=stripe_config_missing${trade_no ? `&trade_no=${trade_no}` : ''}`);
  }

  let session;
  try {
    session = await stripeService.retrieveSession(session_id, stripeConfig);
  } catch (err) {
    console.error('[billing] Stripe retrieve session failed:', err.message);
    return res.redirect(`${redirectUrl}?payment=failed&reason=session_retrieve_failed${trade_no ? `&trade_no=${trade_no}` : ''}`);
  }

  const sessionTradeNo = session.client_reference_id || session.metadata?.trade_no;
  const confirmedTradeNo = trade_no || sessionTradeNo;

  if (!confirmedTradeNo) {
    return res.redirect(`${redirectUrl}?payment=failed&reason=no_trade_no`);
  }

  // Verify the order exists and matches the session
  const confirmedOrder = await db.get('SELECT * FROM payment_orders WHERE trade_no = ?', [confirmedTradeNo]);
  if (!confirmedOrder) {
    return res.redirect(`${redirectUrl}?payment=failed&reason=order_not_found&trade_no=${confirmedTradeNo}`);
  }
  if (confirmedOrder.status === 'paid') {
    return res.redirect(`${redirectUrl}?payment=success&trade_no=${confirmedTradeNo}`);
  }
  if (confirmedOrder.status !== 'pending') {
    return res.redirect(`${redirectUrl}?payment=failed&reason=order_not_pending&trade_no=${confirmedTradeNo}`);
  }

  // Only fulfill when Stripe confirms payment
  if (session.payment_status === 'paid') {
    const result = await fulfillOrder(confirmedTradeNo);
    if (result.success) {
      return res.redirect(`${redirectUrl}?payment=success&trade_no=${confirmedTradeNo}`);
    }
    return res.redirect(`${redirectUrl}?payment=failed&reason=${encodeURIComponent(result.error || 'unknown')}&trade_no=${confirmedTradeNo}`);
  }

  // Payment not completed / still processing
  return res.redirect(`${redirectUrl}?payment=failed&reason=payment_not_paid&trade_no=${confirmedTradeNo}`);
});

// Alipay async notification (notify_url)
callbackRouter.post('/notify', async (req, res) => {
  const signData = req.body;

  // Diagnostic logging: record every incoming notify so we can see whether
  // Alipay reached us and what payload it sent.
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '..', '..', 'logs', 'alipay-notify.log');
  const logEntry = JSON.stringify({
    time: new Date().toISOString(),
    source: 'notify',
    ip: req.ip,
    'x-forwarded-for': req.headers['x-forwarded-for'],
    'user-agent': req.headers['user-agent'],
    trade_no: signData?.out_trade_no,
    trade_status: signData?.trade_status,
    body_keys: Object.keys(signData || {}),
  }) + '\n';
  fs.appendFileSync(logPath, logEntry);

  // Load order to get channel config
  const tradeNo = signData.out_trade_no;
  const order = tradeNo ? await db.get('SELECT channel_config_id FROM payment_orders WHERE trade_no = ?', [tradeNo]) : null;
  let alipayConfig = null;
  let configSource = 'none';
  if (order && order.channel_config_id) {
    const ch = await db.get('SELECT config FROM payment_channels WHERE id = ?', [order.channel_config_id]);
    if (ch) {
      alipayConfig = JSON.parse(ch.config || '{}');
      configSource = `order_channel_${order.channel_config_id}`;
    }
  }
  // Fallback to primary alipay channel if order config missing (diagnostic only)
  if (!alipayConfig && tradeNo) {
    const primary = await db.get("SELECT config FROM payment_channels WHERE type = 'alipay' AND is_primary = true LIMIT 1");
    if (primary) {
      alipayConfig = JSON.parse(primary.config || '{}');
      configSource = 'primary_channel';
    }
  }

  let isValid = false;
  let verifyError = null;
  try {
    isValid = alipay.verifyNotify(signData, alipayConfig);
  } catch (err) {
    verifyError = err.message;
  }

  // Diagnostic logging: record verification result and config source
  const verifyLogEntry = JSON.stringify({
    time: new Date().toISOString(),
    source: 'notify_verify',
    trade_no: tradeNo,
    order_found: !!order,
    config_source: configSource,
    has_alipay_public_key: !!(alipayConfig && alipayConfig.alipayPublicKey),
    sign_type: signData?.sign_type,
    is_valid: isValid,
    verify_error: verifyError,
  }) + '\n';
  fs.appendFileSync(logPath, verifyLogEntry);

  if (!isValid) {
    console.error('[billing] Alipay notify sign verification failed', { tradeNo, configSource, verifyError });
    return res.status(400).send('fail');
  }

  const tradeStatus = signData.trade_status;

  if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(tradeStatus)) {
    return res.send('success');
  }

  if (!tradeNo) {
    return res.status(400).send('fail');
  }

  const result = await fulfillOrder(tradeNo);
  if (result.success) {
    return res.send('success');
  } else {
    return res.status(400).send('fail');
  }
});

// Query order status by trade number (used by frontend after payment redirect)
router.get('/orders/by-trade-no/:tradeNo', async (req, res) => {
  const order = await db.get(
    `SELECT o.*, w.name as workspace_name
     FROM payment_orders o
     LEFT JOIN workspaces w ON w.id = o.workspace_id
     WHERE o.trade_no = ?`,
    [req.params.tradeNo]
  );
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  // Account-only orders (workspace_id is null) are owned by the user;
  // workspace orders require membership.
  const hasPermission = order.workspace_id
    ? !!(await db.get(
        `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [order.workspace_id, req.user.id]
      ))
    : order.user_id === req.user.id;
  if (!hasPermission && req.user.role !== 'admin') {
    return res.status(403).json({ error: '没有权限' });
  }

  res.json(order);
});

// SSE stream for pending order countdowns (auth via header or query token)
router.get('/orders/pending-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable reverse proxy buffering for SSE
  res.flushHeaders();

  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // client disconnected
    }
  };

  const loadPending = async () => {
    let where = "o.status = 'pending'";
    const params = [];
    if (!isAdmin) {
      where += ' AND o.user_id = ?';
      params.push(userId);
    }
    return db.all(
      `SELECT o.id, o.trade_no, o.workspace_id, o.amount, o.channel, o.status, o.created_at, o.expires_at, w.name as workspace_name
       FROM payment_orders o
       LEFT JOIN workspaces w ON w.id = o.workspace_id
       WHERE ${where}
       ORDER BY o.id DESC`,
      params
    );
  };

  // Initial snapshot
  try {
    const orders = await loadPending();
    send('pending:orders', { orders, now: new Date().toISOString() });
  } catch (e) {
    send('error', { message: e.message });
  }

  // Tick every second with fresh data (also expires old orders opportunistically)
  const tick = setInterval(async () => {
    try {
      await invoiceService.expireOldPendingOrders();
      const orders = await loadPending();
      send('pending:tick', { now: new Date().toISOString(), orders });
    } catch (e) {
      send('error', { message: e.message });
    }
  }, 1000);

  const keepAlive = setInterval(() => {
    send('ping', { time: new Date().toISOString() });
  }, 15000);

  req.on('close', () => {
    clearInterval(tick);
    clearInterval(keepAlive);
  });
});

// Query order status
/**
 * @swagger
 * /billing/orders/{id}:
 *   get:
 *     summary: Get order details
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 */
router.get('/orders/:id', async (req, res) => {
  const orderId = parseInt(req.params.id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: '无效的订单 ID' });
  }
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  // Account-only orders (workspace_id is null) are owned by the user;
  // workspace orders require membership.
  const hasPermission = order.workspace_id
    ? !!(await db.get(
        `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [order.workspace_id, req.user.id]
      ))
    : order.user_id === req.user.id;
  if (!hasPermission && req.user.role !== 'admin') {
    return res.status(403).json({ error: '没有权限' });
  }

  // 二维码订单防劫持：如果订单包含 qr_token，必须提供匹配的 token 才能查询
  let metadata = {};
  try {
    metadata = JSON.parse(order.metadata || '{}');
  } catch { /* ignore */ }

  if (metadata.qr_token) {
    const providedToken = req.query.qr_token || req.headers['x-qr-token'];
    if (!providedToken || providedToken !== metadata.qr_token) {
      return res.status(403).json({ error: '无效的二维码安全令牌' });
    }
    // 二维码过期自动标记
    if (metadata.qr_expire_at && new Date(metadata.qr_expire_at).getTime() < Date.now() && order.status === 'pending') {
      await db.run(`UPDATE payment_orders SET status = 'expired' WHERE id = ?`, [orderId]);
      order.status = 'expired';
    }
  }

  res.json(order);
});

// Continue payment for an existing pending order (re-generate QR / payment form)
router.post('/orders/:id/continue-pay', async (req, res) => {
  const orderId = parseInt(req.params.id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: '无效的订单 ID' });
  }

  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }
  if (!isAdmin && order.user_id !== userId) {
    return res.status(403).json({ error: '没有权限' });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单状态不允许继续支付' });
  }
  if (order.expires_at && new Date(order.expires_at) < new Date()) {
    return res.status(400).json({ error: '订单已过期，请重新发起充值' });
  }

  let metadata = {};
  try {
    metadata = JSON.parse(order.metadata || '{}');
  } catch { /* ignore */ }

  // QR token is required for QR orders to prevent hijacking
  const providedToken = req.body.qr_token || req.query.qr_token;
  if (metadata.use_qrcode && metadata.qr_token && providedToken !== metadata.qr_token) {
    return res.status(403).json({ error: '无效的二维码安全令牌' });
  }

  // Load channel config
  let channelConfig = null;
  if (order.channel_config_id) {
    const ch = await db.get('SELECT * FROM payment_channels WHERE id = ?', [order.channel_config_id]);
    if (ch) channelConfig = ch;
  }
  if (!channelConfig) {
    channelConfig = await findChannelConfig(order.channel);
  }
  if (!channelConfig) {
    return res.status(400).json({ error: '支付渠道已失效' });
  }

  const alipayConfig = order.channel === 'alipay' ? JSON.parse(channelConfig.config || '{}') : null;
  const returnUrl = metadata.return_url || '';
  const subject = metadata.target === 'workspace' ? 'Workspace 余额充值' : '账户余额充值';

  if (order.channel === 'alipay' && alipay.isConfigured(alipayConfig)) {
    try {
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const baseUrl = process.env.API_BASE_URL || `${protocol}://${host}`;
      const notifyUrl = alipayConfig.notifyUrl || `${baseUrl}/billing/notify`;
      const baseReturnUrl = alipayConfig.returnUrl || `${baseUrl}/billing/pay-callback`;
      const separator = baseReturnUrl.includes('?') ? '&' : '?';
      const alipayReturnUrl = `${baseReturnUrl}${separator}return_url=${encodeURIComponent(returnUrl)}`;

      if (metadata.use_qrcode) {
        // QR order: only regenerate QR code, never mix with page-pay
        let qrCode = metadata.qr_code;
        if (!qrCode) {
          const result = await alipay.createQrOrder(order.trade_no, order.amount, subject, notifyUrl, alipayConfig);
          qrCode = result.qrCode;
        }
        const qrDataUrl = await QRCode.toDataURL(qrCode, { width: 300, margin: 2 });
        return res.json({
          id: order.id,
          trade_no: order.trade_no,
          amount: order.amount,
          channel: order.channel,
          status: order.status,
          use_qrcode: true,
          qr_code: qrCode,
          qr_data_url: qrDataUrl,
          qr_token: metadata.qr_token,
          qr_expire_at: metadata.qr_expire_at,
          // camelCase aliases
          qrCode,
          qrDataUrl,
        });
      }

      // Page-pay order only
      const paymentForm = await alipay.createOrder(order.trade_no, order.amount, subject, alipayReturnUrl, notifyUrl, alipayConfig);
      return res.json({
        id: order.id,
        trade_no: order.trade_no,
        amount: order.amount,
        channel: order.channel,
        status: order.status,
        use_qrcode: false,
        payment_form: paymentForm,
        form: paymentForm,
      });
    } catch (err) {
      console.error('[billing] Alipay continue-pay failed:', err.message);
      return res.status(400).json({ error: '支付信息生成失败，请稍后重试' });
    }
  }

  return res.status(400).json({ error: '当前渠道不支持继续支付' });
});

// List current user's orders
router.get('/orders', async (req, res) => {
  await invoiceService.expireOldPendingOrders();
  const { workspace_id, status, page = 1, limit = 30, sort } = req.query;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  let where = [];
  let params = [];

  if (!isAdmin) {
    where.push('o.user_id = ?');
    params.push(userId);
  }
  if (workspace_id) {
    where.push('o.workspace_id = ?');
    params.push(parseInt(workspace_id));
  }
  if (status) {
    where.push('o.status = ?');
    params.push(status);
  }

  const SORT_MAP = {
    id_asc: 'o.id ASC',
    id_desc: 'o.id DESC',
    amount_asc: 'o.amount ASC',
    amount_desc: 'o.amount DESC',
    created_asc: 'o.created_at ASC',
    created_desc: 'o.created_at DESC',
  };
  const orderBy = SORT_MAP[sort] || 'o.id ASC';

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;

  const orders = await db.all(
    `SELECT o.*, w.name as workspace_name, c.name as coupon_name
     FROM payment_orders o
     LEFT JOIN workspaces w ON w.id = o.workspace_id
     LEFT JOIN user_coupons uc ON uc.id = o.coupon_id
     LEFT JOIN coupons c ON c.id = uc.coupon_id
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );

  const countRow = await db.get(
    `SELECT COUNT(*) as count FROM payment_orders o ${whereSql}`,
    params
  );

  res.json({
    orders,
    total: countRow?.count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((countRow?.count || 0) / l)
  });
});

// Cancel own pending order
router.post('/orders/:id/cancel', async (req, res) => {
  const orderId = parseInt(req.params.id);
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  // Account-only orders are owned by the user; workspace orders require membership.
  const hasPermission = order.workspace_id
    ? !!(await db.get(
        `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [order.workspace_id, req.user.id]
      ))
    : order.user_id === req.user.id;
  if (!hasPermission && req.user.role !== 'admin') {
    return res.status(403).json({ error: '没有权限' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '只能取消待支付订单' });
  }

  await db.run(
    `UPDATE payment_orders SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  await restoreCoupon(order);
  await logBilling('order_cancelled', { order_id: orderId, trade_no: order.trade_no, by_user: req.user.id });
  res.json({ success: true });
});

// Admin: list all orders
router.get('/admin/orders', async (req, res) => {
  await invoiceService.expireOldPendingOrders();
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const { workspace_id, status, channel, page = 1, limit = 50 } = req.query;
  let where = [];
  let params = [];

  if (workspace_id) {
    where.push('o.workspace_id = ?');
    params.push(parseInt(workspace_id));
  }
  if (status) {
    where.push('o.status = ?');
    params.push(status);
  }
  if (channel) {
    where.push('o.channel = ?');
    params.push(channel);
  }

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;

  const orders = await db.all(
    `SELECT o.*, w.name as workspace_name, u.username as user_name, c.name as coupon_name
     FROM payment_orders o
     LEFT JOIN workspaces w ON w.id = o.workspace_id
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN user_coupons uc ON uc.id = o.coupon_id
     LEFT JOIN coupons c ON c.id = uc.coupon_id
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );

  const countRow = await db.get(
    `SELECT COUNT(*) as count FROM payment_orders o ${whereSql}`,
    params
  );

  res.json({
    orders,
    total: countRow?.count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((countRow?.count || 0) / l)
  });
});

// Admin: cancel any pending order
router.post('/admin/orders/:id/cancel', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const orderId = parseInt(req.params.id);
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '只能取消待支付订单' });
  }

  await db.run(
    `UPDATE payment_orders SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  await restoreCoupon(order);
  await logBilling('admin_order_cancelled', { order_id: orderId, trade_no: order.trade_no, admin_id: req.user.id });
  res.json({ success: true });
});

// Admin: refund a paid order
router.post('/admin/orders/:id/refund', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const orderId = parseInt(req.params.id);
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status !== 'paid') {
    return res.status(400).json({ error: '只能退款已支付订单' });
  }

  const creditAmount = order.original_amount || order.amount;
  const target = resolveOrderTarget(order);
  let newBalance = 0;
  let newUserBalance = 0;

  if (target === 'workspace' && order.workspace_id) {
    const workspace = await db.get('SELECT balance FROM workspaces WHERE id = ?', [order.workspace_id]);
    if ((workspace?.balance || 0) < creditAmount) {
      return res.status(400).json({ error: 'Workspace 余额不足，无法退款' });
    }
    newBalance = normalizeBalance((workspace?.balance || 0) - creditAmount);
    await db.run('UPDATE workspaces SET balance = ? WHERE id = ?', [newBalance, order.workspace_id]);
  }

  if (target === 'account') {
    const user = await db.get('SELECT balance FROM users WHERE id = ?', [order.user_id]);
    if ((user?.balance || 0) < creditAmount) {
      return res.status(400).json({ error: '账户余额不足，无法退款' });
    }
    newUserBalance = normalizeBalance((user?.balance || 0) - creditAmount);
    await db.run(`UPDATE users SET balance = ? WHERE id = ?`, [newUserBalance, order.user_id]);
  }

  await db.run(
    `UPDATE payment_orders SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  await restoreCoupon(order);

  await db.run(
    `INSERT INTO billing_records (workspace_id, user_id, type, amount, balance_after, user_balance_after, description, metadata)
     VALUES (?, ?, 'refund', ?, ?, ?, ?, ?)`,
    [order.workspace_id || null, order.user_id, order.amount, newBalance, newUserBalance, `${order.channel} refund`, JSON.stringify({ order_id: order.id, trade_no: order.trade_no })]
  );

  await logBilling('admin_order_refunded', { order_id: orderId, trade_no: order.trade_no, amount: order.amount, original_amount: order.original_amount, discount_amount: order.discount_amount, coupon_id: order.coupon_id, admin_id: req.user.id, newBalance, newUserBalance });
  res.json({ success: true, balance: newBalance, userBalance: newUserBalance });
});

// User: request invoice for a paid order
router.post('/orders/:id/invoice', async (req, res) => {
  const orderId = parseInt(req.params.id);
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  const membership = await db.get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [order.workspace_id, req.user.id]
  );
  if (!membership && req.user.role !== 'admin') {
    return res.status(403).json({ error: '没有权限' });
  }

  if (order.status !== 'paid') {
    return res.status(400).json({ error: '只有已支付订单才能开票' });
  }

  try {
    const invoice = await invoiceService.issueInvoiceForOrder(order);
    res.json({ success: true, invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: manually issue invoice for any paid order
router.post('/admin/orders/:id/invoice', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const orderId = parseInt(req.params.id);
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status !== 'paid') return res.status(400).json({ error: '只有已支付订单才能开票' });

  try {
    const invoice = await invoiceService.issueInvoiceForOrder(order);
    res.json({ success: true, invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List invoices
router.get('/invoices', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { order_id, status, review_status, page = 1, limit = 50 } = req.query;
  const result = await invoiceService.listInvoices({
    userId: isAdmin ? null : req.user.id,
    orderId: order_id ? parseInt(order_id) : null,
    status,
    reviewStatus: review_status,
    page,
    limit,
  });
  res.json(result);
});

// Admin: invoice audit log
router.get('/admin/invoices/audit-log', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { page = 1, limit = 50 } = req.query;
  try {
    const result = await invoiceService.getInvoiceAuditLog({ page, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: retry failed invoice
router.post('/admin/invoices/:id/retry', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  try {
    const invoice = await invoiceService.retryInvoice(parseInt(req.params.id));
    res.json({ success: true, invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Batch operations helpers
async function canAccessOrder(order, userId, isAdmin) {
  if (isAdmin) return true;
  // Account-only orders (no workspace) are accessible by the order owner.
  if (!order.workspace_id) {
    return order.user_id === userId;
  }
  const membership = await db.get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [order.workspace_id, userId]
  );
  return !!membership;
}

// User: batch cancel pending orders
router.post('/orders/batch-cancel', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '缺少订单 ID' });
  let success = 0;
  let failed = 0;
  for (const id of ids) {
    const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [parseInt(id)]);
    if (!order || !(await canAccessOrder(order, req.user.id, false)) || order.status !== 'pending') {
      failed++;
      continue;
    }
    await db.run(`UPDATE payment_orders SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`, [order.id]);
    await restoreCoupon(order);
    await logBilling('order_batch_cancelled', { order_id: order.id, trade_no: order.trade_no, by_user: req.user.id });
    success++;
  }
  res.json({ success: true, cancelled: success, failed });
});

// User: batch invoice paid orders
router.post('/orders/batch-invoice', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '缺少订单 ID' });
  const results = [];
  for (const id of ids) {
    const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [parseInt(id)]);
    if (!order || !(await canAccessOrder(order, req.user.id, false)) || order.status !== 'paid') {
      results.push({ id, success: false, error: '无权限或订单状态不正确' });
      continue;
    }
    try {
      const invoice = await invoiceService.issueInvoiceForOrder(order);
      results.push({ id, success: true, invoice_no: invoice.invoice_no });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  res.json({ success: true, results });
});

// Admin: batch cancel
router.post('/admin/orders/batch-cancel', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '缺少订单 ID' });
  let success = 0;
  for (const id of ids) {
    const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [parseInt(id)]);
    if (!order || order.status !== 'pending') continue;
    await db.run(`UPDATE payment_orders SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`, [order.id]);
    await restoreCoupon(order);
    await logBilling('admin_order_batch_cancelled', { order_id: order.id, trade_no: order.trade_no, admin_id: req.user.id });
    success++;
  }
  res.json({ success: true, cancelled: success });
});

// Admin: batch refund
router.post('/admin/orders/batch-refund', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '缺少订单 ID' });
  let success = 0;
  for (const id of ids) {
    const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [parseInt(id)]);
    if (!order || order.status !== 'paid') continue;
    const creditAmount = order.original_amount || order.amount;
    const target = resolveOrderTarget(order);
    let newBalance = 0;
    let newUserBalance = 0;

    if (target === 'workspace' && order.workspace_id) {
      const workspace = await db.get('SELECT balance FROM workspaces WHERE id = ?', [order.workspace_id]);
      if ((workspace?.balance || 0) < creditAmount) continue;
      newBalance = normalizeBalance((workspace?.balance || 0) - creditAmount);
      await db.run('UPDATE workspaces SET balance = ? WHERE id = ?', [newBalance, order.workspace_id]);
    }

    if (target === 'account') {
      const user = await db.get('SELECT balance FROM users WHERE id = ?', [order.user_id]);
      if ((user?.balance || 0) < creditAmount) continue;
      newUserBalance = normalizeBalance((user?.balance || 0) - creditAmount);
      await db.run(`UPDATE users SET balance = ? WHERE id = ?`, [newUserBalance, order.user_id]);
    }
    await db.run(`UPDATE payment_orders SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?`, [order.id]);
    await restoreCoupon(order);
    await db.run(
      `INSERT INTO billing_records (workspace_id, user_id, type, amount, balance_after, user_balance_after, description, metadata)
       VALUES (?, ?, 'refund', ?, ?, ?, ?, ?)`,
      [order.workspace_id || null, order.user_id, order.amount, newBalance, newUserBalance, `${order.channel} refund`, JSON.stringify({ order_id: order.id, trade_no: order.trade_no })]
    );
    await logBilling('admin_order_batch_refunded', { order_id: order.id, trade_no: order.trade_no, admin_id: req.user.id, newBalance, newUserBalance });
    success++;
  }
  res.json({ success: true, refunded: success });
});

// Admin: batch invoice
router.post('/admin/orders/batch-invoice', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '缺少订单 ID' });
  const results = [];
  for (const id of ids) {
    const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [parseInt(id)]);
    if (!order || order.status !== 'paid') {
      results.push({ id, success: false, error: '订单不存在或状态不正确' });
      continue;
    }
    try {
      const invoice = await invoiceService.issueInvoiceForOrder(order);
      results.push({ id, success: true, invoice_no: invoice.invoice_no });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  res.json({ success: true, results });
});

// Admin: delete order (only admin, frontend shows 3s confirm)
router.delete('/admin/orders/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const orderId = parseInt(req.params.id);
  const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [orderId]);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  await db.run('DELETE FROM payment_orders WHERE id = ?', [orderId]);
  await logBilling('admin_order_deleted', { order_id: orderId, trade_no: order.trade_no, admin_id: req.user.id });
  res.json({ success: true });
});

// Admin: batch delete
router.post('/admin/orders/batch-delete', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '缺少订单 ID' });
  let success = 0;
  for (const id of ids) {
    const order = await db.get('SELECT * FROM payment_orders WHERE id = ?', [parseInt(id)]);
    if (!order) continue;
    await db.run('DELETE FROM payment_orders WHERE id = ?', [order.id]);
    await logBilling('admin_order_batch_deleted', { order_id: order.id, trade_no: order.trade_no, admin_id: req.user.id });
    success++;
  }
  res.json({ success: true, deleted: success });
});

// Get billing logs (admin only)
/**
 * @swagger
 * /billing/logs:
 *   get:
 *     summary: Get billing operation logs
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Billing logs
 */
router.get('/logs', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const { page = 1, limit = 50 } = req.query;
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;

  const logs = await db.all(
    `SELECT * FROM billing_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [l, offset]
  );

  const total = await db.get(`SELECT COUNT(*) as count FROM billing_logs`);

  res.json({ logs, total: total?.count || 0, page: p, limit: l, totalPages: Math.ceil((total?.count || 0) / l) });
});

// Get workspace balance
/**
 * @swagger
 * /billing/balance/{workspaceId}:
 *   get:
 *     summary: Get workspace balance
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Workspace balance
 */
router.get('/balance/:workspaceId', async (req, res) => {
  const workspaceId = parseInt(req.params.workspaceId);

  const membership = await db.get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership) {
    return res.status(403).json({ error: '没有该工作空间的访问权限' });
  }

  const workspace = await db.get('SELECT balance, quota_limit, quota_used, token_quota_limit, token_quota_used FROM workspaces WHERE id = ?', [workspaceId]);
  res.json(workspace || { balance: 0, quota_limit: 0, quota_used: 0, token_quota_limit: 0, token_quota_used: 0 });
});

// Get current user's per-account balance (admins can pass ?user_id= to query another user)
router.get('/user-balance', async (req, res) => {
  let userId = req.user.id;
  if (req.user.role === 'admin' && req.query.user_id) {
    userId = parseInt(req.query.user_id);
  }
  const user = await db.get('SELECT id, balance FROM users WHERE id = ?', [userId]);
  res.json({ balance: user?.balance || 0 });
});

// Admin: quick recharge for a workspace (credits workspace and/or a selected user account)
router.post('/admin/quick-recharge', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { workspace_id, amount: rawAmount, description, target, user_id } = req.body;
  const workspaceId = workspace_id ? parseInt(workspace_id) : null;
  const parsedAmount = parseFloat(rawAmount);
  const rechargeTarget = ['workspace', 'account'].includes(target) ? target : 'workspace';

  // workspace_id is required for workspace balance recharge; optional for account balance recharge.
  if (rechargeTarget === 'workspace' && !workspaceId) {
    return res.status(400).json({ error: 'Workspace 余额充值需要 workspace_id' });
  }
  if (Number.isNaN(parsedAmount) || parsedAmount <= 0 || !isFinite(parsedAmount)) {
    return res.status(400).json({ error: '参数错误' });
  }

  if (workspaceId) {
    const workspace = await db.get('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
    if (!workspace) return res.status(404).json({ error: 'Workspace 不存在' });
  }

  // When targeting account balance, allow admin to choose a user; default to self if omitted.
  let orderUserId = req.user.id;
  if (rechargeTarget === 'account' && user_id) {
    const targetUser = await db.get('SELECT id FROM users WHERE id = ?', [parseInt(user_id)]);
    if (!targetUser) return res.status(404).json({ error: '目标用户不存在' });
    orderUserId = targetUser.id;
  }
  const tradeNo = `ADM${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const orderResult = await db.run(
    `INSERT INTO payment_orders (workspace_id, user_id, amount, channel, status, trade_no, description, metadata)
     VALUES (?, ?, ?, 'admin', 'pending', ?, ?, ?)`,
    [
      workspaceId || null,
      orderUserId,
      parsedAmount,
      tradeNo,
      description || '管理员快速充值',
      JSON.stringify({ admin_id: req.user.id, is_admin_recharge: true, target: rechargeTarget })
    ]
  );

  const result = await fulfillOrder(tradeNo, { isAdminRecharge: true, target: rechargeTarget });
  if (!result.success) {
    await db.run(`UPDATE payment_orders SET status = 'failed' WHERE id = ?`, [orderResult.lastInsertRowid]);
    return res.status(400).json({ error: result.error || '充值失败' });
  }

  audit.log({
    userId: req.user.id,
    username: req.user.username,
    action: 'admin_recharge',
    resourceType: 'billing',
    resourceId: orderResult.lastInsertRowid,
    resourceName: tradeNo,
    newValue: { workspace_id: workspaceId, amount: parsedAmount, balance: result.balance, user_balance: result.userBalance, target: rechargeTarget },
    req
  });

  res.json({
    success: true,
    trade_no: tradeNo,
    amount: parsedAmount,
    balance: result.balance,
    userBalance: result.userBalance,
    target: rechargeTarget,
    user_id: orderUserId,
    order_id: orderResult.lastInsertRowid,
  });
});

// Admin: review an invoice (approve / reject)
router.post('/admin/invoices/:id/review', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const invoiceId = parseInt(req.params.id);
  const { action, reason } = req.body;
  try {
    const invoice = await invoiceService.reviewInvoice(invoiceId, action, reason);
    await logBilling('admin_invoice_reviewed', { invoice_id: invoiceId, action, reason, admin_id: req.user.id });
    res.json({ success: true, invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SSE stream for invoice status updates (auth via query token)
router.get('/invoices/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('ping', { time: new Date().toISOString() });

  const onUpdate = (invoice) => {
    send('invoice:updated', invoice);
  };
  const onCreated = (invoice) => {
    send('invoice:created', invoice);
  };

  invoiceService.invoiceEmitter.on('invoice:updated', onUpdate);
  invoiceService.invoiceEmitter.on('invoice:created', onCreated);

  const keepAlive = setInterval(() => {
    send('ping', { time: new Date().toISOString() });
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    invoiceService.invoiceEmitter.off('invoice:updated', onUpdate);
    invoiceService.invoiceEmitter.off('invoice:created', onCreated);
  });
});

// Download invoice as XLSX (file valid for 30 days)
router.get('/invoices/:id/download', async (req, res) => {
  const invoiceId = parseInt(req.params.id);
  let invoice = await db.get(
    `SELECT i.*, o.trade_no, u.username as user_name, w.name as workspace_name
     FROM invoices i
     LEFT JOIN payment_orders o ON o.id = i.order_id
     LEFT JOIN users u ON u.id = i.user_id
     LEFT JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.id = ?`,
    [invoiceId]
  );
  if (!invoice) return res.status(404).json({ error: '发票不存在' });

  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && invoice.user_id !== req.user.id) {
    return res.status(403).json({ error: '没有权限' });
  }
  if (invoice.status === 'removed') {
    return res.status(410).json({ error: '发票文件已过期，请重新开票' });
  }
  if (invoice.status !== 'issued' || invoice.review_status !== 'approved') {
    return res.status(400).json({ error: '发票尚未审核通过' });
  }

  if (invoiceService.isFileExpired(invoice)) {
    await invoiceService.markRemoved(invoice.id);
    return res.status(410).json({ error: '发票文件已过期，请重新开票' });
  }

  if (!invoice.invoice_file_path || !fs.existsSync(invoice.invoice_file_path)) {
    invoice = await invoiceService.regenerateInvoiceFile(invoice);
  }

  const filePath = invoice.invoice_file_path;
  const fileName = path.basename(filePath);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[Invoice] Download stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: '文件读取失败' });
  });
  stream.pipe(res);
});

// Admin: get invoice review settings
router.get('/admin/invoice-settings', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const mode = await invoiceService.getInvoiceReviewMode();
  res.json({ mode });
});

// Admin: update invoice review settings
router.post('/admin/invoice-settings', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { mode } = req.body;
  const newMode = await invoiceService.setInvoiceReviewMode(mode);
  await logBilling('invoice_settings_changed', { mode: newMode, admin_id: req.user.id });
  res.json({ mode: newMode });
});

// ========== User coupons ==========

// GET /billing/my-coupons
router.get('/my-coupons', async (req, res) => {
  const userId = req.user.id;
  const { amount } = req.query;
  const originalAmount = parseFloat(amount);

  const rows = await db.all(
    `SELECT uc.id as user_coupon_id, uc.status, uc.issued_at, uc.expires_at,
            c.id as coupon_id, c.name, c.description, c.type, c.threshold, c.discount_amount, c.discount_rate, c.valid_start, c.valid_end
     FROM user_coupons uc
     JOIN coupons c ON c.id = uc.coupon_id
     WHERE uc.user_id = ? AND uc.status = 'unused' AND c.is_active = true
     ORDER BY uc.issued_at DESC`,
    [userId]
  );

  const now = new Date();
  const coupons = rows
    .filter((row) => {
      if (row.valid_end && new Date(row.valid_end) < now) return false;
      if (row.expires_at && new Date(row.expires_at) < now) return false;
      if (row.valid_start && new Date(row.valid_start) > now) return false;
      return true;
    })
    .map((row) => {
      const threshold = parseFloat(row.threshold) || 0;
      const type = row.type || 'threshold_fixed';
      let discount = 0;
      let applicable = true;
      if (!Number.isNaN(originalAmount)) {
        applicable = originalAmount >= threshold;
        if (applicable) {
          if (type === 'threshold_fixed') {
            discount = Math.min(parseFloat(row.discount_amount) || 0, originalAmount);
          } else if (type === 'percentage') {
            discount = originalAmount * (parseFloat(row.discount_rate) || 0);
          }
          discount = Math.round(discount * 100) / 100;
        }
      }
      return {
        id: row.user_coupon_id,
        coupon_id: row.coupon_id,
        name: row.name,
        description: row.description,
        type,
        threshold,
        discount_amount: parseFloat(row.discount_amount) || 0,
        discount_rate: parseFloat(row.discount_rate) || 0,
        discount,
        payable: Number.isNaN(originalAmount) ? null : Math.max(0, Math.round((originalAmount - discount) * 100) / 100),
        applicable,
        expires_at: row.expires_at,
        valid_start: row.valid_start,
        valid_end: row.valid_end,
      };
    });

  res.json({ coupons });
});

// GET /billing/my-coupons/all - list all coupons for current user (including used/expired)
router.get('/my-coupons/all', async (req, res) => {
  const userId = req.user.id;
  const { status } = req.query;

  const where = ['uc.user_id = ?'];
  const params = [userId];
  if (status) {
    where.push('uc.status = ?');
    params.push(status);
  }
  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await db.all(
    `SELECT uc.id as user_coupon_id, uc.status, uc.issued_at, uc.used_at, uc.expires_at,
            c.id as coupon_id, c.name, c.description, c.type, c.threshold, c.discount_amount, c.discount_rate, c.valid_start, c.valid_end, c.is_active
     FROM user_coupons uc
     JOIN coupons c ON c.id = uc.coupon_id
     ${whereSql}
     ORDER BY uc.issued_at DESC`,
    params
  );

  const now = new Date();
  const coupons = rows.map((row) => {
    const threshold = parseFloat(row.threshold) || 0;
    const type = row.type || 'threshold_fixed';
    let effectiveStatus = row.status;
    if (row.status === 'unused') {
      if ((row.valid_end && new Date(row.valid_end) < now) || (row.expires_at && new Date(row.expires_at) < now)) {
        effectiveStatus = 'expired';
      }
    }
    return {
      id: row.user_coupon_id,
      coupon_id: row.coupon_id,
      name: row.name,
      description: row.description,
      type,
      threshold,
      discount_amount: parseFloat(row.discount_amount) || 0,
      discount_rate: parseFloat(row.discount_rate) || 0,
      status: row.status,
      effective_status: effectiveStatus,
      issued_at: row.issued_at,
      used_at: row.used_at,
      expires_at: row.expires_at,
      valid_start: row.valid_start,
      valid_end: row.valid_end,
      is_active: row.is_active === 1 || row.is_active === true,
    };
  });

  res.json({ coupons });
});

// ========== Admin coupon management ==========

// GET /billing/admin/coupons
router.get('/admin/coupons', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const coupons = await db.all(`SELECT * FROM coupons ORDER BY created_at DESC`);
  res.json({ coupons });
});

// POST /billing/admin/coupons
router.post('/admin/coupons', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const {
    name, description, type = 'threshold_fixed', threshold, discount_amount, discount_rate,
    max_uses, valid_start, valid_end, is_active = true
  } = req.body;
  if (!name) return res.status(400).json({ error: '优惠券名称不能为空' });

  try {
    const result = await db.run(
      `INSERT INTO coupons (name, description, type, threshold, discount_amount, discount_rate, max_uses, valid_start, valid_end, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, description || '', type,
        parseFloat(threshold) || 0,
        parseFloat(discount_amount) || 0,
        parseFloat(discount_rate) || 0,
        parseInt(max_uses) || 0,
        valid_start || null,
        valid_end || null,
        asBool(is_active)
      ]
    );
    await logBilling('admin_coupon_created', { coupon_id: result.lastInsertRowid, name, admin_id: req.user.id });
    res.status(201).json({ id: result.lastInsertRowid, success: true });
  } catch (err) {
    console.error('[billing] create coupon failed:', err.message);
    res.status(400).json({ error: '创建优惠券失败' });
  }
});

// PUT /billing/admin/coupons/:id
router.put('/admin/coupons/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const couponId = parseInt(req.params.id);
  const {
    name, description, type, threshold, discount_amount, discount_rate,
    max_uses, valid_start, valid_end, is_active
  } = req.body;

  await db.run(
    `UPDATE coupons
     SET name = ?, description = ?, type = ?, threshold = ?, discount_amount = ?, discount_rate = ?, max_uses = ?, valid_start = ?, valid_end = ?, is_active = ?
     WHERE id = ?`,
    [
      name, description || '', type,
      parseFloat(threshold) || 0,
      parseFloat(discount_amount) || 0,
      parseFloat(discount_rate) || 0,
      parseInt(max_uses) || 0,
      valid_start || null,
      valid_end || null,
      asBool(is_active),
      couponId
    ]
  );
  await logBilling('admin_coupon_updated', { coupon_id: couponId, admin_id: req.user.id });
  res.json({ success: true });
});

// DELETE /billing/admin/coupons/:id
router.delete('/admin/coupons/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const couponId = parseInt(req.params.id);
  await db.run('DELETE FROM coupons WHERE id = ?', [couponId]);
  await logBilling('admin_coupon_deleted', { coupon_id: couponId, admin_id: req.user.id });
  res.json({ success: true });
});

// GET /billing/admin/user-coupons
router.get('/admin/user-coupons', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { user_id, username, status, page = 1, limit = 50 } = req.query;
  const where = [];
  const params = [];
  if (user_id) { where.push('uc.user_id = ?'); params.push(parseInt(user_id)); }
  if (username) { where.push('u.username LIKE ?'); params.push(`%${username}%`); }
  if (status) { where.push('uc.status = ?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;

  const rows = await db.all(
    `SELECT uc.*, u.username, u.id as user_id, c.name as coupon_name, c.type, c.threshold, c.discount_amount, c.discount_rate
     FROM user_coupons uc
     JOIN users u ON u.id = uc.user_id
     JOIN coupons c ON c.id = uc.coupon_id
     ${whereSql}
     ORDER BY uc.issued_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );
  const countRow = await db.get(`SELECT COUNT(*) as count FROM user_coupons uc ${whereSql}`, params);
  res.json({ coupons: rows, total: countRow?.count || 0, page: p, limit: l, totalPages: Math.ceil((countRow?.count || 0) / l) });
});

// POST /billing/admin/user-coupons/issue
router.post('/admin/user-coupons/issue', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { coupon_id, user_ids, usernames, expires_at } = req.body;
  if (!coupon_id) return res.status(400).json({ error: '缺少优惠券 ID' });

  let targetUserIds = [];
  if (Array.isArray(user_ids) && user_ids.length > 0) {
    targetUserIds = user_ids.map((id) => parseInt(id)).filter(Boolean);
  } else if (Array.isArray(usernames) && usernames.length > 0) {
    const placeholders = usernames.map(() => '?').join(',');
    const users = await db.all(`SELECT id FROM users WHERE username IN (${placeholders})`, usernames);
    targetUserIds = users.map((u) => u.id);
  } else {
    return res.status(400).json({ error: '请指定发放用户' });
  }

  if (targetUserIds.length === 0) return res.status(400).json({ error: '未找到目标用户' });

  const coupon = await db.get('SELECT * FROM coupons WHERE id = ?', [parseInt(coupon_id)]);
  if (!coupon) return res.status(404).json({ error: '优惠券不存在' });

  const issued = [];
  for (const uid of targetUserIds) {
    const result = await db.run(
      `INSERT INTO user_coupons (user_id, coupon_id, status, expires_at) VALUES (?, ?, 'unused', ?)`,
      [uid, parseInt(coupon_id), expires_at || null]
    );
    issued.push(result.lastInsertRowid);
  }
  await logBilling('admin_coupon_issued', { coupon_id, issued_to: targetUserIds, count: issued.length, admin_id: req.user.id });
  res.json({ success: true, issued, count: issued.length });
});

// POST /billing/admin/user-coupons/:id/revoke
router.post('/admin/user-coupons/:id/revoke', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const id = parseInt(req.params.id);
  await db.run(`UPDATE user_coupons SET status = 'cancelled' WHERE id = ? AND status = 'unused'`, [id]);
  await logBilling('admin_user_coupon_revoked', { user_coupon_id: id, admin_id: req.user.id });
  res.json({ success: true });
});

// POST /billing/admin/coupons/batch-delete
router.post('/admin/coupons/batch-delete', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择优惠券' });
  const placeholders = ids.map(() => '?').join(',');
  await db.run(`DELETE FROM coupons WHERE id IN (${placeholders})`, ids.map(id => parseInt(id)));
  await logBilling('admin_coupons_batch_deleted', { coupon_ids: ids, admin_id: req.user.id });
  res.json({ success: true });
});

// POST /billing/admin/coupons/batch-status
router.post('/admin/coupons/batch-status', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids, is_active } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择优惠券' });
  const active = asBool(is_active);
  const placeholders = ids.map(() => '?').join(',');
  await db.run(`UPDATE coupons SET is_active = ? WHERE id IN (${placeholders})`, [active, ...ids.map(id => parseInt(id))]);
  await logBilling('admin_coupons_batch_status', { coupon_ids: ids, is_active: active, admin_id: req.user.id });
  res.json({ success: true });
});

// POST /billing/admin/user-coupons/batch-revoke
router.post('/admin/user-coupons/batch-revoke', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择用户优惠券' });
  const placeholders = ids.map(() => '?').join(',');
  await db.run(`UPDATE user_coupons SET status = 'cancelled' WHERE id IN (${placeholders}) AND status = 'unused'`, ids.map(id => parseInt(id)));
  await logBilling('admin_user_coupons_batch_revoked', { user_coupon_ids: ids, admin_id: req.user.id });
  res.json({ success: true });
});

module.exports = { router, callbackRouter, stripeWebhookRouter };
