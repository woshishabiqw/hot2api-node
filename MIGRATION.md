# PostgreSQL 迁移指南

## 已完成

- ✅ Prisma Schema 定义 (`backend/prisma/schema.prisma`)
- ✅ PostgreSQL DB Adapter (`backend/src/config/db/postgres.js`)
- ✅ 项目已切换为仅 PostgreSQL (`backend/src/config/database.js`)
- ✅ 初始迁移 SQL (`backend/prisma/migrations/20240524000000_init/migration.sql`)
- ✅ Docker Compose 编排 (PostgreSQL + Redis + 3 services)

> 注意：SQLite 适配器已移除，项目不再支持 `DATABASE_TYPE=sqlite`。

## 迁移步骤

### 1. 启动 PostgreSQL (Docker)

```bash
docker compose up -d postgres redis
```

### 2. 应用数据库 Schema

```bash
cd backend
# 使用 psql 或任意 PostgreSQL 客户端执行迁移 SQL
psql postgresql://gateway:gateway_password@localhost:5432/gateway -f prisma/migrations/20240524000000_init/migration.sql
```

### 3. 配置环境变量

编辑 `backend/.env`：

```env
DATABASE_URL=postgresql://gateway:gateway_password@localhost:5432/gateway
REDIS_URL=redis://localhost:6379
```

`DATABASE_TYPE` 已不再使用。

### 4. 启动应用

```bash
npm run dev
```

或者使用 Docker Compose 启动全部服务：

```bash
docker compose up -d
```

## 注意事项

- PostgreSQL 模式下，**无需手动保存数据库**（不再需要 `saveDatabase()`）
- 并发计数器在启动时自动重置为 0
- `datetime('now', '-5 minutes')` 等 SQLite 语法已由适配器自动转换为 PostgreSQL 语法
- 布尔字段统一使用 PostgreSQL `BOOLEAN` 类型
