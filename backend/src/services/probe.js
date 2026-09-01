const axios = require('axios');
const db = require('../config/database');
const dispatcher = require('./dispatcher');

class ProbeService {
  constructor() {
    this.results = new Map(); // sourceId -> { protocol -> { latencyMs, status, timestamp, error } }
    this.pollIntervalMs = 30 * 1000; // 30秒轮询一次，检查哪些源站到了探测时间
    this.started = false;
    this.clients = new Set(); // SSE clients

    // 各状态对应的探测间隔
    this.intervals = {
      valid: 5 * 60 * 1000,      // 正常：5分钟
      unknown: 30 * 1000,        // 未知：30秒，新源站创建后尽快完成首次探测
      checking: 2 * 60 * 1000,   // 检测中（key疑似失效）：2分钟
      invalid: 30 * 60 * 1000,   // 已禁用：30分钟（看是否人工恢复）
      error: 30 * 1000,          // 网络错误：30秒（和自动恢复保持一致）
    };

    // key失效检测的最大重试次数
    this.maxKeyFailCount = 5;
  }

  start() {
    if (this.started) return;
    this.started = true;
    console.log('[Probe] Key health probe started, poll interval: 30s');
    console.log('[Probe] Intervals: valid=5min, checking=2min, invalid=30min, error=30s');
    this.runProbeCycle();
  }

  async runProbeCycle() {
    const start = Date.now();
    try {
      await this.runProbe();
    } catch (e) {
      console.error('[Probe] Cycle error:', e.message);
    }
    // 调度下一次轮询，确保固定间隔
    const elapsed = Date.now() - start;
    const delay = Math.max(1000, this.pollIntervalMs - elapsed);
    this.timer = setTimeout(() => this.runProbeCycle(), delay);
  }

  async runProbe() {
    const roundTimestamp = new Date().toISOString();
    try {
      const sources = await db.all(`
        SELECT id, name, api_urls, api_keys, api_key, protocol, status,
               direct_last_check, direct_fail_count
        FROM sources
        WHERE is_active = true
      `);

      const now = Date.now();
      const sourcesToProbe = sources.filter(s => {
        const interval = this.intervals[s.status] || this.intervals.valid;
        const lastCheck = new Date(s.direct_last_check || '1970-01-01').getTime();
        return now - lastCheck >= interval;
      });

      if (sourcesToProbe.length > 0 && process.env.LOG_LEVEL === 'debug') {
        console.log(`[Probe] Probing ${sourcesToProbe.length} source(s):`, sourcesToProbe.map(s => `${s.name}(${s.status})`).join(', '));
      }

      for (const source of sourcesToProbe) {
        try {
          await this.probeAndUpdate(source, roundTimestamp);
        } catch (e) {
          console.error(`[Probe] Failed to probe source ${source.id} (${source.name}):`, e.message);
        }
      }

      // Broadcast to SSE clients
      this.broadcast();
    } catch (e) {
      console.error('[Probe] runProbe error:', e.message);
    }
  }

