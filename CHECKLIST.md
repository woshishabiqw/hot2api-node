# Fuck Gateway 上线前检查清单

## ✅ 已完成的功能

### Phase 1 — 基础设施
- [x] PostgreSQL / SQLite 双后端切换
- [x] Docker Compose 编排
- [x] Redis 连接预备
- [x] Prisma Schema + 迁移脚本

### Phase 2 — 权限与审计
- [x] RBAC（admin / moderator / user）
- [x] 审计日志（全操作覆盖 + 统计面板）
- [x] Admin 面板审计日志页面

### Phase 3 — 多租户与计费
- [x] Workspace 创建与管理
- [x] Workspace 成员邀请/移除
- [x] Billing Plans（免费/专业/企业）
- [x] 充值订单 + Mock 支付
- [x] 支付宝沙箱对接框架
- [x] Workspace 余额扣费

### Phase 4 — 安全加固（本次新增）
- [x] 二级密码（6位PIN）
- [x] 前端 PIN 输入 Gate
- [x] XSS 防护（CSP + 输入清理 + 响应头）
- [x] SQL 注入检测
- [x] CORS 限制
- [x] Rate Limiting（登录/注册/二级密码 5次/分钟）
- [x] Helmet 强化

### Phase 5 — 测试覆盖（本次新增）
- [x] Jest + Supertest 测试框架
- [x] 46 个测试全部通过
- [x] auth / admin / workspace / billing / security 核心路径覆盖

---

## ⚠️ 上线前必须手动完成的配置

### 1. 环境变量（backend/.env）

```env
# 原有配置
PORT=3000
JWT_SECRET=your-super-secret-jwt-key-change-in-production
ENCRYPTION_KEY=your-32-character-encryption-key

# 新增：二级密码（必须独立设置，不要和 JWT_SECRET 相同）
SECOND_AUTH_SECRET=another-32-character-secret-key

# 新增：支付宝沙箱（不填则自动用 mock 支付）
ALIPAY_APPID=your-sandbox-appid
ALIPAY_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
ALIPAY_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
ALIPAY_GATEWAY=https://openapi.alipaydev.com/gateway.do

# 新增：CORS（生产环境填你的域名）
CORS_ORIGINS=http://localhost:3001,http://localhost:3002
```

### 2. 数据库初始化

项目仅支持 PostgreSQL。

```bash
# 1. 启动 PostgreSQL
docker compose up -d postgres

# 2. 应用 Schema
psql $DATABASE_URL -f prisma/migrations/20240524000000_init/migration.sql

# 3. 启动
npm run dev
```

> `DATABASE_TYPE` 与 SQLite 适配器已移除。

### 3. 测试验证

```bash
cd backend
npm test
```

预期输出：
```
Test Suites: 5 passed, 5 total
Tests:       46 passed, 46 total
```

### 4. 支付宝沙箱测试

1. 登录 https://open.alipay.com → 沙箱环境
2. 获取 APPID、应用私钥、支付宝公钥
3. 填入 backend/.env
4. 用沙箱买家账号测试充值
5. 确认余额正确更新

### 5. 二级密码设置

1. 首次登录 admin 账号
2. 系统会强制要求设置 6 位 PIN
3. 设置后重新输入 PIN 才能进入管理界面
4. 忘记 PIN 可由另一个 admin 调用 POST /auth/second-password/reset 重置

---

## 🔒 安全检查项

| 检查项 | 方法 | 预期结果 |
|--------|------|----------|
| 未授权访问 Admin | curl /admin/sources 不带 token | 401 |
| 越权访问 | user 角色访问 /admin/users | 403 |
| XSS 注入 | 注册用户名 `<script>alert(1)</script>` | 被转义，不执行 |
| SQL 注入 | 登录密码 `' OR 1=1 --` | 401，不崩溃 |
| 二级密码 | 登录后不输入 PIN 直接访问 /admin/sources | 403 |
| Rate Limit | 连续错误登录 6 次 | 第 6 次 429 |
| 支付幂等 | 同一订单回调 3 次 | 余额只加一次 |

---

## 🚀 上线启动命令

```bash
# 开发模式
npm run dev

# 生产模式（Docker）
docker compose up -d

# 运行测试
npm test
```

---

## 📋 已知限制（后续可优化）

1. **微信支付** — 只预留了接口，未对接真实 SDK
2. **K8s 编排** — Docker Compose 可用，K8s Helm Chart 未做
3. **Prometheus 监控** — 无 Metrics 暴露端点
4. **admin.js 测试覆盖率低**（16%）— 文件 1000+ 行，建议拆分为多个路由文件后补测试
5. **重置二级密码前端按钮** — 后端接口已就绪，Admin 面板的用户管理页暂未加重置按钮
