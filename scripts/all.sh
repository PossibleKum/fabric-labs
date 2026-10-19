#!/usr/bin/env bash
# Runs steps 1-3
set -euo pipefail
D="$(dirname "$0")"
bash "$D/setup.sh" && bash "$D/enroll.sh" && bash "$D/start-apis.sh"
