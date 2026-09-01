/**
 * 缓存抽象层 - 支持 Redis + 内存降级
 * Redis 连接失败时自动降级到内存缓存
 */

const { getRedis } = require('../config/redis');

class CacheService {
  constructor() {
    this.redis = null;
    this.memoryCache = new Map();
    this.memoryTTL = new Map();
    this.useRedis = false;
  }

  /**
   * 初始化 Redis 连接
   * @returns {Promise<boolean>} 是否成功连接 Redis
   */
  _isRedisHealthy() {
    return this.useRedis && this.redis && this.redis.isOpen;
  }

  /**
   * 获取底层 Redis 客户端（仅当连接健康时返回）
   * @returns {any|null}
   */
  getRedisClient() {
    return this._isRedisHealthy() ? this.redis : null;
  }

  _disconnectRedis() {
    this.useRedis = false;
    this.redis = null;
  }

  async initRedis() {
    try {
      this.redis = getRedis();
      if (this.redis && this.redis.isOpen) {
        await this.redis.ping();
        this.useRedis = true;
        console.log('[Cache] Redis connected successfully');
        return true;
      } else {
        console.log('[Cache] Redis not available, using memory cache');
        this._disconnectRedis();
        return false;
      }
    } catch (error) {
      console.warn('[Cache] Redis connection failed, falling back to memory cache:', error?.message);
      this._disconnectRedis();
      return false;
    }
  }

  /**
   * 设置缓存
   * @param {string} key 缓存键
   * @param {any} value 缓存值
   * @param {number} ttl 过期时间（秒）
   */
  _isClientClosedError(error) {
    return error.name === 'ClientClosedError' ||
      (error?.message && /client is closed/i.test(error?.message));
  }

