# AI Key 中转站 - 项目规划文档

## 一、项目概述

**项目名称**: AI Key Gateway (AI 密钥网关中转站)

**核心功能**:
- API 请求代理转发（OpenAI 协议 + Anthropic 协议）
- Token 消耗统计与额度控制
- 多 Key 自动分发与负载均衡
- 后台管理 + 前台用户界面

---

## 二、技术栈

| 层级 | 技术 | 说明 |
|-----|------|------|
| **前端** | React 18 + Tailwind CSS + Shadcn UI | 支持深色模式 |
| **后端** | Node.js + Express | API 代理服务 |
| **主数据库** | PostgreSQL | 生产环境使用 |
| **备用数据库** | SQLite | 开发/测试环境 |
| **认证** | JWT | 管理员 + 用户认证 |

---

## 三、系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户请求                                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     中转站后端 (Express)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ OpenAI协议  │  │Anthropic协议│  │    Key分发引擎          │  │
│  │ /v1/chat/*  │  │ /v1/messages│  │ - 轮询/随机/权重/故障转移│  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Token统计   │  │  额度控制   │  │    日志记录             │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    源站 API (MiMo/OpenAI/Claude...)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、双站点规划

### 4.1 总站 (Admin) - 后台管理

**端口**: `3001` (默认)  
**路径**: `/admin/*`  
**用户**: 管理员

**功能模块**:

| 模块 | 功能 |
|-----|------|
| **仪表盘** | 总览统计、今日请求量、Token消耗趋势图 |
| **Key管理** | 添加/编辑/删除源站Key、测试Key有效性、查看余额状态 |
| **源站配置** | 配置源站URL、支持的模型、协议类型 |
| **分发规则** | 配置Key分发策略(轮询/随机/权重/故障转移) |
| **用户管理** | 管理前台用户、分配额度、设置权限 |
| **统计报表** | 请求日志、Token消耗明细、按用户/Key/模型统计 |
| **系统设置** | 中转站URL配置、数据库切换、日志级别 |

### 4.2 子站 (User) - 前台用户

**端口**: `3000` (默认)  
**路径**: `/`  
**用户**: 普通用户

**功能模块**:

| 模块 | 功能 |
|-----|------|
| **仪表盘** | 个人用量统计、剩余额度、API调用趋势 |
| **API文档** | 中转站接口文档、调用示例、模型列表 |
| **密钥管理** | 生成/撤销个人API Key、查看调用记录 |
| **用量明细** | 请求历史、Token消耗详情 |

---

## 五、数据库设计

### 5.1 核心表结构

```sql
-- 源站配置表
CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,           -- 源站名称 (如: MiMo, OpenAI)
    base_url TEXT NOT NULL,       -- 源站API地址
    protocol TEXT DEFAULT 'openai', -- 协议类型: openai/anthropic
    api_key TEXT NOT NULL,        -- 源站API Key (加密存储)
    weight INTEGER DEFAULT 1,     -- 权重
    is_active BOOLEAN DEFAULT 1,  -- 是否启用
    last_check_at DATETIME,       -- 最后检测时间
    status TEXT DEFAULT 'unknown', -- 状态: valid/invalid/insufficient
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 模型映射表
CREATE TABLE models (
    id INTEGER PRIMARY KEY,
    source_id INTEGER,            -- 关联源站
    model_id TEXT NOT NULL,       -- 模型ID (如: mimo-v2-pro)
    model_alias TEXT,             -- 别名 (如: gpt-4 映射到 mimo-v2-pro)
    input_price REAL,             -- 输入价格 (每百万token)
    output_price REAL,            -- 输出价格 (每百万token)
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (source_id) REFERENCES sources(id)
);

-- 用户表
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',     -- admin/user
    quota_limit INTEGER DEFAULT 0, -- 额度限制 (0=无限制)
    quota_used INTEGER DEFAULT 0,  -- 已用额度
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户API Key表
CREATE TABLE user_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    key_hash TEXT NOT NULL,       -- 用户API Key (哈希存储)
    key_prefix TEXT NOT NULL,     -- Key前缀 (用于显示: sk-xxx...)
    name TEXT,                    -- Key名称/备注
    is_active BOOLEAN DEFAULT 1,
    last_used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 请求日志表
CREATE TABLE request_logs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    user_key_id INTEGER,
    source_id INTEGER,
    model TEXT,
    protocol TEXT,                -- openai/anthropic
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    status_code INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (source_id) REFERENCES sources(id)
);

-- 分发规则表
CREATE TABLE dispatch_rules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    strategy TEXT DEFAULT 'round_robin', -- round_robin/random/weight/failover
    model_filter TEXT,            -- 应用的模型 (JSON数组或*)
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT 1
);

-- 工作空间表 (Phase 4)
CREATE TABLE workspaces (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_id INTEGER NOT NULL,
    plan_id INTEGER,
    balance REAL DEFAULT 0,
    quota_limit INTEGER DEFAULT 0,
    quota_used INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 工作空间成员表 (Phase 4)
CREATE TABLE workspace_members (
    workspace_id INTEGER,
    user_id INTEGER,
    role TEXT DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id)
);

-- 计费套餐表 (Phase 4)
CREATE TABLE billing_plans (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price_monthly REAL DEFAULT 0,
    price_yearly REAL DEFAULT 0,
    quota_limit INTEGER DEFAULT 0,
    features TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 充值订单表 (Phase 4)
CREATE TABLE payment_orders (
    id SERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    channel TEXT NOT NULL,        -- alipay / wechat
    status TEXT DEFAULT 'pending',
    trade_no TEXT,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PIN 密码表 (Phase 4) — 双入口独立密码
CREATE TABLE user_pins (
    user_id INTEGER NOT NULL,
    pin_type TEXT NOT NULL,       -- billing / payment_gateway
    password_hash TEXT,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, pin_type)
);

-- 审计日志表 (Phase 4)
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id INTEGER,
    resource_name TEXT,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 六、API 接口设计

### 6.1 OpenAI 协议接口

```
POST /v1/chat/completions     → 转发到源站 + 统计
POST /v1/completions          → 转发到源站 + 统计
GET  /v1/models               → 返回可用模型列表
POST /v1/embeddings           → 转发到源站 + 统计
```

### 6.2 Anthropic 协议接口

```
POST /v1/messages             → 转发到源站 + 统计
```

### 6.3 管理接口 (Admin API)

```
# 源站管理
GET    /admin/sources              → 获取源站列表
POST   /admin/sources              → 添加源站
PUT    /admin/sources/:id          → 更新源站
DELETE /admin/sources/:id          → 删除源站
POST   /admin/sources/:id/test     → 测试源站Key

# 模型管理
GET    /admin/models               → 获取模型列表
POST   /admin/models               → 添加模型映射
PUT    /admin/models/:id           → 更新模型

# 用户管理
GET    /admin/users                → 获取用户列表
POST   /admin/users                → 创建用户
PUT    /admin/users/:id            → 更新用户
PUT    /admin/users/:id/quota      → 设置用户额度

# 统计
GET    /admin/stats/overview       → 总览统计
GET    /admin/stats/logs           → 请求日志
GET    /admin/stats/tokens         → Token消耗统计

# 系统设置
GET    /admin/settings             → 获取系统设置
PUT    /admin/settings             → 更新系统设置

# 审计日志 (Phase 4)
GET    /admin/audit-logs           → 获取审计日志列表 (支持分页/过滤)
GET    /admin/audit-logs/stats     → 获取审计统计

# 计费管理 (Phase 4)
GET    /billing/plans              → 获取计费套餐
POST   /billing/recharge           → 创建充值订单
GET    /billing/orders/:id         → 查询订单状态
GET    /billing/balance/:id        → 查询余额

# 支付回调 (Phase 4) — 公开访问，无需认证
GET    /billing/pay-callback       → 支付宝同步回调
POST   /billing/notify             → 支付宝异步通知
GET    /billing/pay-mock           → 模拟支付回调 (开发测试)

# 支付渠道配置 (Phase 4)
GET    /payment-gateway/settings   → 获取支付配置
POST   /payment-gateway/settings   → 更新支付配置

# 二次验证 PIN (Phase 4)
POST   /auth/second-password/setup      → 设置计费 PIN
POST   /auth/second-password/verify     → 验证计费 PIN
POST   /auth/payment-password/setup     → 设置支付渠道 PIN
POST   /auth/payment-password/verify    → 验证支付渠道 PIN
```

### 6.4 用户接口 (User API)

```
# 认证
POST   /auth/login                 → 登录
POST   /auth/register              → 注册 (可关闭)
POST   /auth/logout                → 登出

# 用户信息
GET    /user/profile               → 获取个人信息
PUT    /user/profile               → 更新个人信息

# API Key管理
GET    /user/keys                  → 获取我的Key列表
POST   /user/keys                  → 创建新Key
DELETE /user/keys/:id              → 删除Key

# 用量统计
GET    /user/stats                 → 我的用量统计
GET    /user/logs                  → 我的请求日志
```

---

## 七、Key 分发策略

| 策略 | 说明 |
|-----|------|
| **round_robin** | 轮询，依次使用每个Key |
| **random** | 随机选择一个Key |
| **weight** | 按权重分配，权重高的被选中概率大 |
| **failover** | 主Key优先，失败时切换到备用Key |
| **least_used** | 选择使用量最少的Key |

---

## 八、项目目录结构

```
ai-key-gateway/
├── backend/                      # 后端服务
│   ├── src/
│   │   ├── index.js              # 入口文件
│   │   ├── config/               # 配置
│   │   │   ├── database.js       # 数据库配置
│   │   │   └── settings.js       # 系统设置
│   │   ├── routes/               # 路由
│   │   │   ├── openai.js         # OpenAI协议路由
│   │   │   ├── anthropic.js      # Anthropic协议路由
│   │   │   ├── admin.js          # 管理接口
│   │   │   └── user.js           # 用户接口
│   │   ├── services/             # 业务逻辑
│   │   │   ├── dispatcher.js     # Key分发引擎
│   │   │   ├── proxy.js          # 请求代理
│   │   │   ├── stats.js          # 统计服务
│   │   │   └── key-checker.js    # Key检测服务
│   │   ├── middleware/           # 中间件
│   │   │   ├── auth.js           # 认证中间件
│   │   │   ├── rate-limit.js     # 限流
│   │   │   └── logger.js         # 日志
│   │   └── utils/                # 工具函数
│   ├── database/
│   │   ├── sqlite/               # SQLite数据库文件
│   │   └── migrations/           # 数据库迁移
│   ├── package.json
│   └── .env                      # 环境变量
│
├── frontend-admin/               # 总站前端 (后台管理)
│   ├── src/
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx     # 仪表盘
│   │   │   ├── Sources.jsx       # 源站管理
│   │   │   ├── Models.jsx        # 模型管理
│   │   │   ├── Users.jsx         # 用户管理
│   │   │   ├── Stats.jsx         # 统计报表
│   │   │   └── Settings.jsx      # 系统设置
│   │   ├── components/           # 组件
│   │   ├── hooks/                # 自定义Hooks
│   │   └── lib/                  # 工具库
│   ├── package.json
│   └── tailwind.config.js
│
├── frontend-user/                # 子站前端 (前台用户)
│   ├── src/
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx     # 用户仪表盘
│   │   │   ├── ApiKeys.jsx       # API Key管理
│   │   │   ├── Usage.jsx         # 用量明细
│   │   │   └── Docs.jsx          # API文档
│   │   ├── components/
│   │   └── hooks/
│   ├── package.json
│   └── tailwind.config.js
│
├── shared/                       # 共享代码
│   └── types/                    # TypeScript类型定义
│
└── docker-compose.yml            # Docker部署配置
```

---

## 九、默认配置

| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| 后端端口 | 3000 | API服务端口 |
| Admin前端端口 | 3001 | 后台管理界面 |
| User前端端口 | 3002 | 前台用户界面 |
| 数据库 | PostgreSQL | 主数据库 (生产环境) |
| 数据库 | SQLite | 备用数据库 (开发环境) |
| 默认计费 PIN | 123456 | 首次进入计费中心 |
| 默认支付渠道 PIN | 123456 | 首次进入支付渠道配置 |
| JWT密钥 | 随机生成 | 需要在.env中配置 |
| 默认管理员 | admin / admin123 | 首次启动创建 |

---

## 十、开发阶段规划

### Phase 1: 后端核心 (预计 2-3 天)
- [ ] 项目初始化 + 数据库设计
- [ ] OpenAI 协议代理转发
- [ ] Anthropic 协议代理转发
- [ ] Token 统计与记录
- [ ] Key 分发引擎

### Phase 2: 管理后台 (预计 2-3 天)
- [ ] Admin 前端项目搭建
- [ ] 登录/认证页面
- [ ] 仪表盘页面
- [ ] 源站/Key 管理页面
- [ ] 用户管理页面
- [ ] 统计报表页面

### Phase 3: 用户前台 (预计 1-2 天)
- [ ] User 前端项目搭建
- [ ] 用户登录/注册
- [ ] 用户仪表盘
- [ ] API Key 管理
- [ ] 用量明细

### Phase 4: PostgreSQL 迁移 + 计费系统 + 审计日志 ✅ 已完成
- [x] PostgreSQL 数据库迁移（SQLite → PG）
- [x] SQL 方言自动转换层（`convertSql`）
- [x] 工作空间（Workspace）系统
- [x] 计费套餐（Billing Plans）
- [x] 充值订单（Payment Orders）
- [x] 双 PIN 验证系统（计费中心 / 支付渠道独立密码）
- [x] 审计日志（Audit Logs）完整链路
- [x] 第三方支付回调路由（无 auth 公开访问）
- [x] 登录 rate-limit
- [x] 前端空值安全全面加固（18个文件，37处修复）
- [x] 后端致命 bug 修复（`mapasync` / `async` 算术 / `user_pins` 表缺失）
- [x] Audit Log HTTP API 暴露
- [ ] 深色模式完善
- [ ] 响应式布局
- [ ] 性能优化

---

## 十一、安全考虑

1. **API Key 加密存储**: 源站 Key 使用 AES 加密
2. **用户 Key 哈希存储**: 用户 API Key 使用 bcrypt 哈希
3. **JWT 认证**: 所有管理接口需要 JWT 认证
4. **请求限流**: 防止滥用
5. **日志脱敏**: 日志中不记录完整 Key
6. **双 PIN 验证**: 计费中心和支付渠道配置分别需要独立 PIN 密码
7. **PIN 错误锁定**: 10 次错误尝试后锁定 24 小时
8. **支付回调无 auth**: 第三方支付回调路由独立暴露，不经过 JWT 认证
9. **登录 rate-limit**: 每分钟 10 次尝试限制

---

**请确认以上规划，确认后开始开发。**
