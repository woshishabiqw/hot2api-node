const axios = require('axios');
const db = require('../config/database');

class KeyChecker {
  /**
   * 统一更新源站检测结果，保留 HTTP 状态码与详细错误信息供前端 tooltip 展示。
   */
  async _updateSourceCheck(sourceId, status, statusCode, detail) {
    const detailText = detail && String(detail).length > 500 ? String(detail).slice(0, 500) + '...' : detail;
    await db.run(
      `UPDATE sources SET status = ?, last_check_at = datetime('now'), last_check_status_code = ?, last_check_detail = ? WHERE id = ?`,
      [status, statusCode ?? null, detailText ?? null, sourceId]
    );
  }

  async checkSource(sourceId, forceModelId = null) {
    const source = await db.get('SELECT * FROM sources WHERE id = ?', [sourceId]);

    if (!source) {
      return { valid: false, error: 'Source not found' };
    }

    const apiKey = db.getApiKey(source, source.protocol);
    const headers = {
      'Content-Type': 'application/json'
    };

    let endpoint;
    let testPayload;

    if (source.protocol === 'gemini') {
      // Gemini: POST /v1beta/models/{model}:generateContent
      const baseUrl = db.getApiUrl(source, 'gemini');
      const separator = baseUrl.includes('?') ? '&' : '?';
      endpoint = `${baseUrl}/v1beta/models/gemini-2.0-flash:generateContent${separator}key=${apiKey}`;
      testPayload = {
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 }
      };
    } else if (source.protocol === 'bedrock') {
      // Bedrock: Just check if credentials are valid by making a minimal request
      // We'll use the proxy's signing mechanism, so for now just mark as unknown
      await this._updateSourceCheck(sourceId, 'unknown', null, 'Bedrock 密钥检测尚未实现');
      return { valid: true, status: 'unknown', note: 'Bedrock key check not yet implemented' };
    } else if (source.protocol === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      endpoint = `${db.getApiUrl(source, 'anthropic').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`;
      // Use forced model, otherwise the first available model from this source for testing, fallback to common names
      const testModel = forceModelId
        ? { source_model_id: forceModelId }
        : await db.get(
            'SELECT source_model_id, model_id FROM models WHERE source_id = ? AND is_active = true LIMIT 1',
            [sourceId]
          );
      testPayload = {
        model: testModel?.source_model_id || testModel?.model_id || 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      };
    } else {
      // OpenAI-compatible: build endpoint list and auth variants
      const baseUrl = db.getApiUrl(source, 'openai').replace(/\/+$/, '');
      const endpoints = [
        `${baseUrl}/chat/completions`,
        `${baseUrl}/v1/chat/completions`,
      ];
      if (baseUrl.endsWith('/v1')) {
        const stripped = baseUrl.replace(/\/v1$/, '');
        endpoints.push(`${stripped}/chat/completions`);
        endpoints.push(`${stripped}/v1/chat/completions`);
      }
      // Also try /v1/messages for Anthropic-compatible endpoints
      endpoints.push(`${baseUrl}/v1/messages`);
      if (baseUrl.endsWith('/v1')) {
        const stripped = baseUrl.replace(/\/v1$/, '');
        endpoints.push(`${stripped}/v1/messages`);
      }
      endpoint = endpoints;
      // Use forced model, otherwise the source's first active model instead of a hardcoded test model,
      // because upstreams may rate-limit or reject models they don't actually serve.
      const testModel = forceModelId
        ? { source_model_id: forceModelId }
        : await db.get(
            'SELECT source_model_id, model_id FROM models WHERE source_id = ? AND is_active = true LIMIT 1',
            [sourceId]
          );
      testPayload = {
        model: testModel?.source_model_id || testModel?.model_id || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10
      };
    }

    // Try multiple endpoints if provided as array
    const endpointsToTry = Array.isArray(endpoint) ? endpoint : [endpoint];
    // Auth variants to try (similar to fetchModels)
    const authVariants = source.protocol === 'anthropic' ? [headers] : [
      { ...headers, 'Authorization': `Bearer ${apiKey}` },
      { ...headers, 'x-api-key': apiKey },
    ];
    if (process.env.LOG_LEVEL === 'debug') console.log(`[KeyChecker] Source ${sourceId} (${source.protocol}): trying ${endpointsToTry.length} endpoints x ${authVariants.length} auth methods`);
    let lastError = null;

