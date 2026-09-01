/**
 * Web Chat API - JWT authenticated chat completions for the user portal.
 *
 * This route lets logged-in users chat directly from the browser without
 * creating an API key. It reuses the existing proxyChat pipeline so that
 * streaming, billing, logging, and model dispatch remain consistent with
 * the API-key path. The only differences are:
 *   - Authentication uses JWT (authMiddleware) instead of API keys.
 *   - Logs are tagged with client_type = 'webchat'.
 */

const express = require('express');
const db = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const proxyService = require('../services/proxy');
const currencyService = require('../services/currency');
const webChatConfig = require('../services/webChatConfig');
const { testSearch } = require('../services/webSearchTester');
const webSearchPlanner = require('../services/webSearchPlanner');

const router = express.Router();
const OVERDRAFT_CNY = 10;

async function getCachedExchangeRate() {
  try {
    return await currencyService.getExchangeRate();
  } catch {
    return 7.25;
  }
}

/**
 * Build an apiKey-shaped object from the logged-in user so that the proxy
 * logging / billing code can stay unchanged.
 */
async function buildWebChatApiKey(userId) {
  const user = await db.get(
    'SELECT id, username, role, currency, quota_type, quota_limit, quota_used, balance, total_tokens, total_requests, total_cost FROM users WHERE id = ? AND is_active = true',
    [userId]
  );
  if (!user) return null;

  return {
    id: null,
    userId: user.id,
    username: user.username,
    role: user.role,
    quotaLimit: Number(user.quota_limit) || 0,
    quotaUsed: Number(user.quota_used) || 0,
    keyQuotaLimit: Number(user.quota_limit) || 0,
    keyQuotaUsed: Number(user.quota_used) || 0,
    quotaType: user.quota_type || 'currency',
    rateLimit: 60,
    maxConcurrent: 500,
    currentConcurrent: 0,
    modelLimit: 'all',
    groupLimit: 'all',
    workspaceId: null,
    currency: user.currency || 'CNY',
    userCurrency: user.currency || 'CNY',
    balance: Number(user.balance) || 0,
    totalTokens: Number(user.total_tokens) || 0,
    totalRequests: Number(user.total_requests) || 0,
    totalCost: Number(user.total_cost) || 0,
    clientType: 'webchat'
  };
}

async function checkUserQuota(user) {
  const OVERDRAFT_CNY = 10;
  const userCurrency = user.currency || 'CNY';
  const exchangeRate = await getCachedExchangeRate();
  const overdraftLimit = userCurrency === 'USD' ? OVERDRAFT_CNY / exchangeRate : OVERDRAFT_CNY;

  const userLimit = Number(user.quota_limit) || 0;
  const quotaUsedUser = Number(user.quota_used) || 0;

  // Monetary quota check
  if (userLimit !== 0 && quotaUsedUser >= userLimit + overdraftLimit) {
    return {
      ok: false,
      status: 429,
      error: {
        message: `账户额度已用尽（含透支${userCurrency === 'USD' ? '$' : '¥'}${overdraftLimit.toFixed(2)}），当前已用 ${quotaUsedUser.toFixed(4)} / ${userLimit.toFixed(4)}`,
        type: 'quota_exceeded'
      }
    };
  }

  // Balance check
  const userBalance = Number(user.balance) || 0;
  if (userBalance + overdraftLimit <= 0) {
    return {
      ok: false,
      status: 429,
      error: {
        message: `账户余额不足（含透支${userCurrency === 'USD' ? '$' : '¥'}${overdraftLimit.toFixed(2)}），当前余额 ${userBalance.toFixed(4)}`,
        type: 'insufficient_balance'
      }
    };
  }

  return { ok: true };
}