  async set(key, value, ttl = 3600) {
    try {
      if (this._isRedisHealthy()) {
        await this.redis.set(key, JSON.stringify(value), { EX: ttl });
        return;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] Set error:', error?.message);
      }
    }
    // 降级到内存缓存
    this.memoryCache.set(key, value);
    this.memoryTTL.set(key, Date.now() + ttl * 1000);
  }

  /**
   * 获取缓存
   * @param {string} key 缓存键
   * @returns {any|null} 缓存值
   */
  async get(key) {
    try {
      if (this._isRedisHealthy()) {
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] Get error:', error?.message);
      }
    }
    // 降级到内存缓存
    const ttl = this.memoryTTL.get(key);
    if (ttl && Date.now() > ttl) {
      this.memoryCache.delete(key);
      this.memoryTTL.delete(key);
      return null;
    }
    // 如果 Redis 健康但 key 不存在，memoryCache 中可能残留 Redis 健康前写入的过期值
    //（set() 在 Redis 健康时不会更新 memoryTTL），此时应清除残留值避免永远返回脏数据
    if (ttl === undefined && this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
      return null;
    }
    return this.memoryCache.get(key) || null;
  }

  /**
   * 删除缓存
   * @param {string} key 缓存键
   */
  async del(key) {
    try {
      if (this._isRedisHealthy()) {
        await this.redis.del(key);
        return;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] Delete error:', error?.message);
      }
    }
    // 降级到内存缓存
    this.memoryCache.delete(key);
    this.memoryTTL.delete(key);
  }

  /**
   * 批量删除缓存
   * @param {string} pattern 缓存键模式
   */
  async delPattern(pattern) {
    try {
      if (this._isRedisHealthy()) {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        return;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] Delete pattern error:', error?.message);
      }
    }
    // 内存缓存不支持模式匹配，需要遍历
    for (const key of this.memoryCache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.memoryCache.delete(key);
        this.memoryTTL.delete(key);
      }
    }
  }

  /**
   * 简单的模式匹配
   * @param {string} key 键
   * @param {string} pattern 模式
   * @returns {boolean} 是否匹配
   */
  matchPattern(key, pattern) {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return regex.test(key);
  }

  /**
   * 清理过期的内存缓存
   */
  cleanupExpiredMemoryCache() {
    const now = Date.now();
    for (const [key, ttl] of this.memoryTTL.entries()) {
      if (now > ttl) {
        this.memoryCache.delete(key);
        this.memoryTTL.delete(key);
      }
    }
  }

  /**
   * 使用 SCAN 按模式枚举 key（Redis），内存模式下直接遍历。
   * @param {string} pattern
   * @param {number} limit 最大返回数量，默认 100
   * @returns {string[]}
   */
  async scan(pattern, limit = 100) {
    const results = [];
    try {
      if (this._isRedisHealthy()) {
        let cursor = '0';
        do {
          const reply = await this.redis.scan(cursor, { MATCH: pattern, COUNT: Math.max(100, limit) });
          cursor = reply.cursor;
          for (const key of reply.keys) {
            results.push(key);
            if (results.length >= limit) {
              cursor = '0';
              break;
            }
          }
        } while (cursor !== '0');
        return results;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] Scan error:', error?.message);
      }
    }
    // 内存降级
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of this.memoryCache.keys()) {
      if (regex.test(key)) {
        results.push(key);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * 获取 key 剩余 TTL（秒）。内存模式下根据 TTL 计算，无 TTL 返回 -1。
   * @param {string} key
   * @returns {number} 剩余秒数，不存在返回 -2，无 TTL 返回 -1
   */
  async ttl(key) {
    try {
      if (this._isRedisHealthy()) {
        return await this.redis.ttl(key);
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] TTL error:', error?.message);
      }
    }
    if (!this.memoryCache.has(key)) return -2;
    const ttlMs = this.memoryTTL.get(key);
    if (!ttlMs) return -1;
    const remaining = Math.ceil((ttlMs - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  /**
   * 获取缓存状态
   * @returns {Object} 缓存状态
   */
  getStatus() {
    return {
      useRedis: this.useRedis,
      memoryCacheSize: this.memoryCache.size,
      redisConnected: this.redis !== null,
      redisHealthy: this._isRedisHealthy()
    };
  }

  /**
   * 原子递增（Redis INCR / 内存计数器）
   * @param {string} key
   * @param {number} amount
   * @returns {number}
   */
  async increment(key, amount = 1) {
    try {
      if (this._isRedisHealthy()) {
        return await this.redis.incrBy(key, amount);
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] Increment error:', error?.message);
      }
    }
    const current = (this.memoryCache.get(key) || 0) + amount;
    this.memoryCache.set(key, current);
    this.memoryTTL.set(key, Date.now() + 3600 * 1000);
    return current;
  }

  /**
   * 原子递减
   * @param {string} key
   * @param {number} amount
   * @returns {number}
   */
  async decrement(key, amount = 1) {
    return this.increment(key, -amount);
  }

  /**
   * 批量获取
   * @param {string[]} keys
   * @returns {Array<any|null>}
   */
  async mget(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    try {
      if (this._isRedisHealthy()) {
        const values = await this.redis.mGet(keys);
        return values.map(v => v ? JSON.parse(v) : null);
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] MGet error:', error?.message);
      }
    }
    return keys.map(key => this.get(key));
  }

  /**
   * 批量设置
   * @param {Array<{key:string,value:any,ttl?:number}>} entries
   */
  async mset(entries, ttl = 3600) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    try {
      if (this._isRedisHealthy()) {
        const pipeline = this.redis.multi();
        for (const { key, value } of entries) {
          pipeline.set(key, JSON.stringify(value), { EX: ttl });
        }
        await pipeline.exec();
        return;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        console.warn('[Cache] Redis client closed, permanently falling back to memory');
        this._disconnectRedis();
      } else {
        console.error('[Cache] MSet error:', error?.message);
      }
    }
    for (const { key, value, ttl: itemTtl } of entries) {
      this.memoryCache.set(key, value);
      this.memoryTTL.set(key, Date.now() + (itemTtl || ttl) * 1000);
    }
  }

  /**
   * 设置过期时间
   * @param {string} key
   * @param {number} ttl 秒
   */
  async expire(key, ttl) {
    try {
      if (this._isRedisHealthy()) {
        await this.redis.expire(key, ttl);
        return;
      }
    } catch (error) {
      if (this._isClientClosedError(error)) {
        this._disconnectRedis();
      }
    }
    this.memoryTTL.set(key, Date.now() + ttl * 1000);
  }

  /**
   * 是否已连接到可用 Redis
   * @returns {boolean}
   */
  isHealthy() {
    return this._isRedisHealthy();
  }

  /**
   * 关闭缓存连接
   */
  async close() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    this.memoryCache.clear();
    this.memoryTTL.clear();
  }
}

// 创建单例
const cacheService = new CacheService();

// 定期清理过期内存缓存（每5分钟）
setInterval(() => {
  cacheService.cleanupExpiredMemoryCache();
}, 5 * 60 * 1000);

module.exports = cacheService;
