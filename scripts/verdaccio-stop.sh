#!/usr/bin/env bash
set -euo pipefail

# Stop the local Verdaccio registry listening on port 3011.

PID=$(netstat -ano 2>/dev/null | grep ':3011' | grep LISTENING | awk '{print $5}' | head -n1)

if [ -z "$PID" ]; then
  echo "No Verdaccio process found on port 3011"
  exit 0
fi

echo "Stopping Verdaccio process $PID on port 3011 ..."
cmd //c "taskkill /PID $PID /F" >/dev/null 2>&1 || true

echo "Stopped."
