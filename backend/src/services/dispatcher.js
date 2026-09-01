const db = require('../config/database');
const cacheService = require('./cache');
const cacheManager = require('./cache-manager');

class Dispatcher {
  constructor() {
    this.currentIndex = {};
    // In-memory source concurrent counters (source of truth for this process).
    // DB writes are flushed periodically to keep the dashboard / source cache
    // reasonably up to date without blocking every request.
    this.concurrentMap = new Map();
    this.sourceMaxConcurrent = new Map();
    this.sourceStats = new Map(); // sourceId -> { requests, tokens }
    this.lastSuccessStatus = new Map(); // sourceId -> timestamp
    this.rateLimitLogThrottle = new Map(); // sourceId -> timestamp
    this.flushPromise = null;
    // 源站失败计数器：连续失败 N 次才标记为 error，避免偶发网络抖动导致源站被误杀
    this.failCountMap = new Map(); // sourceId -> { count, lastReset }

    // Flush in-memory concurrent counters to DB every 5s
    const flushInterval = parseInt(process.env.SOURCE_FLUSH_MS) || 5000;
    this.flushTimer = setInterval(() => this.flushConcurrentToDB(), flushInterval);
    this.flushTimer.unref?.();

    // Reset stale DB counters from a previous process on startup
    this._resetStaleCounters();

    // Best-effort flush on graceful shutdown
    const shutdownFlush = () => {
      clearInterval(this.flushTimer);
      this.flushConcurrentToDB();
    };
    process.on('SIGINT', shutdownFlush);
    process.on('SIGTERM', shutdownFlush);
  }

  async _resetStaleCounters() {
    try {
      await db.run('UPDATE sources SET current_concurrent = 0');
      console.log('[Startup] Reset all source concurrent counters to 0');
    } catch (err) {
      console.error('[dispatcher] failed to reset stale source counters:', err.message);
    }
  }

  async flushConcurrentToDB() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = (async () => {
      // Batch flush live concurrent counters to reduce DB round-trips
      const concurrentEntries = Array.from(this.concurrentMap.entries());
      if (concurrentEntries.length > 0) {
        const cases = concurrentEntries
          .map(([sourceId, count]) => `WHEN ${sourceId} THEN ${Math.max(0, count)}`)
          .join(' ');
        const ids = concurrentEntries.map(([sourceId]) => sourceId).join(',');
        try {
          await db.run(
            `UPDATE sources SET current_concurrent = CASE id ${cases} ELSE current_concurrent END WHERE id IN (${ids})`,
            []
          );
        } catch (err) {
          console.error('[dispatcher] batch flush concurrent failed:', err.message);
        }
      }

      // Batch flush accumulated source stats
      const statsEntries = Array.from(this.sourceStats.entries());
      if (statsEntries.length > 0) {
        const requestCases = statsEntries
          .map(([sourceId, stats]) => `WHEN ${sourceId} THEN total_requests + ${stats.requests}`)
          .join(' ');
        const tokenCases = statsEntries
          .map(([sourceId, stats]) => `WHEN ${sourceId} THEN total_tokens + ${stats.tokens}`)
          .join(' ');
        const quotaCases = statsEntries
          .map(([sourceId, stats]) => `WHEN ${sourceId} THEN quota_used + ${stats.tokens}`)
          .join(' ');
        const ids = statsEntries.map(([sourceId]) => sourceId).join(',');
        try {
          await db.run(
            `UPDATE sources SET total_requests = CASE id ${requestCases} ELSE total_requests END, total_tokens = CASE id ${tokenCases} ELSE total_tokens END, quota_used = CASE id ${quotaCases} ELSE quota_used END WHERE id IN (${ids})`,
            []
          );
        } catch (err) {
          console.error('[dispatcher] batch flush stats failed:', err.message);
        }
        this.sourceStats.clear();
      }
    })().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  _capMaxConcurrent(max) {
    const REASONABLE_MAX = parseInt(process.env.MAX_SOURCE_CONCURRENT) || 10000;
    if (!Number.isFinite(max) || max <= 0) return 1;
    return Math.min(max, REASONABLE_MAX);
  }

