#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY="http://localhost:3011"
OFFLINE_CONFIG="config/Verdaccio.offline.json"
NORMAL_CONFIG="config/Verdaccio.json"
TEST_DIR=".tmp-offline-test"

stop_registry() {
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ':3011' | grep LISTENING | awk '{print $5}' | head -n1 || true)
  if [ -n "$pid" ]; then
    echo "Stopping registry process $pid ..."
    cmd //c "taskkill /PID $pid /F" >/dev/null 2>&1 || true
    sleep 2
  fi
}

start_registry() {
  local config="$1"
  echo "Starting Verdaccio with $config ..."
  # Start in background so this script continues
  nohup verdaccio --config "$config" --listen 3011 > logs/verdaccio-test.log 2>&1 &
  sleep 5
  if ! curl -s "$REGISTRY/-/ping" >/dev/null; then
    echo "ERROR: Verdaccio did not start"
    exit 1
  fi
  echo "Registry is up."
}

test_project() {
  local proj="$1"
  local src="${proj:-.}"
  local dst="$TEST_DIR/${proj:-root}"
  echo ""
  echo "=== Testing offline install for $src ==="
  rm -rf "$dst"
  mkdir -p "$dst"
  cp "$src/package.json" "$dst/"
  cp "$src/package-lock.json" "$dst/"
  (
    cd "$dst"
    npm ci --registry "$REGISTRY" --offline --ignore-scripts --no-audit --no-fund
  )
  echo "OK: $src installed offline"
}

echo "=== Verdaccio offline test ==="

stop_registry
start_registry "$OFFLINE_CONFIG"

rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

test_project ""
test_project "backend"
test_project "frontend-admin"
test_project "frontend-admin-ssr"
test_project "frontend-user"

echo ""
echo "=== All offline tests passed ==="

stop_registry
echo "Restarting normal registry ..."
start_registry "$NORMAL_CONFIG"

echo ""
echo "Offline test complete. Normal registry is running on $REGISTRY"
