/**
 * 路由配置加载器
 * 支持双缓冲配置加载，根据会话配置版本选择配置
 */

const routingConfig = require('./routing-config');
const cache = require('./cache');

class RoutingLoader {
  constructor() {
    this.configCache = new Map(); // 内存缓存配置版本
    this.lastLoadTime = 0;
    this.loadInterval = 30000; // 30秒重新加载一次
  }

  /**
   * 根据配置版本加载配置
   * @param {number|null} configVersion 配置版本，null 表示使用当前活跃版本
   * @returns {Promise<Object>} 配置数据
   */
  async loadConfig(configVersion = null) {
    try {
      // 如果没有指定版本，使用活跃版本
      if (!configVersion) {
        const active = await routingConfig.getActiveVersion();
        configVersion = active?.version || null;
      }

      // 如果还是没有版本，返回空配置
      if (!configVersion) {
        return this.getDefaultConfig();
      }

      // 先从内存缓存获取
      if (this.configCache.has(configVersion)) {
        return this.configCache.get(configVersion);
      }

      // 从配置服务获取
      const config = await routingConfig.getVersion(configVersion);
      
      if (!config) {
        console.warn(`[RoutingLoader] Config version ${configVersion} not found, using default`);
        return this.getDefaultConfig();
      }

      // 缓存到内存
      this.configCache.set(configVersion, config);
      this.lastLoadTime = Date.now();

      return config;
    } catch (error) {
      console.error('[RoutingLoader] Failed to load config:', error);
      return this.getDefaultConfig();
    }
  }

  /**
   * 获取默认配置（从数据库直接读取）
   * @returns {Promise<Object>} 默认配置
   */
  async getDefaultConfig() {
    try {
      const config = await routingConfig.getCurrentConfig();
      return config;
    } catch (error) {
      console.error('[RoutingLoader] Failed to get default config:', error);
      return { version: null, sources: [] };
    }
  }

  /**
   * 根据源站ID获取路由配置
   * @param {number} sourceId 源站ID
   * @param {number|null} configVersion 配置版本
   * @returns {Promise<Object|null>} 源站路由配置
   */
  async getSourceRouting(sourceId, configVersion = null) {
    try {
      const config = await this.loadConfig(configVersion);
      const sourceConfig = config.sources.find(s => s.id === sourceId);
      
      if (!sourceConfig) {
        return null;
      }

      return {
        direct_status: sourceConfig.direct_status || 'enabled',
        relay_source_id: sourceConfig.relay_source_id || null
      };
    } catch (error) {
      console.error('[RoutingLoader] Failed to get source routing:', error);
      return null;
    }
  }

  /**
   * 清除指定版本的缓存
   * @param {number} configVersion 配置版本
   */
  clearCache(configVersion = null) {
    if (configVersion) {
      this.configCache.delete(configVersion);
    } else {
      this.configCache.clear();
    }
  }

  /**
   * 预加载配置到缓存
   * @param {number} configVersion 配置版本
   */
  async preloadConfig(configVersion) {
    try {
      await this.loadConfig(configVersion);
      console.log(`[RoutingLoader] Preloaded config version ${configVersion}`);
    } catch (error) {
      console.error('[RoutingLoader] Failed to preload config:', error);
    }
  }

  /**
   * 获取缓存状态
   * @returns {Object} 缓存状态
   */
  getCacheStatus() {
    return {
      cachedVersions: Array.from(this.configCache.keys()),
      cacheSize: this.configCache.size,
      lastLoadTime: this.lastLoadTime
    };
  }

  /**
   * 定期刷新缓存
   */
  startRefresh() {
    setInterval(async () => {
      try {
        // 获取当前活跃版本
        const active = await routingConfig.getActiveVersion();
        if (active?.version) {
          // 重新加载活跃版本
          await this.loadConfig(active.version);
        }
      } catch (error) {
        console.error('[RoutingLoader] Failed to refresh cache:', error);
      }
    }, this.loadInterval);
  }
}

module.exports = new RoutingLoader();
