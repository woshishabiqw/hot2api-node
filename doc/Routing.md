# 协议路由系统

## 概述

协议路由系统负责智能选择最优的源站进行请求转发，支持自动模式和手动模式。系统通过实时探针检测源站延迟，根据延迟阈值自动禁用高延迟源站，确保请求路由到最优路径。

## 核心组件

### 1. 探针服务 (ProbeService)
**文件**: `backend/src/services/probe.js`

**功能**:
- 定期检测所有活跃源站的延迟
- 支持多协议检测（OpenAI、Anthropic、Gemini）
- 记录延迟、状态、错误信息
- 为智能路由提供实时数据

**检测逻辑**:
```javascript
async probeSource(source, roundTimestamp) {
  const result = {};
  const protocols = ['openai', 'anthropic', 'gemini'];
  
  for (const proto of protocols) {
    if (!apiUrls[proto]) continue;
    const start = Date.now();
    try {
      const latency = await this.probeProtocol(source, proto);
      result[proto] = { latencyMs: latency, status: 'ok', timestamp: roundTimestamp };
    } catch (e) {
      const httpStatus = e.response?.status;
      const status = httpStatus === 401 || httpStatus === 403 ? 'invalid_key' : 'error';
      result[proto] = { latencyMs: Date.now() - start, status, error: errMsg, timestamp: roundTimestamp };
    }
  }
  return result;
}
```

**检测间隔**: 1 秒

**超时设置**: 15 秒

**协议检测方式**:
- **OpenAI**: GET `/models`，使用 Bearer Token 认证
- **Anthropic**: GET `/v1/models`，使用 x-api-key 头
- **Gemini**: GET `/v1beta/models?key=xxx`，使用查询参数

### 2. 智能路由服务 (SmartRoutingService)
**文件**: `backend/src/services/smart-routing.js`

**功能**:
- 管理路由模式（auto/manual）
- 根据探针数据自动禁用高延迟源站
- 支持手动调整源站状态
- 提供路由状态查询接口

## 路由模式

### 自动模式 (auto)
**启用条件**: `settings.routing_mode = 'auto'`

**工作流程**:
1. 定期检查所有活跃源站
2. 获取探针延迟数据
3. 计算动态延迟阈值
4. 超过阈值的源站自动禁用
5. 正常源站自动启用

**检查间隔**:
- 启用状态: 15 分钟（可配置 `direct_check_interval_enabled`）
- 禁用状态: 30 分钟（可配置 `direct_check_interval_disabled`）
- 待定状态: 5 分钟（可配置 `direct_check_interval_pending`）

### 手动模式 (manual)
**启用条件**: `settings.routing_mode = 'manual'`

**特点**:
- 停止自动检查
- 完全由管理员手动控制
- 不会自动禁用/启用源站

## 智能路由逻辑

### 1. 延迟阈值计算
```javascript
async shouldDisableDirect(source, protocol, latency) {
  const multiplier = parseFloat(await this.getSetting('direct_latency_multiplier', '2'));
  const threshold = parseInt(await this.getSetting('direct_latency_threshold_ms', '300'));

  // 获取所有协议的延迟
  const probeData = probeService.getResults();
  const allLatencies = [];

  for (const [sourceId, sourceProbe] of probeData.entries()) {
    for (const [proto, data] of Object.entries(sourceProbe)) {
      if (data.status === 'ok' && data.latencyMs > 0) {
        allLatencies.push(data.latencyMs);
      }
    }
  }

  if (allLatencies.length === 0) return false;

  const minLatency = Math.min(...allLatencies);
  const dynamicThreshold = Math.max(threshold, minLatency * multiplier);

  return latency > dynamicThreshold;
}
```

**动态阈值公式**:
```
threshold = max(固定阈值, 最小延迟 × 倍数)
```

**默认配置**:
- 固定阈值: 300ms
- 倍数: 2
- 禁用时长: 24 小时

### 2. 源站状态管理

**状态类型**:
- `enabled`: 启用直通
- `disabled`: 禁用直通
- `pending`: 待定（检测失败）

**状态转换**:
```
enabled → disabled: 延迟超过阈值
disabled → enabled: 延迟正常且禁用期结束
enabled → pending: 检测失败
pending → enabled: 检测成功
```

