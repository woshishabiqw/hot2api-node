let AlipaySdk = null;

function loadSdk() {
  if (!AlipaySdk) {
    try {
      const sdkModule = require('alipay-sdk');
      AlipaySdk = sdkModule.AlipaySdk || sdkModule.default;
      if (!AlipaySdk) {
        console.warn('[alipay] AlipaySdk export not found');
        return null;
      }
    } catch (e) {
      console.warn('[alipay] alipay-sdk not installed');
      return null;
    }
  }
  return AlipaySdk;
}

function createSdk(config) {
  const Sdk = loadSdk();
  if (!Sdk) return null;
  if (!config || !config.appId || !config.privateKey || !config.alipayPublicKey) return null;

  // Alipay SDK v4 requires keyType to match the PEM header:
  // - PKCS8: '-----BEGIN PRIVATE KEY-----'
  // - PKCS1: '-----BEGIN RSA PRIVATE KEY-----' (default)
  // Auto-detect from the supplied key; allow config.keyType to override.
  const keyType = config.keyType || (
    config.privateKey.includes('-----BEGIN PRIVATE KEY-----') ? 'PKCS8' : 'PKCS1'
  );

  return new Sdk({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    keyType,
    gateway: config.gateway || 'https://openapi.alipaydev.com/gateway.do',
    signType: 'RSA2',
    charset: 'utf-8',
    timeout: 15000,
  });
}

function isConfigured(config) {
  return !!(config && config.appId && config.privateKey && config.alipayPublicKey && loadSdk());
}

async function withRetry(fn, { retries = 3, delayMs = 800, maxDelayMs = 5000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isTimeout = err.message && /\b(504|timeout|ETIMEDOUT|ECONNRESET|socket hang up)\b/i.test(err.message);
      if (!isTimeout || attempt === retries) throw err;
      const wait = Math.min(delayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

/**
 * Create an Alipay page-pay order.
 * @param {string} tradeNo - Merchant order number
 * @param {number} amount - Order amount
 * @param {string} subject - Order subject / title
 * @param {string} returnUrl - Sync callback URL (absolute)
 * @param {string} notifyUrl - Async notify URL (absolute)
 * @param {object} config - Channel config { appId, privateKey, alipayPublicKey, gateway }
 * @returns {string} HTML form snippet for auto-submit
 */
async function createOrder(tradeNo, amount, subject, returnUrl, notifyUrl, config) {
  const sdk = createSdk(config);
  if (!sdk) {
    throw new Error('Alipay SDK not configured');
  }

  // Alipay SDK v4+ 要求 page 类接口使用 pageExecute，exec + formData 会抛
  // "options.formData.getFiles is not a function" / "formData 参数不包含文件"
  let formData = await withRetry(() => sdk.pageExecute(
    'alipay.trade.page.pay',
    'POST',
    {
      notifyUrl,
      returnUrl,
      bizContent: {
        outTradeNo: tradeNo,
        totalAmount: String(amount),
        subject: subject || 'Workspace 余额充值',
        productCode: 'FAST_INSTANT_TRADE_PAY',
      },
    }
  ));

  // The SDK encodes spaces in the action URL as '+' (form-urlencoded).
  // In a URL query string '+' is literal plus, so Alipay verifies with the wrong
  // timestamp and rejects the signature. Replace them with '%20'.
  formData = formData.replace(/action="([^"]+)"/, (match, url) => {
    return `action="${url.replace(/\+/g, '%20')}"`;
  });

  // Wrap in a UTF-8 document so the browser submits the form with the correct
  // encoding and the Chinese subject is not mangled.
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${formData}</body></html>`;
}

/**
 * Create an Alipay face-to-face (precreate) order and return a QR code string.
 * @param {string} tradeNo - Merchant order number
 * @param {number} amount - Order amount
 * @param {string} subject - Order subject / title
 * @param {string} notifyUrl - Async notify URL (absolute)
 * @param {object} config - Channel config { appId, privateKey, alipayPublicKey, gateway }
 * @returns {Promise<{qrCode: string, tradeNo: string}>}
 */
async function createQrOrder(tradeNo, amount, subject, notifyUrl, config) {
  const sdk = createSdk(config);
  if (!sdk) {
    throw new Error('Alipay SDK not configured');
  }

  const result = await withRetry(() => sdk.exec('alipay.trade.precreate', {
    notify_url: notifyUrl,
    bizContent: {
      outTradeNo: tradeNo,
      totalAmount: String(amount),
      subject: subject || 'Workspace 余额充值',
    },
  }));

  if (!result || result.code !== '10000' || !result.qrCode) {
    throw new Error(result?.msg || 'Alipay precreate failed');
  }

  return { qrCode: result.qrCode, tradeNo };
}

/**
 * Verify Alipay notification / callback signature.
 * @param {object} signData - Request body (POST notify) or query object (GET callback)
 * @param {object} config - Channel config { appId, privateKey, alipayPublicKey, gateway }
 * @returns {boolean}
 */
function verifyNotify(signData, config) {
  const sdk = createSdk(config);
  if (!sdk) return false;
  return sdk.checkNotifySign(signData);
}

module.exports = {
  isConfigured,
  createOrder,
  createQrOrder,
  verifyNotify,
};
