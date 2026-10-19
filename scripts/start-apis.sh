#!/usr/bin/env bash
# Step 3: start both REST APIs in the background (3001 = Exp 8, 3000 = Exp 9)
set -euo pipefail
source "$(dirname "$0")/env.sh"
pkill -f "node server.js" 2>/dev/null || true
for p in supplychain-fabric healthcare-fabric; do
  (cd "$ROOT/$p/api" && nohup node server.js > "$ROOT/$p.log" 2>&1 &)
done
sleep 3
curl -s localhost:3001/health; echo
curl -s localhost:3000/health; echo
