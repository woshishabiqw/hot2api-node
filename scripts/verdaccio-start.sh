#!/usr/bin/env bash
set -euo pipefail

# Start the local Verdaccio registry using config/Verdaccio.json on port 3011.
# This command blocks the terminal so you can see logs. Use Ctrl+C to stop.

cd "$(dirname "$0")/.."

echo "Starting Verdaccio on http://localhost:3011 ..."
echo "Config: $(pwd)/config/Verdaccio.json"
echo "Storage: $(pwd)/verdaccio-storage"
echo ""

verdaccio --config config/Verdaccio.json --listen 3011
