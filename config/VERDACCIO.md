# 本地 npm Registry（Verdaccio）

本项目已配置本地 Verdaccio registry，用于在无外网环境下安装 npm 依赖。

## 文件说明

| 文件 | 说明 |
|---|---|
| `config/Verdaccio.json` | 主配置，端口 `3011`，代理上游 `https://registry.npmjs.org/` |
| `config/Verdaccio.offline.json` | 离线测试配置，无上游代理，仅使用本地缓存 |
| `verdaccio-storage/` | 本地缓存的 npm 包 tarball（位于项目根目录，已填充本项目全部依赖） |

## 快速使用

### 1. 启动 Registry

```bash
npm run registry:start
```

Registry 将运行在 http://localhost:3011。

### 2. 使用本地 Registry 安装依赖

```bash
npm ci
```

如需强制离线：

```bash
npm ci --offline
```

### 3. 停止 Registry

```bash
npm run registry:stop
```

## 重新填充 Registry

```bash
npm run registry:populate
npm run registry:populate-one backend
```

## 离线测试

```bash
npm run registry:test-offline
```

## 强制使用 Verdaccio

项目已通过以下机制避免直接命中 npm 官方 registry：

1. **根目录 `.npmrc`**：默认 `registry=http://localhost:3011/`，因此执行：
   ```bash
   npm install <module>
   ```
   会自动走本地 Verdaccio，无需手动指定 `--registry`。

2. **`preinstall` 钩子**：在每个 `package.json` 中添加了 `preinstall` 脚本。当执行项目级安装（如 `npm install`、`npm ci`）且显式使用非 Verdaccio registry 时，会直接退出并报错：
   ```
   [ERROR] 直接通过 npm 官方 registry 安装模块已被禁用。
   请使用本地 Verdaccio registry ...
   ```

> **注意**：npm 在 `npm install <module>` 时不会触发当前项目的 `preinstall` 生命周期钩子。因此，若显式绕过 `.npmrc`（例如 `npm install <module> --registry https://registry.npmjs.org/`），npm 仍可能直接访问官方 registry。请确保团队使用项目提供的 `.npmrc`，不要覆盖 registry。

## 离线状态

- Prisma engine 已随 npm 包内置，`prisma generate` 离线可执行。
- frontend-admin-ssr 的 Google Fonts 已替换为本地 `geist` 包，构建时不再请求 fonts.gstatic.com。
- frontend-admin-ssr 的 TypeScript 错误已修复，`next build` 可离线通过。
- 当前缓存基于 Windows x64 平台。其他平台需重新运行 `registry:populate` 以缓存对应平台的 optional dependency。
