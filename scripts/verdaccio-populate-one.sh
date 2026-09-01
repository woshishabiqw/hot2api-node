#!/usr/bin/env bash
set -euo pipefail

# Populate local Verdaccio registry for a single project.
# Usage: ./scripts/verdaccio-populate-one.sh <project-dir> [registry_url]

PROJ_DIR="${1}"
REGISTRY="${2:-http://localhost:3011}"
WORK_DIR=".tmp-verdaccio-populate-one"

echo "Populating registry for: $PROJ_DIR"
echo "Registry: $REGISTRY"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

src="${PROJ_DIR:-.}"
dst="$WORK_DIR/project"

mkdir -p "$dst"
cp "$src/package.json" "$dst/"
cp "$src/package-lock.json" "$dst/"

# Use an isolated npm cache so npm is forced to fetch every tarball
# through the local Verdaccio registry, populating its storage.
export NPM_CONFIG_CACHE=".npm-cache-populate"

(
  cd "$dst"
  npm ci \
    --registry "$REGISTRY" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --loglevel info
)

echo ""
echo "=== Populate complete for $PROJ_DIR ==="
