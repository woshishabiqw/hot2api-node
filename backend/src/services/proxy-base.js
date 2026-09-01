const db = require('../config/database');
const { parseGroups } = require('../config/database');
const cacheService = require('./cache');
const cacheManager = require('./cache-manager');
const statsBuffer = require('./stats-buffer');
const dispatcher = require('./dispatcher');
const currencyService = require('./currency');
const { requestContext } = require('./transit-scanner');
const axios = require('axios');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// 全局启用 HTTP keep-alive，减少每次上游请求的 TCP 握手延迟
// High-load tuning: increased maxSockets, added timeout and free socket cleanup
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 200,
  maxFreeSockets: 50,
  timeout: 60000,
  freeSocketTimeout: 30000
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 200,
  maxFreeSockets: 50,
  timeout: 60000,
  freeSocketTimeout: 30000
});
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

// Periodic agent health cleanup: destroy stale sockets every 5 minutes
setInterval(() => {
  try {
    const httpSockets = httpAgent.sockets ? Object.keys(httpAgent.sockets).length : 0;
    const httpFree = httpAgent.freeSockets ? Object.keys(httpAgent.freeSockets).length : 0;
    const httpsSockets = httpsAgent.sockets ? Object.keys(httpsAgent.sockets).length : 0;
    const httpsFree = httpsAgent.freeSockets ? Object.keys(httpsAgent.freeSockets).length : 0;
    if (httpSockets + httpFree + httpsSockets + httpsFree > 0) {
      console.log(`[Agent] HTTP sockets: ${httpSockets} active, ${httpFree} free | HTTPS sockets: ${httpsSockets} active, ${httpsFree} free`);
    }
  } catch (e) {}
}, 5 * 60 * 1000);

class ProxyBase {
  async getModelInfo(model, sourceId) {
    const cacheKey = `model_info:${model}:${sourceId}`;
    let info = await cacheService.get(cacheKey);
    if (info) return info;

    // Try exact match first, then alias, then wildcard *
    info = await db.get(
      `SELECT m.* FROM models m WHERE m.model_id = ? AND m.source_id = ? AND m.is_active = true LIMIT 1`,
      [model, sourceId]
    );
    if (!info) {
      info = await db.get(
        `SELECT m.* FROM models m WHERE m.model_alias = ? AND m.source_id = ? AND m.is_active = true LIMIT 1`,
        [model, sourceId]
      );
    }
    if (!info) {
      info = await db.get(
        `SELECT m.* FROM models m WHERE (m.model_id = '*' OR m.model_alias = '*') AND m.source_id = ? AND m.is_active = true LIMIT 1`,
        [sourceId]
      );
    }
    // Fallback: strip auto-suffix (_2, _3) and try again (handles dispatcher routing to sibling sources)
    if (!info) {
      const baseModel = model.replace(/_\d+$/, '');
      if (baseModel !== model) {
        info = await db.get(
          `SELECT m.* FROM models m WHERE m.model_id = ? AND m.source_id = ? AND m.is_active = true LIMIT 1`,
          [baseModel, sourceId]
        );
        if (!info) {
          info = await db.get(
            `SELECT m.* FROM models m WHERE m.model_alias = ? AND m.source_id = ? AND m.is_active = true LIMIT 1`,
            [baseModel, sourceId]
          );
        }
      }
    }
    if (info) {
      info.group_rate_multiplier = await this._getGroupRate(info.model_group);
      await cacheManager.set(cacheKey, info, 300, { tags: ['proxy', `source:${sourceId}`, `model:${model}`] });
    }
    return info;
  }

  async _getGroupRate(modelGroup) {
    if (!modelGroup) return 1;
    const cacheKey = `group_rate:${modelGroup}`;
    let cached = await cacheService.get(cacheKey);
    if (cached !== null) return cached;

    const groups = parseGroups(modelGroup);
    let maxRate = 1;
    for (const g of groups) {
      const row = await db.get('SELECT rate_multiplier FROM model_groups WHERE name = ?', [g]);
      if (row && row.rate_multiplier > maxRate) maxRate = row.rate_multiplier;
    }
    await cacheManager.set(cacheKey, maxRate, 300, { tags: ['proxy', `model_group:${modelGroup}`] });
    return maxRate;
  }

