/**
 * StatsBuffer - 高并发下聚合计费/统计写操作，批量 flush 到 DB
 * 设计目标：
 *   1. 请求路径绝对不 await flush，避免阻塞 event loop。
 *   2. 内存聚合 + 后台批量 SQL，降低 DB 行级锁竞争。
 *   3. 失败可重试，异常时不丢数据但也不无限堆积。
 */

const db = require('../config/database');

class StatsBuffer {
  constructor() {
    this.pendingLogs = [];
    // key: `${table}:${id}`, value: { table, id, fields: { field: delta } }
    this.pendingQuota = new Map();
    // key: `${userId}:${date}:${model}`, value: { userId, date, model, requests, tokens, cost }
    this.pendingDailyStats = new Map();
    // key: `${userId}:${hour}:${model}`, value: { userId, hour, model, requests, tokens, cost }
    this.pendingHourlyStats = new Map();
    // key: `${sourceId}:${date}:${model}`, value: { sourceId, date, model, requests, tokens, cost }
    this.pendingSourceDailyStats = new Map();
    // key: `${sourceId}:${hour}:${model}`, value: { sourceId, hour, model, requests, tokens, cost }
    this.pendingSourceHourlyStats = new Map();

    this.flushTimer = null;
    this.flushScheduled = false;
    this.flushing = false;

    this.flushIntervalMs = parseInt(process.env.STATS_FLUSH_INTERVAL_MS, 10) || 1000;
    this.maxBufferSize = parseInt(process.env.STATS_BUFFER_SIZE, 10) || 200;
    this.batchSize = parseInt(process.env.STATS_BATCH_SIZE, 10) || 50;
    this.maxRetries = 3;
    this.baseRetryDelayMs = 50;
    this.maxQueueLogs = this.maxBufferSize * 5; // 硬上限，防止 OOM

    this._schedulePeriodicFlush();

    // 优雅关闭时尽量 flush 剩余数据（同步启动一次 flush）
    const flushOnExit = () => {
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flush().catch(() => {});
    };
    process.on('SIGINT', flushOnExit);
    process.on('SIGTERM', flushOnExit);
  }

