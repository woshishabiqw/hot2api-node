const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const db = require('../config/database');
const dispatcher = require('./dispatcher');
const ProxyBase = require('./proxy-base');
const { pipeline } = require('stream');
const transitScanner = require('./transit-scanner');

class ProxyGemini extends ProxyBase {
  async proxy(req, res, source, startTime, clientProtocol) {
    let concurrentReleased = false;
    let isStreaming = false;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source.id).catch(() => {});
      }
    };
    try {
      req._clientProtocol = 'gemini';
      await dispatcher.tryIncrementConcurrent(source.id);
      const apiKey = db.getApiKey(source, 'gemini');
      if (!apiKey) {
        dispatcher.decrementConcurrent(source.id).catch(() => {});
        console.error(`[proxy-gemini] Source "${source.name}" (id=${source.id}) has no API key configured`);
        return res.status(502).json({
          error: { message: `Source "${source.name}" missing API key`, type: 'server_error' }
        });
      }

      // Clean [undefined] values from request body (including nested messages)
      this.cleanUndefined(req.body);

      const { model, messages, stream, tools, tool_choice, temperature, top_p, max_tokens, stop, response_format } = req.body;
      const useStream = stream === true;

      const modelInfo = await this.getModelInfo(model, source.id);
      const upstreamModel = modelInfo?.source_model_id || model;
      const geminiModel = upstreamModel.replace('gemini/', '');
      const endpoint = `${db.getApiUrl(source, 'gemini')}/v1beta/models/${geminiModel}`;

      const systemInstruction = messages?.[0]?.role === 'system'
        ? { parts: [{ text: messages[0].content }] }
        : undefined;

      const contents = this._convertMessages(messages || []);

      const body = { contents };
      if (temperature !== undefined || top_p !== undefined) {
        body.generationConfig = {};
        if (temperature !== undefined) body.generationConfig.temperature = temperature;
        if (top_p !== undefined) body.generationConfig.topP = top_p;
        if (max_tokens !== undefined) body.generationConfig.maxOutputTokens = max_tokens;
        if (stop) body.generationConfig.stopSequences = Array.isArray(stop) ? stop : [stop];
        if (response_format?.type === 'json_object') {
          body.generationConfig.responseMimeType = 'application/json';
        }
      }
      if (systemInstruction) body.systemInstruction = systemInstruction;

      body.safetySettings = [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ];

      const stripTools = source.strip_tools || (modelInfo && !modelInfo.supports_tools);
      if (Array.isArray(tools) && tools.length > 0 && !stripTools) {
        body.tools = [{
          functionDeclarations: tools
            .filter(t => t.type === 'function')
            .map(t => {
              const decl = { name: t.function.name, description: t.function.description || '' };
              if (t.function.parameters) {
                decl.parameters = this._convertSchema(t.function.parameters);
              }
              return decl;
            })
        }];
      }

      const response = await axios.post(
        `${endpoint}:generateContent?key=${apiKey}`,
        body,
        { headers: { 'Content-Type': 'application/json' }, timeout: 300000, responseType: useStream ? 'stream' : 'json' }
      );

      if (useStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let fullText = '';
        let functionCalls = [];
        let promptTokens = 0, completionTokens = 0, totalTokens = 0;
        let scanBuffer = [];
        let scanBufferLen = 0;
        const MAX_SCAN_BUFFER_LEN = 131072;

        const decoder = new StringDecoder('utf8');
        let isFirstChunkGem = true;
        response.data.on('data', (chunk) => {
          const text = decoder.write(chunk);

          // Accumulate upstream text for transit security scan (best-effort, capped)
          if (scanBufferLen < MAX_SCAN_BUFFER_LEN) {
            if (scanBufferLen + text.length > MAX_SCAN_BUFFER_LEN) {
              scanBuffer.push(text.substring(0, MAX_SCAN_BUFFER_LEN - scanBufferLen));
              scanBufferLen = MAX_SCAN_BUFFER_LEN;
            } else {
              scanBuffer.push(text);
              scanBufferLen += text.length;
            }
          }

          // Detect upstream returning HTML instead of JSON/SSE
          if (isFirstChunkGem) {
            isFirstChunkGem = false;
            if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<body') || text.includes('<head')) {
              console.error(`[proxy-gemini] Upstream ${source.name} returned HTML instead of JSON, aborting stream`);
              try { res.end(); } catch (e) {}
              releaseConcurrent();
              response.data.destroy();
              return;
            }
          }

          try {
            const json = JSON.parse(text);
            if (json.usageMetadata) {
              promptTokens = json.usageMetadata.promptTokenCount || promptTokens;
              completionTokens = json.usageMetadata.candidatesTokenCount || completionTokens;
              totalTokens = json.usageMetadata.totalTokenCount || totalTokens;
            }
            const candidate = json.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  const delta = part.text.slice(fullText.length);
                  fullText = part.text;
                  res.write(`data: ${JSON.stringify({ id: `gemini-${Date.now()}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
                }
                if (part.functionCall) {
                  functionCalls.push(part.functionCall);
                }
              }
            }
          } catch (e) {}
        });

        response.data.on('end', () => {
          if (functionCalls.length > 0) {
            const toolCalls = functionCalls.map((fc, i) => ({
              index: i, id: `call_${Date.now()}_${i}`, type: 'function',
              function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) }
            }));
            res.write(`data: ${JSON.stringify({ id: `gemini-${Date.now()}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id: `gemini-${Date.now()}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();

          const latency = Date.now() - startTime;
          this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol || 'gemini', inputTokens: promptTokens, outputTokens: completionTokens, totalTokens, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: promptTokens, statusCode: 200, latencyMs: latency });
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

      // Non-streaming
      const latency = Date.now() - startTime;
      const candidate = response.data.candidates?.[0];
      let content = '', toolCalls = [];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) content += part.text;
          if (part.functionCall) toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
        }
      }
      const um = response.data.usageMetadata || {};
      const promptTokens = um.promptTokenCount || 0;
      const completionTokens = um.candidatesTokenCount || 0;
      const totalTokens = um.totalTokenCount || 0;
      const finishReason = { 'STOP': 'stop', 'MAX_TOKENS': 'length', 'SAFETY': 'content_filter', 'RECITATION': 'content_filter' }[candidate?.finishReason] || 'stop';

      const openaiResponse = { id: `gemini-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: toolCalls.length > 0 ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content }, finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } };
      res.json(openaiResponse);

      this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol || 'gemini', inputTokens: promptTokens, outputTokens: completionTokens, totalTokens, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: promptTokens, statusCode: 200, latencyMs: latency });
      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
      transitScanner.scan({ rawBody: JSON.stringify(response.data), req, source, statusCode: 200 }).catch(() => {});
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 502;
      const errorMessage = this.extractErrorMessage(error);
      this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: req.body?.model, protocol: clientProtocol || 'gemini', inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode, latencyMs: latency, errorMessage });
      if (statusCode === 429) {
        dispatcher.handleRateLimit(source?.id, errorMessage);
      } else if (statusCode >= 500) {
        dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
      } else if (statusCode === 401 || statusCode === 403) {
        dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
      }
      if (!res.headersSent) {
        res.status(statusCode).json({ error: { message: errorMessage, type: 'proxy_error', code: statusCode } });
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
   * Gemini 原生透传: Gemini 客户端 → Gemini 源站，不做格式转换
   */
  async geminiPassthrough(req, res, source, startTime, modelName, isStream, clientProtocol) {
    req._clientProtocol = 'gemini';
    await dispatcher.tryIncrementConcurrent(source.id);
    const apiKey = db.getApiKey(source, 'gemini');
    if (!apiKey) {
      await dispatcher.decrementConcurrent(source.id).catch(() => {});
      return res.status(502).json({ error: { message: `Source "${source.name}" missing API key`, type: 'server_error' } });
    }

    const modelInfo = await db.get('SELECT source_model_id FROM models WHERE model_id = ? AND source_id = ? AND is_active = true', [modelName, source.id]);
    const upstreamModel = (modelInfo?.source_model_id || modelName).replace('gemini/', '');
    const baseUrl = db.getApiUrl(source, 'gemini');
    const action = isStream ? 'streamGenerateContent' : 'generateContent';
    const endpoint = `${baseUrl}/v1beta/models/${upstreamModel}:${action}?key=${apiKey}`;

    let concurrentReleased = false;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source.id).catch(() => {});
      }
    };
    try {
      const response = await axios.post(endpoint, req.body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000,
        responseType: isStream ? 'stream' : 'json'
      });

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        pipeline(response.data, res, (err) => {
          if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            console.error('[proxy-gemini] Stream pipeline error:', err.message);
          }
          try { res.end(); } catch (e) {}
          dispatcher.markSourceSuccess(source?.id);
          dispatcher.decrementConcurrent(source?.id).catch(() => {});
        });
        res.on('close', () => {
          releaseConcurrent();
        });
      } else {
        res.json(response.data);
        const um = response.data.usageMetadata || {};
        const inputTokens = um.promptTokenCount || 0;
        const outputTokens = um.candidatesTokenCount || 0;
        const totalTokens = um.totalTokenCount || 0;
        this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: modelName, protocol: `${clientProtocol || 'gemini'}→gemini`, inputTokens, outputTokens, totalTokens, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: inputTokens, statusCode: 200, latencyMs: Date.now() - startTime });
        dispatcher.markSourceSuccess(source?.id);
        dispatcher.updateStats(source?.id, totalTokens);
        dispatcher.decrementConcurrent(source?.id).catch(() => {});
        transitScanner.scan({ rawBody: JSON.stringify(response.data), req, source, statusCode: 200 }).catch(() => {});
      }
    } catch (error) {
      const statusCode = error.response?.status || 502;
      const message = error.response?.data?.error?.message || error?.message || 'Upstream connection failed';
      this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: modelName, protocol: `${clientProtocol || 'gemini'}→gemini`, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode, latencyMs: Date.now() - startTime, errorMessage: message });
      if (statusCode === 429) dispatcher.handleRateLimit(source?.id, message);
      else if (statusCode >= 500) dispatcher.markSourceFailed(source?.id, message, statusCode);
      else if (statusCode === 401 || statusCode === 403) dispatcher.markSourceFailed(source?.id, message, statusCode);
      dispatcher.decrementConcurrent(source?.id).catch(() => {});
      if (!res.headersSent) {
        res.status(statusCode).json({ error: { message, code: statusCode } });
      } else {
        try { res.end(); } catch (e) {}
      }
    }
  }

  /**
   * Gemini 客户端 → 任意协议源站
   * 将 Gemini 格式请求转为 OpenAI 格式，代理到可用源站，再将 OpenAI 响应转回 Gemini 格式
   */
  async proxyGeminiClient(req, res, modelName, isStream) {
    const startTime = Date.now();
    req._clientProtocol = 'gemini';
    const clientProtocol = 'gemini';
    const GeminiConverter = require('./converter-gemini');

    const geminiBody = req.body;
    const genConfig = geminiBody.generationConfig || {};
    const messages = this._geminiContentsToOpenai(geminiBody);

    // Convert Gemini thinkingConfig to OpenAI-compatible include_reasoning parameter
    const thinkingConfig = genConfig.thinkingConfig;
    const includeReasoning = thinkingConfig?.includeThoughts === true;

    req.body = {
      model: modelName,
      messages,
      stream: isStream,
      ...(genConfig.temperature !== undefined && { temperature: genConfig.temperature }),
      ...(genConfig.topP !== undefined && { top_p: genConfig.topP }),
      ...(genConfig.maxOutputTokens !== undefined && { max_tokens: genConfig.maxOutputTokens }),
      ...(genConfig.stopSequences?.length && { stop: genConfig.stopSequences }),
      ...(includeReasoning && { include_reasoning: true }),
    };

    const source = await dispatcher.selectSource(modelName);
    if (!source) {
      return res.status(503).json({ error: { message: `No available source for model ${modelName}`, code: 503 } });
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const originalWrite = res.write.bind(res);
      let buffer = '';
      const sd = new StringDecoder('utf8');
      res.write = (chunk, ...args) => {
        const lines = (buffer + sd.write(chunk)).split('\n');
        buffer = '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.startsWith('data: ')) { if (i === lines.length - 1) buffer = line; continue; }
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return true;
          try {
            const parsed = JSON.parse(payload);
            const geminiChunk = GeminiConverter.streamChunkToGemini(parsed, {});
            originalWrite(`data: ${JSON.stringify(geminiChunk)}\n\n`);
          } catch (e) {}
        }
        return true;
      };
    } else {
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        if (data?.choices) {
          const choice = data.choices[0];
          const parts = [];
          let reasoningText = '';
          if (choice?.message?.reasoning_content) {
            reasoningText = typeof choice.message.reasoning_content === 'string'
              ? choice.message.reasoning_content.trim()
              : JSON.stringify(choice.message.reasoning_content).trim();
          }
          let contentText = '';
          if (choice?.message?.content) {
            contentText = choice.message.content.trim();
          }

          // Smart deduplication: remove overlapping text between reasoning and content
          if (reasoningText && contentText) {
            const maxOverlap = Math.min(reasoningText.length, contentText.length);
            for (let i = maxOverlap; i > 0; i--) {
              if (reasoningText.endsWith(contentText.slice(0, i))) {
                reasoningText = reasoningText.slice(0, -i).trim();
                break;
              }
            }
            if (reasoningText.endsWith(contentText)) {
              reasoningText = reasoningText.slice(0, -contentText.length).trim();
            }
          }

          if (reasoningText) {
            parts.push({ text: reasoningText, thought: true });
          }

          if (contentText) {
            const thinkMatch = contentText.match(/<think>([\s\S]*?)<\/think>/);
            const thinkingMatch = !thinkMatch && contentText.match(/<thinking>([\s\S]*?)<\/thinking>/);
            const embeddedThink = thinkMatch || thinkingMatch;
            if (embeddedThink) {
              const thinkText = embeddedThink[1].trim();
              const remainingText = contentText.replace(/<think>[\s\S]*?<\/think>/, '').replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
              if (thinkText && !reasoningText.includes(thinkText)) {
                parts.push({ text: thinkText, thought: true });
              }
              if (remainingText) {
                parts.push({ text: remainingText });
              }
            } else if (!reasoningText.includes(contentText)) {
              parts.push({ text: contentText });
            }
          }
          if (choice?.message?.tool_calls) {
            for (const tc of choice.message.tool_calls) {
              try { parts.push({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') } }); }
              catch { parts.push({ functionCall: { name: tc.function.name, args: {} } }); }
            }
          }
          const finishMap = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY', tool_calls: 'STOP' };
          return originalJson({
            candidates: [{ content: { role: 'model', parts }, finishReason: finishMap[choice?.finish_reason] || 'STOP', index: 0 }],
            usageMetadata: { promptTokenCount: data.usage?.prompt_tokens || 0, candidatesTokenCount: data.usage?.completion_tokens || 0, totalTokenCount: data.usage?.total_tokens || 0 }
          });
        }
        return originalJson(data);
      };
    }

    const proxyOpenAI = require('./proxy-openai');
    const proxyAnthropic = require('./proxy-anthropic');
    const proxyBedrock = require('./proxy-bedrock');
    const cp = clientProtocol || 'gemini';
    switch (source.protocol) {
      case 'anthropic': return proxyAnthropic.proxy(req, res, source, startTime, `${cp}→anthropic`);
      case 'bedrock':   return proxyBedrock.proxy(req, res, source, startTime, `${cp}→bedrock`);
      case 'gemini':    return this.proxy(req, res, source, startTime, `${cp}→gemini`);
      default:          return proxyOpenAI.proxy(req, res, source, startTime, `${cp}→openai`);
    }
  }

  /**
   * 将 Gemini 格式的 contents/systemInstruction 转换为 OpenAI messages 数组
   */
  _geminiContentsToOpenai(geminiBody) {
    const messages = [];
    if (geminiBody.systemInstruction?.parts) {
      const text = geminiBody.systemInstruction.parts.map(p => p.text || '').join('');
      if (text) messages.push({ role: 'system', content: text });
    }
    for (const turn of (geminiBody.contents || [])) {
      const role = turn.role === 'model' ? 'assistant' : 'user';
      let content = '';
      const toolCalls = [];
      const toolResults = [];
      for (const part of (turn.parts || [])) {
        if (part.text) content += part.text;
        if (part.functionCall) {
          toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
        }
        if (part.functionResponse) {
          toolResults.push({ role: 'tool', tool_call_id: part.functionResponse.name, name: part.functionResponse.name, content: JSON.stringify(part.functionResponse.response || {}) });
        }
      }
      if (toolResults.length > 0) messages.push(...toolResults);
      else if (toolCalls.length > 0) messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      else messages.push({ role, content });
    }
    return messages;
  }

  _convertMessages(messages) {
    const contents = [];
    const nonSystem = messages.filter(m => m.role !== 'system');
    for (const msg of nonSystem) {
      if (msg.role === 'assistant') {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            try { parts.push({ functionCall: { name: tc.function.name, arguments: JSON.parse(tc.function.arguments) } }); }
            catch { parts.push({ functionCall: { name: tc.function.name, arguments: {} } }); }
          }
        }
        if (parts.length > 0) contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        let result;
        try { result = JSON.parse(msg.content); } catch { result = { output: msg.content }; }
        contents.push({ role: 'user', parts: [{ functionResponse: { name: msg.name, response: result } }] });
      } else if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const parts = [];
          for (const part of msg.content) {
            if (part.type === 'text') parts.push({ text: part.text });
            else if (part.type === 'image_url') {
              const url = part.image_url?.url || '';
              if (url.startsWith('data:')) {
                const match = url.match(/^data:(.*?);base64,(.*)$/);
                if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
              } else { parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: url } }); }
            }
          }
          contents.push({ role: 'user', parts });
        } else {
          contents.push({ role: 'user', parts: [{ text: msg.content }] });
        }
      }
    }
    return contents;
  }

  /**
   * 带协议转换的代理方法
   * 客户端发 Anthropic 格式 → 转为 OpenAI → 由 proxy() 处理 OpenAI → Gemini → 收到 OpenAI 响应 → 转回 Anthropic
   */
  async proxyWithConversion(req, res, source, startTime, clientProtocol) {
    const AnthropicConverter = require('./converter-anthropic');

    if (!startTime) startTime = Date.now();
    if (process.env.LOG_LEVEL === "debug") console.log('[proxy-gemini] === Converted request (Anthropic → OpenAI → Gemini) ===');

    const anthropicBody = req.body;
    const openaiBody = AnthropicConverter.requestToOpenai(anthropicBody);
    req.body = openaiBody;

    if (clientProtocol === 'anthropic') {
      const originalJson = res.json.bind(res);
      const originalWrite = res.write.bind(res);

      res.json = (data) => {
        const anthropicResponse = AnthropicConverter.responseToAnthropic(data, anthropicBody.model);
        return originalJson(anthropicResponse);
      };

      let streamState = { started: false, contentBlockStarted: false, textBlockClosed: false, toolCalls: null };
      let buffer = '';
      const sd2 = new StringDecoder('utf8');

      res.write = (chunk, ...args) => {
        const chunkStr = sd2.write(chunk);
        const lines = (buffer + chunkStr).split('\n');
        buffer = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.startsWith('data: ')) {
            if (i === lines.length - 1) buffer = line;
            continue;
          }
          const data = line.slice(6).trim();
          if (data === '[DONE]') return true;
          try {
            const parsed = JSON.parse(data);
            const events = AnthropicConverter.streamChunkToAnthropic(parsed, streamState);
            for (const event of events) {
              originalWrite(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
          } catch (e) {}
        }
        return true;
      };
    }

    return this.proxy(req, res, source, startTime, clientProtocol);
  }

  _convertSchema(schema) {
    if (!schema) return {};
    const result = { type: schema.type?.toUpperCase() };
    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;
    if (schema.type === 'object' && schema.properties) {
      result.properties = {};
      for (const [key, val] of Object.entries(schema.properties)) {
        result.properties[key] = this._convertSchema(val);
      }
      if (schema.required) result.required = schema.required;
    }
    if (schema.type === 'array' && schema.items) {
      result.items = this._convertSchema(schema.items);
    }
    return result;
  }
}

module.exports = new ProxyGemini();