  /**
   * 读取流式响应的 Buffer 内容，自动处理 gzip 解压
   * axios 的 responseType: 'stream' 不会自动解压 gzip，需要手动处理
   */
  async readStreamBuffer(stream, headers) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    let raw = Buffer.concat(chunks);
    if (headers && (headers['content-encoding'] || '').includes('gzip')) {
      try { raw = zlib.gunzipSync(raw); } catch (e) {}
    }
    return raw.toString();
  }

  /**
   * 从上游错误响应中提取人类可读的错误消息
   * 支持多种常见格式：OpenAI {error:{message}}, FastAPI {detail}, 字符串 {error}, 等
   */
  extractErrorMessage(error, fallback = 'Upstream connection failed') {
    if (!error) return fallback;
    const data = error.response?.data;
    // axios 的流式响应中 error.response.data 可能是 Gunzip/IncomingMessage 流对象，不能 JSON.stringify
    if (data && typeof data.pipe === 'function') {
      return error.message || fallback;
    }
    if (data) {
      // OpenAI / Anthropic / Gemini 标准格式
      if (data.error?.message) return data.error.message;
      if (typeof data.error === 'string') return data.error;
      if (data.message) return data.message;
      // FastAPI / 常见框架
      if (data.detail) return data.detail;
      if (data.error_msg) return data.error_msg;
      if (data.error_description) return data.error_description;
      if (data.description) return data.description;
      // DashScope
      if (data.output?.message) return data.output.message;
      // 兜底：尝试 JSON 序列化整个 data（但限制长度）
      try {
        const str = JSON.stringify(data);
        if (str && str !== '{}' && str !== 'null') return str.substring(0, 500);
      } catch (e) {
        return '[circular structure]'
      }
    }
    return error.message || fallback;
  }

  /**
   * Wait for a source to have an available concurrent slot.
   * Defined in the base class so all proxy implementations (OpenAI, Anthropic, etc.)
   * can reuse the same non-blocking wait logic.
   * @param {number} sourceId
   * @param {number} maxConcurrent
   * @param {number} timeoutMs - max wait time in ms
   * @returns {Promise<boolean>} true if slot available, false if timed out
   */
  async _waitForSlot(sourceId, maxConcurrent, timeoutMs = 30000) {
    const startTime = Date.now();
    const checkInterval = 200; // check every 200ms

    while (Date.now() - startTime < timeoutMs) {
      const available = await dispatcher.checkSlotAvailable(sourceId);
      if (available) {
        return true;
      }
      await new Promise(r => setTimeout(r, checkInterval));
    }
    return false;
  }

  cleanUndefined(obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object') this.cleanUndefined(item);
      }
    } else if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        if (obj[key] === '[undefined]' || obj[key] === undefined) {
          delete obj[key];
        } else if (obj[key] && typeof obj[key] === 'object') {
          this.cleanUndefined(obj[key]);
        }
      }
    }
  }

  async logRequest(data) {
    // 异步执行日志记录，不阻塞响应返回给客户端
    setImmediate(async () => {
      try {
        await this._doLogRequest(data);
      } catch (error) {
        console.error('[logRequest] async error:', error?.message);
      }
    });
  }

  async _doLogRequest(data) {
    let cost = 0;
    if (data.model && (data.inputTokens > 0 || data.outputTokens > 0)) {
      // 使用已缓存的 getModelInfo，避免每个请求都查 DB 定价
      let modelInfo = await this.getModelInfo(data.model, data.sourceId);

      if (!modelInfo) {
        // Fallback: use default pricing (Claude Sonnet-like: 3/15 per 1M)
        const DEFAULT_INPUT_PRICE = 3;
        const DEFAULT_OUTPUT_PRICE = 15;
        console.warn(`No model pricing found for model="${data.model}" source_id=${data.sourceId}, using defaults (in=${DEFAULT_INPUT_PRICE}, out=${DEFAULT_OUTPUT_PRICE})`);
        modelInfo = {
          input_price: DEFAULT_INPUT_PRICE,
          input_price_cache: DEFAULT_INPUT_PRICE * 0.9,
          output_price: DEFAULT_OUTPUT_PRICE,
          rate_multiplier: 1,
          group_rate_multiplier: 1
        };
      }

      if (modelInfo) {
        const modelRate = modelInfo.rate_multiplier || 1;
        const groupRate = modelInfo.group_rate_multiplier || 1;
        const inputPrice = modelInfo.input_price || 0;
        const inputPriceCache = modelInfo.input_price_cache || 0;
        const outputPrice = modelInfo.output_price || 0;

        const uncachedInput = data.uncachedTokens || data.inputTokens;
        const cachedInput = data.cachedTokens || 0;
        const cacheCreation = data.cacheCreationTokens || 0;

        cost = (
          (uncachedInput * inputPrice) +
          (cachedInput * inputPriceCache) +
          (cacheCreation * inputPrice) +
          (data.outputTokens * outputPrice)
        ) / 1000000 * modelRate * groupRate;
      }
    }

    // Convert USD cost to the user's billing currency for balance/quota deduction
    const userCurrency = (data.userCurrency || 'CNY').toUpperCase();
    const keyCurrency = (data.keyCurrency || userCurrency).toUpperCase();
    const exchangeRate = await currencyService.getExchangeRate();
    const costLocal = currencyService.convertFromUSD(cost, userCurrency, exchangeRate);
    const keyCostLocal = currencyService.convertFromUSD(cost, keyCurrency, exchangeRate);

    // 使用 StatsBuffer 批量写入 request_logs 和配额更新，避免高并发下逐请求 UPDATE 竞争
    const store = requestContext.getStore();
    statsBuffer.addLog({
      userId: data.userId || null,
      userKeyId: data.userKeyId || null,
      sourceId: data.sourceId,
      model: data.model,
      protocol: data.protocol,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      totalTokens: data.totalTokens,
      cachedTokens: data.cachedTokens || 0,
      cacheCreationTokens: data.cacheCreationTokens || 0,
      uncachedTokens: data.uncachedTokens || 0,
      statusCode: data.statusCode,
      latencyMs: data.latencyMs,
      errorMessage: data.errorMessage || null,
      cost,
      costLocal,
      hasThinking: data.hasThinking,
      instanceId: data.instanceId || null,
      workspaceId: data.workspaceId || null,
      requestUuid: data.requestUuid || store?.requestUuid || null,
      clientType: data.clientType || store?.clientType || 'apikey'
    });

    // Convert cost to integer (cents) for PostgreSQL integer columns (user_keys/sources)
    const costCents = Math.max(0, Math.round(cost * 100));
    const tokens = Math.round(data.totalTokens || 0);

    // Date buckets used by both user and source aggregations
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentHour = `${today} ${String(now.getUTCHours()).padStart(2, '0')}:00`;

    // Deduct balance/quota from the owning account only:
    // workspace keys touch the workspace balance; personal keys touch the user balance.
    if (data.workspaceId) {
      const wsFields = {};
      if (costLocal > 0) {
        wsFields.quota_used = costLocal;
        wsFields.balance = -costLocal;
      }
      if (tokens > 0) {
        wsFields.token_quota_used = tokens;
      }
      if (Object.keys(wsFields).length > 0) {
        statsBuffer.addQuota('workspaces', data.workspaceId, wsFields);
      }
    } else if (data.userId && costLocal > 0) {
      statsBuffer.addQuota('users', data.userId, { quota_used: costLocal, balance: -costLocal });
    }

    // Keep per-user cumulative dashboard stats regardless of who paid.
    if (data.userId) {
      statsBuffer.addQuota('users', data.userId, {
        total_tokens: tokens,
        total_requests: 1,
        total_cost: costLocal
      });
      // Per-user per-day per-model aggregation for fast dashboard
      statsBuffer.addDailyModelStat({
        userId: data.userId,
        date: today,
        model: data.model || 'unknown',
        requests: 1,
        tokens,
        cost,
        latencyMs: data.latencyMs || 0
      });
      statsBuffer.addHourlyModelStat({
        userId: data.userId,
        hour: currentHour,
        model: data.model || 'unknown',
        requests: 1,
        tokens,
        cost,
        latencyMs: data.latencyMs || 0
      });
    }

    // Per-source per-day/per-hour aggregation for fast admin dashboard
    if (data.sourceId) {
      statsBuffer.addSourceDailyModelStat({
        sourceId: data.sourceId,
        date: today,
        model: data.model || 'unknown',
        requests: 1,
        tokens,
        cost,
        latencyMs: data.latencyMs || 0
      });
      statsBuffer.addSourceHourlyModelStat({
        sourceId: data.sourceId,
        hour: currentHour,
        model: data.model || 'unknown',
        requests: 1,
        tokens,
        cost,
        latencyMs: data.latencyMs || 0
      });
    }

    if (data.userKeyId) {
      // quota_used 的增量在 StatsBuffer flush 时根据 key 的 quota_type 决定
      // 这里先把 tokens 和 cost 都带上，避免每请求查一次 user_keys
      statsBuffer.addQuota('user_keys', data.userKeyId, {
        total_tokens: tokens,
        _cost: keyCostLocal,
        _tokens: tokens
      });
    }

    // sources 的 total_requests/total_tokens 由 dispatcher.updateStats 批量 flush，避免重复 UPDATE
  }
}

module.exports = ProxyBase;
