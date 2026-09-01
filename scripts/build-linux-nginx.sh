#!/usr/bin/env bash
# Build a static nginx binary for Linux x86_64.
# Run this on the target Linux server (or a compatible build container).
# Output: nginx/linux/bin/nginx-static

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${PROJECT_ROOT}/nginx/linux/bin"
OUTPUT_BIN="${OUTPUT_DIR}/nginx-static"
BUILD_DIR="$(mktemp -d)"
NGINX_VERSION="1.30.3"
NGINX_URL="https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz"

cleanup() {
  rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

if [[ "$OSTYPE" != "linux-gnu"* ]]; then
  echo "[build-linux-nginx] This script must run on Linux. Current: ${OSTYPE}"
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

echo "[build-linux-nginx] Installing build dependencies..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y build-essential libpcre2-dev zlib1g-dev libssl-dev wget tar
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y gcc make pcre2-devel zlib-devel openssl-devel wget tar
elif command -v apk >/dev/null 2>&1; then
  sudo apk add --no-cache build-base pcre2-dev zlib-dev openssl-dev wget tar
else
  echo "[build-linux-nginx] Unsupported package manager. Please install: gcc, make, pcre2-dev, zlib-dev, openssl-dev"
  exit 1
fi

cd "${BUILD_DIR}"

echo "[build-linux-nginx] Downloading nginx ${NGINX_VERSION} source..."
wget -q "${NGINX_URL}"
tar -xzf "nginx-${NGINX_VERSION}.tar.gz"
cd "nginx-${NGINX_VERSION}"

echo "[build-linux-nginx] Configuring static build..."
./configure \
  --prefix="${BUILD_DIR}/install" \
  --with-cc-opt="-static -O2" \
  --with-ld-opt="-static" \
  --with-pcre \
  --with-http_ssl_module \
  --with-http_v2_module \
  --with-http_gzip_static_module \
  --without-http_rewrite_module \
  --without-http_geo_module \
  --without-http_fastcgi_module \
  --without-http_uwsgi_module \
  --without-http_scgi_module \
  --without-http_memcached_module \
  --without-http_limit_req_module \
  --without-http_empty_gif_module \
  --without-http_browser_module

echo "[build-linux-nginx] Building..."
make -j"$(nproc)"
make install

cp "${BUILD_DIR}/install/sbin/nginx" "${OUTPUT_BIN}"

echo "[build-linux-nginx] Built static binary: ${OUTPUT_BIN}"
echo "[build-linux-nginx] Version: $(${OUTPUT_BIN} -v 2>&1)"
