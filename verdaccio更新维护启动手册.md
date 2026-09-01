# Verdaccio 更新维护启动手册

## 位置

- 配置：`config/Verdaccio.json`
- 缓存：`verdaccio-storage/`（项目根目录）
- 端口：`3011`

## 启动

```bash
npm run registry:start
```

访问 http://localhost:3011 确认运行正常。

## 停止

```bash
npm run registry:stop
```

## 更新缓存

依赖变更后执行：

```bash
npm run registry:populate
```

只更新单个项目：

```bash
npm run registry:populate-one backend
npm run registry:populate-one frontend-admin
npm run registry:populate-one frontend-admin-ssr
npm run registry:populate-one frontend-user
```

## 离线测试

```bash
npm run registry:test-offline
```

## 使用本地 registry 安装

```bash
npm ci --registry http://localhost:3011
```

强制离线：

```bash
npm ci --offline
```

## 维护说明

- 不要删除 `verdaccio-storage/`，否则缓存丢失。
- 跨平台使用时需重新填充缓存，因为 optional dependency 与平台相关。
- 新增依赖后必须重新 `registry:populate` 才能离线使用。
