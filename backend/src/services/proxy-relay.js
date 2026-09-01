const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const db = require('../config/database');
const dispatcher = require('./dispatcher');
const ProxyBase = require('./proxy-base');

/**
 * 系统级中转代理 - 透传模式
 * 不做任何协议转换，直接转发请求到中转站，原样返回响应
 * 中转站自己处理协议转换
 */
class ProxyRelay extends ProxyBase {
  async proxy(req, res, source, startTime, logProtocol) {
    let concurrentReleased = false;
    let isStreaming = false;
    const releaseConcurrent = () => {
      if (!concurrentReleased) {
        concurrentReleased = true;
        dispatcher.decrementConcurrent(source.id).catch(() => {});
      }
    };
    let clientProtocol;
    try {
      if (!startTime) startTime = Date.now();
      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-relay] === Passthrough request ===');

      const apiKey = db.getApiKey(source, 'openai') || db.getApiKey(source, 'anthropic');
      if (!apiKey) {
        console.error(`[proxy-relay] Source "${source.name}" has no API key configured`);
        return res.status(502).json({
          error: { message: `Source "${source.name}" missing API key`, type: 'server_error' }
        });
      }

      // 检测客户端协议
      const isAnthropic = req.path.includes('/messages');
      clientProtocol = isAnthropic ? 'anthropic' : 'openai';
      if (!logProtocol) logProtocol = `${clientProtocol}→relay`;

      // 构建请求体 - 清理 [undefined] 值
      const body = { ...req.body };
      this.cleanUndefined(body);

      // 确定目标 URL
      const baseUrl = db.getApiUrl(source, clientProtocol).replace(/\/+$/, '').replace(/\/v1$/, '');
      let targetUrl;
      if (isAnthropic) {
        targetUrl = `${baseUrl}/v1/messages`;
      } else {
        targetUrl = `${baseUrl}/v1/chat/completions`;
      }

      if (process.env.LOG_LEVEL === "debug") console.log('[proxy-relay] Target:', targetUrl, 'Protocol:', clientProtocol);

      // 构建 headers - 同时支持两种认证方式
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };

      const useStream = body.stream === true;

      await dispatcher.tryIncrementConcurrent(source.id);

      const response = await axios.post(targetUrl, body, {
        headers,
        timeout: 300000,
        responseType: useStream ? 'stream' : 'json',
        validateStatus: () => true // 不抛出 HTTP 错误
      });

      // 如果上游返回错误，直接透传
      if (response.status >= 400) {
        if (process.env.LOG_LEVEL === "debug") console.log('[proxy-relay] Upstream error:', response.status);
        res.status(response.status);
        if (useStream && response.data?.pipe) {
          response.data.pipe(res).on('error', (err) => {
            if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
              console.error('[proxy-relay] Pipe error:', err.message);
            }
          });
        } else {
          res.json(response.data);
        }
        return;
      }

      // 流式响应 - 直接透传
      if (useStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;

        // Guard against client disconnects killing the process
        res.on('error', (err) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            console.error('[proxy-relay] Response stream error:', err.message);
          }
        });

        response.data.on('error', (err) => {
          console.error('[proxy-relay] Upstream stream error:', err.message);
          try { res.end(); } catch (e) {}
          releaseConcurrent();
        });

        const decoder = new StringDecoder('utf8');
        let isFirstChunkRelay = true;
        response.data.on('data', (chunk) => {
          const chunkStr = decoder.write(chunk);

          // Detect upstream returning HTML instead of SSE
          if (isFirstChunkRelay) {
            isFirstChunkRelay = false;
            if (chunkStr.includes('<!DOCTYPE') || chunkStr.includes('<html') || chunkStr.includes('<body') || chunkStr.includes('<head')) {
              console.error(`[proxy-relay] Upstream ${source.name} returned HTML instead of SSE, aborting stream`);
              try { res.end(); } catch (e) {}
              releaseConcurrent();
              response.data.destroy();
              return;
            }
          }

          try {
            res.write(chunk);
          } catch (e) {
            // Client disconnected, ignore
          }

          // 尝试提取 usage 信息用于日志
          try {
            const lines = chunkStr.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              const parsed = JSON.parse(data);

              // OpenAI 格式 usage
              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens || inputTokens;
                outputTokens = parsed.usage.completion_tokens || outputTokens;
              }
              // Anthropic 格式 usage
              if (parsed.message?.usage) {
                inputTokens = parsed.message.usage.input_tokens || inputTokens;
                outputTokens = parsed.message.usage.output_tokens || outputTokens;
                cachedTokens = parsed.message.usage.cache_read_input_tokens || cachedTokens;
              }
              if (parsed.usage?.input_tokens) {
                inputTokens = parsed.usage.input_tokens;
                outputTokens = parsed.usage.output_tokens || outputTokens;
              }
            }
          } catch (e) {}
        });

        response.data.on('end', () => {
          try { res.end(); } catch (e) {}
          const latency = Date.now() - startTime;
          const totalTokens = inputTokens + outputTokens;
          this.logRequest({
            userId: req.apiKey?.userId,
            userKeyId: req.apiKey?.id,
            sourceId: source?.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
            model: body.model,
            protocol: logProtocol,
            inputTokens, outputTokens, totalTokens,
            cachedTokens, cacheCreationTokens: 0,
            uncachedTokens: Math.max(0, inputTokens - cachedTokens),
            statusCode: 200, latencyMs: latency
          });
          dispatcher.markSourceSuccess(source?.id);
          dispatcher.updateStats(source?.id, totalTokens);
          releaseConcurrent();
        });

        response.data.on('error', (err) => {
          console.error('[proxy-relay] Stream error:', err.message);
          res.end();
          releaseConcurrent();
        });
        res.on('close', () => {
          releaseConcurrent();
        });
        isStreaming = true;
        return;
      }

      // 非流式响应 - 直接透传
      const latency = Date.now() - startTime;
      const usage = response.data.usage || {};
      const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;

      this.logRequest({
        userId: req.apiKey?.userId,
        userKeyId: req.apiKey?.id,
        sourceId: source.id, instanceId: source._instanceId || null, workspaceId: req.apiKey?.workspaceId || null, userCurrency: req.apiKey?.userCurrency, keyCurrency: req.apiKey?.currency,
        model: body.model,
        protocol: logProtocol,
        inputTokens, outputTokens, totalTokens,
        cachedTokens: 0, cacheCreationTokens: 0, uncachedTokens: inputTokens,
        statusCode: 200, latencyMs: latency
      });

      dispatcher.markSourceSuccess(source.id);
      dispatcher.updateStats(source.id, totalTokens);
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
        protocol: logProtocol,
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
}

module.exports = new ProxyRelay();