  async probeAndUpdate(source, roundTimestamp) {
    const probeResult = await this.probeSource(source, roundTimestamp);
    this.results.set(source.id, probeResult);

    const previousStatus = source.status;
    const previousFailCount = source.direct_fail_count || 0;
    let newStatus = previousStatus;
    let newFailCount = previousFailCount;
    let statusChanged = false;

    // 分析探测结果
    const values = Object.values(probeResult);
    const hasOk = values.some(r => r.status === 'ok');
    const hasInvalidKey = values.some(r => r.status === 'invalid_key');
    const hasError = values.some(r => r.status === 'error');

    // 提取用于 tooltip 的 HTTP 状态码与详情
    const firstInvalid = values.find(r => r.status === 'invalid_key');
    const firstError = values.find(r => r.status === 'error');
    const pickDetail = () => {
      if (hasOk) return { code: 200, detail: '探测正常' };
      if (firstInvalid) return { code: firstInvalid.error?.includes('401') ? 401 : 403, detail: firstInvalid.error || 'Key 失效' };
      if (firstError) return { code: null, detail: firstError.error || '探测失败' };
      return { code: null, detail: '' };
    };
    const { code: probeStatusCode, detail: probeDetail } = pickDetail();

    if (hasOk) {
      // 探测成功：任何状态都恢复为 valid
      if (previousStatus !== 'valid') {
        console.log(`[Probe] Source ${source.id} (${source.name}) recovered from ${previousStatus} to valid`);
        newStatus = 'valid';
        newFailCount = 0;
        statusChanged = true;
        await this._updateSourceStatus(source.id, 'valid', 0, probeStatusCode, probeDetail);
        await dispatcher.markSourceRecovered(source.id);
      } else {
        // 更新探测时间，重置失败计数
        await this._updateSourceStatus(source.id, 'valid', 0, probeStatusCode, probeDetail);
      }
    } else if (hasInvalidKey) {
      // Key 失效（401/403）
      if (previousStatus === 'valid' || previousStatus === 'unknown') {
        // 第一次检测到 key 失效 → checking 状态
        console.warn(`[Probe] Source ${source.id} (${source.name}) key CHECKING: ${firstInvalid?.error || 'Invalid key'} (1/${this.maxKeyFailCount})`);
        newStatus = 'checking';
        newFailCount = 1;
        statusChanged = true;
        await this._updateSourceStatus(source.id, 'checking', 1, probeStatusCode, probeDetail);
      } else if (previousStatus === 'checking') {
        newFailCount = previousFailCount + 1;
        if (newFailCount >= this.maxKeyFailCount) {
          // 5 次都失效 → 永久标记 invalid
          console.warn(`[Probe] Source ${source.id} (${source.name}) key INVALID after ${this.maxKeyFailCount} retries: ${firstInvalid?.error || 'Invalid key'}`);
          newStatus = 'invalid';
          statusChanged = true;
          await this._updateSourceStatus(source.id, 'invalid', newFailCount, probeStatusCode, probeDetail);
          await dispatcher.markSourceFailed(source.id, firstInvalid?.error || 'Probe: key invalid after max retries', 401);
        } else {
          console.warn(`[Probe] Source ${source.id} (${source.name}) key CHECKING: ${firstInvalid?.error || 'Invalid key'} (${newFailCount}/${this.maxKeyFailCount})`);
          await this._updateSourceStatus(source.id, 'checking', newFailCount, probeStatusCode, probeDetail);
        }
      } else if (previousStatus === 'invalid') {
        // 保持 invalid，更新探测时间
        await this._updateSourceStatus(source.id, 'invalid', previousFailCount, probeStatusCode, probeDetail);
      } else if (previousStatus === 'error') {
        // 从网络错误转为 key 失效
        console.warn(`[Probe] Source ${source.id} (${source.name}) key CHECKING (was error): ${firstInvalid?.error || 'Invalid key'} (1/${this.maxKeyFailCount})`);
        newStatus = 'checking';
        newFailCount = 1;
        statusChanged = true;
        await this._updateSourceStatus(source.id, 'checking', 1, probeStatusCode, probeDetail);
      }
    } else if (hasError) {
      // 网络错误（500/超时等），不影响 key 检测状态机
      // 但如果当前是 valid，按原有逻辑处理（连续3次error才标记）
      if (previousStatus === 'valid') {
        newFailCount = previousFailCount + 1;
        if (newFailCount >= 3) {
          console.warn(`[Probe] Source ${source.id} (${source.name}) network ERROR after ${newFailCount} retries`);
          newStatus = 'error';
          statusChanged = true;
          await this._updateSourceStatus(source.id, 'error', newFailCount, probeStatusCode, probeDetail);
        } else {
          await this._updateSourceStatus(source.id, 'valid', newFailCount, probeStatusCode, probeDetail);
        }
      } else if (previousStatus === 'checking') {
        // checking 状态下遇到网络错误，不增加 key 失效计数
        // 保持 checking，只更新探测时间
        await this._updateSourceStatus(source.id, 'checking', previousFailCount, probeStatusCode, probeDetail);
      } else {
        await this._updateSourceStatus(source.id, previousStatus, previousFailCount, probeStatusCode, probeDetail);
      }
    }

    // 状态真正变化时，清除相关模型缓存，确保客户端瞬时切换
    if (statusChanged) {
      await dispatcher._clearCacheBySourceId(source.id);
    }
  }

