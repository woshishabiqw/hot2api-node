#!/usr/bin/env bash
set -euo pipefail

# Populate local Verdaccio registry with all project dependencies.
# Usage: ./scripts/verdaccio-populate.sh [registry_url]

REGISTRY="${1:-http://localhost:3011}"
WORK_DIR=".tmp-verdaccio-populate-v2"
PROJECTS=("" "backend" "frontend-admin" "frontend-admin-ssr" "frontend-user")

echo "Populating Verdaccio registry at $REGISTRY"
echo "Using temp work dir: $WORK_DIR"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

for proj in "${PROJECTS[@]}"; do
  src="${proj:-.}"
  dst="$WORK_DIR/${proj:-root}"

  echo ""
  echo "=== Preparing $src -> $dst ==="
  mkdir -p "$dst"
  cp "$src/package.json" "$dst/"
  cp "$src/package-lock.json" "$dst/"

  echo "=== Installing $src (populating registry) ==="
  (
    cd "$dst"
    # Use an isolated npm cache so npm is forced to fetch every tarball
    # through the local Verdaccio registry, populating its storage.
    export NPM_CONFIG_CACHE=".npm-cache-populate"
    npm ci \
      --registry "$REGISTRY" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --loglevel info
  )
done

echo ""
echo "=== Populate complete ==="
echo "Registry storage size:"
du -sh verdaccio-storage 2>/dev/null || true
