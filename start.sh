#!/bin/bash
# Fuck Gateway - Local Production Start Script
# No GitHub required. All local.

set -e

echo "=========================================="
echo "  Fuck Gateway - 本地部署启动"
echo "=========================================="

# 1. Check .env
echo ""
echo "[1/5] 检查环境变量..."
if [ ! -f "backend/.env" ]; then
  echo "⚠️  backend/.env 不存在，从 .env.example 复制"
  cp backend/.env.example backend/.env
  echo "    请编辑 backend/.env 填入你的密钥"
fi

# 2. Install dependencies
echo ""
echo "[2/5] 检查依赖..."
if [ ! -d "backend/node_modules" ]; then
  echo "    安装后端依赖..."
  cd backend && npm install && cd ..
fi
if [ ! -d "frontend-admin/node_modules" ]; then
  echo "    安装前端依赖..."
  cd frontend-admin && npm install && cd ..
fi
if [ ! -d "frontend-user/node_modules" ]; then
  echo "    安装用户端依赖..."
  cd frontend-user && npm install && cd ..
fi

# 3. Run tests
echo ""
echo "[3/5] 运行测试..."
cd backend
npm test 2>&1 | tail -5
cd ..

# 4. Build frontends for production
echo ""
echo "[4/5] 构建前端..."
echo "    Admin..."
cd frontend-admin && npm run build && cd ..
echo "    User..."
cd frontend-user && npm run build && cd ..

# 5. Start backend in production mode
echo ""
echo "[5/5] 启动后端服务..."
echo ""
echo "=========================================="
echo "  🚀 服务已启动"
echo "=========================================="
echo "  API:     http://localhost:3000"
echo "  Admin:   http://localhost:3000/admin/ (或 dist 目录直接打开)"
echo "  User:    http://localhost:3000/user/"
echo "=========================================="
echo ""
echo "按 Ctrl+C 停止"
echo ""

cd backend
NODE_ENV=production npm start
