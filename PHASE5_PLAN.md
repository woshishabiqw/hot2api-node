# Phase 5 规划 — 体验优化 + 工程化加固

## 背景

Phase 4（PostgreSQL 迁移 + 计费系统 + 审计日志 + 安全加固）已全部完成。Phase 5 聚焦用户体验和工程化完善。

---

## 任务清单

### P0 — 核心体验（防止崩溃 + 加载体验）

#### 1. 前端 Error Boundary
- **目标**：单个组件崩溃不导致整页白屏
- **文件**：`frontend-admin/src/components/ErrorBoundary.jsx`、`frontend-user/src/components/ErrorBoundary.jsx`
- **实现**：React Class Component `componentDidCatch`，显示友好的错误回退 UI + 刷新按钮
- **挂载**：包裹 `App.jsx` 的 `<Routes>` 层级

#### 2. 加载状态优化（骨架屏）
- **目标**：替换全页 "Loading..." 文字，减少用户感知等待时间
- **范围**：Dashboard、Users、Sources、ModelsAdmin、ModelGroups、Workspaces、Billing、PaymentManager、AuditLogs
- **实现**：基于 Shadcn UI Skeleton 组件的页面级骨架屏

#### 3. Chunk 代码分割
- **目标**：解决构建警告 `Some chunks are larger than 500 kB`
- **实现**：`vite.config.js` 中配置 `build.rollupOptions.output.manualChunks`
  - `vendor`: React + ReactDOM + ReactRouter
  - `ui`: Tailwind + Radix + Lucide
  - `charts`: Recharts
  - `utils`: 其他第三方库
- **预期效果**：主包从 ~800KB 降至 ~300KB

---

### P1 — 深色模式 + 响应式

#### 4. 深色模式完善
- **当前状态**：已有 `useTheme` Hook，支持 system/light/dark，localStorage 持久化
- **缺失**：
  - User 端没有 ThemeProvider（仅 Admin 端有）
  - 部分组件可能没有完整 dark: 类名覆盖
  - 需要检查 Charts（Recharts）在深色模式下的坐标轴/网格颜色
- **实现**：
  - 为 `frontend-user` 添加 `useTheme` Hook 和 ThemeProvider
  - 在 Layout 中添加主题切换按钮
  - 修复 Recharts 深色模式配色

#### 5. 响应式布局
- **目标**：管理后台在 768px 以下屏幕可用
- **范围**：
  - 侧边栏：变为底部 Tab Bar 或汉堡菜单
  - 数据表格：横向滚动 + 卡片式布局切换
  - 表单：单列布局
  - Dashboard 图表：堆叠而非并排
- **优先级页面**：Dashboard、Users、Sources、Settings

---

### P2 — 后端健壮性 + 监控

#### 6. 后端健康检查端点
- **目标**：部署监控和负载均衡器需要 /health 端点
- **实现**：
  - `GET /health` → 检查 PostgreSQL 连接 + 返回 `{ status: 'ok', db: 'connected', timestamp }`
  - `GET /health/ready` → 数据库 + Redis（如果启用）
  - `GET /health/live` → 进程存活

#### 7. 日志轮转
- **目标**：防止 `server.log` 无限增长
- **实现**：使用 `rotating-file-stream` 或 Winston，按天/按大小切割日志
- **配置**：保留最近 7 天日志，单文件最大 10MB

#### 8. 数据库连接池监控
- **目标**：暴露连接池状态，便于排查慢查询和连接泄漏
- **实现**：在 `/health` 或新增 `/admin/metrics` 返回连接池统计

---

### P3 — 工程化

#### 9. API 文档自动生成
- **目标**：减少手动维护 API 文档
- **实现**：使用 Swagger/OpenAPI，通过 `swagger-jsdoc` + `swagger-ui-express` 自动生成文档
- **挂载**：`/api-docs` 路径

#### 10. 前端构建产物分析
- **目标**：了解每个 chunk 的组成，持续优化
- **实现**：`rollup-plugin-visualizer` 生成构建分析报告

---

## 实施顺序建议

```
Week 1:
  Day 1-2: P0.1 Error Boundary + P0.2 骨架屏
  Day 3:   P0.3 Chunk 分割
  Day 4-5: P1.4 深色模式完善（user端 + Recharts配色）

Week 2:
  Day 1-3: P1.5 响应式布局（核心页面）
  Day 4:   P2.6 /health 端点
  Day 5:   P2.7 日志轮转
```

## 验收标准

- [ ] 单个组件 throw Error 时页面不白屏
- [ ] Dashboard 加载时有骨架屏而非空白
- [ ] 构建后主包 < 400KB
- [ ] User 端支持深色模式切换
- [ ] Admin 后台在 iPad 宽度下可用
- [ ] `GET /health` 返回 200
- [ ] `server.log` 按天切割

---

**确认后开始实施。**
