const db = require('../config/database');
const dispatcher = require('./dispatcher');
const ProxyBase = require('./proxy-base');
const { v4: uuidv4 } = require('uuid');
const { requestContext } = require('./transit-scanner');
const proxyOpenAI = require('./proxy-openai');
const proxyAnthropic = require('./proxy-anthropic');
const proxyGemini = require('./proxy-gemini');
const proxyBedrock = require('./proxy-bedrock');
const proxyRelay = require('./proxy-relay');

class ProxyService extends ProxyBase {
  /**
   * 智能检测源站原生协议
   * 如果源站的 api_urls 中明确配置了客户端协议的 URL，优先用客户端协议直连
   * 否则回退到 source.protocol（用户配置时自动检测的结果）
   */
  _detectSourceProtocol(source, clientProtocol) {
    // 如果是 relay 模式，直接返回
    if (source.protocol === 'relay') return 'relay';

    // 如果源站 api_urls 中配置了客户端协议的 URL，说明源站原生支持该协议，直接直连
    if (clientProtocol && source.api_urls) {
      try {
        const urls = typeof source.api_urls === 'string' ? JSON.parse(source.api_urls) : source.api_urls;
        if (urls[clientProtocol]) return clientProtocol;
      } catch (e) {}
    }

    return source.protocol || 'openai';
  }

  async proxyChat(req, res, protocol) {
    const requestUuid = uuidv4();
    return requestContext.run({ requestUuid, clientType: req.clientType || req.apiKey?.clientType || 'apikey' }, () => this._proxyChat(req, res, protocol, requestUuid));
  }

  async _proxyChat(req, res, protocol, requestUuid) {
    const startTime = Date.now();
    const clientProtocol = protocol || 'openai';
    const { model } = req.body;
    req.requestUuid = requestUuid;
    if (process.env.LOG_LEVEL === 'debug') console.log(`[proxyChat] called protocol=${protocol} model=${model}`);

    if (!model) {
      if (process.env.LOG_LEVEL === 'debug') console.log('[proxyChat] missing model');
      return res.status(400).json({
        error: { message: 'model is required', type: 'invalid_request_error' }
      });
    }

    const source = await dispatcher.selectSource(model, protocol || 'openai');
    if (process.env.LOG_LEVEL === 'debug') console.log(`[proxyChat] selected source=${source ? source.name : 'null'} protocol=${source?.protocol}`);
    if (!source) {
      return res.status(503).json({
        error: { message: 'No available source for this model', type: 'service_unavailable' }
      });
    }

    // Wait for available slot if source is at max concurrency
    // Note: each proxy file manages its own tryIncrementConcurrent/decrementConcurrent
    // We only wait here to avoid hammering the proxy with requests that will immediately fail
    if (source.queueWait) {
      if (process.env.LOG_LEVEL === 'debug') console.log(`[proxy] Source ${source.name} at max concurrency, waiting for slot...`);
      const waitResult = await this._waitForSlot(source.id, source.max_concurrent, 30000);
      if (!waitResult) {
        return res.status(503).json({
          error: { message: 'Source at max concurrency, timed out waiting for slot', type: 'service_unavailable' }
        });
      }
      // Slot is now available, but let the proxy file call tryIncrementConcurrent itself
    }

    // relay 模式：透传，不做任何转换
    if (source.protocol === 'relay') {
      return proxyRelay.proxy(req, res, source, startTime, `${clientProtocol}→relay`);
    }

    // 智能检测源站原生协议（考虑 api_urls 中是否支持客户端协议直连）
    const sourceProtocol = this._detectSourceProtocol(source, clientProtocol);

    // 客户端协议 = 源站协议 → 直连
    if (clientProtocol === sourceProtocol) {
      return this._dispatch(sourceProtocol, req, res, source, startTime, `${clientProtocol}→${sourceProtocol}`);
    }

    // 客户端协议 ≠ 源站协议 → 自动转换
    // 注：用量明细协议列统一使用「客户端协议→源站协议」格式，用户一眼看出自己用的什么协议、走了哪个源站
    // Anthropic 客户端 → 各种源站
    if (clientProtocol === 'anthropic' && sourceProtocol === 'openai') {
      return proxyOpenAI.proxyWithConversion(req, res, source, startTime, 'anthropic→openai');
    }
    if (clientProtocol === 'anthropic' && sourceProtocol === 'gemini') {
      return proxyGemini.proxyWithConversion(req, res, source, startTime, 'anthropic→gemini');
    }
    if (clientProtocol === 'anthropic' && sourceProtocol === 'bedrock') {
      return proxyBedrock.proxyWithConversion(req, res, source, startTime, 'anthropic→bedrock');
    }
    // OpenAI 客户端 → Anthropic 源站
    if (clientProtocol === 'openai' && sourceProtocol === 'anthropic') {
      return proxyAnthropic.proxyWithConversion(req, res, source, startTime, 'openai→anthropic');
    }
    // OpenAI 客户端 → Gemini/Bedrock（proxy 内部已处理 OpenAI → 原生格式）
    if (clientProtocol === 'openai' && (sourceProtocol === 'gemini' || sourceProtocol === 'bedrock')) {
      return this._dispatch(sourceProtocol, req, res, source, startTime, `${clientProtocol}→${sourceProtocol}`);
    }

    // 兜底：直接 dispatch
    return this._dispatch(sourceProtocol, req, res, source, startTime, `${clientProtocol}→${sourceProtocol}`);
  }

