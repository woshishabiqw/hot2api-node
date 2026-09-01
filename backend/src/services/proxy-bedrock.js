const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const db = require('../config/database');
const dispatcher = require('./dispatcher');
const ProxyBase = require('./proxy-base');

class ProxyBedrock extends ProxyBase {
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
      dispatcher.tryIncrementConcurrent(source.id);
      const apiKey = db.getApiKey(source, 'bedrock');
      if (!apiKey) {
        dispatcher.decrementConcurrent(source.id).catch(() => {});
        console.error(`[proxy-bedrock] Source "${source.name}" (id=${source.id}) has no API key configured`);
        return res.status(502).json({
          error: { message: `Source "${source.name}" missing API key`, type: 'server_error' }
        });
      }

      // Clean [undefined] values from request body (including nested messages)
      this.cleanUndefined(req.body);

      const { model, messages, stream, tools, tool_choice, temperature, top_p, max_tokens, stop } = req.body;
      const useStream = stream === true;

      const modelInfo = await this.getModelInfo(model, source.id);

      // Parse AWS credentials from apiKey (format: accessKeyId:secretAccessKey:region)
      const parts = apiKey.split(':');
      const accessKeyId = parts[0];
      const secretAccessKey = parts[1];
      const region = parts[2] || 'us-east-1';
      const upstreamModel = modelInfo?.source_model_id || model;
      const modelId = upstreamModel.replace('bedrock/', '');

      const systemMessages = messages?.filter(m => m.role === 'system') || [];
      const nonSystemMessages = messages?.filter(m => m.role !== 'system') || [];
      const bedrockMessages = this._convertMessages(nonSystemMessages);

      const body = { messages: bedrockMessages };
      if (systemMessages.length > 0) {
        body.system = systemMessages.map(m => ({ text: m.content }));
      }

      body.inferenceConfig = {};
      if (max_tokens) body.inferenceConfig.maxTokens = max_tokens;
      if (temperature !== undefined) body.inferenceConfig.temperature = temperature;
      if (top_p !== undefined) body.inferenceConfig.topP = top_p;
      if (stop) body.inferenceConfig.stopSequences = Array.isArray(stop) ? stop : [stop];

      body.guardrailConfig = { guardrailIdentifier: 'none', guardrailVersion: 'none' };

      const stripTools = source.strip_tools || (modelInfo && !modelInfo.supports_tools);
      if (Array.isArray(tools) && tools.length > 0 && !stripTools) {
        body.toolConfig = {
          tools: tools.filter(t => t.type === 'function').map(t => ({
            toolSpec: {
              name: t.function.name,
              description: t.function.description || '',
              inputSchema: { json: t.function.parameters || { type: 'object', properties: {} } }
            }
          }))
        };
        if (tool_choice) {
          if (tool_choice.type === 'auto') body.toolConfig.toolChoice = { auto: {} };
          else if (tool_choice.type === 'required') body.toolConfig.toolChoice = { any: {} };
          else if (tool_choice.type === 'function') body.toolConfig.toolChoice = { tool: { name: tool_choice.function.name } };
        }
      }

      const host = `bedrock-runtime.${region}.amazonaws.com`;
      const path = `/model/${encodeURIComponent(modelId)}/converse${useStream ? '-stream' : ''}`;
      const url = `https://${host}${path}`;

      const authHeaders = this._awsSigV4Sign({
        method: 'POST', host, path, region, service: 'bedrock',
        accessKeyId, secretAccessKey,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        timeout: 300000,
        responseType: useStream ? 'stream' : 'json'
      });

