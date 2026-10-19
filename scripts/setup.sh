#!/usr/bin/env bash
# Step 1: install Fabric, start the network, deploy both chaincodes (takes several minutes)
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$HOME"
if [ ! -d fabric-samples ]; then
  curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
  chmod +x install-fabric.sh
  ./install-fabric.sh docker samples binary
fi

cd "$FABRIC_TN"
./network.sh down
./network.sh up createChannel -c healthchannel -ca

./network.sh deployCC -c healthchannel -ccn supplychain \
  -ccp "$ROOT/supplychain-fabric/chaincode" -ccl javascript

./network.sh deployCC -c healthchannel -ccn healthcare \
  -ccp "$ROOT/healthcare-fabric/chaincode" -ccl javascript \
  -cccg "$ROOT/healthcare-fabric/collections_config.json"

echo "Network and both chaincodes are ready."
