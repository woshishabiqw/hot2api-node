# AI Key Gateway

AI API 中转站 - 统一管理多个 AI 服务的 API Key，自动分发请求，统计 Token 消耗。

## 功能特性

- **双协议支持**: OpenAI + Anthropic + Gemini API 协议
- **自动 Key 分发**: 轮询/随机/权重/故障转移/最少使用策略
- **Token 统计**: 精确记录每次请求的消耗
- **额度控制**: 为用户设置使用上限
- **工作空间**: 多团队隔离，独立余额与配额
- **计费系统**: 套餐订阅 + 在线充值 (支付宝/微信)
- **审计日志**: 完整的操作审计追踪
- **双 PIN 验证**: 计费中心与支付渠道独立密码保护
- **深色模式**: 支持明暗主题切换
- **双站点**: 管理后台 + 用户前台

## 快速启动

### 手动启动
```bash
# 安装依赖
cd backend && npm install
cd ../frontend-admin && npm install
cd ../frontend-user && npm install

# 启动服务
cd backend && npm run dev          # 端口 3000
cd frontend-admin && npm run dev   # 端口 3001
cd frontend-user && npm run dev    # 端口 3002
```

## 访问地址

| 服务 | 地址 |
|-----|------|
| Backend API | http://localhost:3000 |
| Admin Panel | http://localhost:3001 |
| User Portal | http://localhost:3002 |

## 默认账号

> ⚠️ 出于安全考虑，项目不再内置默认密码。首次启动前请在 `backend/.env` 中设置强密码：
>
> ```bash
> DEFAULT_ADMIN_USERNAME=admin
> DEFAULT_ADMIN_PASSWORD=your-strong-password
> INIT_DATABASE_PIN=123456   # 管理后台初始化数据库时使用的6位PIN
> ```
>
> 未设置 `DEFAULT_ADMIN_PASSWORD` 时，系统不会创建默认管理员账号。

- **管理员**: 在 `backend/.env` 中配置的 `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD`
- **计费 PIN**: 首次进入计费中心时由管理员自行设置 6 位数字 PIN
- **支付渠道 PIN**: 首次进入支付渠道配置时由管理员自行设置 6 位数字 PIN

## 安全配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ALLOW_REGISTRATION` | 是否允许用户自主注册。未设置或为空时等同于 `true`；显式设为 `false` 时关闭注册入口 | `true` |

### 信任代理（Trust Proxy）

网关部署在 Nginx 等反向代理后方时，需要正确识别客户端真实 IP，否则登录锁定、IP 黑名单、限速等安全功能会失效。

- 在 `config/server.json` 中设置 `trust_proxy`（布尔值），默认为 `true`。启动时后端会调用 `app.set('trust proxy', ...)`。
- 如果直接暴露后端端口（无反向代理），建议设为 `false`，避免客户端伪造 `X-Forwarded-For`。
- 该配置可通过管理后台「系统设置 → 安全管理」在线修改，修改后需要重启 Node.js 后端生效。

### Nginx 层安全

项目自带 Nginx（`nginx/nginx.exe`）时，启动脚本会生成 `nginx/nginx.conf` 并在 `nginx/.nginx-control.json` 中标记 `controlled: true`。只有在 **可控 Nginx** 状态下，管理后台才会显示以下 Nginx 层安全选项：

- 隐藏 Nginx 版本号（`server_tokens off`）
- 追加 Nginx 安全响应头
- Admin 后台 IP 白名单
- API 速率限制（`limit_req`，需要 Nginx 编译包含 `--with-http_limit_req_module`）

如果项目检测到外部/不可控 Nginx（`controlled: false`），生成脚本不会向 `nginx/nginx.conf` 写入任何安全指令，避免污染外部配置。Nginx 层安全设置同样通过「系统设置 → 安全管理」页面维护，保存后系统自动重载 Nginx。

## 使用流程

1. 启动服务前，配置 `backend/.env` 中的管理员密码等环境变量
2. 访问 Admin Panel (http://localhost:3001)
3. 使用配置好的管理员账号登录
4. 在 Sources 页面添加 AI 服务的 API Key
4. 点击 Test 按钮验证 Key 是否有效
5. 点击 Models 按钮自动获取可用模型列表
6. 用户可以通过 User Portal 创建自己的 API Key
7. 使用网关地址调用 AI API

## API 调用示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_GATEWAY_KEY",
    base_url="http://localhost:3000/v1"
)

response = client.chat.completions.create(
    model="mimo-v2-pro",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### cURL
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2-pro","messages":[{"role":"user","content":"Hello!"}]}'
```

## 项目结构

```
ai-key-gateway/
├── backend/           # Node.js 后端
│   ├── src/
│   │   ├── routes/    # API 路由
│   │   ├── services/  # 业务逻辑
│   │   └── middleware/
│   └── database/      # 数据库相关（已切换到 PostgreSQL）
├── frontend-admin/    # 管理后台 (React)
├── frontend-user/     # 用户前台 (React)
└── start.bat          # 启动脚本
```

## 技术栈

- **后端**: Node.js + Express + PostgreSQL
- **前端**: React + Tailwind CSS + Shadcn UI
- **认证**: JWT