  _getSourceMaxConcurrent(sourceId) {
    const cached = this.sourceMaxConcurrent.get(sourceId);
    if (cached !== undefined) return cached;
    return null;
  }

  async _loadSourceMaxConcurrent(sourceId) {
    const cached = this.sourceMaxConcurrent.get(sourceId);
    if (cached !== undefined) return cached;
    try {
      const row = await db.get('SELECT max_concurrent FROM sources WHERE id = ?', [sourceId]);
      const max = this._capMaxConcurrent(row?.max_concurrent);
      this.sourceMaxConcurrent.set(sourceId, max);
      return max;
    } catch (err) {
      console.error(`[dispatcher] failed to load max_concurrent for source ${sourceId}:`, err.message);
      return 1;
    }
  }

  async getStrategy() {
    const cacheKey = 'dispatch_strategy';
    let strategy = await cacheService.get(cacheKey);
    if (strategy) return strategy;

    try {
      const setting = await db.get("SELECT value FROM settings WHERE key = 'dispatch_strategy'");
      strategy = setting?.value || 'round_robin';
    } catch (e) {
      strategy = 'round_robin';
    }
    await cacheManager.set(cacheKey, strategy, 60, { tags: ['settings'] });
    return strategy;
  }

  async getAvailableSources(model, protocol) {
    const cacheKey = `available_sources:${model}:${protocol || 'any'}`;
    const negativeCacheKey = `available_sources:${model}:${protocol || 'any'}:empty`;

    // 1. 尝试从缓存读取（高并发场景下大部分请求命中缓存，避免数据库被打爆）
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      if (process.env.LOG_LEVEL === 'debug') console.log(`[dispatcher] Cache hit for ${cacheKey}, sources=${cached.length}`);
      return cached;
    }
    // 负缓存：如果最近确认过没有可用源站，直接返回空数组
    const negativeCached = await cacheService.get(negativeCacheKey);
    if (negativeCached) {
      if (process.env.LOG_LEVEL === 'debug') console.log(`[dispatcher] Negative cache hit for ${cacheKey}`);
      return [];
    }

    // Auto-recover sources that have been in 'error' for more than 30 seconds
    // checking 状态由 probe 管理，不在这里自动恢复
    await db.run(
      `UPDATE sources SET status = 'unknown' WHERE status = 'error' AND last_check_at < datetime('now', '-30 seconds')`
    );

    let sql = `SELECT s.*, m.model_id, m.model_alias, m.input_price, m.input_price_cache,
              m.output_price, m.is_vision,
              m.supports_tools, m.supports_json, m.supports_fim, m.instance_id,
              CASE WHEN m.model_id = ? THEN 0 WHEN m.model_alias = ? THEN 1 WHEN m.model_id = '*' OR m.model_alias = '*' THEN 2 ELSE 3 END as _matchpriority
       FROM sources s
       LEFT JOIN models m ON s.id = m.source_id
       WHERE s.is_active = true
         AND m.is_active = true
         AND s.status != 'invalid'
         AND s.status != 'error'
         AND (s.quota_limit = 0 OR s.quota_used < s.quota_limit)
         AND (s.direct_status IS NULL OR s.direct_status != 'disabled')
         AND (m.model_id = ? OR m.model_alias = ? OR m.model_id = ? OR m.model_alias = ? OR m.model_id = '*' OR m.model_alias = '*')`;

    const baseModel = model.replace(/_\d+$/, '');
    const params = [model, model, model, model, baseModel, baseModel];

    // Protocol filtering removed - allow cross-protocol routing (e.g. OpenAI → Anthropic conversion)

    // 优先精确匹配 model_id，再按 model_alias，最后通配符 * 兜底
    // checking 状态的源站排在最后（权重惩罚），仍然可用但优先使用健康源站
    sql += ` ORDER BY _matchpriority, CASE WHEN s.status = 'checking' THEN 1 ELSE 0 END, s.weight DESC, s.current_concurrent ASC`;

    let sources = await db.all(sql, params);

