/**
 * 路由配置版本管理服务
 * 支持配置版本管理、验证和热切换
 */

const db = require('../config/database');
const cache = require('./cache');
const cacheManager = require('./cache-manager');

class RoutingConfigService {
  constructor() {
    this.CACHE_PREFIX = 'routing_config:';
    this.CACHE_TTL = 3600; // 1小时
  }

  /**
   * 从数据库获取当前所有源站的路由配置
   * @returns {Promise<Object>} 配置数据
   */
  async getCurrentConfig() {
    try {
      const sources = await db.all(`
        SELECT id, name, protocol, direct_status, relay_source_id
        FROM sources WHERE is_active = true
      `);

      const config = {
        version: null,
        sources: sources.map(s => ({
          id: s.id,
          name: s.name,
          protocol: s.protocol,
          direct_status: s.direct_status || 'enabled',
          relay_source_id: s.relay_source_id
        })),
        created_at: new Date().toISOString()
      };

      return config;
    } catch (error) {
      console.error('[RoutingConfig] Failed to get current config:', error);
      throw error;
    }
  }

  /**
   * 创建新配置版本
   * @param {Object} config 配置数据
   * @returns {Promise<Object>} 新版本信息
   */
  async createVersion(config) {
    try {
      // 验证配置
      const validation = this.validateConfig(config);
      if (!validation.valid) {
        throw new Error(`配置验证失败: ${validation.message}`);
      }

      // 获取下一个版本号
      const lastVersion = await db.get(
        'SELECT MAX(version) as max_version FROM routing_config_versions'
      );
      const nextVersion = (lastVersion?.max_version || 0) + 1;

      // 插入新版本
      await db.run(
        'INSERT INTO routing_config_versions (version, config_data, is_active) VALUES (?, ?, ?)',
        [nextVersion, JSON.stringify(config), false]
      );

      // 清除缓存
      await this.clearCache();

      console.log(`[RoutingConfig] Created version ${nextVersion}`);
      return { version: nextVersion, config };
    } catch (error) {
      console.error('[RoutingConfig] Failed to create version:', error);
      throw error;
    }
  }

  /**
   * 获取指定版本的配置
   * @param {number} version 版本号
   * @returns {Promise<Object|null>} 配置数据
   */
  async getVersion(version) {
    try {
      // 先从缓存获取
      const cacheKey = `${this.CACHE_PREFIX}${version}`;
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // 从数据库获取
      const row = await db.get(
        'SELECT config_data FROM routing_config_versions WHERE version = ?',
        [version]
      );

      if (!row) {
        return null;
      }

      const config = JSON.parse(row.config_data);
      
      // 缓存配置
      await cacheManager.set(cacheKey, config, this.CACHE_TTL, { tags: ['routing'] });

      return config;
    } catch (error) {
      console.error('[RoutingConfig] Failed to get version:', error);
      throw error;
    }
  }

  /**
   * 获取当前活跃的配置版本
   * @returns {Promise<Object|null>} 活跃配置
   */
  async getActiveVersion() {
    try {
      const row = await db.get(
        'SELECT version, config_data FROM routing_config_versions WHERE is_active = true ORDER BY version DESC LIMIT 1'
      );

      if (!row) {
        return null;
      }

      return {
        version: row.version,
        config: JSON.parse(row.config_data)
      };
    } catch (error) {
      console.error('[RoutingConfig] Failed to get active version:', error);
      throw error;
    }
  }

  /**
   * 激活指定版本的配置
   * @param {number} version 版本号
   * @returns {Promise<boolean>} 是否成功
   */
  async activateVersion(version) {
    try {
      // 验证版本存在
      const config = await this.getVersion(version);
      if (!config) {
        throw new Error(`版本 ${version} 不存在`);
      }

      // 取消所有活跃版本
      await db.run('UPDATE routing_config_versions SET is_active = false');

      // 激活指定版本
      await db.run(
        'UPDATE routing_config_versions SET is_active = true WHERE version = ?',
        [version]
      );

      // 清除缓存
      await this.clearCache();

      console.log(`[RoutingConfig] Activated version ${version}`);
      return true;
    } catch (error) {
      console.error('[RoutingConfig] Failed to activate version:', error);
      throw error;
    }
  }

  /**
   * 获取所有配置版本列表
   * @returns {Promise<Array>} 版本列表
   */
  async listVersions() {
    try {
      const rows = await db.all(`
        SELECT version, is_active, created_at
        FROM routing_config_versions
        ORDER BY version DESC
      `);

      return rows.map(r => ({
        version: r.version,
        is_active: r.is_active,
        created_at: r.created_at
      }));
    } catch (error) {
      console.error('[RoutingConfig] Failed to list versions:', error);
      throw error;
    }
  }

  /**
   * 删除指定版本
   * @param {number} version 版本号
   * @returns {Promise<boolean>} 是否成功
   */
  async deleteVersion(version) {
    try {
      // 不允许删除活跃版本
      const active = await this.getActiveVersion();
      if (active && active.version === version) {
        throw new Error('不能删除活跃的配置版本');
      }

      await db.run('DELETE FROM routing_config_versions WHERE version = ?', [version]);

      // 清除缓存
      await cacheManager.invalidateKeys([`${this.CACHE_PREFIX}${version}`]);

      console.log(`[RoutingConfig] Deleted version ${version}`);
      return true;
    } catch (error) {
      console.error('[RoutingConfig] Failed to delete version:', error);
      throw error;
    }
  }

  /**
   * 验证配置有效性
   * @param {Object} config 配置数据
   * @returns {Object} 验证结果
   */
  validateConfig(config) {
    if (!config || typeof config !== 'object') {
      return { valid: false, message: '配置必须是对象' };
    }

    if (!Array.isArray(config.sources)) {
      return { valid: false, message: 'sources 必须是数组' };
    }

    if (config.sources.length === 0) {
      return { valid: false, message: '至少需要一个源站配置' };
    }

    // 验证每个源站配置
    for (const source of config.sources) {
      if (!source.id || !source.name || !source.protocol) {
        return { valid: false, message: '源站配置缺少必要字段 (id, name, protocol)' };
      }

      if (!['enabled', 'disabled'].includes(source.direct_status)) {
        return { valid: false, message: `源站 ${source.name} 的 direct_status 必须是 enabled 或 disabled` };
      }

      // 如果是中继模式，验证中继源站存在
      if (source.direct_status === 'disabled' && source.relay_source_id) {
        const relayExists = config.sources.some(s => s.id === source.relay_source_id);
        if (!relayExists) {
          return { valid: false, message: `源站 ${source.name} 的中继源站不存在` };
        }
      }
    }

    return { valid: true };
  }

  /**
   * 清除配置缓存
   */
  async clearCache() {
    await cacheManager.invalidatePatterns([`${this.CACHE_PREFIX}*`]);
  }

  /**
   * 获取配置状态摘要
   * @returns {Promise<Object>} 状态摘要
   */
  async getStatus() {
    try {
      const active = await this.getActiveVersion();
      const versions = await this.listVersions();
      const cacheStatus = cache.getStatus();

      return {
        activeVersion: active?.version || null,
        activeConfig: active?.config || null,
        totalVersions: versions.length,
        versions: versions,
        cache: cacheStatus
      };
    } catch (error) {
      console.error('[RoutingConfig] Failed to get status:', error);
      throw error;
    }
  }
}

module.exports = new RoutingConfigService();
