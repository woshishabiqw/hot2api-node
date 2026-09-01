# Redis 配置与运行逻辑

## 概述

本项目使用 Redis 作为缓存层，支持配置热重载和自动降级到内存缓存。Redis 配置通过 JSON 文件管理，支持实时修改而无需重启服务。

## 配置文件

### 位置
`backend/config/redis.json`

### 配置项
```json
{
  "url": "redis://localhost:6379",
  "enabled": true,
  "database": 0,
  "keyPrefix": "traa:",
  "maxRetries": 3,
  "retryDelay": 1000
}
```

### 配置说明
- `url`: Redis 连接地址
- `enabled`: 是否启用 Redis（false 时完全禁用）
- `database`: Redis 数据库编号（0-15）
- `keyPrefix`: 键前缀，用于区分不同应用
- `maxRetries`: 最大重试次数
- `retryDelay`: 重试延迟（毫秒）

## 运行逻辑

### 1. 配置加载
**文件**: `backend/src/config/redis.js`

```javascript
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else {
    // 使用默认配置
    config = {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      enabled: true,
      database: 0,
      keyPrefix: 'traa:',
      maxRetries: 3,
      retryDelay: 1000
    };
  }
  return config;
}
```

**特点**:
- 优先从 JSON 文件读取配置
- 文件不存在时使用默认配置
- 支持环境变量 `REDIS_URL` 覆盖

### 2. 初始化连接
```javascript
async function initRedis() {
  config = loadConfig();
  
  if (!config || !config.enabled) {
    console.log('[Redis] Redis disabled or config not set, skipping initialization');
    return null;
  }

  client = createClient({
    url: config.url,
    database: config.database,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > config.maxRetries) {
          return new Error('Max retries reached');
        }
        return config.retryDelay;
      }
    }
  });

  await client.connect();
  redis = client;
  
  // 启动延迟检测
  setInterval(async () => {
    if (client) {
      const start = Date.now();
      await client.ping();
      lastLatency = Date.now() - start;
    }
  }, 1000);
  
  // 启动配置文件监听
  watchConfig();
  
  return client;
}
```

**特点**:
- 使用 Redis Node.js 客户端
- 内置重连策略
- 自动启动延迟检测（1秒间隔）
- 自动监听配置文件变化

### 3. 延迟检测
```javascript
setInterval(async () => {
  if (client) {
    try {
      const start = Date.now();
      await client.ping();
      lastLatency = Date.now() - start;
    } catch (e) {
      lastLatency = null;
    }
  }
}, 1000);
```

**特点**:
- 每 1 秒执行一次 PING 命令
- 记录响应时间作为延迟指标
- 失败时将延迟设为 null
- 可通过 API 获取实时延迟

### 4. 配置热重载
```javascript
function watchConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const watcher = fs.watch(CONFIG_FILE, (eventType) => {
      if (eventType === 'change') {
        const oldConfig = { ...config };
        loadConfig();
        
        // 配置改变时重新连接
        if (JSON.stringify(oldConfig) !== JSON.stringify(config)) {
          reconnect();
        }
      }
    });
    watchers.push(watcher);
  }
}
```

**特点**:
- 监听配置文件变化
- 配置改变时自动重新连接
- 无需重启服务即可生效

## 降级重连逻辑

### 1. 缓存服务降级
**文件**: `backend/src/services/cache.js`

```javascript
class CacheService {
  async set(key, value, ttl = 3600) {
    try {
      if (this.useRedis && this.redis) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
      } else {
        this.memoryCache.set(key, value);
        this.memoryTTL.set(key, Date.now() + ttl * 1000);
      }
    } catch (error) {
      // 降级到内存缓存
      this.memoryCache.set(key, value);
      this.memoryTTL.set(key, Date.now() + ttl * 1000);
    }
  }

  async get(key) {
    try {
      if (this.useRedis && this.redis) {
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
      } else {
        // 检查内存缓存是否过期
        const ttl = this.memoryTTL.get(key);
        if (ttl && Date.now() > ttl) {
          this.memoryCache.delete(key);
          this.memoryTTL.delete(key);
          return null;
        }
        return this.memoryCache.get(key) || null;
      }
    } catch (error) {
      // 降级到内存缓存
      const ttl = this.memoryTTL.get(key);
      if (ttl && Date.now() > ttl) {
        this.memoryCache.delete(key);
        this.memoryTTL.delete(key);
        return null;
      }
      return this.memoryCache.get(key) || null;
    }
  }
}
```

**降级策略**:
1. 所有缓存操作先尝试 Redis
2. Redis 失败时自动降级到内存 Map
3. 内存缓存支持 TTL 过期机制
4. 每 5 分钟自动清理过期内存缓存

### 2. 自动重连
```javascript
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
```

**重连触发条件**:
- 配置文件变化
- 前端手动触发重连
- Redis 客户端自动重连（达到最大重试次数后停止）

### 3. 状态监控
**API 端点**: `GET /admin/database/status`

**返回数据**:
```json
{
  "redis": {
    "connected": true,
    "ready": false,
    "url": "redis://localhost:6379",
    "latency": 1,
    "config": {
      "enabled": true,
      "database": 0,
      "keyPrefix": "traa:"
    }
  },
  "cache": {
    "useRedis": true,
    "memoryCacheSize": 0,
    "redisConnected": true
  }
}
```

**手动重连**: `POST /admin/database/redis/reconnect`

## 键前缀说明

键前缀用于区分不同应用的 Redis 键，避免键名冲突。

**示例**:
- 用户缓存键: `traa:user:123`
- 源站缓存键: `traa:source:456`
- 路由缓存键: `traa:route:config`

**修改键前缀**:
1. 编辑 `backend/config/redis.json`
2. 修改 `keyPrefix` 字段
3. 保存文件，自动重新连接
4. 新键前缀立即生效

## 故障排查

### Redis 未就绪
**现象**: `ready: false`

**原因**:
- Redis 服务未启动
- 连接地址错误
- 网络问题

**解决**:
1. 检查 Redis 服务是否运行
2. 验证 `redis.json` 中的 URL 配置
3. 使用手动重连按钮

### 延迟过高
**现象**: `latency` 值较大

**原因**:
- 网络延迟
- Redis 负载过高
- 本地资源不足

**解决**:
1. 检查网络连接
2. 监控 Redis 负载
3. 考虑使用本地 Redis

### 缓存降级
**现象**: `cache.useRedis: false`

**原因**:
- Redis 连接失败
- Redis 未启用

**解决**:
1. 检查 Redis 连接状态
2. 确认 `enabled: true`
3. 查看错误日志

## 最佳实践

1. **生产环境**
   - 使用专用 Redis 服务器
   - 设置适当的键前缀
   - 配置密码认证
   - 启用持久化

2. **开发环境**
   - 使用本地 Redis
   - 保持默认配置
   - 监控延迟指标

3. **监控**
   - 定期检查延迟指标
   - 监控缓存命中率
   - 关注降级事件