  async _updateSourceStatus(sourceId, status, failCount, statusCode = null, detail = '') {
    const detailText = detail && String(detail).length > 500 ? String(detail).slice(0, 500) + '...' : detail;
    await db.run(
      `UPDATE sources SET status = ?, direct_fail_count = ?, direct_last_check = datetime('now'), last_check_at = datetime('now'), last_check_status_code = ?, last_check_detail = ? WHERE id = ?`,
      [status, failCount, statusCode ?? null, detailText || null, sourceId]
    );
  }

  addClient(res) {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });

    // Send initial data
    const initialData = this.getResults();
    try { res.write(`data: ${JSON.stringify(initialData)}\n\n`); } catch (e) { this.clients.delete(res); }
  }

  broadcast() {
    const data = this.getResults();
    const message = `data: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (e) {
        this.clients.delete(client);
      }
    }
  }

  async probeSource(source, roundTimestamp) {
    const result = {};

    // Probe only protocols the source actually supports:
    //   - the source's native protocol (via base_url)
    //   - any explicit per-protocol URLs in api_urls
    // Avoid falling back to base_url for unrelated protocols, which produces
    // misleading "offline" rows on the latency page.
    const apiUrls = typeof source.api_urls === 'string'
      ? (source.api_urls ? JSON.parse(source.api_urls) : {})
      : (source.api_urls || {});
    const supportedProtocols = new Set([
      source.protocol,
      ...Object.keys(apiUrls),
    ].filter(Boolean));

    const protocols = ['openai', 'anthropic', 'gemini', 'bedrock'];
    for (const proto of protocols) {
      if (!supportedProtocols.has(proto)) continue;
      let apiUrl = apiUrls[proto];
      if (!apiUrl && proto === source.protocol) apiUrl = source.base_url;
      if (!apiUrl) continue;
      const start = Date.now();
      try {
        await this.probeProtocol(source, proto, apiUrl);
        result[proto] = { latencyMs: Date.now() - start, status: 'ok', timestamp: roundTimestamp };
      } catch (e) {
        const httpStatus = e.response?.status;
        const status = httpStatus === 401 || httpStatus === 403 ? 'invalid_key' : 'error';
        const errMsg = e.response?.data?.error?.message
          || e.response?.data?.message
          || (httpStatus ? `HTTP ${httpStatus}: ${e.message}` : e.message);
        result[proto] = { latencyMs: Date.now() - start, status, error: errMsg, timestamp: roundTimestamp };
      }
    }
    return result;
  }

  async probeProtocol(source, protocol, apiUrl) {
    const apiKey = db.getApiKey(source, protocol);
    if (!apiKey || !apiUrl) throw new Error('Missing key or url');

    if (protocol === 'gemini') {
      const url = `${apiUrl.replace(/\/+$/, '')}/v1beta/models?key=${apiKey}`;
      await axios.get(url, { timeout: 15000 });
      return;
    }

    if (protocol === 'anthropic') {
      const baseUrl = apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
      const url = `${baseUrl}/v1/messages`;
      try {
        await axios.post(url, {
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }, {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          timeout: 15000
        });
      } catch (e) {
        // 400 = 端点可达，仅模型/参数被拒绝（探测成功）
        if (e.response?.status === 400) return;
        throw e;
      }
      return;
    }

    if (protocol === 'bedrock') {
      const baseUrl = apiUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/models`;
      await axios.get(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 15000
      });
      return;
    }

    // openai: prefer /v1/models, fallback to /models for non-standard deployments
    const baseUrl = apiUrl.replace(/\/+$/, '');
    const candidates = baseUrl.endsWith('/v1')
      ? [`${baseUrl}/models`, `${baseUrl.replace(/\/v1$/, '')}/v1/models`]
      : [`${baseUrl}/v1/models`, `${baseUrl}/models`];

    let lastError;
    for (const url of candidates) {
      try {
        await axios.get(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          timeout: 15000
        });
        return;
      } catch (err) {
        lastError = err;
        if (err.response?.status === 404) continue;
        throw err;
      }
    }
    throw lastError;
  }

  getResults() {
    const out = {};
    for (const [id, data] of this.results.entries()) {
      out[id] = data;
    }
    return out;
  }

  async getResultsWithNames() {
    const sources = await db.all('SELECT id, name FROM sources WHERE is_active = true');
    const out = [];
    for (const s of sources) {
      const probe = this.results.get(s.id) || {};
      out.push({ id: s.id, name: s.name, probe });
    }
    return out;
  }
}

module.exports = new ProbeService();