  _schedulePeriodicFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this._tryFlush();
    }, this.flushIntervalMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * 请求路径调用：只修改内存结构，不触发任何异步/CPU 密集型操作。
   */
  addLog(record) {
    this.pendingLogs.push(record);
    if (this.pendingLogs.length > this.maxQueueLogs) {
      // 超出硬上限时丢弃最旧日志，避免 OOM；优先保配额准确性
      const dropCount = Math.max(1, Math.floor(this.maxQueueLogs * 0.2));
      this.pendingLogs.splice(0, dropCount);
      console.error('[StatsBuffer] Dropped', dropCount, 'oldest logs to avoid OOM');
    }
    this._maybeScheduleFlush();
  }

  addQuota(table, id, fieldDeltas) {
    if (!id || !fieldDeltas || Object.keys(fieldDeltas).length === 0) return;
    const key = `${table}:${id}`;
    const existing = this.pendingQuota.get(key);
    if (existing) {
      for (const [field, delta] of Object.entries(fieldDeltas)) {
        existing.fields[field] = (existing.fields[field] || 0) + delta;
      }
    } else {
      this.pendingQuota.set(key, { table, id: Number(id), fields: { ...fieldDeltas } });
    }
    if (this.pendingQuota.size > this.maxBufferSize * 5) {
      // 配额 map 过大时强制 flush，不阻塞调用方
      this._maybeScheduleFlush();
    }
  }

  /**
   * 聚合用户+日期+模型维度统计，供 dashboard 秒开。
   * 请求路径只改内存，不触发 IO。
   */
  addDailyModelStat({ userId, date, model, requests = 1, tokens = 0, cost = 0, latencyMs = 0 }) {
    if (!userId || !date || !model) return;
    const key = `${userId}:${date}:${model}`;
    const existing = this.pendingDailyStats.get(key);
    if (existing) {
      existing.requests += requests;
      existing.tokens += tokens;
      existing.cost += cost;
      existing.latency_ms_sum += latencyMs;
      existing.latency_ms_count += 1;
    } else {
      this.pendingDailyStats.set(key, { userId: Number(userId), date, model, requests, tokens, cost, latency_ms_sum: latencyMs, latency_ms_count: 1 });
    }
  }

  /**
   * 聚合用户+小时+模型维度统计，供 sub-day dashboard 秒开。
   * 请求路径只改内存，不触发 IO。
   */
  addHourlyModelStat({ userId, hour, model, requests = 1, tokens = 0, cost = 0, latencyMs = 0 }) {
    if (!userId || !hour || !model) return;
    const key = `${userId}:${hour}:${model}`;
    const existing = this.pendingHourlyStats.get(key);
    if (existing) {
      existing.requests += requests;
      existing.tokens += tokens;
      existing.cost += cost;
      existing.latency_ms_sum += latencyMs;
      existing.latency_ms_count += 1;
    } else {
      this.pendingHourlyStats.set(key, { userId: Number(userId), hour, model, requests, tokens, cost, latency_ms_sum: latencyMs, latency_ms_count: 1 });
    }
  }

  /**
   * 聚合源站+日期+模型维度统计，供 admin dashboard 秒开。
   * 请求路径只改内存，不触发 IO。
   */
  addSourceDailyModelStat({ sourceId, date, model, requests = 1, tokens = 0, cost = 0, latencyMs = 0 }) {
    if (!sourceId || !date || !model) return;
    const key = `${sourceId}:${date}:${model}`;
    const existing = this.pendingSourceDailyStats.get(key);
    if (existing) {
      existing.requests += requests;
      existing.tokens += tokens;
      existing.cost += cost;
      existing.latency_ms_sum += latencyMs;
      existing.latency_ms_count += 1;
    } else {
      this.pendingSourceDailyStats.set(key, { sourceId: Number(sourceId), date, model, requests, tokens, cost, latency_ms_sum: latencyMs, latency_ms_count: 1 });
    }
  }

  /**
   * 聚合源站+小时+模型维度统计，供 admin sub-day dashboard 秒开。
   * 请求路径只改内存，不触发 IO。
   */
  addSourceHourlyModelStat({ sourceId, hour, model, requests = 1, tokens = 0, cost = 0, latencyMs = 0 }) {
    if (!sourceId || !hour || !model) return;
    const key = `${sourceId}:${hour}:${model}`;
    const existing = this.pendingSourceHourlyStats.get(key);
    if (existing) {
      existing.requests += requests;
      existing.tokens += tokens;
      existing.cost += cost;
      existing.latency_ms_sum += latencyMs;
      existing.latency_ms_count += 1;
    } else {
      this.pendingSourceHourlyStats.set(key, { sourceId: Number(sourceId), hour, model, requests, tokens, cost, latency_ms_sum: latencyMs, latency_ms_count: 1 });
    }
  }

  /**
   * 如果 buffer 达到阈值且没有 scheduled，则 schedule 一次后台 flush。
   * 永远不在请求路径上 await。
   */
  _maybeScheduleFlush() {
    const shouldFlush =
      this.pendingLogs.length >= this.maxBufferSize ||
      this.pendingQuota.size >= this.maxBufferSize ||
      this.pendingDailyStats.size >= this.maxBufferSize ||
      this.pendingHourlyStats.size >= this.maxBufferSize ||
      this.pendingSourceDailyStats.size >= this.maxBufferSize ||
      this.pendingSourceHourlyStats.size >= this.maxBufferSize;
    if (shouldFlush && !this.flushScheduled) {
      this.flushScheduled = true;
      // 用 setImmediate 把 flush 推到当前事件循环末尾，避免影响请求响应
      setImmediate(() => {
        this.flushScheduled = false;
        this._tryFlush();
      });
    }
  }

  _tryFlush() {
    // fire-and-forget：不等待，异常在内部处理
    this.flush().catch(err => {
      console.error('[StatsBuffer] flush error:', err?.message || err);
    });
  }

  async flush() {
    if (this.flushing) return;
    if (this.pendingLogs.length === 0 && this.pendingQuota.size === 0 && this.pendingDailyStats.size === 0 && this.pendingHourlyStats.size === 0 && this.pendingSourceDailyStats.size === 0 && this.pendingSourceHourlyStats.size === 0) return;

    this.flushing = true;
    let logs = [];
    let quotas = [];
    let dailyStats = [];
    let hourlyStats = [];
    let sourceDailyStats = [];
    let sourceHourlyStats = [];

    try {
      // 只取一批，避免单次 SQL 过大阻塞 DB/网络
      logs = this.pendingLogs.splice(0, Math.min(this.pendingLogs.length, this.batchSize));
      const quotaEntries = Array.from(this.pendingQuota.values()).slice(0, this.batchSize);
      quotas = quotaEntries;
      for (const q of quotaEntries) this.pendingQuota.delete(`${q.table}:${q.id}`);
      const dailyEntries = Array.from(this.pendingDailyStats.values()).slice(0, this.batchSize);
      dailyStats = dailyEntries;
      for (const d of dailyEntries) this.pendingDailyStats.delete(`${d.userId}:${d.date}:${d.model}`);
      const hourlyEntries = Array.from(this.pendingHourlyStats.values()).slice(0, this.batchSize);
      hourlyStats = hourlyEntries;
      for (const d of hourlyEntries) this.pendingHourlyStats.delete(`${d.userId}:${d.hour}:${d.model}`);
      const sourceDailyEntries = Array.from(this.pendingSourceDailyStats.values()).slice(0, this.batchSize);
      sourceDailyStats = sourceDailyEntries;
      for (const d of sourceDailyEntries) this.pendingSourceDailyStats.delete(`${d.sourceId}:${d.date}:${d.model}`);
      const sourceHourlyEntries = Array.from(this.pendingSourceHourlyStats.values()).slice(0, this.batchSize);
      sourceHourlyStats = sourceHourlyEntries;
      for (const d of sourceHourlyEntries) this.pendingSourceHourlyStats.delete(`${d.sourceId}:${d.hour}:${d.model}`);

      // 并发执行 logs / quotas / daily stats / hourly stats / source stats 写入，进一步提升吞吐
      await Promise.all([
        this._flushLogs(logs),
        this._flushQuotas(quotas),
        this._flushDailyStats(dailyStats),
        this._flushHourlyStats(hourlyStats),
        this._flushSourceDailyStats(sourceDailyStats),
        this._flushSourceHourlyStats(sourceHourlyStats)
      ]);

      // 如果还有数据，递归 drain，不依赖 interval 等待
      if (this.pendingLogs.length > 0 || this.pendingQuota.size > 0 || this.pendingDailyStats.size > 0 || this.pendingHourlyStats.size > 0 || this.pendingSourceDailyStats.size > 0 || this.pendingSourceHourlyStats.size > 0) {
        setImmediate(() => this._tryFlush());
      }
    } catch (err) {
      console.error('[StatsBuffer] Flush failed:', err?.message || err);
      // 失败重试：把数据重新放回队列
      this._requeue(logs, quotas, dailyStats, hourlyStats, sourceDailyStats, sourceHourlyStats);
      // 指数退避后重试一次，避免立刻失败
      setTimeout(() => this._tryFlush(), this.baseRetryDelayMs * 2);
    } finally {
      this.flushing = false;
    }
  }

  _requeue(logs, quotas, dailyStats, hourlyStats, sourceDailyStats, sourceHourlyStats) {
    if (logs.length > 0) {
      if (this.pendingLogs.length + logs.length <= this.maxQueueLogs) {
        this.pendingLogs.unshift(...logs);
      } else {
        console.error('[StatsBuffer] Dropping', logs.length, 'logs after flush failure');
      }
    }
    if (quotas.length > 0) {
      for (const q of quotas) {
        const key = `${q.table}:${q.id}`;
        const existing = this.pendingQuota.get(key);
        if (existing) {
          for (const [field, delta] of Object.entries(q.fields)) {
            existing.fields[field] = (existing.fields[field] || 0) + delta;
          }
        } else {
          this.pendingQuota.set(key, q);
        }
      }
    }
    if (dailyStats.length > 0) {
      for (const d of dailyStats) {
        const key = `${d.userId}:${d.date}:${d.model}`;
        const existing = this.pendingDailyStats.get(key);
        if (existing) {
          existing.requests += d.requests;
          existing.tokens += d.tokens;
          existing.cost += d.cost;
          existing.latency_ms_sum += d.latency_ms_sum || 0;
          existing.latency_ms_count += d.latency_ms_count || 0;
        } else {
          this.pendingDailyStats.set(key, d);
        }
      }
    }
    if (hourlyStats.length > 0) {
      for (const d of hourlyStats) {
        const key = `${d.userId}:${d.hour}:${d.model}`;
        const existing = this.pendingHourlyStats.get(key);
        if (existing) {
          existing.requests += d.requests;
          existing.tokens += d.tokens;
          existing.cost += d.cost;
          existing.latency_ms_sum += d.latency_ms_sum || 0;
          existing.latency_ms_count += d.latency_ms_count || 0;
        } else {
          this.pendingHourlyStats.set(key, d);
        }
      }
    }
    if (sourceDailyStats.length > 0) {
      for (const d of sourceDailyStats) {
        const key = `${d.sourceId}:${d.date}:${d.model}`;
        const existing = this.pendingSourceDailyStats.get(key);
        if (existing) {
          existing.requests += d.requests;
          existing.tokens += d.tokens;
          existing.cost += d.cost;
          existing.latency_ms_sum += d.latency_ms_sum || 0;
          existing.latency_ms_count += d.latency_ms_count || 0;
        } else {
          this.pendingSourceDailyStats.set(key, d);
        }
      }
    }
    if (sourceHourlyStats.length > 0) {
      for (const d of sourceHourlyStats) {
        const key = `${d.sourceId}:${d.hour}:${d.model}`;
        const existing = this.pendingSourceHourlyStats.get(key);
        if (existing) {
          existing.requests += d.requests;
          existing.tokens += d.tokens;
          existing.cost += d.cost;
          existing.latency_ms_sum += d.latency_ms_sum || 0;
          existing.latency_ms_count += d.latency_ms_count || 0;
        } else {
          this.pendingSourceHourlyStats.set(key, d);
        }
      }
    }
  }

  async _flushLogs(logs) {
    if (logs.length === 0) return;
    const columns = [
      'user_id', 'user_key_id', 'source_id', 'model', 'protocol',
      'input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens',
      'cache_creation_tokens', 'uncached_tokens', 'status_code', 'latency_ms',
      'error_message', 'cost', 'cost_local', 'has_thinking', 'instance_id', 'workspace_id', 'request_uuid', 'client_type'
    ];
    const colCount = columns.length;
    const placeholders = new Array(logs.length);
    const values = new Array(logs.length * colCount);
    let idx = 0;

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      const row = [
        log.userId || null,
        log.userKeyId || null,
        log.sourceId,
        log.model,
        log.protocol,
        log.inputTokens,
        log.outputTokens,
        log.totalTokens,
        log.cachedTokens || 0,
        log.cacheCreationTokens || 0,
        log.uncachedTokens || 0,
        log.statusCode,
        log.latencyMs,
        log.errorMessage || null,
        log.cost,
        log.costLocal != null ? log.costLocal : log.cost,
        log.hasThinking ? true : false,
        log.instanceId || null,
        log.workspaceId || null,
        log.requestUuid || null,
        log.clientType || 'apikey'
      ];
      const ph = new Array(colCount);
      for (let j = 0; j < colCount; j++) {
        values[idx] = row[j];
        ph[j] = `$${idx + 1}`;
        idx++;
      }
      placeholders[i] = `(${ph.join(', ')})`;
    }

    const sql = `INSERT INTO request_logs (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`;
    await this._runWithRetry(sql, values);
  }

  async _flushQuotas(quotas) {
    if (quotas.length === 0) return;
    const byTable = new Map();
    for (const q of quotas) {
      if (!byTable.has(q.table)) byTable.set(q.table, []);
      byTable.get(q.table).push(q);
    }

    for (const [table, items] of byTable) {
      if (table === 'user_keys') {
        await this._flushUserKeyQuotas(items);
        continue;
      }
      await this._flushTableQuotas(table, items);
    }
  }

  async _flushTableQuotas(table, items) {
    const fields = new Set();
    for (const item of items) {
      for (const f of Object.keys(item.fields)) fields.add(f);
    }
    const fieldList = Array.from(fields);
    const cases = [];
    for (const field of fieldList) {
      const whens = [];
      for (const item of items) {
        const v = item.fields[field];
        if (typeof v === 'number') {
          // Balance is stored as NUMERIC(18,4); tiny floating-point residuals
          // (e.g. -1e-8) round to -0.0000 and display as "-0.00". Clamp them to 0.
          if (field === 'balance') {
            whens.push(`WHEN ${item.id} THEN CASE WHEN ABS(${field} + ${v}) < 0.00005 THEN 0 ELSE ${field} + ${v} END`);
          } else {
            whens.push(`WHEN ${item.id} THEN ${field} + ${v}`);
          }
        }
      }
      if (whens.length === 0) continue;
      cases.push(`${field} = CASE id ${whens.join(' ')} ELSE ${field} END`);
    }
    if (cases.length === 0) return;

    const ids = items.map(item => item.id).join(',');
    const sql = `UPDATE ${table} SET ${cases.join(', ')} WHERE id IN (${ids})`;
    await this._runWithRetry(sql, []);
  }

  async _flushDailyStats(items) {
    if (items.length === 0) return;

    // PostgreSQL: unnest arrays for a single upsert
    const userIds = [];
    const dates = [];
    const models = [];
    const requests = [];
    const tokens = [];
    const costs = [];
    const latencySums = [];
    const latencyCounts = [];
    for (const d of items) {
      userIds.push(d.userId);
      dates.push(d.date);
      models.push(d.model);
      requests.push(d.requests);
      tokens.push(d.tokens);
      costs.push(d.cost);
      latencySums.push(d.latency_ms_sum || 0);
      latencyCounts.push(d.latency_ms_count || 0);
    }
    const sql = `
      INSERT INTO user_daily_model_stats (user_id, date, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT * FROM UNNEST($1::int[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::double precision[], $7::bigint[], $8::bigint[])
        AS t(user_id, date, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      ON CONFLICT (user_id, date, model)
      DO UPDATE SET
        requests = user_daily_model_stats.requests + EXCLUDED.requests,
        tokens = user_daily_model_stats.tokens + EXCLUDED.tokens,
        cost = user_daily_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = user_daily_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = user_daily_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this._runWithRetry(sql, [userIds, dates, models, requests, tokens, costs, latencySums, latencyCounts]);
  }

  async _flushHourlyStats(items) {
    if (items.length === 0) return;

    const userIds = [];
    const hours = [];
    const models = [];
    const requests = [];
    const tokens = [];
    const costs = [];
    const latencySums = [];
    const latencyCounts = [];
    for (const d of items) {
      userIds.push(d.userId);
      hours.push(d.hour);
      models.push(d.model);
      requests.push(d.requests);
      tokens.push(d.tokens);
      costs.push(d.cost);
      latencySums.push(d.latency_ms_sum || 0);
      latencyCounts.push(d.latency_ms_count || 0);
    }
    const sql = `
      INSERT INTO user_hourly_model_stats (user_id, hour, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT * FROM UNNEST($1::int[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::double precision[], $7::bigint[], $8::bigint[])
        AS t(user_id, hour, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      ON CONFLICT (user_id, hour, model)
      DO UPDATE SET
        requests = user_hourly_model_stats.requests + EXCLUDED.requests,
        tokens = user_hourly_model_stats.tokens + EXCLUDED.tokens,
        cost = user_hourly_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = user_hourly_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = user_hourly_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this._runWithRetry(sql, [userIds, hours, models, requests, tokens, costs, latencySums, latencyCounts]);
  }

  async _flushSourceDailyStats(items) {
    if (items.length === 0) return;

    const sourceIds = [];
    const dates = [];
    const models = [];
    const requests = [];
    const tokens = [];
    const costs = [];
    const latencySums = [];
    const latencyCounts = [];
    for (const d of items) {
      sourceIds.push(d.sourceId);
      dates.push(d.date);
      models.push(d.model);
      requests.push(d.requests);
      tokens.push(d.tokens);
      costs.push(d.cost);
      latencySums.push(d.latency_ms_sum || 0);
      latencyCounts.push(d.latency_ms_count || 0);
    }
    const sql = `
      INSERT INTO source_daily_model_stats (source_id, date, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT * FROM UNNEST($1::int[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::double precision[], $7::bigint[], $8::bigint[])
        AS t(source_id, date, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      ON CONFLICT (source_id, date, model)
      DO UPDATE SET
        requests = source_daily_model_stats.requests + EXCLUDED.requests,
        tokens = source_daily_model_stats.tokens + EXCLUDED.tokens,
        cost = source_daily_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = source_daily_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = source_daily_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this._runWithRetry(sql, [sourceIds, dates, models, requests, tokens, costs, latencySums, latencyCounts]);
  }

  async _flushSourceHourlyStats(items) {
    if (items.length === 0) return;

    const sourceIds = [];
    const hours = [];
    const models = [];
    const requests = [];
    const tokens = [];
    const costs = [];
    const latencySums = [];
    const latencyCounts = [];
    for (const d of items) {
      sourceIds.push(d.sourceId);
      hours.push(d.hour);
      models.push(d.model);
      requests.push(d.requests);
      tokens.push(d.tokens);
      costs.push(d.cost);
      latencySums.push(d.latency_ms_sum || 0);
      latencyCounts.push(d.latency_ms_count || 0);
    }
    const sql = `
      INSERT INTO source_hourly_model_stats (source_id, hour, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT * FROM UNNEST($1::int[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::double precision[], $7::bigint[], $8::bigint[])
        AS t(source_id, hour, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      ON CONFLICT (source_id, hour, model)
      DO UPDATE SET
        requests = source_hourly_model_stats.requests + EXCLUDED.requests,
        tokens = source_hourly_model_stats.tokens + EXCLUDED.tokens,
        cost = source_hourly_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = source_hourly_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = source_hourly_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this._runWithRetry(sql, [sourceIds, hours, models, requests, tokens, costs, latencySums, latencyCounts]);
  }

  async _flushUserKeyQuotas(items) {
    const ids = items.map(item => item.id).join(',');
    const keyRows = await this._allWithRetry(`SELECT id, quota_type FROM user_keys WHERE id IN (${ids})`, []);
    const quotaTypeMap = new Map(keyRows.map(r => [r.id, r.quota_type]));

    const totalTokensCases = [];
    const quotaUsedCases = [];

    for (const item of items) {
      const qt = quotaTypeMap.get(item.id) || 'cost';
      const tokens = typeof item.fields._tokens === 'number' ? item.fields._tokens : (item.fields.total_tokens || 0);
      const cost = typeof item.fields._cost === 'number' ? item.fields._cost : (item.fields.quota_used || 0);
      const quotaIncrement = qt === 'tokens' ? tokens : cost;

      if (tokens !== 0) totalTokensCases.push(`WHEN ${item.id} THEN total_tokens + ${tokens}`);
      if (quotaIncrement !== 0) quotaUsedCases.push(`WHEN ${item.id} THEN quota_used + ${quotaIncrement}`);
    }

    const setClauses = [];
    if (totalTokensCases.length > 0) {
      setClauses.push(`total_tokens = CASE id ${totalTokensCases.join(' ')} ELSE total_tokens END`);
    }
    if (quotaUsedCases.length > 0) {
      setClauses.push(`quota_used = CASE id ${quotaUsedCases.join(' ')} ELSE quota_used END`);
    }
    if (setClauses.length === 0) return;

    const sql = `UPDATE user_keys SET ${setClauses.join(', ')} WHERE id IN (${ids})`;
    await this._runWithRetry(sql, []);
  }

  async _runWithRetry(sql, params) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await db.run(sql, params);
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries) throw err;
        const delay = this.baseRetryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async _allWithRetry(sql, params) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await db.all(sql, params);
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries) throw err;
        const delay = this.baseRetryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}

module.exports = new StatsBuffer();