**禁用逻辑**:
```javascript
async disableDirect(source, protocol) {
  const hours = parseInt(await this.getSetting('direct_disable_duration_hours', '24'));
  const disabledUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  await db.run(
    `UPDATE sources SET direct_status = 'disabled', direct_disabled_until = ?, 
     direct_fail_count = direct_fail_count + 1, direct_flap_count = direct_flap_count + 1 
     WHERE id = ?`,
    [disabledUntil, source.id]
  );
}
```

**启用逻辑**:
```javascript
async enableDirect(source, protocol) {
  await db.run(
    `UPDATE sources SET direct_status = 'enabled', direct_disabled_until = NULL, 
     direct_success_count = direct_success_count + 1 WHERE id = ?`,
    [source.id]
  );
}
```

### 3. 统计指标

**跟踪指标**:
- `direct_latency_ms`: 直通延迟
- `direct_last_check`: 最后检查时间
- `direct_fail_count`: 失败次数
- `direct_success_count`: 成功次数
- `direct_flap_count`: 状态切换次数
- `direct_disabled_until`: 禁用到期时间
- `relay_source_id`: 中继源站 ID

## 配置参数

### 路由模式
**键**: `routing_mode`
**值**: `auto` | `manual`
**默认**: `auto`

### 延迟阈值
**键**: `direct_latency_threshold_ms`
**值**: 毫秒数
**默认**: 300

### 延迟倍数
**键**: `direct_latency_multiplier`
**值**: 数字
**默认**: 2

### 禁用时长
**键**: `direct_disable_duration_hours`
**值**: 小时数
**默认**: 24

### 检查间隔
**键**: `direct_check_interval_{status}`
**值**: 分钟数
**默认**:
- `enabled`: 15
- `disabled`: 30
- `pending`: 5

### 路由策略
**键**: `routing_strategy`
**值**: `aggressive` | `balanced` | `conservative`
**默认**: `balanced`

## API 接口

### 获取路由状态
**端点**: `GET /admin/routing/status`

**返回数据**:
```json
{
  "sources": [
    {
      "id": 1,
      "name": "Source 1",
      "protocol": "openai",
      "direct_status": "enabled",
      "direct_disabled_until": null,
      "direct_latency_ms": 150,
      "direct_last_check": "2026-05-26T08:00:00.000Z",
      "direct_fail_count": 0,
      "direct_success_count": 100,
      "direct_flap_count": 2,
      "relay_source_id": null
    }
  ],
  "settings": {
    "mode": "auto",
    "latencyMultiplier": 2,
    "latencyThreshold": 300,
    "disableDuration": 24,
    "strategy": "balanced"
  }
}
```

### 设置路由模式
**端点**: `POST /admin/routing/mode`

**请求体**:
```json
{
  "mode": "auto"
}
```

### 手动更新源站状态
**端点**: `PUT /admin/routing/source/:id/status`

**请求体**:
```json
{
  "status": "enabled"
}
```

## 工作流程

### 启动流程
1. 加载路由模式配置
2. 如果是自动模式，启动探针服务
3. 为每个活跃源站安排检查任务
4. 开始定期检查

### 检查流程
1. 获取源站探针数据
2. 检查是否在禁用期内
3. 计算动态延迟阈值
4. 判断是否需要禁用
5. 更新源站状态
6. 安排下一次检查

### 降级策略
- 探针失败时标记为 `pending`
- 连续失败不会立即禁用
- 禁用期结束后自动重新检查
- 手动模式停止所有自动操作

## 故障排查

### 源站频繁禁用
**原因**:
- 延迟倍数设置过低
- 固定阈值设置过低
- 网络不稳定

**解决**:
1. 增加 `direct_latency_multiplier`
2. 提高 `direct_latency_threshold_ms`
3. 检查网络连接

### 源站长期禁用
**原因**:
- 禁用时长设置过长
- 延迟持续过高
- API 密钥失效

**解决**:
1. 减少 `direct_disable_duration_hours`
2. 检查源站延迟
3. 验证 API 密钥

### 探针检测失败
**原因**:
- API URL 配置错误
- API 密钥无效
- 网络连接问题

**解决**:
1. 检查 `api_urls` 配置
2. 验证 API 密钥
3. 检查网络连接

## 最佳实践

### 生产环境
- 使用合理的延迟倍数（1.5-2.5）
- 设置适当的禁用时长（12-48 小时）
- 监控源站状态变化
- 定期检查探针数据

### 开发环境
- 使用较短的检查间隔（1-5 分钟）
- 降低延迟阈值便于测试
- 手动模式便于调试

### 监控指标
- 源站状态切换频率
- 探针检测成功率
- 平均延迟变化趋势
- 禁用源站数量
