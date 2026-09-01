/**
 * 会话追踪中间件
 * 用于追踪用户会话和配置版本，实现负载切换
 */

const crypto = require('crypto');
const db = require('../config/database');
const cache = require('../services/cache');
const routingConfig = require('../services/routing-config');

const SESSION_TTL = 3600; // 会话过期时间（秒）
const SESSION_CACHE_PREFIX = 'session:';
const CLEANUP_INTERVAL = 300000; // 5分钟清理一次过期会话

class SessionTracker {
  constructor() {
    this.isCleaning = false;
    this.startCleanup();
  }

  /**
   * 生成会话ID
   * @returns {string} 会话ID
   */
  generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 从请求中获取或创建会话ID
   * @param {Object} req 请求对象
   * @returns {string} 会话ID
   */
  getOrCreateSessionId(req) {
    // 优先从请求头获取
    let sessionId = req.headers['x-session-id'];
    
    // 其次从 Cookie 获取
    if (!sessionId && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').map(c => c.trim());
      const sessionCookie = cookies.find(c => c.startsWith('session_id='));
      if (sessionCookie) {
        sessionId = sessionCookie.split('=')[1];
      }
    }

    // 如果都没有，创建新会话
    if (!sessionId) {
      sessionId = this.generateSessionId();
    }

    return sessionId;
  }

  /**
   * 获取会话的配置版本
   * @param {string} sessionId 会话ID
   * @returns {Promise<number|null>} 配置版本
   */
  async getSessionConfigVersion(sessionId) {
    try {
      // 先从缓存获取
      const cacheKey = `${SESSION_CACHE_PREFIX}${sessionId}`;
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached.config_version;
      }

      // 从数据库获取
      const row = await db.get(
        'SELECT config_version FROM routing_sessions WHERE session_id = ?',
        [sessionId]
      );

      if (!row) {
        return null;
      }

      // 缓存会话信息
      await cache.set(cacheKey, { config_version: row.config_version }, SESSION_TTL);

      return row.config_version;
    } catch (error) {
      console.error('[SessionTracker] Failed to get session config version:', error);
      return null;
    }
  }

  /**
   * 创建或更新会话
   * @param {string} sessionId 会话ID
   * @param {string} userId 用户ID
   * @param {number} configVersion 配置版本
   * @returns {Promise<boolean>} 是否成功
   */
  async createOrUpdateSession(sessionId, userId, configVersion) {
    try {
      const now = new Date();
      
      // 检查会话是否存在
      const existing = await db.get(
        'SELECT id FROM routing_sessions WHERE session_id = ?',
        [sessionId]
      );

      if (existing) {
        // 更新会话
        await db.run(
          'UPDATE routing_sessions SET user_id = ?, config_version = ?, last_activity = ? WHERE session_id = ?',
          [userId, configVersion, now, sessionId]
        );
      } else {
        // 创建新会话
        await db.run(
          'INSERT INTO routing_sessions (session_id, user_id, config_version, created_at, last_activity) VALUES (?, ?, ?, ?, ?)',
          [sessionId, userId, configVersion, now, now]
        );
      }

      // 缓存会话信息
      const cacheKey = `${SESSION_CACHE_PREFIX}${sessionId}`;
      await cache.set(cacheKey, { config_version: configVersion }, SESSION_TTL);

      return true;
    } catch (error) {
      console.error('[SessionTracker] Failed to create/update session:', error);
      return false;
    }
  }

  /**
   * 更新会话活跃时间
   * @param {string} sessionId 会话ID
   * @returns {Promise<boolean>} 是否成功
   */
  async updateSessionActivity(sessionId) {
    try {
      const now = new Date();
      await db.run(
        'UPDATE routing_sessions SET last_activity = ? WHERE session_id = ?',
        [now, sessionId]
      );
      return true;
    } catch (error) {
      console.error('[SessionTracker] Failed to update session activity:', error);
      return false;
    }
  }

  /**
   * 删除会话
   * @param {string} sessionId 会话ID
   * @returns {Promise<boolean>} 是否成功
   */
  async deleteSession(sessionId) {
    try {
      await db.run('DELETE FROM routing_sessions WHERE session_id = ?', [sessionId]);
      
      // 清除缓存
      const cacheKey = `${SESSION_CACHE_PREFIX}${sessionId}`;
      await cache.del(cacheKey);

      return true;
    } catch (error) {
      console.error('[SessionTracker] Failed to delete session:', error);
      return false;
    }
  }

  /**
   * 清理过期会话
   */
  async cleanupExpiredSessions() {
    if (this.isCleaning) return;
    
    this.isCleaning = true;
    try {
      const expiredTime = new Date(Date.now() - SESSION_TTL * 1000);
      
      const result = await db.run(
        'DELETE FROM routing_sessions WHERE last_activity < ?',
        [expiredTime]
      );

      if (result.changes > 0) {
        console.log(`[SessionTracker] Cleaned up ${result.changes} expired sessions`);
      }
    } catch (error) {
      console.error('[SessionTracker] Failed to cleanup sessions:', error);
    } finally {
      this.isCleaning = false;
    }
  }

  /**
   * 启动定期清理
   */
  startCleanup() {
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL);
  }

  /**
   * Express 中间件
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // 获取或创建会话ID
        const sessionId = this.getOrCreateSessionId(req);
        req.sessionId = sessionId;

        // 获取用户ID（从认证信息中）
        const userId = req.user?.id || req.apiKey?.user_id || 'anonymous';

        // 获取当前活跃配置版本
        const activeConfig = await routingConfig.getActiveVersion();
        const currentVersion = activeConfig?.version || null;

        // 获取会话的配置版本
        const sessionVersion = await this.getSessionConfigVersion(sessionId);

        // 如果会话不存在或配置版本不匹配，创建/更新会话
        if (!sessionVersion || sessionVersion !== currentVersion) {
          await this.createOrUpdateSession(sessionId, userId, currentVersion);
          req.configVersion = currentVersion;
        } else {
          req.configVersion = sessionVersion;
          // 更新会话活跃时间
          await this.updateSessionActivity(sessionId);
        }

        // 在响应头中返回会话ID
        res.setHeader('X-Session-ID', sessionId);

        next();
      } catch (error) {
        console.error('[SessionTracker] Middleware error:', error);
        // 出错时继续处理请求，使用默认配置
        req.sessionId = null;
        req.configVersion = null;
        next();
      }
    };
  }

  /**
   * 获取会话统计信息
   * @returns {Promise<Object>} 统计信息
   */
  async getStats() {
    try {
      const total = await db.get('SELECT COUNT(*) as count FROM routing_sessions');
      const active = await db.get(
        'SELECT COUNT(*) as count FROM routing_sessions WHERE last_activity > ?',
        [new Date(Date.now() - 300000)] // 5分钟内活跃
      );

      return {
        totalSessions: total?.count || 0,
        activeSessions: active?.count || 0
      };
    } catch (error) {
      console.error('[SessionTracker] Failed to get stats:', error);
      return { totalSessions: 0, activeSessions: 0 };
    }
  }
}

module.exports = new SessionTracker();