    for (const ep of endpointsToTry) {
      for (const authHeaders of authVariants) {
      try {
        if (process.env.LOG_LEVEL === 'debug') console.log(`[KeyChecker] Trying: ${ep}`);
        const response = await axios.post(ep, testPayload, {
          headers: authHeaders,
          timeout: 15000,
          validateStatus: () => true
        });
        const statusCode = response.status;

        if (statusCode === 200) {
          await this._updateSourceCheck(sourceId, 'valid', 200, 'Key/网络检测正常');
          return { valid: true, status: 'valid', usage: response.data?.usage };
        } else if (statusCode === 400) {
          const errData = response.data?.error || {};
          const errText = [errData.message, errData.param, errData.code].filter(Boolean).join(' ');
          if (errText.toLowerCase().includes('model') || errText.includes('模型') || errText.toLowerCase().includes('param incorrect')) {
            await this._updateSourceCheck(sourceId, 'valid', 400, 'Key 有效但测试模型不受支持，请导入可用模型');
            return { valid: true, status: 'valid', note: 'Key valid but test model not supported. Import models to use.' };
          }
          lastError = { statusCode, message: errText || 'Bad request' };
        } else if (statusCode === 401) {
          await this._updateSourceCheck(sourceId, 'invalid', 401, 'API Key 无效或已过期');
          return { valid: false, status: 'invalid', error: 'API Key is invalid or expired' };
        } else if (statusCode === 402 || statusCode === 429) {
          const errBody = response.data?.error?.message || response.data?.message || '';
          // 429 with "overloaded" is a transient upstream capacity issue, not balance/rate-limit
          if (statusCode === 429 && /overloaded|too many requests|capacity/i.test(errBody)) {
            await this._updateSourceCheck(sourceId, 'unavailable', 429, `源站暂时过载：${errBody || '上游容量不足'}`);
            return { valid: false, status: 'unavailable', error: '源站暂时过载，请稍后重试' };
          }
          await this._updateSourceCheck(sourceId, 'insufficient', statusCode, `余额不足或触发限速：${errBody || `HTTP ${statusCode}`}`);
          return { valid: false, status: 'insufficient', error: 'Insufficient balance or rate limit exceeded' };
        } else if (statusCode === 403) {
          await this._updateSourceCheck(sourceId, 'valid', 403, 'Key 有效但访问受限，可能需要更换模型或端点');
          return { valid: true, status: 'valid', note: 'Key valid but access restricted. May need different model or endpoint.' };
        } else if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
          const errBody = response.data?.error?.message || response.data?.message || '';
          if (process.env.LOG_LEVEL === 'debug') console.log(`[KeyChecker] ${statusCode} at ${ep}: ${errBody}`);
          // Check if error is model-related (key is valid but model not found)
          if (errBody.toLowerCase().includes('model') || errBody.includes('模型') || errBody.toLowerCase().includes('not found')) {
            await this._updateSourceCheck(sourceId, 'valid', statusCode, 'Key 有效但测试模型不受支持，请导入可用模型');
            return { valid: true, status: 'valid', note: 'Key valid but test model not supported. Import models to use.' };
          }
          lastError = { statusCode, message: errBody || `Service Unavailable (${statusCode})` };
          continue; // try next endpoint
        } else if (statusCode === 404) {
          const errBody = response.data?.error?.message || response.data?.message || '';
          if (process.env.LOG_LEVEL === 'debug') console.log(`[KeyChecker] 404 at ${ep}: ${errBody}`);
          // Some APIs return 404 with model-related message when key is valid but model not found
          if (errBody.toLowerCase().includes('model') || errBody.includes('模型') || errBody.toLowerCase().includes('not found the model')) {
            await this._updateSourceCheck(sourceId, 'valid', statusCode, 'Key 有效但测试模型不受支持，请导入可用模型');
            return { valid: true, status: 'valid', note: 'Key valid but test model not supported. Import models to use.' };
          }
          lastError = { statusCode, message: errBody || 'Endpoint not found' };
          continue; // try next endpoint
        } else {
          lastError = { statusCode, message: `Unexpected status ${statusCode}` };
        }
      } catch (error) {
        lastError = { statusCode: error.response?.status, message: error?.message };
        if (error.response?.status === 404) continue; // try next endpoint
      }
      } // end authVariants loop
    }

    // All endpoints failed
    if (process.env.LOG_LEVEL === 'debug') console.log(`[KeyChecker] All endpoints failed for source ${sourceId}. Last error:`, lastError);
    const allTried = endpointsToTry.join(', ');
    let status, message;
    if (lastError?.statusCode === 404) {
      status = 'error';
      message = `所有端点均返回404，请检查base_url和协议设置。已尝试: ${allTried}`;
    } else if ([502, 503, 504].includes(lastError?.statusCode)) {
      status = 'unavailable';
      message = `源站暂时不可用 (${lastError.statusCode})。已尝试: ${allTried}`;
    } else {
      status = 'unknown';
      message = lastError?.message || 'Request failed';
    }
    await this._updateSourceCheck(sourceId, status, lastError?.statusCode, message);
    return { valid: false, status, statusCode: lastError?.statusCode, error: message };
  }

  async checkAllSources() {
    const sources = await db.all('SELECT id FROM sources WHERE is_active = true');
    const results = [];

    for (const source of sources) {
      const result = await this.checkSource(source.id);
      results.push({ id: source.id, ...result });
    }

    return results;
  }

  async fetchModels(sourceId) {
    const source = await db.get('SELECT * FROM sources WHERE id = ?', [sourceId]);

    if (!source) {
      return { error: 'Source not found' };
    }

    // 按优先级尝试各协议获取模型：openai → anthropic → gemini → bedrock
    const tryProtocols = ['openai', 'anthropic', 'gemini', 'bedrock'];

    for (const proto of tryProtocols) {
      const protoKey = db.getApiKey(source, proto);
      const protoUrl = db.getApiUrl(source, proto);
      if (!protoKey || !protoUrl) continue;

      if (proto === 'bedrock') {
        continue; // Bedrock 不支持自动获取
      }

      if (proto === 'gemini') {
        try {
          const geminiUrl = protoUrl;
          const separator = geminiUrl.includes('?') ? '&' : '?';
          const endpoint = `${geminiUrl}/v1beta/models${separator}key=${protoKey}`;
          const response = await axios.get(endpoint, { timeout: 10000 });
          let rawModels = response.data?.models || [];
          const models = rawModels.map(m => {
            if (typeof m === 'string') return { id: m };
            return { id: m.name || m.id, ...m };
          }).filter(m => m.id);
          if (models.length > 0) return { success: true, models, detectedProtocol: 'gemini' };
        } catch (e) { /* try next */ }
        continue;
      }

      if (proto === 'anthropic') {
        const baseUrl = protoUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const domainRoot = baseUrl.replace(/\/[^\/]+$/, '');
        const urlVariants = [
          `${baseUrl}/v1/models`, `${baseUrl}/models`,
          `${domainRoot}/v1/models`, `${domainRoot}/models`,
        ];
        const authVariants = [
          { 'x-api-key': protoKey, 'anthropic-version': '2023-06-01' },
          { 'Authorization': `Bearer ${protoKey}` },
        ];
        for (const url of urlVariants) {
          for (const auth of authVariants) {
            try {
              const response = await axios.get(url, { headers: auth, timeout: 10000 });
              let rawModels = response.data?.data || response.data?.models || [];
              const models = rawModels.map(m => {
                if (typeof m === 'string') return { id: m };
                return { id: m.id || m.name, ...m };
              }).filter(m => m.id);
              if (models.length > 0) return { success: true, models, detectedProtocol: 'anthropic' };
            } catch (e) { /* try next */ }
          }
        }
        continue;
      }

      // openai
      const baseUrl = protoUrl.replace(/\/+$/, '');
      const urlVariants = [`${baseUrl}/models`, `${baseUrl}/v1/models`];
      if (baseUrl.endsWith('/v1')) {
        const stripped = baseUrl.replace(/\/v1$/, '');
        urlVariants.push(`${stripped}/models`, `${stripped}/v1/models`);
      }
      const authVariants = [
        { 'Authorization': `Bearer ${protoKey}` },
        { 'x-api-key': protoKey },
      ];
      for (const url of urlVariants) {
        for (const auth of authVariants) {
          try {
            let allModels = [];
            let cursor = null;
            let pageNum = 0;
            const maxPages = 20;
            do {
              const pageUrl = cursor ? `${url}?after=${cursor}&limit=100` : url;
              const response = await axios.get(pageUrl, { headers: auth, timeout: 8000 });
              let rawModels = response.data?.data || response.data?.models || [];
              const models = rawModels.map(m => {
                if (typeof m === 'string') return { id: m };
                return { id: m.id || m.name, ...m };
              }).filter(m => m.id);
              allModels.push(...models);
              const hasMore = response.data?.has_more === true;
              cursor = hasMore && models.length > 0 ? models[models.length - 1].id : null;
              pageNum++;
            } while (cursor && pageNum < maxPages);
            if (allModels.length > 400) allModels = allModels.slice(0, 400);
            if (allModels.length > 0) return { success: true, models: allModels, detectedProtocol: 'openai' };
          } catch (e) { /* try next */ }
        }
      }
    }

    return { error: '无法自动获取模型列表，请手动添加模型' };
  }

  /**
   * 不消耗 Token 的模型存在性检查：调用上游 /models 列表确认模型是否存在。
   * @param {object} source - sources 表行（包含 protocol/api_key/api_urls/base_url）
   * @param {string} modelId - 要检查的模型ID（优先 source_model_id）
   * @returns {Promise<{status:'ok'|'not_found'|'error'|'unsupported', latencyMs:number, error?:string}>}
   */
  async validateModelExists(source, modelId) {
    if (!source || !modelId) {
      return { status: 'error', latencyMs: 0, error: '缺少源站或模型ID' };
    }

    const protocol = source.protocol || 'openai';
    if (protocol === 'bedrock') {
      return { status: 'unsupported', latencyMs: 0, error: 'Bedrock 暂不支持模型存在性检查' };
    }

    const apiUrl = db.getApiUrl(source, protocol);
    const key = db.getApiKey(source, protocol);
    if (!apiUrl || !key) {
      return { status: 'error', latencyMs: 0, error: `缺少 ${protocol} 协议的 URL 或 Key` };
    }

    const start = Date.now();
    let matched = false;
    let lastError = null;

    try {
      if (protocol === 'gemini') {
        const baseUrl = apiUrl.replace(/\/+$/, '');
        const separator = baseUrl.includes('?') ? '&' : '?';
        const url = `${baseUrl}/v1beta/models${separator}key=${key}`;
        try {
          const response = await axios.get(url, { timeout: 10000 });
          const list = response.data?.models || [];
          matched = list.some(m => {
            const id = m.name || m.id || '';
            return id === modelId || id === `models/${modelId}` || id.endsWith(`/${modelId}`);
          });
        } catch (e) { lastError = e; }
      } else if (protocol === 'anthropic') {
        const baseUrl = apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const urlVariants = [`${baseUrl}/v1/models`, `${baseUrl}/models`];
        const authVariants = [
          { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          { 'Authorization': `Bearer ${key}` }
        ];
        for (const url of urlVariants) {
          for (const auth of authVariants) {
            try {
              const response = await axios.get(url, { headers: auth, timeout: 10000 });
              const list = response.data?.data || response.data?.models || [];
              matched = list.some(m => (m.id || m.name) === modelId);
              if (matched) break;
            } catch (e) { lastError = e; }
          }
          if (matched) break;
        }
      } else {
        // openai / relay
        const baseUrl = apiUrl.replace(/\/+$/, '');
        const urlVariants = [`${baseUrl}/models`, `${baseUrl}/v1/models`];
        if (baseUrl.endsWith('/v1')) {
          const stripped = baseUrl.replace(/\/v1$/, '');
          urlVariants.push(`${stripped}/models`, `${stripped}/v1/models`);
        }
        const authVariants = [
          { 'Authorization': `Bearer ${key}` },
          { 'x-api-key': key }
        ];
        for (const url of urlVariants) {
          for (const auth of authVariants) {
            try {
              const response = await axios.get(url, { headers: auth, timeout: 10000 });
              const list = response.data?.data || response.data?.models || [];
              matched = list.some(m => (m.id || m.name) === modelId);
              if (matched) break;
            } catch (e) { lastError = e; }
          }
          if (matched) break;
        }
      }
    } catch (e) {
      lastError = e;
    }

    const latencyMs = Date.now() - start;
    if (matched) {
      return { status: 'ok', latencyMs };
    }
    if (lastError) {
      const msg = lastError.response?.data?.error?.message
        || lastError.response?.data?.message
        || lastError.message
        || String(lastError);
      return { status: 'error', latencyMs, error: msg };
    }
    return { status: 'not_found', latencyMs, error: '模型不在上游模型列表中' };
  }
}

module.exports = new KeyChecker();
