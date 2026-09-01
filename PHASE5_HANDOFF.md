# Phase 5 交接文档 — 剩余任务

> 生成时间：2026-05-25
> 前置 Phase 1~4 已全部完成，Phase 5 部分完成。
> 本文档供新 Agent 接手剩余任务使用。

---

## 一、Phase 5 已完成工作（不要再重复做）

| 任务 | 状态 | 关键文件 | 说明 |
|------|------|----------|------|
| P0.1 Error Boundary | ✅ | `frontend-admin/src/components/ErrorBoundary.jsx`<br>`frontend-user/src/components/ErrorBoundary.jsx` | 包裹 Routes，白屏时显示友好回退 UI |
| P0.3 Chunk 代码分割 | ✅ | `frontend-admin/vite.config.js`<br>`frontend-user/vite.config.js` | vendor/ui/charts 拆包，主包从 819KB→227KB |
| P1.4 深色模式 | ✅ | `frontend-user/src/hooks/useTheme.jsx`<br>`frontend-user/src/components/Layout.jsx` | user 端已有 ThemeProvider + 切换按钮，和 admin 端一致 |
| P2.6 /health 端点 | ✅ | `backend/src/index.js` | `/health`、`/health/ready`、`/health/live` |
| P2.7 日志轮转 | ✅ | `backend/src/index.js` | morgan 日志写入 `backend/logs/access.log`，按天轮转，保留 7 天 |
| P2.8 连接池监控 | ✅ | `backend/src/routes/admin.js` | `GET /admin/metrics/db` 返回连接池统计 |
| P3.10 构建分析 | ✅ | `frontend-admin/vite.config.js`<br>`frontend-user/vite.config.js` | `rollup-plugin-visualizer` 生成 `dist/stats.html` |

---

## 二、Phase 5 剩余任务（需继续完成）

### 任务 A：P0.2 骨架屏（优先级：高）

**目标**：替换全页 "Loading..." 文字，数据加载时用骨架占位减少用户感知等待时间。

**范围**：优先做核心管理页面
- `frontend-admin/src/pages/Dashboard.jsx`
- `frontend-admin/src/pages/Users.jsx`
- `frontend-admin/src/pages/Sources.jsx`
- `frontend-admin/src/pages/ModelsAdmin.jsx`

**参考实现**：
```jsx
// 创建 frontend-admin/src/components/SkeletonDashboard.jsx
// 使用 Tailwind animate-pulse + bg-muted 做占位
// 包含：统计卡片(4个) + 图表区 + 表格区(5行)

// Dashboard.jsx 中修改：
if (loading || !stats) return <SkeletonDashboard />;
```

**注意**：
- 不要修改数据加载逻辑
- 使用 Tailwind 类：`animate-pulse bg-muted rounded h-4`
- 保持原有页面布局结构（骨架屏应该和真实内容区域形状一致）

---

### 任务 B：P1.5 响应式布局（优先级：中）

**目标**：管理后台在平板/手机宽度（<768px）下可用。

**当前问题**：
- 侧边栏在移动端占满屏幕，没有汉堡菜单
- 数据表格超出视口，没有横向滚动
- Dashboard 图表并排显示，小屏幕被挤压

**修改范围**：
1. `frontend-admin/src/components/Layout.jsx`
   - 侧边栏：已有关闭按钮，但内容区域没有适配小屏幕的 padding
   - 添加 `lg:` 前缀控制侧边栏显示/隐藏
2. `frontend-admin/src/pages/Dashboard.jsx`
   - 图表区域：`grid-cols-2` → `grid-cols-1 md:grid-cols-2`
3. `frontend-admin/src/pages/Users.jsx`
   - 表格容器添加 `overflow-x-auto`
   - 操作按钮在小屏幕下改为图标按钮
4. `frontend-admin/src/pages/Sources.jsx`
   - 同上，表格加横向滚动

