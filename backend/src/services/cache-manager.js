/**
 * 集中式缓存管理子系统
 *
 * 在 cacheService 之上增加“标签（tag）”能力：写入缓存时声明它依赖哪些实体/命名空间，
 * 实体变更时按标签失效，避免手动记 key 或写 delPattern('*') 导致的脏缓存问题。
 *
 * 支持 Redis + 内存降级两套后端。
 */

const cacheService = require('./cache');

const TAG_INDEX_PREFIX = 'cache:tags:';   // Set<key>  记录每个 tag 下有哪些 key
const KEY_TAGS_PREFIX = 'cache:keytags:'; // Set<tag>  记录每个 key 属于哪些 tag

class CacheManager {
  constructor() {
    // 内存降级时的索引结构
    this.memoryTagIndex = new Map(); // tag -> Set<key>
    this.memoryKeyTags = new Map();  // key -> Set<tag>
  }

  _tagKey(tag) {
    return `${TAG_INDEX_PREFIX}${tag}`;
  }

  _keyTagsKey(key) {
    return `${KEY_TAGS_PREFIX}${key}`;
  }

  _isRedisHealthy() {
    return cacheService.isHealthy();
  }

  /**
   * 写入缓存并绑定标签
   * @param {string} key
   * @param {any} value
   * @param {number} ttl 秒
   * @param {Object} options
   * @param {string[]} options.tags 例如 ['source:14', 'routing']
   */
  async set(key, value, ttl, options = {}) {
    await cacheService.set(key, value, ttl);

    const tags = Array.isArray(options.tags) ? options.tags : [];
    if (tags.length === 0) return;

    try {
      if (this._isRedisHealthy()) {
        const redis = cacheService.getRedisClient();
        const pipeline = redis.multi();
        for (const tag of tags) {
          pipeline.sAdd(this._tagKey(tag), key);
        }
        pipeline.sAdd(this._keyTagsKey(key), tags);
        pipeline.expire(this._keyTagsKey(key), ttl || 3600);
        for (const tag of tags) {
          // tag 索引本身不过期，key 删除时会自动清理；但为防止孤儿，给一个较长的兜底 TTL
          pipeline.expire(this._tagKey(tag), 7 * 24 * 3600);
        }
        await pipeline.exec();
        return;
      }
    } catch (err) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.error('[CacheManager] Redis tag index error:', err.message);
      }
    }

    // 内存降级
    for (const tag of tags) {
      if (!this.memoryTagIndex.has(tag)) this.memoryTagIndex.set(tag, new Set());
      this.memoryTagIndex.get(tag).add(key);
    }
    this.memoryKeyTags.set(key, new Set(tags));
  }

  /**
   * 读取缓存（直接透传 cacheService）
   */
  async get(key) {
    return cacheService.get(key);
  }

  /**
   * 删除单个 key，并清理其标签索引
   */
  async del(key) {
    await this.invalidateKeys([key]);
  }

  /**
   * 按精确 key 列表失效
   */
  async invalidateKeys(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return { deleted: 0 };

    try {
      if (this._isRedisHealthy()) {
        const redis = cacheService.getRedisClient();
        const keyTagsPipeline = redis.multi();
        for (const key of keys) {
          keyTagsPipeline.sMembers(this._keyTagsKey(key));
        }
        const tagArrays = await keyTagsPipeline.exec();

        const keyToTags = new Map();
        const pipeline = redis.multi();
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const tags = Array.isArray(tagArrays[i]) ? tagArrays[i] : [];
          keyToTags.set(key, tags);
          pipeline.del(key);
          pipeline.del(this._keyTagsKey(key));
          for (const tag of tags) {
            pipeline.sRem(this._tagKey(tag), key);
          }
        }
        await pipeline.exec();
        return { deleted: keys.length };
      }
    } catch (err) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.error('[CacheManager] Redis invalidateKeys error:', err.message);
      }
    }

    // 内存降级
    for (const key of keys) {
      await cacheService.del(key);
      const tags = this.memoryKeyTags.get(key);
      if (tags) {
        for (const tag of tags) {
          this.memoryTagIndex.get(tag)?.delete(key);
          if (this.memoryTagIndex.get(tag)?.size === 0) {
            this.memoryTagIndex.delete(tag);
          }
        }
        this.memoryKeyTags.delete(key);
      }
    }
    return { deleted: keys.length };
  }

  /**
   * 按标签失效：删除所有声明过该标签的 key
   */
  async invalidateTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return { deleted: 0 };
    const allKeys = new Set();

    try {
      if (this._isRedisHealthy()) {
        const redis = cacheService.getRedisClient();
        const pipeline = redis.multi();
        for (const tag of tags) {
          pipeline.sMembers(this._tagKey(tag));
        }
        const results = await pipeline.exec();
        for (const arr of results) {
          if (Array.isArray(arr)) {
            for (const key of arr) allKeys.add(key);
          }
        }
        const keys = Array.from(allKeys);
        if (keys.length > 0) {
          await this.invalidateKeys(keys);
        }
        // 删除 tag 集合本身
        const delPipeline = redis.multi();
        for (const tag of tags) {
          delPipeline.del(this._tagKey(tag));
        }
        await delPipeline.exec();
        return { deleted: keys.length };
      }
    } catch (err) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.error('[CacheManager] Redis invalidateTags error:', err.message);
      }
    }

    // 内存降级
    for (const tag of tags) {
      const keys = this.memoryTagIndex.get(tag);
      if (keys) {
        for (const key of keys) allKeys.add(key);
        this.memoryTagIndex.delete(tag);
      }
    }
    const keys = Array.from(allKeys);
    if (keys.length > 0) {
      // 从每个 key 的 tags 集合中移除这些 tag
      for (const key of keys) {
        const keyTags = this.memoryKeyTags.get(key);
        if (keyTags) {
          for (const tag of tags) keyTags.delete(tag);
          if (keyTags.size === 0) this.memoryKeyTags.delete(key);
        }
      }
      await this.invalidateKeys(keys);
    }
    return { deleted: keys.length };
  }

  /**
   * 命名空间就是一类特殊标签，直接复用 tag 机制
   */
  async invalidateNamespaces(namespaces) {
    return this.invalidateTags(namespaces);
  }

  /**
   * 按模式失效：先 SCAN 出 key，再失效并清理标签索引
   */
  async invalidatePatterns(patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return { deleted: 0 };
    const allKeys = new Set();
    for (const pattern of patterns) {
      const keys = await cacheService.scan(pattern, 1000);
      for (const key of keys) allKeys.add(key);
    }
    const keys = Array.from(allKeys);
    if (keys.length > 0) {
      await this.invalidateKeys(keys);
    }
    return { deleted: keys.length };
  }

  /**
   * 清空所有被标签系统跟踪的业务缓存（默认保留原生 Redis 计数类 key）
   */
  async flush(options = {}) {
    if (!options.confirm) {
      return { error: 'confirm required' };
    }

    try {
      if (this._isRedisHealthy()) {
        const redis = cacheService.getRedisClient();
        // 只删除被索引的 key
        const tagKeys = await redis.scan('0', { MATCH: `${TAG_INDEX_PREFIX}*`, COUNT: 1000 }).then(r => r.keys);
        const allKeys = new Set();
        const pipeline = redis.multi();
        for (const tagKey of tagKeys) {
          pipeline.sMembers(tagKey);
        }
        const membersArrays = await pipeline.exec();
        for (const arr of membersArrays) {
          if (Array.isArray(arr)) {
            for (const key of arr) allKeys.add(key);
          }
        }
        const keys = Array.from(allKeys);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
        const delPipeline = redis.multi();
        for (const tagKey of tagKeys) delPipeline.del(tagKey);
        const keyTagsKeys = await redis.scan('0', { MATCH: `${KEY_TAGS_PREFIX}*`, COUNT: 1000 }).then(r => r.keys);
        for (const ktk of keyTagsKeys) delPipeline.del(ktk);
        await delPipeline.exec();
        return { deleted: keys.length };
      }
    } catch (err) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.error('[CacheManager] Redis flush error:', err.message);
      }
    }

    // 内存降级
    let deleted = 0;
    for (const key of this.memoryKeyTags.keys()) {
      await cacheService.del(key);
      deleted++;
    }
    this.memoryTagIndex.clear();
    this.memoryKeyTags.clear();
    return { deleted };
  }

  /**
   * 按模式枚举 key，返回 key 与剩余 TTL
   */
  async keys(pattern, limit = 100) {
    const keys = await cacheService.scan(pattern, limit);
    const result = [];
    for (const key of keys) {
      const ttl = await cacheService.ttl(key);
      result.push({ key, ttl });
    }
    return result;
  }

  /**
   * 获取缓存统计：连接状态 + 各标签 key 数量
   */
  async stats() {
    const status = cacheService.getStatus();
    const tagStats = [];

    try {
      if (this._isRedisHealthy()) {
        const redis = cacheService.getRedisClient();
        let cursor = '0';
        const tagKeys = [];
        do {
          const reply = await redis.scan(cursor, { MATCH: `${TAG_INDEX_PREFIX}*`, COUNT: 500 });
          cursor = reply.cursor;
          tagKeys.push(...reply.keys);
        } while (cursor !== '0' && tagKeys.length < 1000);

        if (tagKeys.length > 0) {
          const pipeline = redis.multi();
          for (const tagKey of tagKeys) {
            pipeline.sCard(tagKey);
          }
          const counts = await pipeline.exec();
          for (let i = 0; i < tagKeys.length; i++) {
            const tag = tagKeys[i].slice(TAG_INDEX_PREFIX.length);
            tagStats.push({ tag, count: Number(counts[i]) || 0 });
          }
        }
        tagStats.sort((a, b) => b.count - a.count);
        return { ...status, tags: tagStats };
      }
    } catch (err) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.error('[CacheManager] Redis stats error:', err.message);
      }
    }

    // 内存降级
    for (const [tag, keys] of this.memoryTagIndex.entries()) {
      tagStats.push({ tag, count: keys.size });
    }
    tagStats.sort((a, b) => b.count - a.count);
    return { ...status, tags: tagStats };
  }
}

module.exports = new CacheManager();