    // Use real-time in-memory concurrent counters for load balancing instead of
    // the stale DB values.  Also keep the max_concurrent cache warm and cap
    // unreasonable DB values to protect the gateway.
    for (const source of sources) {
      source.max_concurrent = this._capMaxConcurrent(source.max_concurrent);
      this.sourceMaxConcurrent.set(source.id, source.max_concurrent);
      source.current_concurrent = this.concurrentMap.get(source.id) || 0;
    }

    // 如果有精确匹配的源站（priority=0），只保留精确匹配，过滤掉通配符 * 的兜底源站
    // 但保留精确匹配源站所属虚拟源站（source_group）内的所有成员
    const exactMatches = sources.filter(s => s._matchpriority === 0);
    if (exactMatches.length > 0) {
      // 检查精确匹配源站是否全部不健康（checking/invalid/error）
      const allExactUnhealthy = exactMatches.every(s => s.status === 'checking' || s.status === 'invalid' || s.status === 'error');
      if (allExactUnhealthy) {
        // 所有精确匹配源站都不健康，尝试 baseModel 回退
        const baseModel = model.replace(/_\d+$/, '');
        if (baseModel !== model) {
          const baseSources = sources.filter(s => s._matchpriority === 3 && s.status !== 'checking' && s.status !== 'invalid' && s.status !== 'error');
          if (baseSources.length > 0) {
            sources = baseSources;
          }
        }
      } else {
        const exactVirtualGroups = new Set(
          exactMatches.filter(s => s.source_group).map(s => s.source_group)
        );
        sources = sources.filter(s =>
          s._matchpriority === 0 ||
          (s.source_group && exactVirtualGroups.has(s.source_group))
        );
      }
    } else {
      // 严格路由：如果该模型在数据库中有精确注册记录（即使当前源站不可用），也不允许回退到通配符 *
      // 防止"一句正常一句报错"的不稳定现象——精确源站不可用时错误地走到不支持该模型的通配符源站
      // 例外：如果有 baseModel 匹配的源站可用（自动后缀如 _2 _3），允许回退到这些源站
      const hasExactRegistration = await db.get(
        `SELECT 1 FROM models m JOIN sources s ON m.source_id = s.id 
         WHERE (m.model_id = ? OR m.model_alias = ?) AND m.model_id != '*' LIMIT 1`,
        [model, model]
      );
      if (hasExactRegistration) {
        const baseModel = model.replace(/_\d+$/, '');
        if (baseModel !== model && sources.length > 0) {
          // 当前 sources 已包含 baseModel 匹配的源站（_matchpriority=3），过滤掉通配符 * 后直接使用
          const nonWildcard = sources.filter(s => s._matchpriority !== 2);
          if (nonWildcard.length > 0) {
            sources = nonWildcard;
          } else {
            return [];
          }
        } else {
          return []; // 精确源站不可用且没有 baseModel 回退，直接返回空，让上层返回 503
        }
      }
    }

    // Group sources by source_group (virtual source) for stacking
    // Deduplicate by source.id within each group, preferring records with instance_id
    const grouped = new Map();
    const independent = [];

    for (const source of sources) {
      if (source.source_group) {
        if (!grouped.has(source.source_group)) {
          grouped.set(source.source_group, new Map());
        }
        const groupMap = grouped.get(source.source_group);
        const existing = groupMap.get(source.id);
        if (!existing || (!existing.instance_id && source.instance_id)) {
          groupMap.set(source.id, source);
        }
      } else {
        // Deduplicate independent sources too, preferring instance records
        const existingIdx = independent.findIndex(s => s.id === source.id);
        if (existingIdx >= 0) {
          if (!independent[existingIdx].instance_id && source.instance_id) {
            independent[existingIdx] = source;
          }
        } else {
          independent.push(source);
        }
      }
    }

    const result = [];

