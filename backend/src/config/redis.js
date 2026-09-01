require('dotenv').config();
const fs = require('fs');
const path = require('path');

let redis = null;
let client = null;
let config = null;
let watchers = [];
let lastLatency = null;

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'redis.json');

/**
 * 加载 Redis 配置
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = JSON.parse(configData);
      console.log('[Redis] Config loaded from file:', CONFIG_FILE);
    } else {
      // 默认配置
      config = {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        enabled: true,
        database: 0,
        keyPrefix: 'traa:',
        maxRetries: 3,
        retryDelay: 1000
      };
      console.log('[Redis] Using default config');
    }
    return config;
  } catch (err) {
    console.error('[Redis] Failed to load config:', err.message);
    return null;
  }
}

/**
 * 监听配置文件变化
 */
function watchConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const watcher = fs.watch(CONFIG_FILE, (eventType) => {
      if (eventType === 'change') {
        console.log('[Redis] Config file changed, reloading...');
        const oldConfig = { ...config };
        loadConfig();
        
        // 如果配置改变，重新连接
        if (JSON.stringify(oldConfig) !== JSON.stringify(config)) {
          reconnect();
        }
      }
    });
    watchers.push(watcher);
  }
}

/**
 * 停止监听配置文件
 */
function stopWatching() {
  watchers.forEach(watcher => watcher.close());
  watchers = [];
}

async function initRedis() {
  config = loadConfig();
  
  if (!config || !config.enabled) {
    console.log('[Redis] Redis disabled or config not set, skipping initialization');
    return null;
  }

  try {
    const { createClient } = require('redis');
    
    client = createClient({
      url: config.url,
      database: config.database,
      socket: {
        reconnectStrategy: (retries) => {
          // 永不放弃重连，使用指数退避（最大30秒）
          const delay = Math.min(config.retryDelay * Math.pow(2, retries), 30000);
          console.log(`[Redis] Reconnecting in ${delay}ms (retry #${retries})`);
          return delay;
        }
      }
    });

    client.on('error', (err) => {
      console.error('[Redis] Error:', err.message);
      // 如果客户端被永久关闭，清理全局引用让 cache.js 降级到内存
      if (err.message && (
        err.message.includes('client is closed') ||
        err.message.includes('Socket closed unexpectedly')
      )) {
        console.warn('[Redis] Client closed unexpectedly, clearing reference');
        redis = null;
      }
    });

    client.on('end', () => {
      console.warn('[Redis] Connection ended');
      redis = null;
    });

    client.on('connect', () => {
      console.log('[Redis] Connected');
    });

    client.on('ready', () => {
      console.log('[Redis] Ready');
    });

    client.on('reconnecting', () => {
      console.log('[Redis] Reconnecting...');
    });

    await client.connect();
    redis = client;

    // 定期检测延迟
    setInterval(async () => {
      if (client && client.isOpen) {
        try {
          const start = process.hrtime.bigint();
          await client.ping();
          const end = process.hrtime.bigint();
          lastLatency = Number(end - start); // 保持纳秒精度
        } catch (e) {
          lastLatency = null;
        }
      } else {
        lastLatency = null;
      }
    }, 60000);
    
    // 启动配置文件监听
    watchConfig();
    
    return client;
  } catch (err) {
    console.error('[Redis] Initialization failed:', err.message);
    return null;
  }
}

/**
 * 重新连接 Redis
 */
async function reconnect() {
  try {
    if (client) {
      await client.quit();
    }
    await initRedis();
  } catch (err) {
    console.error('[Redis] Reconnection failed:', err.message);
  }
}

function getRedis() {
  return redis;
}

function getConfig() {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

function getStatus() {
  const currentConfig = getConfig();
  return {
    connected: redis !== null,
    ready: client?.isOpen || false,
    config: currentConfig,
    url: currentConfig?.url?.replace(/\/\/:[^@]+@/, '//:***@') || null,
    latency: lastLatency
  };
}

async function closeRedis() {
  stopWatching();
  if (client) {
    await client.quit();
    redis = null;
    client = null;
  }
}

module.exports = { initRedis, getRedis, closeRedis, getConfig, getStatus, reconnect };
