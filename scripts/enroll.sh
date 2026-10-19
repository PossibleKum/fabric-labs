#!/usr/bin/env bash
# Step 2: install API dependencies and create wallet users
set -euo pipefail
source "$(dirname "$0")/env.sh"
for p in supplychain-fabric healthcare-fabric; do
  (cd "$ROOT/$p/api" && npm install --no-audit --no-fund && node enrollUsers.js)
done
