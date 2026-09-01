# Linux 版 Nginx

本目录提供了两种 Linux 使用方式：

## 推荐：一键启动脚本

项目已提供跨平台启动脚本 `nginx/start.js`，自动完成：

1. 从 `config/server.json` 生成 `nginx.conf`
2. 检查后端服务是否已启动
3. 选择正确的 nginx 二进制（Windows 用 `nginx.exe`，Linux 用 `linux/bin/nginx`）
4. 启动或重载 nginx

### 在 Linux 上启动

```bash
cd nginx
chmod +x start linux/bin/nginx
./start
```

### 参数

```bash
./start --test    # 只生成并测试配置
./start --reload  # 重载配置
./start --stop    # 停止 nginx
```

## 预置二进制（Alpine/musl）

文件：`linux/bin/nginx`

- 版本：nginx 1.30.2（Alpine Linux 官方包提取）
- 架构：x86_64
- 动态链接 musl libc，依赖 `/lib/ld-musl-x86_64.so.1`

适合在 Alpine Linux 或已安装 musl 的系统上直接使用。

## 系统包管理器安装（生产环境推荐）

在目标 Linux 服务器上安装官方 nginx，然后把本项目的配置复制过去：

```bash
# Ubuntu/Debian
sudo apt install nginx

# 然后使用项目生成的配置
cd /path/to/project
npm run nginx:generate
sudo cp nginx/nginx.conf /etc/nginx/conf.d/ai-gateway.conf
sudo nginx -s reload
```

## 静态编译独立二进制

如果需要一个不依赖系统库的独立 `nginx` 二进制，可以在 Linux 服务器上运行：

```bash
cd scripts
./build-linux-nginx.sh
```

脚本会把静态编译结果输出到 `nginx/linux/bin/nginx-static`，可在大多数 x86_64 Linux 上直接运行。