    // Handle grouped sources
    for (const [groupName, groupMap] of grouped) {
      const groupSources = Array.from(groupMap.values());
      const stackMode = groupSources[0].stack_mode || 'merged';

      if (stackMode === 'merged') {
        // Merged: combine concurrency, pick best available
        const totalMaxConcurrent = groupSources.reduce((sum, s) => sum + s.max_concurrent, 0);
        const totalCurrentConcurrent = groupSources.reduce((sum, s) => sum + s.current_concurrent, 0);
        const available = groupSources.filter(s => s.current_concurrent < s.max_concurrent);

        if (available.length > 0) {
          // Pick source with least concurrent within the group
          available.sort((a, b) => a.current_concurrent - b.current_concurrent);
          result.push({
            ...available[0],
            _group: groupName,
            _stackMode: 'merged',
            _groupMaxConcurrent: totalMaxConcurrent,
            _groupCurrentConcurrent: totalCurrentConcurrent
          });
        } else {
          // All at capacity, return first with queue flag
          result.push({
            ...groupSources[0],
            _group: groupName,
            _stackMode: 'merged',
            queueWait: true,
            _groupMaxConcurrent: totalMaxConcurrent,
            _groupCurrentConcurrent: totalCurrentConcurrent
          });
        }
      } else {
        // Failover: try sources in order
        for (const source of groupSources) {
          if (source.current_concurrent < source.max_concurrent) {
            result.push({ ...source, _group: groupName, _stackMode: 'failover' });
            break;
          }
        }
        // If all at capacity, add first with queue flag
        if (!result.find(r => r._group === groupName)) {
          result.push({ ...groupSources[0], _group: groupName, _stackMode: 'failover', queueWait: true });
        }
      }
    }

    // Add independent sources
    result.push(...independent.filter(s => s.current_concurrent < s.max_concurrent));

    // Add independent sources
    result.push(...independent.filter(s => s.current_concurrent < s.max_concurrent));