      if (useStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let content = [], toolCalls = [], stopReason = 'end_turn';
        let inputTokens = 0, outputTokens = 0;
        let currentToolIndex = -1, currentToolName = '', currentToolInput = '';

        response.data.on('error', (err) => {
          console.error('[proxy-bedrock] Upstream stream error:', err.message);
          try { res.end(); } catch (e) {}
          releaseConcurrent();
        });

        const decoder = new StringDecoder('utf8');
        let isFirstChunkBr = true;
        response.data.on('data', (chunk) => {
          const text = decoder.write(chunk);

          // Detect upstream returning HTML instead of SSE
          if (isFirstChunkBr) {
            isFirstChunkBr = false;
            if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<body') || text.includes('<head')) {
              console.error(`[proxy-bedrock] Upstream ${source.name} returned HTML instead of SSE, aborting stream`);
              try { res.end(); } catch (e) {}
              releaseConcurrent();
              response.data.destroy();
              return;
            }
          }

          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.messageStart) {
                inputTokens = event.messageStart.usage?.inputTokens || inputTokens;
              } else if (event.contentBlockStart) {
                const block = event.contentBlockStart.contentBlock;
                if (block?.toolUse) {
                  currentToolIndex = block.toolUse.toolUseId;
                  currentToolName = block.toolUse.name;
                  currentToolInput = '';
                }
              } else if (event.contentBlockDelta) {
                const delta = event.contentBlockDelta.delta;
                if (delta?.text) {
                  content.push(delta.text);
                  res.write(`data: ${JSON.stringify({ id: `bedrock-${Date.now()}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] })}\n\n`);
                }
                if (delta?.toolUse) currentToolInput += delta.toolUse.input;
              } else if (event.contentBlockStop) {
                if (currentToolName) {
                  try { toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, type: 'function', function: { name: currentToolName, arguments: currentToolInput } }); }
                  catch { toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, type: 'function', function: { name: currentToolName, arguments: '{}' } }); }
                  currentToolName = ''; currentToolInput = '';
                }
              } else if (event.messageStop) {
                stopReason = event.messageStop.stopReason || 'end_turn';
              } else if (event.metadata) {
                inputTokens = event.metadata.usage?.inputTokens || inputTokens;
                outputTokens = event.metadata.usage?.outputTokens || outputTokens;
              }
            } catch (e) {}
          }
        });

        response.data.on("end", () => {
          try {
            if (toolCalls.length > 0) {
              try { res.write('data: ' + JSON.stringify({ id: 'bedrock-' + Date.now(), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] }) + '\n\n'); } catch (e) {}
            }
            const finishReason = { "end_turn": "stop", "max_tokens": "length", "tool_use": "tool_calls", "content_filtered": "content_filter" }[stopReason] || "stop";
            const totalTokens = inputTokens + outputTokens;
            try { res.write('data: ' + JSON.stringify({ id: 'bedrock-' + Date.now(), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } }) + '\n\n'); } catch (e) {}
            try { res.write('data: [DONE]\n\n'); } catch (e) {}
            try { res.end(); } catch (e) {}
          } catch (e) {}

          const latency = Date.now() - startTime;
          this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol || 'bedrock', inputTokens, outputTokens, totalTokens, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: inputTokens, statusCode: 200, latencyMs: latency });
          dispatcher.markSourceSuccess(source?.id);
          dispatcher.updateStats(source?.id, totalTokens);
          releaseConcurrent();
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
      const output = response.data.output || {};
      const msg = output.message || {};
      let content = '', toolCalls = [];
      if (msg.content) {
        for (const block of msg.content) {
          if (block.text) content += block.text;
          if (block.toolUse) {
            toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, type: 'function', function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input || {}) } });
          }
        }
      }
      const usage = response.data.usage || {};
      const inputTokens = usage.inputTokens || 0;
      const outputTokens = usage.outputTokens || 0;
      const totalTokens = inputTokens + outputTokens;
      const stopReason = { 'end_turn': 'stop', 'max_tokens': 'length', 'tool_use': 'tool_calls', 'content_filtered': 'content_filter' }[msg.stopReason] || 'stop';

      const openaiResponse = { id: `bedrock-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: toolCalls.length > 0 ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content }, finish_reason: toolCalls.length > 0 ? 'tool_calls' : stopReason }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } };
      res.json(openaiResponse);

      this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol || 'bedrock', inputTokens, outputTokens, totalTokens, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: inputTokens, statusCode: 200, latencyMs: latency });
      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 502;
      const errorMessage = this.extractErrorMessage(error);
      this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: req.body?.model, protocol: clientProtocol || 'bedrock', inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode, latencyMs: latency, errorMessage });
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
   * 带协议转换的代理方法
   * 客户端发 Anthropic 格式 → 转为 OpenAI → 由 proxy() 处理 OpenAI → Bedrock → 收到 OpenAI 响应 → 转回 Anthropic
   */
  async proxyWithConversion(req, res, source, startTime, clientProtocol) {
    const AnthropicConverter = require('./converter-anthropic');

    if (!startTime) startTime = Date.now();
    if (process.env.LOG_LEVEL === "debug") console.log('[proxy-bedrock] === Converted request (Anthropic → OpenAI → Bedrock) ===');

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
      const sd = new StringDecoder('utf8');

      res.write = (chunk, ...args) => {
        const chunkStr = sd.write(chunk);
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

  _convertMessages(messages) {
    const result = [];
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const content = [];
        if (msg.content) content.push({ text: msg.content });
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let input;
            try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
            content.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input } });
          }
        }
        if (content.length > 0) result.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        let resultContent;
        try { resultContent = JSON.parse(msg.content); } catch { resultContent = { text: msg.content }; }
        result.push({ role: 'user', content: [{ toolResult: { toolUseId: msg.tool_call_id, content: [typeof resultContent === 'string' ? { text: resultContent } : { json: resultContent }] } }] });
      } else if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const content = [];
          for (const part of msg.content) {
            if (part.type === 'text') content.push({ text: part.text });
            else if (part.type === 'image_url') {
              const url = part.image_url?.url || '';
              if (url.startsWith('data:')) {
                const match = url.match(/^data:(.*?);base64,(.*)$/);
                if (match) {
                  const format = match[1].split('/')[1] || 'jpeg';
                  content.push({ image: { format, source: { bytes: match[2] } } });
                }
              }
            }
          }
          result.push({ role: 'user', content });
        } else {
          result.push({ role: 'user', content: [{ text: msg.content }] });
        }
      }
    }
    return result;
  }

  _awsSigV4Sign({ method, host, path, region, service, accessKeyId, secretAccessKey, headers, body }) {
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').substring(0, 8);
    const amzDate = dateStamp + 'T' + now.toISOString().replace(/[:-]|\.\d{3}/g, '').substring(9, 15) + 'Z';

    const canonicalHeaders = { ...headers, 'host': host, 'x-amz-date': amzDate, 'x-amz-target': 'AmazonBedrockFrontendService.Converse' };
    const sortedKeys = Object.keys(canonicalHeaders).sort();
    const signedHeaders = sortedKeys.join(';');
    const canonicalHeaderStr = sortedKeys.map(k => `${k}:${canonicalHeaders[k]}\n`).join('');

    const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');
    const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaderStr}\n${signedHeaders}\n${payloadHash}`;

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      ...headers,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': amzDate,
      'x-amz-target': 'AmazonBedrockFrontendService.Converse'
    };
  }
}

module.exports = new ProxyBedrock();
