const axios = require('axios');
const { Transform, pipeline } = require('stream');
const { StringDecoder } = require('string_decoder');
const db = require('../config/database');
const dispatcher = require('./dispatcher');
const ProxyBase = require('./proxy-base');
const transitScanner = require('./transit-scanner');

class ProxyAnthropic extends ProxyBase {

  // Convert OpenAI messages to Anthropic format
  _convertToAnthropic(openaiBody) {
    const messages = openaiBody.messages || [];
    let system = undefined;
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic uses top-level `system` field
        system = msg.content;
        continue;
      }
      if (msg.role === 'assistant') {
        const clean = { role: 'assistant', content: msg.content || '' };
        // Remove OpenAI-specific assistant fields
        // (reasoning_content, tool_calls: "[undefined]" etc.)
        anthropicMessages.push(clean);
      } else if (msg.role === 'user') {
        anthropicMessages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'tool') {
        // OpenAI tool result → Anthropic tool_result
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content
          }]
        });
      }
    }

    const body = {
      model: openaiBody.model,
      messages: anthropicMessages,
      max_tokens: openaiBody.max_tokens || 4096,
      stream: !!openaiBody.stream
    };

    if (system) body.system = system;
    if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature;
    if (openaiBody.top_p !== undefined) body.top_p = openaiBody.top_p;
    if (openaiBody.stop) {
      body.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
    }

    // Convert OpenAI tools to Anthropic format
    if (openaiBody.tools && openaiBody.tools !== '[undefined]') {
      body.tools = openaiBody.tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} }
      }));
    }

    // Convert tool_choice
    if (openaiBody.tool_choice && openaiBody.tool_choice !== '[undefined]') {
      if (openaiBody.tool_choice === 'auto' || openaiBody.tool_choice.type === 'auto') {
        body.tool_choice = { type: 'auto' };
      } else if (openaiBody.tool_choice.type === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (openaiBody.tool_choice.type === 'function') {
        body.tool_choice = { type: 'tool', name: openaiBody.tool_choice.function.name };
      }
    }

    return body;
  }

  // Convert Anthropic SSE stream to OpenAI SSE format
  _writeOpenAIStreamChunk(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  async proxy(req, res, source, startTime, clientProtocol) {
    if (!clientProtocol) clientProtocol = req._clientProtocol ? req._clientProtocol + '→anthropic' : 'openai→anthropic';
    req._clientProtocol = clientProtocol;
    let concurrentReleased = false;
    let isStreaming = false;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source.id).catch(() => {});
      }
    };
    try {
      if (!startTime) startTime = Date.now();

      const openaiBody = req.body;
      const model = openaiBody.model;

      // 检测输入格式：如果已经是 Anthropic 格式，直接透传
      // Anthropic 格式特征：system 是 string/array、messages 的 content 是 array of objects with type、有 thinking 参数
      const isAnthropicInput = openaiBody.system !== undefined ||
        openaiBody.thinking !== undefined ||
        openaiBody.max_tokens_to_sample !== undefined ||
        (Array.isArray(openaiBody.messages) && openaiBody.messages.some(m =>
          Array.isArray(m.content) && m.content.some(c => c.type !== undefined)
        ));

      if (isAnthropicInput) {
        return this._proxyPassthrough(req, res, source, startTime, clientProtocol);
      }

      if (!model) {
        return res.status(400).json({
          error: { message: 'model is required', type: 'invalid_request_error' }
        });
      }

      if (!source) {
        source = await dispatcher.selectSource(model);
        if (!source) {
          return res.status(503).json({
            error: { message: 'No available source for this model', type: 'service_unavailable' }
          });
        }
      }

      await dispatcher.tryIncrementConcurrent(source.id);
      const freshSource = await db.get('SELECT api_key, api_keys FROM sources WHERE id = ?', [source.id]);
      const apiKey = db.getApiKey(freshSource || source, 'anthropic');
      if (!apiKey) {
        dispatcher.decrementConcurrent(source.id).catch(() => {});
        console.error(`[proxy-anthropic] Source "${source.name}" (id=${source.id}) has no API key configured`);
        return res.status(502).json({
          error: { message: `Source "${source.name}" missing API key`, type: 'server_error' }
        });
      }
      const useStream = openaiBody.stream === true;
      const modelInfo = await this.getModelInfo(model, source.id);

      // Convert OpenAI body → Anthropic body
      this.cleanUndefined(openaiBody);
      const body = this._convertToAnthropic(openaiBody);

      // Use source_model_id for upstream API call
      if (modelInfo?.source_model_id) body.model = modelInfo.source_model_id;

      // Strip tools if needed
      if (source.strip_tools || (modelInfo && !modelInfo.supports_tools)) {
        delete body.tools;
        delete body.tool_choice;
      }

      const response = await axios.post(
        `${db.getApiUrl(source, 'anthropic').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`,
        body,
        {
          headers: {
            'x-api-key': apiKey,
            'Authorization': `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          timeout: 300000,
          responseType: useStream ? 'stream' : 'json'
        }
      );

      if (useStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let cacheCreationTokens = 0;
        let toolCalls = [];
        let currentToolIndex = -1;
        let currentToolName = '';
        let currentToolInput = '';
        let contentText = '';
        let finishReason = 'stop';
        let hasThinking = false;
        let scanBuffer = [];
        let scanBufferLen = 0;
        const MAX_SCAN_BUFFER_LEN = 131072;
        const chunkId = `chatcmpl-${Date.now()}`;

        response.data.on('error', (err) => {
          console.error('[proxy-anthropic] Upstream stream error:', err.message);
          try { res.end(); } catch (e) {}
          releaseConcurrent();
        });

        const decoder = new StringDecoder('utf8');
        response.data.on('data', (chunk) => {
          const chunkStr = decoder.write(chunk);

          // Accumulate upstream text for transit security scan (best-effort, capped)
          if (scanBufferLen < MAX_SCAN_BUFFER_LEN) {
            if (scanBufferLen + chunkStr.length > MAX_SCAN_BUFFER_LEN) {
              scanBuffer.push(chunkStr.substring(0, MAX_SCAN_BUFFER_LEN - scanBufferLen));
              scanBufferLen = MAX_SCAN_BUFFER_LEN;
            } else {
              scanBuffer.push(chunkStr);
              scanBufferLen += chunkStr.length;
            }
          }

          const lines = chunkStr.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));

              // Debug: log all event types
              if (process.env.LOG_LEVEL === "debug") console.log('[proxy-anthropic] event:', parsed.type, parsed.type === 'message_start' ? JSON.stringify(parsed).substring(0, 400) : '');

              // Try to extract usage from any event that has it
              const usage = parsed.message?.usage || parsed.usage || parsed.metadata?.usage;
              if (usage) {
                if (usage.input_tokens) inputTokens = usage.input_tokens;
                if (usage.cache_read_input_tokens) cachedTokens = usage.cache_read_input_tokens;
                if (usage.cache_creation_input_tokens) cacheCreationTokens = usage.cache_creation_input_tokens;
                if (usage.output_tokens) outputTokens = usage.output_tokens;
              }

              if (parsed.type === 'content_block_start') {
                if (parsed.content_block?.type === 'thinking') {
                  hasThinking = true;
                }
                if (parsed.content_block?.type === 'tool_use') {
                  currentToolIndex = toolCalls.length;
                  currentToolName = parsed.content_block.name;
                  currentToolInput = '';
                  toolCalls.push({
                    id: parsed.content_block.id || `call_${Date.now()}_${currentToolIndex}`,
                    type: 'function',
                    function: { name: currentToolName, arguments: '' }
                  });
                  // Send tool_calls start chunk
                  this._writeOpenAIStreamChunk(res, {
                    id: chunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: currentToolIndex, id: toolCalls[currentToolIndex].id, type: 'function', function: { name: currentToolName, arguments: '' } }] }, finish_reason: null }]
                  });
                }
              }

              if (parsed.type === 'content_block_delta') {
                if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                  contentText += parsed.delta.text;
                  this._writeOpenAIStreamChunk(res, {
                    id: chunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { content: parsed.delta.text }, finish_reason: null }]
                  });
                }
                if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
                  currentToolInput += parsed.delta.partial_json;
                  if (currentToolIndex >= 0) {
                    this._writeOpenAIStreamChunk(res, {
                      id: chunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                      choices: [{ index: 0, delta: { tool_calls: [{ index: currentToolIndex, function: { arguments: parsed.delta.partial_json } }] }, finish_reason: null }]
                    });
                  }
                }
              }

              if (parsed.type === 'content_block_stop') {
                if (currentToolName && currentToolIndex >= 0) {
                  toolCalls[currentToolIndex].function.arguments = currentToolInput;
                  currentToolName = '';
                  currentToolInput = '';
                }
              }

              if (parsed.type === 'message_delta') {
                const stopReason = parsed.delta?.stop_reason;
                if (stopReason === 'end_turn' || stopReason === 'stop_sequence') finishReason = 'stop';
                else if (stopReason === 'max_tokens') finishReason = 'length';
                else if (stopReason === 'tool_use') finishReason = 'tool_calls';
              }
            } catch (e) {}
          }
        });

        response.data.on('end', () => {
          // Send tool_calls if any
          if (toolCalls.length > 0) {
            finishReason = 'tool_calls';
          }

          // Send final chunk with finish_reason
          const finalChunk = {
            id: chunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
          };
          this._writeOpenAIStreamChunk(res, finalChunk);
          res.write('data: [DONE]\n\n');
          res.end();

          const latency = Date.now() - startTime;
          const totalTokens = inputTokens + outputTokens;
          const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
          this.logRequest({
            userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null,
            workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
            model, protocol: clientProtocol || 'anthropic',
            inputTokens, outputTokens, totalTokens,
            cachedTokens, cacheCreationTokens, uncachedTokens,
            statusCode: 200, latencyMs: latency,
            hasThinking
          });
          dispatcher.markSourceSuccess(source.id);
          dispatcher.updateStats(source.id, totalTokens);
          releaseConcurrent();
          transitScanner.scan({ rawBody: scanBuffer.join(''), req, source, statusCode: 200 }).catch(() => {});
        });

        response.data.on('error', () => { res.end(); releaseConcurrent(); });
        res.on('close', () => {
          releaseConcurrent();
        });
        isStreaming = true;
        return;
      }

      // Non-streaming: convert Anthropic response → OpenAI format
      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-anthropic] Non-streaming response:', JSON.stringify(response.data).substring(0, 800));
      const latency = Date.now() - startTime;
      const usage = response.data.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      const cachedTokens = usage.cache_read_input_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const uncachedTokens = Math.max(0, inputTokens - cachedTokens);

      // Convert Anthropic content blocks to OpenAI message
      const contentBlocks = response.data.content || [];
      let content = '';
      const toolCalls = [];
      let hasThinking = false;
      for (const block of contentBlocks) {
        if (block.type === 'thinking') hasThinking = true;
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
          });
        }
      }

      const stopReason = response.data.stop_reason;
      let finishReason = 'stop';
      if (stopReason === 'max_tokens') finishReason = 'length';
      else if (stopReason === 'tool_use') finishReason = 'tool_calls';

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: toolCalls.length > 0
            ? { role: 'assistant', content: null, tool_calls: toolCalls }
            : { role: 'assistant', content },
          finish_reason: finishReason
        }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens }
      };

      this.logRequest({
        userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null,
            workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model, protocol: clientProtocol || 'anthropic',
        inputTokens, outputTokens, totalTokens,
        cachedTokens, cacheCreationTokens, uncachedTokens,
        statusCode: 200, latencyMs: latency,
        hasThinking
      });

      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
      res.json(openaiResponse);
      transitScanner.scan({ rawBody: JSON.stringify(response.data), req, source, statusCode: 200 }).catch(() => {});
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      const errorData = error.response?.data;
      const errorMessage = this.extractErrorMessage(error);

      this.logRequest({
        userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null,
            workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model: req.body?.model, protocol: clientProtocol || 'anthropic',
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0,
        statusCode, latencyMs: latency, errorMessage
      });

      if (statusCode === 429) {
        dispatcher.handleRateLimit(source?.id, errorMessage);
      } else if (statusCode >= 500) {
        dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
      } else if (statusCode === 401 || statusCode === 403) {
        dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
      }

      if (!res.headersSent) {
        res.status(statusCode).json({
          error: { message: errorMessage, type: 'proxy_error', code: statusCode }
        });
      } else {
        try { res.end(); } catch (e) {}
      }
    } finally {
      if (!isStreaming) {
        releaseConcurrent();
      }
    }
  }

  /**
   * 带协议转换的代理方法
   * 客户端发 OpenAI 格式 → 转为 Anthropic → 发给源站 → 收到 Anthropic 响应 → 转回 OpenAI
   * 直接调用现有 proxy 方法，它已经处理了 OpenAI ↔ Anthropic 转换
   */
  async proxyWithConversion(req, res, source, startTime, clientProtocol) {
    if (process.env.LOG_LEVEL === "debug") console.log('[proxy-anthropic] === Converted request (OpenAI → Anthropic) ===');
    return this.proxy(req, res, source, startTime, clientProtocol);
  }

  /**
   * Anthropic 格式直通模式
   * 客户端发 Anthropic 格式 → 源站也是 Anthropic → 直接透传，不做任何转换
   */
  async _proxyPassthrough(req, res, source, startTime, clientProtocol) {
    if (!clientProtocol) clientProtocol = req._clientProtocol ? req._clientProtocol + '→anthropic' : 'anthropic→anthropic';
    req._clientProtocol = clientProtocol;
    const body = req.body;
    const model = body.model;
    // Always fetch fresh api_key from DB to avoid stale cache
    const freshSource = await db.get('SELECT api_key, api_keys FROM sources WHERE id = ?', [source.id]);
    const apiKey = db.getApiKey(freshSource || source, 'anthropic');
    if (!apiKey) {
      return res.status(502).json({ error: { message: `Source "${source.name}" missing API key`, type: 'server_error' } });
    }

    // Fix 1: DeepSeek/Kimi/MiMo require thinking blocks on assistant messages with tool_use
    // Fix 2: Remove orphan tool_use blocks whose tool_result is NOT in the very next message (causes 400)
    if (Array.isArray(body.messages)) {
      let removedCount = 0;

      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const hasToolUse = msg.content.some(b => b && b.type === 'tool_use');
          const hasThinking = msg.content.some(b => b && b.type === 'thinking');

          // Fix 1: inject thinking block if missing
          if (hasToolUse && !hasThinking) {
            msg.content.unshift({ type: 'thinking', thinking: '', signature: 'fix' });
          }

          // Fix 2: remove tool_use blocks whose tool_result is NOT in the immediately next message
          const nextMsg = body.messages[i + 1];
          const nextToolResultIds = new Set();
          if (nextMsg && (nextMsg.role === 'user' || nextMsg.role === 'tool') && Array.isArray(nextMsg.content)) {
            for (const b of nextMsg.content) {
              if (b && b.type === 'tool_result' && b.tool_use_id) nextToolResultIds.add(b.tool_use_id);
            }
          }

          const originalLen = msg.content.length;
          msg.content = msg.content.filter(b => {
            if (b && b.type === 'tool_use' && b.id && !nextToolResultIds.has(b.id)) {
              removedCount++;
              return false;
            }
            return true;
          });
          // If we removed all blocks, keep at least a text placeholder
          if (msg.content.length === 0 && originalLen > 0) {
            msg.content = [{ type: 'text', text: '(removed orphan tool calls)' }];
          }
        }
      }
      if (removedCount > 0) {
        if (process.env.LOG_LEVEL === "debug") console.log(`[proxy-anthropic] Removed ${removedCount} orphan tool_use blocks`);
      }
    }

    this.cleanUndefined(body);
    const modelInfo = await this.getModelInfo(body.model, source.id);
    if (modelInfo?.source_model_id) body.model = modelInfo.source_model_id;

    const useStream = body.stream === true;
    const upstreamUrl = `${db.getApiUrl(source, 'anthropic').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`;

    let concurrentReleased = false;
    let isStreaming = false;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source.id).catch(() => {});
      }
    };
    try {
      await dispatcher.tryIncrementConcurrent(source.id);

      const response = await axios.post(upstreamUrl, body, {
        headers: {
          'x-api-key': apiKey,
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 300000,
        responseType: useStream ? 'stream' : 'json',
        validateStatus: () => true
      });

      if (response.status >= 400) {
        let errorData = response.data;
        if (errorData && typeof errorData.pipe === 'function') {
          try {
            const raw = await this.readStreamBuffer(errorData, response.headers);
            try { errorData = JSON.parse(raw); } catch (e) { errorData = { raw: raw.substring(0, 500) }; }
          } catch (e) { errorData = { readError: e.message }; }
        }
        const errorMessage = this.extractErrorMessage({ response: { data: errorData } }, `Upstream returned ${response.status}`);
        this.logRequest({
          userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null,
            workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
          model, protocol: clientProtocol || 'anthropic',
          inputTokens: 0, outputTokens: 0, totalTokens: 0,
          cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0,
          statusCode: response.status, latencyMs: Date.now() - startTime, errorMessage
        });
        if (response.status >= 500 || response.status === 429) dispatcher.markSourceFailed(source.id, errorMessage, response.status);
        else if (response.status === 401 || response.status === 403) dispatcher.markSourceFailed(source.id, errorMessage, response.status);
        releaseConcurrent();
        return res.status(response.status).json({ error: { message: errorMessage, type: 'proxy_error', code: response.status } });
      }

      // 检查上游返回的 Content-Type 是否匹配 SSE 格式
      const contentTypeAnth = response.headers['content-type'] || '';
      if (useStream && contentTypeAnth.includes('application/json') && !contentTypeAnth.includes('text/event-stream')) {
        let errorData = response.data;
        if (errorData && typeof errorData.pipe === 'function') {
          try {
            const raw = await this.readStreamBuffer(errorData, response.headers);
            try { errorData = JSON.parse(raw); } catch (e) { errorData = { raw: raw.substring(0, 500) }; }
          } catch (e) { errorData = { readError: e.message }; }
        }
        const errorMessage = this.extractErrorMessage({ response: { data: errorData } }, 'Upstream returned JSON instead of SSE stream');
        console.error(`[proxy-anthropic] _proxyPassthrough format mismatch: Content-Type=${contentTypeAnth}, message: ${errorMessage}`);
        this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol || 'anthropic', inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode: 502, latencyMs: Date.now() - startTime, errorMessage });
        dispatcher.markSourceFailed(source.id, errorMessage, 502);
        releaseConcurrent();
        return res.status(502).json({ error: { message: errorMessage, type: 'proxy_error', code: 502 } });
      }

      if (useStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Intercept stream to extract usage data from Anthropic SSE events
        let inputTokens = 0, outputTokens = 0, cachedTokens = 0, cacheCreationTokens = 0;
        let hasThinking = false;
        let buffer = '';
        let scanBuffer = [];
        let scanBufferLen = 0;
        const MAX_SCAN_BUFFER_LEN = 131072;
        const self = this;

        const sd = new StringDecoder('utf8');
        let isFirstChunkAnth = true;
        const interceptor = new Transform({
          transform(chunk, encoding, callback) {
            const chunkStr = sd.write(chunk);

            // Accumulate upstream text for transit security scan (best-effort, capped)
            if (scanBufferLen < MAX_SCAN_BUFFER_LEN) {
              if (scanBufferLen + chunkStr.length > MAX_SCAN_BUFFER_LEN) {
                scanBuffer.push(chunkStr.substring(0, MAX_SCAN_BUFFER_LEN - scanBufferLen));
                scanBufferLen = MAX_SCAN_BUFFER_LEN;
              } else {
                scanBuffer.push(chunkStr);
                scanBufferLen += chunkStr.length;
              }
            }

            // Detect upstream returning HTML instead of SSE
            if (isFirstChunkAnth) {
              isFirstChunkAnth = false;
              if (chunkStr.includes('<!DOCTYPE') || chunkStr.includes('<html') || chunkStr.includes('<body') || chunkStr.includes('<head')) {
                console.error(`[proxy-anthropic] _proxyPassthrough upstream ${source.name} returned HTML instead of SSE, aborting stream`);
                callback(new Error('Upstream returned HTML instead of SSE'));
                return;
              }
            }

            buffer += chunkStr;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const parsed = JSON.parse(line.slice(6));
                const usage = parsed.message?.usage || parsed.usage;
                if (usage) {
                  if (usage.input_tokens) inputTokens = usage.input_tokens;
                  if (usage.cache_read_input_tokens) cachedTokens = usage.cache_read_input_tokens;
                  if (usage.cache_creation_input_tokens) cacheCreationTokens = usage.cache_creation_input_tokens;
                  if (usage.output_tokens) outputTokens = usage.output_tokens;
                }
                if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
                  hasThinking = true;
                }
              } catch (e) {}
            }
            this.push(chunk);
            callback();
          }
        });

        pipeline(response.data, interceptor, res, (err) => {
          if (err) {
            // ECONNRESET/EPIPE are normal when client disconnects mid-stream
            if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
              console.error('[proxy-anthropic] Stream pipeline error:', err.message);
            }
          }
          const latency = Date.now() - startTime;
          const totalTokens = inputTokens + outputTokens;
          const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
          self.logRequest({
            userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null,
            workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
            model, protocol: clientProtocol || 'anthropic',
            inputTokens, outputTokens, totalTokens,
            cachedTokens, cacheCreationTokens, uncachedTokens,
            statusCode: 200, latencyMs: latency,
            hasThinking
          });
          if (!err) {
            dispatcher.markSourceSuccess(source.id);
          }
          dispatcher.updateStats(source.id, totalTokens);
          releaseConcurrent();
          transitScanner.scan({ rawBody: scanBuffer.join(''), req, source, statusCode: 200 }).catch(() => {});
        });
        res.on('close', () => {
          releaseConcurrent();
        });
        isStreaming = true;
        return;
      }

      // Non-streaming: extract usage from response
      const latency = Date.now() - startTime;
      const usage = response.data?.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      const cachedTokens = usage.cache_read_input_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
      const hasThinking = Array.isArray(response.data?.content) && response.data.content.some(b => b.type === 'thinking');

      this.logRequest({
        userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null,
            workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model, protocol: clientProtocol || 'anthropic',
        inputTokens, outputTokens, totalTokens,
        cachedTokens, cacheCreationTokens, uncachedTokens,
        statusCode: 200, latencyMs: latency,
        hasThinking
      });
      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
      releaseConcurrent();
      res.json(response.data);
      transitScanner.scan({ rawBody: JSON.stringify(response.data), req, source, statusCode: 200 }).catch(() => {});
    } catch (error) {
      console.error(`[proxy-anthropic] _proxyPassthrough exception:`, error?.message);
      releaseConcurrent();
      if (!res.headersSent) {
        res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed'), type: 'proxy_error', code: 500 } });
      } else {
        try { res.end(); } catch (e) {}
      }
    }
  }
}

module.exports = new ProxyAnthropic();