    // Debug: log available source ids for this model
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(`[dispatcher] getAvailableSources("${model}"): ${result.length} sources:`, result.map(s => `${s.id}/${s.name}(status=${s.status},direct=${s.direct_status},current=${s.current_concurrent},max=${s.max_concurrent})`).join(', '));
    }

    // 写入缓存（短TTL，平衡性能和实时性）
    // 正常结果缓存5秒，负缓存（空结果）缓存3秒
    const tags = ['routing', `model:${model}`];
    if (result.length > 0) {
      await cacheManager.set(cacheKey, result, 5, { tags });
    } else {
      await cacheManager.set(negativeCacheKey, true, 3, { tags });
    }

    return result;
  }

  /**
   * 清除指定模型的可用源站缓存
   */
  async _clearAvailableSourcesCache(model) {
    const protocols = ['any', 'openai', 'anthropic', 'gemini', 'bedrock'];
    const keys = [];
    for (const protocol of protocols) {
      keys.push(`available_sources:${model}:${protocol}`);
      keys.push(`available_sources:${model}:${protocol}:empty`);
    }
    try {
      await cacheManager.invalidateKeys(keys);
    } catch (e) {}
  }

  /**
   * 根据源站ID清除相关模型的可用源站缓存
   * 当某个源站状态变化时，只清除与该源站相关的模型缓存，避免全量刷新
   */
  async _clearCacheBySourceId(sourceId) {
    try {
      const models = await db.all('SELECT DISTINCT model_id, model_alias FROM models WHERE source_id = ?', [sourceId]);
      const cleared = new Set();
      for (const m of models) {
        if (m.model_id && !cleared.has(m.model_id)) {
          await this._clearAvailableSourcesCache(m.model_id);
          cleared.add(m.model_id);
        }
        if (m.model_alias && m.model_alias !== m.model_id && !cleared.has(m.model_alias)) {
          await this._clearAvailableSourcesCache(m.model_alias);
          cleared.add(m.model_alias);
        }
      }
      // 同时清除通配符模型缓存（如果源站注册了 *）
      await this._clearAvailableSourcesCache('*');
    } catch (e) {
      console.error(`[dispatcher] Failed to clear cache for source ${sourceId}:`, e.message);
    }
  }

  async selectSource(model, protocol) {
    const strategy = await this.getStrategy();
    const allSources = await this.getAvailableSources(model, protocol);

    if (allSources.length === 0) {
      // Debug: log when no sources available
      const allModels = await db.all(`SELECT model_id, model_alias, source_id FROM models WHERE model_id = ? OR model_alias = ?`, [model, model]);
      const allSourcesForModel = await db.all(`SELECT id, name, is_active, status FROM sources WHERE id IN (SELECT source_id FROM models WHERE model_id = ? OR model_alias = ?)`, [model, model]);
      if (process.env.LOG_LEVEL === 'debug') console.log(`[dispatcher] No available source for model "${model}". Registered models:`, JSON.stringify(allModels), 'Sources:', JSON.stringify(allSourcesForModel));
      return null;
    }

    const sources = allSources;
    let source;

    switch (strategy) {
      case 'random':
        source = this.selectRandom(sources); break;
      case 'weight':
        source = this.selectByWeight(sources); break;
      case 'failover':
        source = this.selectFailover(sources); break;
      case 'least_used':
        source = await this.selectLeastUsed(sources); break;
      case 'least_concurrent':
        source = this.selectLeastConcurrent(sources); break;
      case 'round_robin':
      default:
        source = this.selectRoundRobin(sources, model); break;
    }

    // Instance expansion: if selected source is an instance model, pick member by instance stack_mode
    if (source && source.instance_id) {
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [source.instance_id]);
      if (instance && instance.is_active) {
        const members = await db.all(`
          SELECT s.* FROM instance_members im
          JOIN sources s ON im.source_id = s.id
          WHERE im.instance_id = ? AND s.is_active = true
            AND s.status != 'error' AND s.status != 'invalid'
            AND (s.quota_limit = 0 OR s.quota_used < s.quota_limit)
            AND (s.direct_status IS NULL OR s.direct_status != 'disabled')
        `, [source.instance_id]);

        if (members.length > 0) {
          // Smart scoring: lower score = better source
          // Phase 1 (low load < 10 avg): distribute evenly with jitter to avoid thundering herd
          // Phase 2 (medium load): balance by concurrency deviation from average
          // Phase 3 (high load > 50% max): heavily penalize overloaded members
          const avgConcurrent = members.reduce((sum, s) => sum + (s.current_concurrent || 0), 0) / members.length;
          const scoreMember = (s) => {
            const failCount = s.direct_fail_count || 0;
            const successCount = s.direct_success_count || 0;
            const totalProbes = failCount + successCount;
            const errorRate = totalProbes > 10 ? failCount / totalProbes : 0;
            const concurrency = s.current_concurrent || 0;
            const maxConcurrent = s.max_concurrent || 1;
            const utilization = concurrency / maxConcurrent;
            const aboveAvg = Math.max(0, concurrency - avgConcurrent);
            
            let score = concurrency + (aboveAvg * 3) + (errorRate * 100);
            
            // Phase 1: low total load — add jitter to spread initial requests evenly
            if (avgConcurrent < 10) {
              score = concurrency + (Math.random() * 15) + (errorRate * 50);
            }
            
            // Phase 3: heavily penalize members above 50% utilization regardless of error rate
            if (utilization > 0.5) {
              score += (utilization - 0.5) * 200;
            }
            
            return score;
          };

          if (instance.stack_mode === 'merged') {
            const available = members.filter(s => s.current_concurrent < s.max_concurrent);
            if (available.length > 0) {
              available.sort((a, b) => scoreMember(a) - scoreMember(b));
              source = { ...available[0], _modelId: instance.inbound_model_id, _instanceId: instance.id };
            } else {
              members.sort((a, b) => scoreMember(a) - scoreMember(b));
              source = { ...members[0], _modelId: instance.inbound_model_id, _instanceId: instance.id, queueWait: true };
            }
          } else {
            // failover: sort by score, then pick first available
            members.sort((a, b) => scoreMember(a) - scoreMember(b));
            for (const m of members) {
              if (m.current_concurrent < m.max_concurrent) {
                source = { ...m, _modelId: instance.inbound_model_id, _instanceId: instance.id };
                break;
              }
            }
            if (!source._instanceId) {
              source = { ...members[0], _modelId: instance.inbound_model_id, _instanceId: instance.id, queueWait: true };
            }
          }
        }
      }
    }

    return source;
  }

  selectRoundRobin(sources, model) {
    const key = model || 'default';
    if (!this.currentIndex[key]) {
      this.currentIndex[key] = 0;
    }

    const source = sources[this.currentIndex[key] % sources.length];
    this.currentIndex[key]++;

    return source;
  }

  selectRandom(sources) {
    return sources[Math.floor(Math.random() * sources.length)];
  }

  selectByWeight(sources) {
    const totalWeight = sources.reduce((sum, s) => sum + s.weight, 0);
    let random = Math.random() * totalWeight;

    for (const source of sources) {
      random -= source.weight;
      if (random <= 0) {
        return source;
      }
    }

    return sources[0];
  }

  selectFailover(sources) {
    return sources[0];
  }

  async selectLeastUsed(sources) {
    const sourceIds = sources.map(s => s.id);
    const placeholders = sourceIds.map(() => '?').join(',');

    const usage = await db.all(
      `SELECT source_id, SUM(total_tokens) as total
       FROM request_logs
       WHERE source_id IN (${placeholders})
         AND created_at > datetime('now', '-1 hour')
       GROUP BY source_id`,
      sourceIds
    );

    const usageMap = new Map(usage.map(u => [u.source_id, u.total]));

    sources.sort((a, b) => {
      const aUsage = usageMap.get(a.id) || 0;
      const bUsage = usageMap.get(b.id) || 0;
      return aUsage - bUsage;
    });

    return sources[0];
  }

  selectLeastConcurrent(sources) {
    sources.sort((a, b) => a.current_concurrent - b.current_concurrent);
    return sources[0];
  }

  /**
   * Atomically try to increment concurrent counter (in-memory, no DB write)
   * Returns true if succeeded, false if at max capacity
   */
  async tryIncrementConcurrent(sourceId) {
    let maxConcurrent = this._getSourceMaxConcurrent(sourceId);
    if (maxConcurrent === null) {
      maxConcurrent = await this._loadSourceMaxConcurrent(sourceId);
    }

    const current = this.concurrentMap.get(sourceId) || 0;
    if (current >= maxConcurrent) {
      return false;
    }
    this.concurrentMap.set(sourceId, current + 1);
    return true;
  }

  /**
   * Check whether a source currently has an available slot without acquiring it.
   */
  async checkSlotAvailable(sourceId) {
    let maxConcurrent = this._getSourceMaxConcurrent(sourceId);
    if (maxConcurrent === null) {
      maxConcurrent = await this._loadSourceMaxConcurrent(sourceId);
    }
    const current = this.concurrentMap.get(sourceId) || 0;
    return current < maxConcurrent;
  }

  async incrementConcurrent(sourceId) {
    this.concurrentMap.set(sourceId, (this.concurrentMap.get(sourceId) || 0) + 1);
  }

  async decrementConcurrent(sourceId) {
    const current = this.concurrentMap.get(sourceId) || 0;
    if (current <= 0) {
      // Guard against double-release: memory count already 0
      if (process.env.LOG_LEVEL === 'debug') {
        console.warn(`[dispatcher] decrementConcurrent skipped for source ${sourceId}: memory count already ${current}`);
      }
      return;
    }
    this.concurrentMap.set(sourceId, current - 1);
  }

  async updateStats(sourceId, tokens) {
    if (!sourceId) return;
    const stats = this.sourceStats.get(sourceId) || { requests: 0, tokens: 0 };
    stats.requests += 1;
    stats.tokens += Number(tokens) || 0;
    this.sourceStats.set(sourceId, stats);
  }

  // 订阅过期/余额不足类错误关键词（中英文）
  static EXPIRED_KEYWORDS = [
    'subscription expired', 'quota exceeded', 'insufficient balance',
    '余额不足', '订阅已过期', 'account suspended', 'credit exhausted',
    'no remaining quota', 'out of quota', 'usage limit exceeded',
    'api key invalid', 'invalid key', 'authentication failed',
    'unauthorized', 'access denied', 'forbidden',
    '配额不足', '额度不足', '欠费', '已欠费',
    'trial ended', 'plan expired', 'license expired',
    'request was rejected', 'not supported model'
  ];

  /**
   * 判断错误是否属于"订阅过期/余额不足"类不可逆错误
   */
  _isExpiredError(errorMessage, statusCode) {
    if (!errorMessage && statusCode !== 401 && statusCode !== 403) return false;
    const msg = (errorMessage || '').toLowerCase();
    // 401/403 默认视为认证/授权问题，但如果有明确非过期消息则不排除
    const hasExpiredKeyword = Dispatcher.EXPIRED_KEYWORDS.some(kw => msg.includes(kw.toLowerCase()));
    return hasExpiredKeyword || statusCode === 401 || statusCode === 403;
  }

  async markSourceFailed(sourceId, errorMessage, statusCode) {
    const now = Date.now();

    // 401/403 key 失效：走 checking → invalid 状态机，不是直接 invalid
    // probe 会按 2min 间隔持续检测，5 次失败后才是真正的 invalid
    if (this._isExpiredError(errorMessage, statusCode)) {
      const source = await db.get('SELECT status, direct_fail_count FROM sources WHERE id = ?', [sourceId]);
      const currentStatus = source?.status || 'valid';
      const currentFailCount = source?.direct_fail_count || 0;

      if (currentStatus === 'valid' || currentStatus === 'unknown') {
        // 第一次检测到 key 失效 → checking 状态
        console.warn(`[dispatcher] Source ${sourceId} key CHECKING (from ${currentStatus}): ${errorMessage?.substring(0, 200)} (1/5)`);
        await db.run(
          `UPDATE sources SET status = 'checking', direct_fail_count = 1, last_check_at = datetime('now') WHERE id = ?`,
          [sourceId]
        );
      } else if (currentStatus === 'checking') {
        const newFailCount = currentFailCount + 1;
        if (newFailCount >= 5) {
          // 5 次都失效 → 永久 invalid
          console.warn(`[dispatcher] Source ${sourceId} key INVALID after 5 retries: ${errorMessage?.substring(0, 200)}`);
          await db.run(
            `UPDATE sources SET status = 'invalid', direct_fail_count = ?, last_check_at = datetime('now') WHERE id = ?`,
            [newFailCount, sourceId]
          );
        } else {
          console.warn(`[dispatcher] Source ${sourceId} key CHECKING: ${errorMessage?.substring(0, 200)} (${newFailCount}/5)`);
          await db.run(
            `UPDATE sources SET status = 'checking', direct_fail_count = ?, last_check_at = datetime('now') WHERE id = ?`,
            [newFailCount, sourceId]
          );
        }
      } else if (currentStatus === 'invalid') {
        // 保持 invalid
        console.warn(`[dispatcher] Source ${sourceId} key still INVALID: ${errorMessage?.substring(0, 200)}`);
      } else if (currentStatus === 'error') {
        // 从网络错误转为 key 失效
        console.warn(`[dispatcher] Source ${sourceId} key CHECKING (was error): ${errorMessage?.substring(0, 200)} (1/5)`);
        await db.run(
          `UPDATE sources SET status = 'checking', direct_fail_count = 1, last_check_at = datetime('now') WHERE id = ?`,
          [sourceId]
        );
      }
      // 状态变化，清除相关模型缓存，确保瞬时切换
      await this._clearCacheBySourceId(sourceId);
      this.failCountMap.delete(sourceId);
      return;
    }

    // 清理超过 1 小时没有更新的失败记录，防止 Map 无限增长
    for (const [id, record] of this.failCountMap.entries()) {
      if (now - record.lastReset > 60 * 60 * 1000) {
        this.failCountMap.delete(id);
      }
    }

    const record = this.failCountMap.get(sourceId) || { count: 0, lastReset: 0 };

    // 超过 1 分钟没有新的失败，重置计数器（偶发网络抖动不应当作源站故障）
    if (now - record.lastReset > 60000) {
      record.count = 0;
      record.lastReset = now;
    }

    record.count++;
    this.failCountMap.set(sourceId, record);

    // 连续失败 3 次才标记为 error，避免一次超时/500 就把源站踢掉导致 503 雪崩
    if (record.count >= 3) {
      await db.run(`UPDATE sources SET status = 'error', last_check_at = datetime('now') WHERE id = ?`, [sourceId]);
      await this._clearCacheBySourceId(sourceId);
    }
  }

  async markSourceSuccess(sourceId) {
    // 请求成功，清除失败计数。  将 DB 更新和缓存清除异步化并去重：同一个源站在
    // 30s 内最多写一次 DB，避免高并发下对 sources 行的反复更新。
    this.failCountMap.delete(sourceId);

    const last = this.lastSuccessStatus.get(sourceId);
    if (last && Date.now() - last < 30000) return;
    this.lastSuccessStatus.set(sourceId, Date.now());

    db.run(
      `UPDATE sources SET status = 'valid', direct_fail_count = 0, last_check_at = datetime('now') WHERE id = ?`,
      [sourceId]
    )
      .then(() => this._clearCacheBySourceId(sourceId))
      .catch(err => console.error(`[dispatcher] markSourceSuccess failed for source ${sourceId}:`, err.message));
  }

  /**
   * 探测发现源站恢复时调用（从 invalid/error/checking 改回 valid）
   */
  async markSourceRecovered(sourceId) {
    const source = await db.get('SELECT status FROM sources WHERE id = ?', [sourceId]);
    if (source && (source.status === 'invalid' || source.status === 'error' || source.status === 'checking')) {
      console.log(`[dispatcher] Source ${sourceId} recovered from ${source.status}, marking as valid`);
      await db.run(
        `UPDATE sources SET status = 'valid', direct_fail_count = 0, last_check_at = datetime('now') WHERE id = ?`,
        [sourceId]
      );
      await this._clearCacheBySourceId(sourceId);
      this.failCountMap.delete(sourceId);
    }
  }

  /**
   * Handle 429 rate limit: log only, no auto-adjustment
   * max_concurrent is now admin-managed only
   */
  async handleRateLimit(sourceId, errorMessage) {
    // Throttle: one log per source every 10 seconds to avoid I/O flooding
    const now = Date.now();
    const lastLog = this.rateLimitLogThrottle.get(sourceId);
    if (lastLog && now - lastLog < 10000) return;
    this.rateLimitLogThrottle.set(sourceId, now);

    // Try to extract limit from error message like "max 5 concurrent requests"
    const match = errorMessage?.match(/max\s+(\d+)\s+concurrent/i);
    const detectedLimit = match ? parseInt(match[1]) : null;

    let maxConcurrent = this._getSourceMaxConcurrent(sourceId);
    if (maxConcurrent === null) {
      maxConcurrent = await this._loadSourceMaxConcurrent(sourceId);
    }

    console.warn(`[dispatcher] Source ${sourceId} hit rate limit (current max_concurrent=${maxConcurrent}). ` +
      `Admin should review and adjust manually if needed. Detected limit=${detectedLimit || 'N/A'}`);
  }

  /**
   * Gradually increase max_concurrent to probe for optimal limit
   * DISABLED: max_concurrent is now admin-managed only
   */
  async probeConcurrencyLimit(sourceId) {
    // No-op: admin controls max_concurrent exclusively
    return;
  }

  async getConcurrencyStatus() {
    try {
      // Use the in-memory concurrentMap as the source of truth for current
      // concurrency. The DB column is only flushed periodically and would
      // miss short-lived requests, so it often shows 0 even under load.
      // We intentionally avoid caching here: concurrency changes on every
      // request and a stale cached value makes the dashboard useless.
      const sources = await db.all('SELECT id, name, max_concurrent, current_concurrent FROM sources WHERE is_active = true');
      const result = sources.map(s => {
        const liveCurrent = this.concurrentMap.get(s.id) ?? s.current_concurrent ?? 0;
        return {
          ...s,
          current_concurrent: liveCurrent,
          utilization: s.max_concurrent > 0 ? (liveCurrent / s.max_concurrent * 100).toFixed(1) : 0
        };
      });
      return result;
    } catch (err) {
      console.error('[dispatcher] getConcurrencyStatus failed:', err.message);
      return [];
    }
  }
}

module.exports = new Dispatcher();
