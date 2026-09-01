const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const db = require('../config/database');
const dispatcher = require('./dispatcher');
const ProxyBase = require('./proxy-base');
const transitScanner = require('./transit-scanner');

// Throttle repeated upstream error logs to prevent synchronous console I/O from
// blocking the event loop under high-concurrency error storms.
const errorLogThrottle = new Map();
const ERROR_LOG_THROTTLE_MS = 5000;

function shouldLogUpstreamError(key) {
  const now = Date.now();
  const last = errorLogThrottle.get(key);
  if (last && now - last < ERROR_LOG_THROTTLE_MS) return false;
  errorLogThrottle.set(key, now);
  // Prevent unbounded growth in long-running process
  if (errorLogThrottle.size > 1000) {
    const oldest = errorLogThrottle.keys().next().value;
    errorLogThrottle.delete(oldest);
  }
  return true;
}

function safeJsonStringify(obj, maxLen = 2000) {
  try {
    const str = JSON.stringify(obj, null, 2);
    return str.length > maxLen ? str.slice(0, maxLen) + `... [truncated ${str.length - maxLen} chars]` : str;
  } catch (e) {
    return '[unserializable object]';
  }
}

class ProxyOpenAI extends ProxyBase {
  async proxy(req, res, source, startTime, clientProtocol) {
    // Defensive copy: prevent any upstream code from mutating the dispatcher's cached source object
    source = JSON.parse(JSON.stringify(source || {}));
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
      if (!clientProtocol) {
        clientProtocol = req._clientProtocol ? req._clientProtocol + '→openai' : 'openai→openai';
      }
      req._clientProtocol = clientProtocol;
      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] === New request ===');
      const { model, messages, stream, ...rest } = req.body;
      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] model:', model, 'stream:', stream, 'tools type:', typeof rest.tools, 'tool_choice type:', typeof rest.tool_choice);

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

      if (source.queueWait) {
        if (process.env.LOG_LEVEL === "debug") console.log(`Source ${source.name} at max concurrency, request will wait`);
      }

      // Atomically acquire concurrent slot
      const acquired = await dispatcher.tryIncrementConcurrent(source.id);
      if (!acquired) {
        // Wait for slot to become available
        if (process.env.LOG_LEVEL === "debug") console.log(`[proxy-openai] Source ${source.name} at max concurrency, waiting for slot...`);
        const waitResult = await this._waitForSlot(source.id, source.max_concurrent, 30000);
        if (!waitResult) {
          return res.status(503).json({
            error: { message: 'Source at max concurrency, timed out waiting for slot', type: 'service_unavailable' }
          });
        }
        // Try again after waiting
        if (!await dispatcher.tryIncrementConcurrent(source.id)) {
          return res.status(503).json({
            error: { message: 'Source at max concurrency, could not acquire slot', type: 'service_unavailable' }
          });
        }
      }
      const apiKey = db.getApiKey(source, 'openai');
      if (!apiKey) {
        dispatcher.decrementConcurrent(source.id).catch(() => {});
        console.error(`[proxy-openai] Source "${source.name}" (id=${source.id}) has no API key configured`);
        return res.status(502).json({
          error: { message: `Source "${source.name}" missing API key`, type: 'server_error' }
        });
      }
      const useStream = stream === true;

      const body = { model, messages, stream: useStream, ...rest };
      const modelInfo = await this.getModelInfo(model, source.id);

      // Clean up [undefined] string values sent by some clients (e.g. Cherry Studio)
      this.cleanUndefined(body);

      // Use source_model_id for upstream API call
      if (modelInfo?.source_model_id) body.model = modelInfo.source_model_id;

      // Strip tools if source requires it OR model doesn't support them
      if (source.strip_tools || (modelInfo && !modelInfo.supports_tools)) {
        delete body.tools;
        delete body.tool_choice;
      }

      // Strip image_url content if model doesn't support vision (prevent upstream 404)
      if (modelInfo && !modelInfo.is_vision && Array.isArray(body.messages)) {
        let imageStripped = false;
        for (const msg of body.messages) {
          if (Array.isArray(msg.content)) {
            const textParts = msg.content.filter(c => c.type === 'text');
            if (textParts.length !== msg.content.length) {
              imageStripped = true;
              msg.content = textParts.length > 0 ? textParts : [{ type: 'text', text: '(image omitted)' }];
            }
          }
        }
        if (imageStripped && process.env.LOG_LEVEL === 'debug') {
          console.log('[proxy-openai] Vision content stripped for non-vision model:', model);
        }
      }

      // Remove null/empty values that some APIs reject
      for (const key of Object.keys(body)) {
        if (body[key] === null || body[key] === 'null' || body[key] === '') {
          delete body[key];
        }
      }

      // Strip fields that some clients send but many APIs don't support
      const unsupportedFields = ['parallel_tool_calls', 'logprobs', 'top_logprobs', 'frequency_penalty', 'presence_penalty'];
      for (const field of unsupportedFields) {
        if (body[field] === undefined || body[field] === null || body[field] === '[undefined]') {
          delete body[field];
        }
      }

      // JSON output fallback
      if (body.response_format?.type === 'json_object' && modelInfo && !modelInfo.supports_json) {
        const hasSystem = body.messages?.[0]?.role === 'system';
        if (hasSystem) {
          body.messages[0].content += '\n\nYou must respond with valid JSON only.';
        } else {
          body.messages.unshift({ role: 'system', content: 'You must respond with valid JSON only.' });
        }
        delete body.response_format;
      }

      // Request usage in stream
      if (useStream) {
        body.stream_options = { include_usage: true };
      }

      // Log the outgoing request body for debugging
      const logBody = { ...body };
      if (logBody.messages) logBody.messages = `[${logBody.messages.length} messages]`;
      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] Outgoing body:', safeJsonStringify(logBody));

      // Build candidate URLs: try base_url as-is, then with /v1 prefix if not present
      const rawApiUrl = db.getApiUrl(source, 'openai');
      const baseUrl = rawApiUrl.replace(/\/+$/, '');
      const candidateUrls = [`${baseUrl}/chat/completions`];
      if (!baseUrl.endsWith('/v1')) {
        candidateUrls.unshift(`${baseUrl}/v1/chat/completions`);
      }
      if (process.env.LOG_LEVEL === 'debug') {
        console.error(`[proxy-openai] DEBUG source=${source.id}/${source.name} protocol=${source.protocol} rawApiUrl=${rawApiUrl} source.api_urls=${source.api_urls} source.base_url=${source.base_url} candidates=${JSON.stringify(candidateUrls)}`);
        console.log('[proxy-openai] Candidate URLs:', candidateUrls);
      }

      let response;
      let lastError;
      for (const upstreamUrl of candidateUrls) {
        try {
          if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] Trying:', upstreamUrl);
          response = await axios.post(
            upstreamUrl,
            body,
            {
              headers: {
                'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey,
                'Content-Type': 'application/json'
              },
              timeout: 300000,
              responseType: useStream ? 'stream' : 'json'
            }
          );
          break; // success
        } catch (err) {
          lastError = err;
          const status = err.response?.status;
          if (status === 404) {
            if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] 404 at', upstreamUrl, '- trying next');
            continue;
          }
          throw err; // non-404 errors should not retry
        }
      }
      if (!response) throw lastError;

      if (useStream) {
        // 流式路径同样需要检查上游是否返回了错误状态码
        if (response.status >= 400) {
          const statusCode = response.status;
          let errorData = response.data;
          if (errorData && typeof errorData.pipe === 'function') {
            try {
              const raw = await this.readStreamBuffer(errorData, response.headers);
              try { errorData = JSON.parse(raw); } catch (e) { errorData = { raw: raw.substring(0, 500) }; }
            } catch (e) { errorData = { readError: e.message }; }
          }
          const errorMessage = this.extractErrorMessage({ response: { data: errorData } }, `Upstream returned ${statusCode}`);
          console.error(`[proxy-openai] Stream upstream error: ${statusCode} ${errorMessage}`);
          this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source?._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode, latencyMs: Date.now() - startTime, errorMessage });
          if (statusCode === 429) {
            dispatcher.handleRateLimit(source?.id, errorMessage);
          } else if (statusCode >= 500) {
            dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
          } else if (statusCode === 401 || statusCode === 403) {
            dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
          }
          releaseConcurrent();
          return res.status(statusCode).json({ error: { message: errorMessage, type: 'proxy_error', code: statusCode } });
        }

        // 检查上游返回的 Content-Type 是否匹配 SSE 格式（某些源站在高并发下可能返回 200+JSON）
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
          let errorData = response.data;
          if (errorData && typeof errorData.pipe === 'function') {
            try {
              const raw = await this.readStreamBuffer(errorData, response.headers);
              try { errorData = JSON.parse(raw); } catch (e) { errorData = { raw: raw.substring(0, 500) }; }
            } catch (e) { errorData = { readError: e.message }; }
          }
          const errorMessage = this.extractErrorMessage({ response: { data: errorData } }, 'Upstream returned JSON instead of SSE stream');
          console.error(`[proxy-openai] Stream format mismatch: upstream returned Content-Type=${contentType}, message: ${errorMessage}`);
          this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source?._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode: 502, latencyMs: Date.now() - startTime, errorMessage });
          dispatcher.markSourceFailed(source?.id, errorMessage, 502);
          releaseConcurrent();
          return res.status(502).json({ error: { message: errorMessage, type: 'proxy_error', code: 502 } });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let totalTokens = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let hasThinking = false;
        let fallbackText = ''; // accumulate content text only, not raw buffers
        let hasReceivedDone = false;
        let scanBuffer = [];
        let scanBufferLen = 0;
        const MAX_SCAN_BUFFER_LEN = 131072;

        isStreaming = true;
        const decoder = new StringDecoder('utf8');
        let sseBuffer = ''; // buffer incomplete SSE lines across TCP chunks

        // Guard against client disconnects killing the process
        res.on('error', (err) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            console.error('[proxy-openai] Response stream error:', err.message);
          }
        });
        response.data.on('error', (err) => {
          console.error('[proxy-openai] Upstream stream error:', err.message);
          try { res.end(); } catch (e) {}
          releaseConcurrent();
        });

        let isFirstChunk = true;
        response.data.on('data', (chunk) => {
          // Use StringDecoder to correctly handle UTF-8 multi-byte characters across chunk boundaries
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

          // Detect upstream returning HTML instead of SSE (e.g. WAF/CDN error page under high load)
          if (isFirstChunk) {
            isFirstChunk = false;
            if (chunkStr.includes('<!DOCTYPE') || chunkStr.includes('<html') || chunkStr.includes('<body') || chunkStr.includes('<head')) {
              console.error(`[proxy-openai] Upstream ${source.name} returned HTML instead of SSE, aborting stream`);
              try { res.end(); } catch (e) {}
              releaseConcurrent();
              response.data.destroy();
              return;
            }
          }

          // Buffer incomplete SSE lines across TCP chunks, then parse complete lines only
          sseBuffer += chunkStr;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || ''; // keep trailing incomplete line for next chunk

          for (const line of lines) {
            // Track upstream [DONE] without modifying output bytes
            if (line.trim() === 'data: [DONE]') {
              hasReceivedDone = true;
              continue;
            }
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens || inputTokens;
                outputTokens = parsed.usage.completion_tokens || outputTokens;
                totalTokens = parsed.usage.total_tokens || totalTokens;
                // Debug: log usage object to identify DashScope cache fields
                if (parsed.usage.prompt_tokens_details || parsed.usage.prompt_cache_hit_tokens || parsed.usage.cache_read_input_tokens || parsed.usage.cached_input_tokens || parsed.usage.cache_hit_tokens || parsed.usage.prompt_cache_miss_tokens) {
                  if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] Cache usage fields:', JSON.stringify(parsed.usage));
                }
                cachedTokens = parsed.usage.prompt_tokens_details?.cached_tokens ||
                               parsed.usage.prompt_cache_hit_tokens ||
                               parsed.usage.cache_read_input_tokens ||
                               parsed.usage.cached_input_tokens ||
                               parsed.usage.cache_hit_tokens || cachedTokens;
                if (!cachedTokens && parsed.usage.prompt_cache_miss_tokens && inputTokens > 0) {
                  cachedTokens = Math.max(0, inputTokens - parsed.usage.prompt_cache_miss_tokens);
                }
                if ((parsed.usage.completion_tokens_details?.reasoning_tokens || 0) > 0) {
                  hasThinking = true;
                }
              }
              // Accumulate content text for fallback token estimation
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                fallbackText += delta.content;
              }
            } catch (e) {}
          }

          // Forward raw bytes to client — preserves upstream encoding exactly
          try { res.write(chunk); } catch (e) { /* Client disconnected, ignore */ }
        });

        response.data.on('end', () => {
          const remaining = decoder.end();
          if (remaining) sseBuffer += remaining;

          if (sseBuffer) {
            // Parse any trailing usage data
            const lines = sseBuffer.split('\n');
            for (const line of lines) {
              if (line.trim() === 'data: [DONE]') {
                hasReceivedDone = true;
                continue;
              }
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                  hasReceivedDone = true;
                  continue;
                }
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.usage) {
                    inputTokens = parsed.usage.prompt_tokens || inputTokens;
                    outputTokens = parsed.usage.completion_tokens || outputTokens;
                    totalTokens = parsed.usage.total_tokens || totalTokens;
                  }
                } catch (e) {}
              }
            }
          }
          sseBuffer = '';

          // Ensure [DONE] is sent exactly once
          if (!hasReceivedDone) {
            try { res.write('data: [DONE]\n\n'); } catch (e) {}
          }
          try { res.end(); } catch (e) {}

          if (totalTokens === 0 && fallbackText.length > 0) {
            outputTokens = Math.ceil(fallbackText.length / 4);
            totalTokens = outputTokens;
          }
          fallbackText = ''; // free memory immediately
          const latency = Date.now() - startTime;
          const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
          this.logRequest({
            userId: req.apiKey?.userId,
            userKeyId: req.apiKey?.id,
            sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
            model,
            protocol: clientProtocol,
            inputTokens, outputTokens, totalTokens,
            cachedTokens, cacheCreationTokens: 0, uncachedTokens,
            statusCode: 200, latencyMs: latency,
            hasThinking
          });
          dispatcher.markSourceSuccess(source.id);
          dispatcher.updateStats(source.id, totalTokens);
          releaseConcurrent();
          transitScanner.scan({ rawBody: scanBuffer.join(''), req, source, statusCode: 200 }).catch(() => {});
        });

        return;
      }

      // Non-streaming
      // 空响应检测：均衡实例成员返回空 choices 或空 content 时，自动故障转移
      if (source._instanceId) {
        const choices = response.data.choices;
        const hasEmptyContent = !choices || choices.length === 0 || !choices[0]?.message?.content;
        if (hasEmptyContent) {
          try {
            const members = await db.all(
              `SELECT s.* FROM instance_members im
               JOIN sources s ON im.source_id = s.id
               WHERE im.instance_id = ? AND s.id != ? AND s.is_active = true
                 AND s.status != 'error' AND s.status != 'invalid'
                 AND (s.quota_limit = 0 OR s.quota_used < s.quota_limit)
                 AND (s.direct_status IS NULL OR s.direct_status != 'disabled')
                 AND s.current_concurrent < s.max_concurrent
               ORDER BY s.current_concurrent ASC
               LIMIT 2`,
              [source._instanceId, source.id]
            );
            if (members.length > 0) {
              releaseConcurrent();
              console.warn(`[proxy-openai] Instance member ${source.name} returned empty response, retrying with ${members.length} fallback member(s)`);
              for (const member of members) {
                try {
                  console.warn(`[proxy-openai] Retrying empty response with member ${member.name} (${member.id})`);
                  return await this.proxy(req, res, member, startTime, clientProtocol);
                } catch (retryErr) {
                  console.error(`[proxy-openai] Fallback member ${member.id} also failed:`, retryErr.message);
                }
              }
            }
          } catch (e) {
            console.error('[proxy-openai] Failed to get fallback members for empty response:', e.message);
          }
        }
      }

      const latency = Date.now() - startTime;
      const usage = response.data.usage || {};
      const totalTokens = usage.total_tokens || 0;
      // Debug: log usage object to identify DashScope cache fields
      if (usage.prompt_tokens_details || usage.prompt_cache_hit_tokens || usage.cache_read_input_tokens || usage.cached_input_tokens || usage.cache_hit_tokens || usage.prompt_cache_miss_tokens) {
        if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] Cache usage fields:', JSON.stringify(usage));
      }
      let cachedTokens = usage.prompt_tokens_details?.cached_tokens ||
                           usage.prompt_cache_hit_tokens ||
                           usage.cache_read_input_tokens ||
                           usage.cached_input_tokens ||
                           usage.cache_hit_tokens || 0;
      const inputTokens = usage.prompt_tokens || 0;
      if (!cachedTokens && usage.prompt_cache_miss_tokens && inputTokens > 0) {
        cachedTokens = Math.max(0, inputTokens - usage.prompt_cache_miss_tokens);
      }
      const uncachedTokens = Math.max(0, inputTokens - cachedTokens);

      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model,
        protocol: clientProtocol,
        inputTokens,
        outputTokens: usage.completion_tokens || 0,
        totalTokens,
        cachedTokens, cacheCreationTokens: 0, uncachedTokens,
        statusCode: 200, latencyMs: latency,
        hasThinking: (usage.completion_tokens_details?.reasoning_tokens || 0) > 0
      });

      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
      dispatcher.probeConcurrencyLimit(source.id);
      res.json(response.data);
      transitScanner.scan({ rawBody: JSON.stringify(response.data), req, source, statusCode: 200 }).catch(() => {});
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      let errorMessage = this.extractErrorMessage(error);

      // 均衡实例故障转移：如果当前成员返回 500/503，尝试其他可用成员
      if (source._instanceId && !res.headersSent && (statusCode >= 500 || statusCode === 429 || statusCode === 503)) {
        try {
          const members = await db.all(
            `SELECT s.* FROM instance_members im
             JOIN sources s ON im.source_id = s.id
             WHERE im.instance_id = ? AND s.id != ? AND s.is_active = true
               AND s.status != 'error' AND s.status != 'invalid'
               AND (s.quota_limit = 0 OR s.quota_used < s.quota_limit)
               AND (s.direct_status IS NULL OR s.direct_status != 'disabled')
               AND s.current_concurrent < s.max_concurrent
             ORDER BY s.current_concurrent ASC
             LIMIT 2`,
            [source._instanceId, source?.id]
          );
          if (members.length > 0) {
            // 释放当前失败成员的并发
            releaseConcurrent();
            console.warn(`[proxy-openai] Instance member ${source.name} (${source?.id}) failed with ${statusCode}, retrying with ${members.length} fallback member(s)`);
            for (const member of members) {
              try {
                console.warn(`[proxy-openai] Retrying with member ${member.name} (${member.id})`);
                return await this.proxy(req, res, member, startTime, clientProtocol);
              } catch (retryErr) {
                console.error(`[proxy-openai] Fallback member ${member.id} also failed:`, retryErr.message);
              }
            }
          }
        } catch (e) {
          console.error('[proxy-openai] Failed to get fallback members:', e.message);
        }
      }

      // 尝试从上游响应中提取更具体的错误信息（流式错误 response.data 是流对象，需要先读取）
      let upstreamDetail = null;
      if (error.response?.data) {
        const data = error.response.data;
        if (data && typeof data.pipe === 'function') {
          try {
            upstreamDetail = (await this.readStreamBuffer(data, error.response.headers)).substring(0, 1000);
          } catch (e) { upstreamDetail = null; }
        } else {
          try { upstreamDetail = JSON.stringify(data).substring(0, 1000); } catch (e) { upstreamDetail = null; }
        }
      }
      if (upstreamDetail) {
        try {
          const parsed = JSON.parse(upstreamDetail);
          const upstreamMessage = this.extractErrorMessage({ response: { data: parsed } });
          if (upstreamMessage && upstreamMessage !== errorMessage) errorMessage = upstreamMessage;
        } catch (e) {
          if (upstreamDetail !== errorMessage) errorMessage = `${errorMessage} | ${upstreamDetail}`;
        }
      }

      // 详细错误日志（节流：同一源站+状态码每 5 秒只打一次详情，避免同步 I/O 阻塞事件循环）
      const errorLogKey = `${source?.id || 'unknown'}:${statusCode}:${errorMessage?.substring(0, 80) || ''}`;
      const allowDetailedLog = shouldLogUpstreamError(errorLogKey);
      if (allowDetailedLog) {
        console.error(`[proxy-openai] ERROR ${statusCode}:`, errorMessage);
        if (upstreamDetail) console.error('[proxy-openai] Upstream error detail:', upstreamDetail);
        console.error('[proxy-openai] Request URL:', error.config?.url);
        if (error.config?.data) {
          try {
            const sentBody = typeof error.config.data === 'string' ? JSON.parse(error.config.data) : error.config.data;
            const logSent = { ...sentBody };
            if (logSent.messages) logSent.messages = `[${logSent.messages.length} messages]`;
            console.error('[proxy-openai] Sent body:', JSON.stringify(logSent));
          } catch (e) {
            console.error('[proxy-openai] Sent body (raw):', String(error.config.data).slice(0, 500));
          }
        }
      } else if (process.env.LOG_LEVEL === 'debug') {
        console.error(`[proxy-openai] ERROR ${statusCode} (throttled):`, errorMessage);
      }

      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source?.id ?? null, instanceId: source?._instanceId ?? null, workspaceId: req.apiKey?.workspaceId ?? null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model: req.body?.model,
        protocol: clientProtocol,
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0,
        statusCode, latencyMs: latency, errorMessage
      });

      if (source?.id && statusCode === 429) {
        dispatcher.handleRateLimit(source.id, errorMessage);
      } else if (source?.id && statusCode >= 500) {
        dispatcher.markSourceFailed(source.id, errorMessage, statusCode);
      } else if (source?.id && (statusCode === 401 || statusCode === 403)) {
        dispatcher.markSourceFailed(source.id, errorMessage, statusCode);
      }

      if (!res.headersSent) {
        res.status(statusCode).json({
          error: { message: errorMessage, type: 'proxy_error', code: statusCode }
        });
      } else {
        // Streaming response already started — just end the stream gracefully
        try { res.end(); } catch (e) {}
      }
    } finally {
      if (!isStreaming) {
        releaseConcurrent();
      }
    }
  }

  async proxyCompletions(req, res, clientProtocol) {
    if (!clientProtocol) clientProtocol = 'openai→openai';
    let concurrentReleased = false;
    let isStreaming = false;
    let source;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source?.id).catch(() => {});
      }
    };
    const startTime = Date.now();
    try {
      const { model, prompt, suffix, stream, ...rest } = req.body;

      if (!model) {
        return res.status(400).json({
          error: { message: 'model is required', type: 'invalid_request_error' }
        });
      }

      const modelInfo = await db.get('SELECT supports_fim FROM models WHERE model_id = ? AND is_active = true LIMIT 1', [model]);
      if (modelInfo && !modelInfo.supports_fim) {
        return res.status(400).json({
          error: { message: `Model "${model}" does not support fill-in-the-middle completions`, type: 'invalid_request_error' }
        });
      }

      source = await dispatcher.selectSource(model);
      if (!source) {
        return res.status(503).json({
          error: { message: 'No available source for this model', type: 'service_unavailable' }
        });
      }

      await dispatcher.tryIncrementConcurrent(source.id);
      const apiKey = db.getApiKey(source, 'openai');
      const useStream = stream === true;

      const body = { model, prompt, stream: useStream, ...rest };
      if (suffix) body.suffix = suffix;
      // Build candidate URLs for completions endpoint
      const compBaseUrl = db.getApiUrl(source, 'openai').replace(/\/+$/, '');
      const compCandidateUrls = [`${compBaseUrl}/completions`];
      if (!compBaseUrl.endsWith('/v1')) {
        compCandidateUrls.unshift(`${compBaseUrl}/v1/completions`);
      }

      let response;
      let compLastError;
      for (const compUrl of compCandidateUrls) {
        try {
          response = await axios.post(
            compUrl,
            body,
            {
              headers: {
                'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey,
                'Content-Type': 'application/json'
              },
              timeout: 300000,
              responseType: useStream ? 'stream' : 'json'
            }
          );
          break;
        } catch (err) {
          compLastError = err;
          if (err.response?.status === 404) continue;
          throw err;
        }
      }
      if (!response) throw compLastError;

      if (useStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let totalTokens = 0;
        let hasThinking = false;
        let fallbackText = '';

        response.data.on('error', (err) => {
          console.error('[proxy-openai] Upstream stream error:', err.message);
          try { res.end(); } catch (e) {}
          releaseConcurrent();
        });

        const decoder = new StringDecoder('utf8');
        response.data.on('data', (chunk) => {
          const chunkStr = decoder.write(chunk);
          const lines = chunkStr.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.usage) {
                  totalTokens = parsed.usage.total_tokens || totalTokens;
                  if ((parsed.usage.completion_tokens_details?.reasoning_tokens || 0) > 0) {
                    hasThinking = true;
                  }
                }
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                  fallbackText += delta.content;
                }
              } catch (e) {}
            }
          }
          res.write(chunk);
        });

        response.data.on('end', () => {
          res.end();
          const latency = Date.now() - startTime;
          this.logRequest({
            userId: req.apiKey?.userId,
            userKeyId: req.apiKey?.id,
            sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
            model,
            protocol: clientProtocol,
            inputTokens: 0, outputTokens: totalTokens || Math.ceil(fallbackText.length / 4), totalTokens: totalTokens || Math.ceil(fallbackText.length / 4),
            cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: totalTokens || Math.ceil(fallbackText.length / 4),
            statusCode: 200, latencyMs: latency,
            hasThinking
          });
          dispatcher.markSourceSuccess(source.id);
          dispatcher.updateStats(source.id, totalTokens || Math.ceil(fallbackText.length / 4));
          releaseConcurrent();
        });

        response.data.on('error', () => {
          try { res.end(); } catch (e) {}
          releaseConcurrent();
        });

        return;
      }

      const latency = Date.now() - startTime;
      const usage = response.data.usage || {};
      const totalTokens = usage.total_tokens || 0;

      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model,
        protocol: clientProtocol,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        totalTokens,
        cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: totalTokens,
        statusCode: 200, latencyMs: latency,
        hasThinking: (usage.completion_tokens_details?.reasoning_tokens || 0) > 0
      });

      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
      dispatcher.probeConcurrencyLimit(source.id);
      res.json(response.data);
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      const errorMessage = this.extractErrorMessage(error);

      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model: req.body?.model,
        protocol: clientProtocol,
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

  async proxyImage(req, res, source, startTime, clientProtocol) {
    if (!clientProtocol) clientProtocol = 'openai→openai';
    try {
      if (!startTime) startTime = Date.now();
      const { model, prompt, ...rest } = req.body;

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

      // 检测是否为 DashScope 源站，走原生图片 API
      const baseUrl = db.getApiUrl(source, 'openai').replace(/\/+$/, '');
      if (baseUrl.includes('dashscope.aliyuncs.com') || baseUrl.includes('dashscope')) {
        return await this._proxyDashScopeImage(req, res, source, startTime, model, prompt, rest, clientProtocol);
      }

      await dispatcher.tryIncrementConcurrent(source.id);
      const apiKey = db.getApiKey(source, 'openai');

      const body = { model, prompt, ...rest };
      this.cleanUndefined(body);

      const modelInfo = await this.getModelInfo(model, source.id);
      if (modelInfo?.source_model_id) body.model = modelInfo.source_model_id;

      const candidateUrls = [`${baseUrl}/images/generations`];
      if (!baseUrl.endsWith('/v1')) {
        candidateUrls.unshift(`${baseUrl}/v1/images/generations`);
      }
      let response;
      let lastError;
      for (const upstreamUrl of candidateUrls) {
        try {
          if (process.env.LOG_LEVEL === "debug") console.log('[proxy-image] Trying:', upstreamUrl);
          response = await axios.post(upstreamUrl, body, {
            headers: {
              'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey,
              'Content-Type': 'application/json'
            },
            timeout: 300000
          });
          break;
        } catch (err) {
          lastError = err;
          if (err.response?.status === 404) continue;
          throw err;
        }
      }
      if (!response) throw lastError;

      // Handle async task-based APIs (e.g. doubao/火山引擎)
      // If response has status field indicating a task, poll until complete
      const taskData = response.data;
      if (taskData && taskData.id && taskData.status && ['pending', 'running', 'processing', 'submitted'].includes(taskData.status)) {
        if (process.env.LOG_LEVEL === "debug") console.log('[proxy-image] Task-based response detected, polling task:', taskData.id);
        const pollUrl = `${candidateUrls[0].replace(/\/generations$/, '')}/generations/${taskData.id}`;
        const maxPolls = 60; // max 60 polls
        const pollInterval = 2000; // 2s between polls

        for (let i = 0; i < maxPolls; i++) {
          await new Promise(r => setTimeout(r, pollInterval));
          try {
            const pollRes = await axios.get(pollUrl, {
              headers: { 'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey },
              timeout: 15000
            });
            const pollData = pollRes.data;
            if (process.env.LOG_LEVEL === "debug") console.log(`[proxy-image] Poll ${i + 1}: status=${pollData.status}`);

            if (pollData.status === 'succeeded' || pollData.status === 'completed' || pollData.status === 'success') {
              // Convert to OpenAI format: { created, data: [{url: "..."}] or [{b64_json: "..."}] }
              const images = pollData.data || pollData.result?.data || pollData.output?.images || pollData.images || [];
              const openaiData = images.map(img => {
                if (img.b64_json || img.url) return img;
                if (img.base64) return { b64_json: img.base64 };
                if (img.image_url) return { url: img.image_url };
                return img;
              });
              const finalData = openaiData.length > 0 ? openaiData : images;
              // If client requested b64_json but got URLs, download and convert
              if (body.response_format === 'b64_json' && finalData.some(d => d.url && !d.b64_json)) {
                for (const item of finalData) {
                  if (item.url && !item.b64_json) {
                    for (let retry = 0; retry < 3; retry++) {
                      try {
                        const imgRes = await axios.get(item.url, {
                          responseType: 'arraybuffer',
                          timeout: 30000,
                          headers: { 'User-Agent': 'Mozilla/5.0' }
                        });
                        item.b64_json = Buffer.from(imgRes.data).toString('base64');
                        delete item.url;
                        break;
                      } catch (dlErr) {
                        if (process.env.LOG_LEVEL === "debug") console.log(`[proxy-image] Download attempt ${retry + 1} failed:`, dlErr.message);
                        if (retry === 2 && process.env.LOG_LEVEL === 'debug') console.log('[proxy-image] All download attempts failed, returning URL instead');
                        await new Promise(r => setTimeout(r, 1000));
                      }
                    }
                  }
                }
              }
              response.data = {
                created: pollData.created_at || Math.floor(Date.now() / 1000),
                data: finalData
              };
              break;
            } else if (pollData.status === 'failed' || pollData.status === 'error') {
              throw new Error(pollData.error?.message || pollData.message || 'Image generation failed');
            }
            // else continue polling
          } catch (pollErr) {
            if (i === maxPolls - 1) throw pollErr;
            // ignore transient errors and keep polling
          }
        }
      }

      const latency = Date.now() - startTime;
      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model,
        protocol: clientProtocol,
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0,
        statusCode: 200, latencyMs: latency
      });

      dispatcher.markSourceSuccess(source.id);
      res.json(response.data);
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      const errorMessage = this.extractErrorMessage(error);

      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model: req.body?.model,
        protocol: clientProtocol,
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
      dispatcher.decrementConcurrent(source.id).catch(() => {});
    }
  }

  /**
   * DashScope 原生图片生成 API 适配
   * 将 OpenAI 格式转为 DashScope 格式，轮询异步任务，返回 OpenAI 格式结果
   */
  async _proxyDashScopeImage(req, res, source, startTime, model, prompt, rest, clientProtocol) {
    await dispatcher.tryIncrementConcurrent(source.id);
    const apiKey = db.getApiKey(source, 'openai');

    // 使用 source_model_id 替换模型名
    const modelInfo = await this.getModelInfo(model, source.id);
    const upstreamModel = modelInfo?.source_model_id || model;

    // OpenAI 格式 → DashScope 格式
    const sizeMap = { '1024x1024': '1024*1024', '1792x1024': '1792*1024', '1024x1792': '1024*1792', '512x512': '512*512', '256x256': '256*256' };
    const dashBody = {
      model: upstreamModel,
      input: { prompt },
      parameters: {
        size: sizeMap[rest.size] || rest.size || '1024*1024',
        n: rest.n || 1
      }
    };

    const dashUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis';
    if (process.env.LOG_LEVEL === "debug") console.log('[proxy-image] DashScope native API:', dashUrl, 'model:', upstreamModel, '(original:', model, ')');

    try {
      // 提交异步任务
      const response = await axios.post(dashUrl, dashBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        timeout: 30000
      });

      const taskData = response.data;
      const taskId = taskData.output?.task_id;
      if (!taskId) {
        throw new Error(taskData.output?.message || 'No task_id returned from DashScope');
      }

      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-image] DashScope task submitted:', taskId);

      // 轮询任务状态
      const pollUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`;
      const maxPolls = 90;
      const pollInterval = 3000;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(r => setTimeout(r, pollInterval));
        const pollRes = await axios.get(pollUrl, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey },
          timeout: 15000
        });
        const pollData = pollRes.data;
        const status = pollData.output?.task_status;
        if (process.env.LOG_LEVEL === "debug") console.log(`[proxy-image] DashScope poll ${i + 1}: status=${status}`);

        if (status === 'SUCCEEDED') {
          const images = pollData.output?.results || [];
          const openaiData = [];

          for (const img of images) {
            if (img.url) {
              if (req.body.response_format === 'b64_json') {
                // 下载图片转 base64
                try {
                  const imgRes = await axios.get(img.url, { responseType: 'arraybuffer', timeout: 30000 });
                  openaiData.push({ b64_json: Buffer.from(imgRes.data).toString('base64') });
                } catch (dlErr) {
                  if (process.env.LOG_LEVEL === "debug") console.log('[proxy-image] DashScope download failed, returning URL:', dlErr.message);
                  openaiData.push({ url: img.url });
                }
              } else {
                openaiData.push({ url: img.url });
              }
            }
          }

          const latency = Date.now() - startTime;
          this.logRequest({
            userId: req.apiKey?.userId, userKeyId: req.apiKey?.id,
            sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model, protocol: clientProtocol,
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0,
            statusCode: 200, latencyMs: latency
          });

          dispatcher.markSourceSuccess(source.id);
          return res.json({
            created: Math.floor(Date.now() / 1000),
            data: openaiData
          });
        } else if (status === 'FAILED') {
          throw new Error(pollData.output?.message || 'DashScope image generation failed');
        }
        // PENDING / RUNNING → continue polling
      }

      throw new Error('DashScope image generation timed out');
    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      const errorMessage = this.extractErrorMessage(error);

      this.logRequest({
        userId: req.apiKey?.userId, userKeyId: req.apiKey?.id,
        sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: req.body?.model, protocol: clientProtocol,
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
      dispatcher.decrementConcurrent(source.id).catch(() => {});
    }
  }

  /**
   * 带协议转换的代理方法
   * 客户端发 Anthropic 格式 → 转为 OpenAI → 发给源站 → 收到 OpenAI 响应 → 转回 Anthropic
   * 直接处理完整的代理+转换流程，不依赖 res.write 拦截
   */
  async proxyWithConversion(req, res, source, startTime, clientProtocol) {
    const AnthropicConverter = require('./converter-anthropic');
    if (!clientProtocol) clientProtocol = req._clientProtocol ? req._clientProtocol + '→openai' : 'anthropic→openai';
    req._clientProtocol = clientProtocol;

    if (!startTime) startTime = Date.now();

    const anthropicBody = req.body;
    const openaiBody = AnthropicConverter.requestToOpenai(anthropicBody);
    this.cleanUndefined(openaiBody);

    const useStream = openaiBody.stream === true;
    const apiKey = db.getApiKey(source, 'openai');
    if (!apiKey) {
      return res.status(502).json({ error: { message: `Source "${source.name}" missing API key`, type: 'server_error' } });
    }

    const modelInfo = await this.getModelInfo(openaiBody.model, source.id);
    if (modelInfo?.source_model_id) openaiBody.model = modelInfo.source_model_id;
    if (useStream) openaiBody.stream_options = { include_usage: true };

    // Debug: log the exact request body sent to upstream
    if (process.env.LOG_LEVEL === "debug") console.log('[proxy-openai] upstream request body:', safeJsonStringify(openaiBody));

    const baseUrl = db.getApiUrl(source, 'openai').replace(/\/+$/, '');
    const candidateUrls = [`${baseUrl}/chat/completions`];
    if (!baseUrl.endsWith('/v1')) candidateUrls.unshift(`${baseUrl}/v1/chat/completions`);

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

      let response;
      let lastError;
      for (const upstreamUrl of candidateUrls) {
        try {
          response = await axios.post(upstreamUrl, openaiBody, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey, 'Content-Type': 'application/json' },
            timeout: 300000,
            responseType: useStream ? 'stream' : 'json',
            validateStatus: () => true
          });
          break;
        } catch (err) {
          lastError = err;
          if (err.response?.status === 404) continue;
          throw err;
        }
      }
      if (!response) throw lastError;

      // 处理上游错误响应
      if (response.status >= 400) {
        const statusCode = response.status;
        let errorData = response.data;
        if (errorData && typeof errorData.pipe === 'function') {
          try {
            const raw = await this.readStreamBuffer(errorData, response.headers);
            try { errorData = JSON.parse(raw); } catch (e) { errorData = { raw: raw.substring(0, 500) }; }
          } catch (e) { errorData = { readError: e.message }; }
        }
        const errorMessage = this.extractErrorMessage({ response: { data: errorData } }, `Upstream returned ${statusCode}`);
        console.error(`[proxy-openai] proxyWithConversion upstream error: ${statusCode} ${errorMessage}`);
        console.error('[proxy-openai] request body was:', safeJsonStringify(openaiBody));
        this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source?._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: openaiBody.model, protocol: clientProtocol, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode, latencyMs: Date.now() - startTime, errorMessage });
        if (statusCode === 429) {
          dispatcher.handleRateLimit(source?.id, errorMessage);
        } else if (statusCode >= 500) {
          dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
        } else if (statusCode === 401 || statusCode === 403) {
          dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
        }
        releaseConcurrent();
        return res.status(statusCode).json({ error: { message: errorMessage, type: 'proxy_error', code: statusCode } });
      }

      // 检查上游返回的 Content-Type 是否匹配 SSE 格式
      const contentTypeConv = response.headers['content-type'] || '';
      if (useStream && contentTypeConv.includes('application/json') && !contentTypeConv.includes('text/event-stream')) {
        let errorData = response.data;
        if (errorData && typeof errorData.pipe === 'function') {
          try {
            const raw = await this.readStreamBuffer(errorData, response.headers);
            try { errorData = JSON.parse(raw); } catch (e) { errorData = { raw: raw.substring(0, 500) }; }
          } catch (e) { errorData = { readError: e.message }; }
        }
        const errorMessage = this.extractErrorMessage({ response: { data: errorData } }, 'Upstream returned JSON instead of SSE stream');
        console.error(`[proxy-openai] proxyWithConversion format mismatch: Content-Type=${contentTypeConv}, message: ${errorMessage}`);
        this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source?._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: openaiBody.model, protocol: clientProtocol, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode: 502, latencyMs: Date.now() - startTime, errorMessage });
        dispatcher.markSourceFailed(source?.id);
        releaseConcurrent();
        return res.status(502).json({ error: { message: errorMessage, type: 'proxy_error', code: 502 } });
      }

      // 非流式响应
      if (!useStream) {
        const latency = Date.now() - startTime;
        const anthropicResponse = AnthropicConverter.responseToAnthropic(response.data, anthropicBody.model);
        const usage = response.data?.usage || {};
        const nsInputTokens = usage.prompt_tokens || anthropicResponse.usage?.input_tokens || 0;
        const nsOutputTokens = usage.completion_tokens || anthropicResponse.usage?.output_tokens || 0;
        const nsCachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || usage.cache_read_input_tokens || usage.cached_input_tokens || usage.cache_hit_tokens || 0;
        const nsUncachedTokens = Math.max(0, nsInputTokens - nsCachedTokens);
        this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: openaiBody.model, protocol: clientProtocol, inputTokens: nsInputTokens, outputTokens: nsOutputTokens, totalTokens: nsInputTokens + nsOutputTokens, cachedTokens: nsCachedTokens, cacheCreationTokens: 0, uncachedTokens: nsUncachedTokens, statusCode: 200, latencyMs: latency, hasThinking: (usage.completion_tokens_details?.reasoning_tokens || 0) > 0 });
        dispatcher.markSourceSuccess(source.id);
        transitScanner.scan({ rawBody: JSON.stringify(response.data), req, source, statusCode: 200 }).catch(() => {});
        return res.json(anthropicResponse);
      }

      // 流式响应：直接读取上游流，转换后写入 res
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let streamState = { started: false, contentBlockStarted: false, textBlockClosed: false, thinkingBlockStarted: false, thinkingBlockClosed: false, toolCalls: null };
      let buffer = '';
      let inputTokens = 0, outputTokens = 0, cachedTokens = 0, hasThinking = false;
      let scanBuffer = [];
      let scanBufferLen = 0;
      const MAX_SCAN_BUFFER_LEN = 131072;
      const decoder = new StringDecoder('utf8');

      const processLine = (line) => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || inputTokens;
            outputTokens = parsed.usage.completion_tokens || outputTokens;
            cachedTokens = parsed.usage.prompt_tokens_details?.cached_tokens ||
                           parsed.usage.prompt_cache_hit_tokens ||
                           parsed.usage.cache_read_input_tokens ||
                           parsed.usage.cached_input_tokens ||
                           parsed.usage.cache_hit_tokens || cachedTokens;
            if (!cachedTokens && parsed.usage.prompt_cache_miss_tokens && inputTokens > 0) {
              cachedTokens = Math.max(0, inputTokens - parsed.usage.prompt_cache_miss_tokens);
            }
            if ((parsed.usage.completion_tokens_details?.reasoning_tokens || 0) > 0) {
              hasThinking = true;
            }
          }
          const events = AnthropicConverter.streamChunkToAnthropic(parsed, streamState);
          for (const event of events) {
            try {
              res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
            } catch (writeErr) {}
          }
        } catch (e) {}
      };

      response.data.on('error', (err) => {
        console.error('[proxy-openai] Upstream stream error:', err.message);
        try { res.end(); } catch (e) {}
        releaseConcurrent();
      });
      res.on('close', () => {
        releaseConcurrent();
      });

      let isFirstChunkConv = true;
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

        // Detect upstream returning HTML instead of SSE
        if (isFirstChunkConv) {
          isFirstChunkConv = false;
          if (chunkStr.includes('<!DOCTYPE') || chunkStr.includes('<html') || chunkStr.includes('<body') || chunkStr.includes('<head')) {
            console.error(`[proxy-openai] proxyWithConversion upstream ${source.name} returned HTML instead of SSE, aborting stream`);
            try { res.end(); } catch (e) {}
            releaseConcurrent();
            response.data.destroy();
            return;
          }
        }

        const lines = (buffer + chunkStr).split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
        }
      });

      response.data.on('end', () => {
        const remaining = decoder.end();
        if (remaining || buffer) {
          const finalLines = (buffer + remaining).split('\n');
          for (const line of finalLines) {
            processLine(line);
          }
          buffer = '';
        }
        try {
          // 确保发送 message_stop
          if (!streamState.ended) {
            streamState.ended = true;
            if (!streamState.started) {
              try { res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', content: [], model: anthropicBody.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`); } catch (e) {}
              try { res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`); } catch (e) {}
              try { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`); } catch (e) {}
            }
            if (streamState.contentBlockStarted && !streamState.textBlockClosed) {
              try { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`); } catch (e) {}
            }
            if (streamState.thinkingBlockStarted && !streamState.thinkingBlockClosed) {
              const thinkingIndex = streamState.toolCalls ? Object.keys(streamState.toolCalls).length + 1 : 1;
              try { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: thinkingIndex })}\n\n`); } catch (e) {}
            }
            try { res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`); } catch (e) {}
            try { res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`); } catch (e) {}
          }
          try { res.end(); } catch (e) {}
        } catch (e) {}

        const latency = Date.now() - startTime;
        const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
        this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: openaiBody.model, protocol: clientProtocol, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens, cacheCreationTokens: 0, uncachedTokens, statusCode: 200, latencyMs: latency, hasThinking });
        dispatcher.markSourceSuccess(source?.id);
        dispatcher.updateStats(source?.id, inputTokens + outputTokens);
        releaseConcurrent();
        transitScanner.scan({ rawBody: scanBuffer.join(''), req, source, statusCode: 200 }).catch(() => {});
      });

      response.data.on('error', (err) => {
        console.error('[proxy-openai] Stream error:', err.message);
        try { res.end(); } catch (e) {}
        releaseConcurrent();
      });

      isStreaming = true;
      return;

    } catch (error) {
      const latency = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      const errorMessage = this.extractErrorMessage(error);
      console.error('[proxy-openai] Error:', statusCode, errorMessage);
      this.logRequest({ userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency, model: req.body?.model, protocol: clientProtocol, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0, statusCode, latencyMs: latency, errorMessage });
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
   * TTS 透传代理（OpenAI /v1/audio/speech）
   * 请求体和响应直接透传，不做任何转换
   */
  async proxyTTS(req, res) {
    let source;
    let concurrentReleased = false;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source?.id).catch(() => {});
      }
    };
    try {
      const startTime = Date.now();
      const { model } = req.body;

      if (!model) {
        return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
      }

      source = await dispatcher.selectSource(model, 'openai');
      if (!source) {
        return res.status(503).json({ error: { message: 'No available source for this model', type: 'service_unavailable' } });
      }

      await dispatcher.tryIncrementConcurrent(source.id);
      const apiKey = db.getApiKey(source, 'openai');
      if (!apiKey) {
        dispatcher.decrementConcurrent(source.id).catch(() => {});
        return res.status(502).json({ error: { message: `Source "${source.name}" missing API key`, type: 'server_error' } });
      }
      res.on('close', () => {
        releaseConcurrent();
      });
      const upstreamUrl = `${db.getApiUrl(source, 'openai').replace(/\/+$/, '')}/audio/speech`;
      const response = await axios.post(upstreamUrl, req.body, {
        headers: {
          'Authorization': `Bearer ${apiKey}`, 'api-key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 300000,
        responseType: 'stream'
      });

      // 透传响应头
      const contentType = response.headers['content-type'] || 'audio/mpeg';
      res.setHeader('Content-Type', contentType);
      if (response.headers['content-disposition']) {
        res.setHeader('Content-Disposition', response.headers['content-disposition']);
      }

      response.data.pipe(res).on('error', (err) => {
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          console.error('[proxy-openai] TTS pipe error:', err.message);
        }
      });
      res.on('error', (err) => {
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          console.error('[proxy-openai] TTS response stream error:', err.message);
        }
      });

      response.data.on('end', () => {
        try { res.end(); } catch (e) {}
        const latency = Date.now() - startTime;
        this.logRequest({
          userId: req.apiKey?.userId, userKeyId: req.apiKey?.id, sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
          model, protocol: 'openai→openai', inputTokens: 0, outputTokens: 0, totalTokens: 0,
          cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: 0,
          statusCode: 200, latencyMs: latency
        });
        dispatcher.markSourceSuccess(source?.id);
        releaseConcurrent();
      });

      response.data.on('error', (err) => {
        console.error('[proxy-openai] TTS stream error:', err.message);
        try { res.end(); } catch (e) {}
        releaseConcurrent();
      });

    } catch (error) {
      releaseConcurrent();
      const statusCode = error.response?.status || 502;
      const errorMessage = this.extractErrorMessage(error, 'TTS proxy error');
      console.error(`[proxy-openai] TTS error: ${statusCode} ${errorMessage}`);

      if (source?.id && (statusCode >= 500 || statusCode === 429)) {
        dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
      } else if (source?.id && (statusCode === 401 || statusCode === 403)) {
        dispatcher.markSourceFailed(source?.id, errorMessage, statusCode);
      }

      if (!res.headersSent) {
        res.status(statusCode).json({ error: { message: errorMessage, type: 'proxy_error', code: statusCode } });
      } else {
        try { res.end(); } catch (e) {}
      }
    }
  }
}

module.exports = new ProxyOpenAI();