**注意**：
- Tailwind 断点：`sm:640px md:768px lg:1024px xl:1280px`
- 优先保证可读性，移动端以查看为主，复杂操作引导到桌面端

---

### 任务 C：P3.9 Swagger API 文档（优先级：中）

**目标**：在 `/api-docs` 提供交互式 API 文档。

**已完成**：
- `backend/node_modules` 中已安装 `swagger-jsdoc` 和 `swagger-ui-express`

**待完成**：
1. 在 `backend/src/index.js` 中导入并挂载 Swagger：
   ```js
   const swaggerUi = require('swagger-ui-express');
   const swaggerJsdoc = require('swagger-jsdoc');
   
   const swaggerOptions = {
     definition: {
       openapi: '3.0.0',
       info: { title: 'Fuck Gateway API', version: '1.0.0' },
     },
     apis: ['./src/routes/*.js'],
   };
   const swaggerSpec = swaggerJsdoc(swaggerOptions);
   apiApp.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
   ```
2. 在关键路由文件（`user.js`、`admin.js`、`billing.js`）中添加 JSDoc 注释，描述接口参数和响应

**注意**：
- Swagger UI 不需要 auth
- 挂载在 `apiApp.use(sanitizeInput)` 之前，避免请求体被修改

---

## 三、项目关键上下文（新 Agent 必看）

### 3.1 目录结构
```
E:/Desktop/测试Traa/
├── backend/           # Node.js + Express, 端口 3000
│   ├── src/
│   │   ├── index.js              # 服务入口
│   │   ├── config/
│   │   │   ├── db/postgres.js    # PG 适配器 + convertSql
│   │   │   └── settings.js       # JWT 密钥等
│   │   ├── middleware/
│   │   │   ├── auth.js           # JWT auth + adminMiddleware
│   │   │   ├── second-auth.js    # PIN 验证
│   │   │   └── rate-limit.js
│   │   ├── routes/
│   │   │   ├── admin.js          # /admin/* 路由
│   │   │   ├── user.js           # /auth/* + /user/* 路由
│   │   │   ├── billing.js        # /billing/* 路由
│   │   │   └── payment-gateway.js
│   │   └── services/
│   │       ├── audit.js          # 审计日志服务
│   │       └── dispatcher.js     # Key 分发引擎
│   ├── config/sql.json           # RSA 加密的数据库连接串
│   └── logs/                     # 日志目录（按天轮转）
├── frontend-admin/    # React + Vite, 端口 3001
│   ├── src/
│   │   ├── App.jsx
│   │   ├── hooks/useAuth.jsx
│   │   ├── hooks/useTheme.jsx
│   │   ├── components/
│   │   │   ├── Layout.jsx
│   │   │   ├── ErrorBoundary.jsx   # ✅ 已创建
│   │   │   └── Card.jsx
│   │   └── pages/                # 各管理页面
│   └── vite.config.js            # ✅ 已配置 chunk 分割
├── frontend-user/     # React + Vite, 端口 3002
│   ├── src/
│   │   ├── App.jsx
│   │   ├── hooks/useAuth.jsx
│   │   ├── hooks/useTheme.jsx    # ✅ 已存在
│   │   ├── components/
│   │   │   ├── Layout.jsx        # ✅ 已有主题切换按钮
│   │   │   └── ErrorBoundary.jsx # ✅ 已创建
│   │   └── pages/
│   └── vite.config.js            # ✅ 已配置 chunk 分割
└── package.json         # 根目录 concurrently 启动
```

### 3.2 数据库
- **主数据库**：PostgreSQL（生产环境）
- **适配器**：`backend/src/config/db/postgres.js`
- **关键特性**：`convertSql()` 自动转换 SQLite 语法 → PostgreSQL 语法
  - `?` → `$1, $2...`
  - `datetime('now')` → `NOW()`
  - `datetime('now', '-X hours')` → `NOW() - INTERVAL 'X hours'`
  - `date('now')` → `CURRENT_DATE`
  - `date(column)` → `column::date`
  - `strftime(...)` → `TO_CHAR(...)`
  - `INSERT OR REPLACE` → `ON CONFLICT DO UPDATE`