  _dispatch(protocol, req, res, source, startTime, clientProtocol) {
    switch (protocol) {
      case 'anthropic':
        return proxyAnthropic.proxy(req, res, source, startTime, clientProtocol);
      case 'gemini':
        return proxyGemini.proxy(req, res, source, startTime, clientProtocol);
      case 'bedrock':
        return proxyBedrock.proxy(req, res, source, startTime, clientProtocol);
      default:
        return proxyOpenAI.proxy(req, res, source, startTime, clientProtocol);
    }
  }

  async proxyCompletions(req, res) {
    const requestUuid = uuidv4();
    return requestContext.run({ requestUuid, clientType: req.clientType || req.apiKey?.clientType || 'apikey' }, () => proxyOpenAI.proxyCompletions(req, res));
  }

  async proxyImage(req, res) {
    const requestUuid = uuidv4();
    req.requestUuid = requestUuid;
    return requestContext.run({ requestUuid, clientType: req.clientType || req.apiKey?.clientType || 'apikey' }, () => this._proxyImage(req, res));
  }

  async _proxyImage(req, res) {
    const startTime = Date.now();
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({
        error: { message: 'model is required', type: 'invalid_request_error' }
      });
    }

    const source = await dispatcher.selectSource(model);
    if (!source) {
      return res.status(503).json({
        error: { message: 'No available source for this model', type: 'service_unavailable' }
      });
    }

    // Wait for available slot if source is at max concurrency
    if (source.queueWait) {
      if (process.env.LOG_LEVEL === 'debug') console.log(`[proxy-image] Source ${source.name} at max concurrency, waiting for slot...`);
      const waitResult = await this._waitForSlot(source.id, source.max_concurrent, 30000);
      if (!waitResult) {
        return res.status(503).json({
          error: { message: 'Source at max concurrency, timed out waiting for slot', type: 'service_unavailable' }
        });
      }
      // Slot is now available, but let the proxy file call tryIncrementConcurrent itself
    }

    return proxyOpenAI.proxyImage(req, res, source, startTime);
  }

  async proxyTTS(req, res) {
    const requestUuid = uuidv4();
    return requestContext.run({ requestUuid, clientType: req.clientType || req.apiKey?.clientType || 'apikey' }, () => proxyOpenAI.proxyTTS(req, res));
  }

  async listModels(req, res) {
    try {
      const models = await db.all(`
        SELECT m.*, s.name as source_name, s.protocol, s.status as source_status
        FROM models m
        JOIN sources s ON m.source_id = s.id
        WHERE m.is_active = true AND s.is_active = true
        ORDER BY m.priority DESC, m.model_id
      `);

      const modelList = models.map(m => ({
        id: m.model_id,
        object: 'model',
        owned_by: m.source_name,
        alias: m.model_alias,
        max_tokens: m.max_tokens,
        is_vision: m.is_vision,
        input_price: m.input_price,
        input_price_cache: m.input_price_cache,
        output_price: m.output_price,
        supports_tools: m.supports_tools,
        supports_json: m.supports_json,
        supports_fim: m.supports_fim,
        source_status: m.source_status
      }));

      res.json({ object: 'list', data: modelList });
    } catch (error) {
      res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed') } });
    }
  }

}

module.exports = new ProxyService();