/**
 * POST /api/chat
 * Body: { model, messages, stream?, temperature?, ... }
 * Returns: text/event-stream when stream=true, otherwise JSON completion.
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, username, role, currency, quota_type, quota_limit, quota_used, balance FROM users WHERE id = ? AND is_active = true',
      [req.user.id]
    );
    if (!user) {
      return res.status(401).json({ error: '用户不存在或已被禁用' });
    }

    const quotaCheck = await checkUserQuota(user);
    if (!quotaCheck.ok) {
      return res.status(quotaCheck.status).json({ error: quotaCheck.error });
    }

    const { model, messages, stream = true, reasoning, ...extra } = req.body;
    if (!model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages is required and must be an array', type: 'invalid_request_error' } });
    }

    // Reuse proxy pipeline by presenting an apiKey-shaped object.
    req.apiKey = await buildWebChatApiKey(req.user.id);
    req.clientType = 'webchat';

    const isStream = stream !== false;
    const useWebSearch = extra.web_search === true || req.body.web_search === true;

    if (useWebSearch) {
      const cfg = await webChatConfig.getConfig();
      if (cfg.search_enabled && cfg.search_provider && cfg.search_provider !== 'none') {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.status(200);
        if (res.flushHeaders) res.flushHeaders();

        try {
          await webSearchPlanner.streamSearchChat(res, {
            model,
            messages,
            reasoning: reasoning === true,
            userId: req.user.id,
          });
        } catch (err) {
          console.error('[chat] streaming search agent error:', err?.message);
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: { message: err.message || '搜索失败', type: 'search_error' } })}
\n`);
            res.end();
          }
        }
        return;
      }
    }

    // Build OpenAI-compatible request body for the proxy.
    // Always include an explicit boolean so upstream providers don't default
    // to reasoning when the user toggles it off.
    const { web_search, ...cleanExtra } = extra;
    req.body = {
      model,
      messages,
      stream: isStream,
      reasoning: reasoning === true,
      ...cleanExtra
    };
    if (isStream) {
      req.body.stream_options = { include_usage: true };
    }

    console.log('[chat] proxy request', {
      userId: req.user.id,
      username: req.user.username,
      model,
      messageCount: messages.length,
      stream: isStream,
      reasoning: reasoning === true,
      useWebSearch,
    });

    return proxyService.proxyChat(req, res, 'openai');
  } catch (err) {
    console.error('[chat] Unexpected error:', err?.message, err?.stack);
    if (!res.headersSent) {
      return res.status(500).json({ error: { message: 'Internal server error', type: 'internal_server_error' } });
    }
  }
});

/**
 * GET /api/chat/config
 * Public-safe web chat defaults for the user portal.
 */
router.get('/config', authMiddleware, async (req, res) => {
  try {
    const cfg = await webChatConfig.getConfig();
    res.json({
      default_model: cfg.default_model,
      reasoning_default: cfg.reasoning_default,
      search_provider: cfg.search_provider,
      search_max_steps: cfg.search_max_steps,
      search_enabled: cfg.search_enabled,
    });
  } catch (err) {
    console.error('[chat] Failed to get config:', err?.message);
    res.status(500).json({ error: 'Failed to get chat config' });
  }
});

/**
 * POST /api/chat/search
 * Perform a web search using the configured provider and return a safe preview.
 */
router.post('/search', authMiddleware, async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query is required' });
    }
    const cfg = await webChatConfig.getConfig();
    const result = await testSearch({ query });
    console.log('[chat] search probe', {
      userId: req.user.id,
      username: req.user.username,
      query,
      provider: cfg.search_provider,
      ok: result.ok,
      previewLength: result.preview?.length || 0,
      latencyMs: result.latency_ms,
      error: result.error,
    });
    res.json({ success: result.ok, result });
  } catch (err) {
    console.error('[chat] Search failed:', err?.message);
    res.status(500).json({ error: err.message || 'Search failed' });
  }
});

/**
 * GET /api/chat/models
 * List active models available for web chat.
 */
router.get('/models', authMiddleware, async (req, res) => {
  try {
    const models = await db.all(`
      SELECT m.id, m.model_id, m.model_alias, m.input_price, m.output_price, m.max_tokens, m.is_vision, m.supports_tools, m.description
      FROM models m
      JOIN sources s ON m.source_id = s.id
      WHERE m.is_active = true AND s.is_active = true
      ORDER BY m.priority DESC, m.model_id ASC
    `);
    res.json(models || []);
  } catch (err) {
    console.error('[chat] Failed to list models:', err?.message);
    res.status(500).json({ error: 'Failed to list models' });
  }
});

/**
 * GET /api/chat/models/:model/latency
 * Lightweight latency probe for a model. Returns { ms }.
 *
 * We avoid doing a real chat completion to prevent billing. Instead we time
 * a tiny HTTP round-trip to the selected upstream base URL.
 */
router.get('/models/:model/latency', authMiddleware, async (req, res) => {
  try {
    const { model } = req.params;
    const dispatcher = require('../services/dispatcher');
    const axios = require('axios');

    const start = Date.now();
    const source = await dispatcher.selectSource(model, 'openai');
    if (!source) {
      return res.json({ ms: null, error: 'No available source' });
    }

    const baseUrl = (source.base_url || '').replace(/\/$/, '');
    const probeUrl = `${baseUrl}/v1/models`;
    const headers = { Authorization: `Bearer ${source.api_key || ''}` };

    try {
      await axios.get(probeUrl, { headers, timeout: 5000, validateStatus: () => true });
    } catch {
      // Even if the endpoint returns 4xx/5xx, we still got a network response.
    }

    return res.json({ ms: Date.now() - start });
  } catch (err) {
    console.error('[chat] Latency probe failed:', err?.message);
    return res.json({ ms: null, error: err.message });
  }
});

module.exports = router;