- **表**：users, sources, models, user_keys, request_logs, audit_logs, workspaces, workspace_members, billing_plans, billing_records, payment_orders, user_pins, settings

### 3.3 认证体系
| 层级 | 机制 | 说明 |
|------|------|------|
| 一级 | JWT Token | `Authorization: Bearer <token>`，由 `/auth/login` 发放 |
| 二级 | PIN 密码 | 计费中心 `X-Second-Auth-Token`，支付渠道 `X-Payment-Auth-Token` |
| 锁定 | 10次错误→24h | PIN 连续错误 10 次后锁定 |
| 默认 PIN | 123456 | 首次进入计费中心/支付渠道需验证 |

### 3.4 关键中间件挂载顺序（index.js）
```
apiApp.get('/')                    # 根路由
apiApp.get('/health')              # 健康检查（无 auth）
apiApp.use('/v1', apiKey, rateLimit, openaiRoutes)
apiApp.use('/v1beta', apiKey, rateLimit, geminiRoutes)
apiApp.use(sanitizeInput)          # 输入消毒
apiApp.use(sqlInjectionGuard)      # SQL 注入防护
apiApp.use('/admin', auth, adminMiddleware, adminRoutes)
apiApp.use('/auth/login', rateLimit)   # 登录限流
apiApp.use('/auth/register', rateLimit)
apiApp.use('/auth', userRoutes)    # /auth/* 和 /user/* 共用 router
apiApp.use('/user', userRoutes)
apiApp.use('/billing', callbackRouter)  # 公开回调（无 auth）
apiApp.use('/billing', auth, secondAuth, billingRouter)
apiApp.use('/payment-gateway', auth, paymentAuth, paymentGatewayRoutes)
```

### 3.5 构建命令
```bash
# 根目录启动全部
npm run start

# 单独启动
npm run start:backend   # 3000
npm run start:admin     # 3001 (vite preview)
npm run start:user      # 3002 (vite preview)

# 构建
npm run build           # 构建两个前端
```

---

## 四、已知问题 & 注意事项

1. **Recharts 深色模式**：Dashboard 中已用 `getThemeColors()` 根据 `document.documentElement.classList.contains('dark')` 动态取色，但需确认所有图表都正确响应。
2. **前端 API URL**：前端页面中使用 `/api` 作为基础路径（通过 Vite proxy），不是 `http://localhost:3000`。
3. **支付回调路由**：`/billing/notify`、`/billing/pay-callback`、`/billing/pay-mock` 是无 auth 的公开路由，第三方支付平台会调用。不要给它们加认证。
4. **PG SQL 转换**：所有通过 `db.run`/`db.get`/`db.all`/`db.query` 执行的 SQL 都会自动经过 `convertSql()`。但如果 SQL 是运行时字符串拼接（如 `... WHERE created_at > ${timeFilter}`），要确保拼接后的字符串包含可被转换的 SQLite 语法。
5. **user_pins 表**：PIN 密码存储在此表中，但 `second-auth.js` 中有 fallback 逻辑：如果 `user_pins` 没有记录，会回退到 `users.second_password_hash`。

---

## 五、验收标准（Phase 5 全部完成后）

- [ ] Dashboard 加载时显示骨架屏而非空白
- [ ] Admin 后台在 iPad 宽度（768px）下可用
- [ ] `/api-docs` 可访问并显示 API 文档
- [ ] 构建通过，无报错
- [ ] Error Boundary 捕获错误时不白屏
- [ ] 主包 < 400KB（已完成）
- [ ] `/health` 返回 200（已完成）
- [ ] 日志按天轮转（已完成）
