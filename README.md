# Hyperledger Fabric Labs – Exp 8 (Supply Chain) and Exp 9 (Healthcare)

- `supplychain-fabric/` – Exp 8: supply chain tracking (see its README)
- `healthcare-fabric/` – Exp 9: healthcare data management with privacy and compliance (see its README)

## Run in GitHub Codespaces

1. Push this repo to GitHub (keep it **private**).
2. On the repo page: **Code → Codespaces → Create codespace on main**. Wait for the editor to open (first start takes a few minutes).
3. In the terminal:
   ```bash
   bash scripts/all.sh
   ```
   This installs Fabric, starts the network, deploys both chaincodes, creates users, and starts both APIs (about 10 minutes the first time).
4. Run a demo and take screenshots of the output:
   ```bash
   bash scripts/demo-supplychain.sh
   bash scripts/demo-healthcare.sh
   ```
5. When finished, stop the codespace (Codespaces menu → Stop) so it does not use your free hours.

Step by step instead of `all.sh`: `scripts/setup.sh`, then `scripts/enroll.sh`, then `scripts/start-apis.sh`.

Logs: `supplychain-fabric.log` and `healthcare-fabric.log` in the repo root. To reset everything: `cd ~/fabric-samples/test-network && ./network.sh down`, then run `scripts/all.sh` again.
