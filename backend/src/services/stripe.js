const Stripe = require('stripe');

function createSdk(config) {
  if (!config || !config.secretKey) return null;
  return new Stripe(config.secretKey, {
    apiVersion: '2024-06-20',
    timeout: 15000,
  });
}

function isConfigured(config) {
  return !!(config && config.secretKey && config.secretKey.startsWith('sk_'));
}

/**
 * Create a Stripe Checkout session for a recharge order.
 * @param {string} tradeNo - Merchant order number
 * @param {number} amount - Order amount in CNY
 * @param {string} successUrl - Full URL to redirect after success
 * @param {string} cancelUrl - Full URL to redirect after cancel
 * @param {object} config - { secretKey, publishableKey, paymentMethodTypes?, paymentMethodOptions?, currency? }
 * @returns {Promise<{sessionId: string, url: string}>}
 */
async function createCheckoutSession(tradeNo, amount, successUrl, cancelUrl, config) {
  const stripe = createSdk(config);
  if (!stripe) throw new Error('Stripe SDK not configured');

  // Convert CNY to smallest unit (jiao/fen). Stripe requires integer.
  const unitAmount = Math.round(amount * 100);

  // Allow customization; default to card-only for maximum compatibility with test accounts.
  // Alipay / WeChat Pay require special account enablement and may fail in development.
  const paymentMethodTypes = Array.isArray(config.paymentMethodTypes)
    ? config.paymentMethodTypes
    : (config.payment_method_types || ['card']);

  const paymentMethodOptions = config.paymentMethodOptions || config.payment_method_options || {};
  const currency = (config.currency || 'cny').toLowerCase();

  const payload = {
    payment_method_types: paymentMethodTypes,
    line_items: [
      {
        price_data: {
          currency,
          product_data: {
            name: 'Workspace 余额充值',
            description: `订单号: ${tradeNo}`,
          },
          unit_amount: unitAmount,
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: tradeNo,
    metadata: {
      trade_no: tradeNo,
    },
  };

  if (Object.keys(paymentMethodOptions).length > 0) {
    payload.payment_method_options = paymentMethodOptions;
  }

  const session = await stripe.checkout.sessions.create(payload);

  return { sessionId: session.id, url: session.url };
}

/**
 * Verify Stripe webhook signature.
 */
function constructEvent(payload, signature, secret) {
  const stripe = createSdk({ secretKey: secret });
  if (!stripe) throw new Error('Stripe SDK not configured');
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

/**
 * Retrieve a Checkout session by ID.
 */
async function retrieveSession(sessionId, config) {
  const stripe = createSdk(config);
  if (!stripe) throw new Error('Stripe SDK not configured');
  return stripe.checkout.sessions.retrieve(sessionId);
}

module.exports = {
  isConfigured,
  createCheckoutSession,
  constructEvent,
  retrieveSession,
};
