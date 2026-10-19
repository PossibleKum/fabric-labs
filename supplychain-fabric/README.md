# Exp 8 – Supply Chain Tracking System using Hyperledger Fabric and Node.js

**Platform:** Hyperledger Fabric 2.5 · **Chaincode & API:** Node.js

---

## 1. Aim

To develop a supply chain tracking system on Hyperledger Fabric where a product's journey from manufacturer to distributor, retailer and customer is recorded on an immutable, shared ledger, with a Node.js chaincode (smart contract) and a REST API.

## 2. Objectives

1. Register products on the ledger with batch and origin details.
2. Track every hand-over (ship, receive) and checkpoint with actor, location and time.
3. Enforce who is allowed to do what, using roles in X.509 certificates.
4. Provide full provenance by reading the ledger history of each product.
5. Expose the system through a REST API built with Node.js.

## 3. Why Blockchain for Supply Chains

| Problem in traditional supply chains | How Fabric helps |
|---|---|
| Each party keeps its own database, so records disagree | One shared ledger agreed by all organisations |
| Records can be edited after the fact | Ledger is append-only and every change is signed |
| Counterfeit or grey-market goods | Verifiable origin and chain of custody |
| Disputes about who held the goods | Time-stamped, signed events per actor |
| Competitors must collaborate | Permissioned network with identity (MSP) |

## 4. Architecture

```
  Manufacturer (Org1)         Distributor / Retailer (Org2)
         │                              │
         └──────────  Node.js REST API (Express + fabric-network)  ──────────┐
                                                                             │ gRPC
        ┌────────────────── Fabric channel: healthchannel ───────────────────┘
        │   Peer (Org1)      Peer (Org2)      Orderer (Raft)
        │        └── chaincode "supplychain" (Node.js) ──┘
        │            World state: product assets    Ledger: full history
        └──────────────────────────────────────────────────────────────────
```

### Roles (certificate attribute `role`)

| Role | Can do |
|---|---|
| `manufacturer` | Create product, ship, add checkpoint |
| `distributor` | Receive, ship onward, add checkpoint |
| `retailer` | Receive, add checkpoint, sell |

### Product state machine

```
MANUFACTURED ──ship──► IN_TRANSIT ──receive──► RECEIVED ──sell──► SOLD
                           ▲                       │
                           └────────── ship ───────┘
```

Rules enforced on chain:
- Only the **current owner** can ship or sell.
- Only the **named recipient** can receive, and ownership changes only at that moment.
- A sold product cannot be changed.
- Roles are checked on every transaction.

## 5. Project Structure

```
supplychain-fabric/
├── chaincode/
│   ├── package.json
│   ├── index.js
│   └── lib/supplychain.js
├── api/
│   ├── package.json
│   ├── server.js
│   └── enrollUsers.js
└── README.md
```

## 6. Chaincode Functions

| Function | Role | Description |
|---|---|---|
| `createProduct(id, name, batchNo, origin)` | manufacturer | Register a product, status `MANUFACTURED` |
| `shipProduct(id, toUserId, carrier, location)` | owner | Status becomes `IN_TRANSIT`, recipient recorded |
| `receiveProduct(id, location)` | named recipient | Ownership transfers, status `RECEIVED` |
| `addTrackingEvent(id, location, note)` | owner / recipient | Log a checkpoint |
| `sellProduct(id, customerRef)` | retailer (owner) | Status `SOLD` |
| `getProduct(id)` | any | Current state with all events |
| `getProductHistory(id)` | any | Every ledger version (provenance) |
| `getAllProducts()` / `getProductsByStatus(s)` / `getProductsByOwner(o)` | any | Queries |

## 6.1 REST API

| Method and path | Purpose |
|---|---|
| `POST /products` | Create product |
| `POST /products/:id/ship` | Ship |
| `POST /products/:id/receive` | Receive |
| `POST /products/:id/track` | Checkpoint |
| `POST /products/:id/sell` | Sell |
| `GET /products` (`?status=` or `?owner=`) | List |
| `GET /products/:id` | One product |
| `GET /products/:id/history` | Ledger history |

Every request needs an `x-user` header naming a wallet identity: `mfg1`, `dist1` or `retail1`.

## 7. Setup and Execution

**Requirements:** Linux, macOS, or Windows with WSL2 (run everything inside the Ubuntu terminal). Docker, Docker Compose, Node 18+.

### 7.1 Install Fabric samples and binaries

```bash
cd ~
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh docker samples binary
```

### 7.2 Start the network (with certificate authorities)

```bash
cd ~/fabric-samples/test-network
./network.sh down
./network.sh up createChannel -c healthchannel -ca
```

### 7.3 Deploy the chaincode

```bash
./network.sh deployCC -c healthchannel -ccn supplychain \
  -ccp ~/supplychain-fabric/chaincode -ccl javascript
```

### 7.4 Create users and start the API

```bash
cd ~/supplychain-fabric/api
npm install
export CCP_ORG1=~/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/connection-org1.json
export CCP_ORG2=~/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/connection-org2.json
node enrollUsers.js      # creates mfg1 (Org1), dist1 and retail1 (Org2)
node server.js           # listens on port 3001
```

(Exp 9 uses port 3000 and chaincode name `healthcare`, so both experiments can run on the same network.)

## 8. Demonstration

Run these in a second terminal.

```bash
# 1. Manufacturer creates a product
curl -X POST localhost:3001/products -H 'x-user: mfg1' -H 'content-type: application/json' \
  -d '{"productId":"P100","name":"Paracetamol 500mg","batchNo":"B-2026-11","origin":"Pune Plant"}'

# 2. Manufacturer ships it to the distributor
curl -X POST localhost:3001/products/P100/ship -H 'x-user: mfg1' -H 'content-type: application/json' \
  -d '{"toUserId":"dist1","carrier":"BlueDart","location":"Pune Dispatch"}'

# 3. Wrong party tries to receive -> rejected
curl -X POST localhost:3001/products/P100/receive -H 'x-user: retail1' -H 'content-type: application/json' \
  -d '{"location":"Mumbai Store"}'

# 4. Distributor receives, logs a checkpoint, ships to retailer
curl -X POST localhost:3001/products/P100/receive -H 'x-user: dist1' -H 'content-type: application/json' \
  -d '{"location":"Mumbai Warehouse"}'
curl -X POST localhost:3001/products/P100/track -H 'x-user: dist1' -H 'content-type: application/json' \
  -d '{"location":"Mumbai Warehouse","note":"Cold storage 4C"}'
curl -X POST localhost:3001/products/P100/ship -H 'x-user: dist1' -H 'content-type: application/json' \
  -d '{"toUserId":"retail1","carrier":"Own fleet","location":"Mumbai Warehouse"}'

# 5. Retailer receives and sells
curl -X POST localhost:3001/products/P100/receive -H 'x-user: retail1' -H 'content-type: application/json' \
  -d '{"location":"Andheri Store"}'
curl -X POST localhost:3001/products/P100/sell -H 'x-user: retail1' -H 'content-type: application/json' \
  -d '{"customerRef":"CUST-8841"}'

# 6. Provenance: current state with events, and ledger history
curl localhost:3001/products/P100 -H 'x-user: mfg1'
curl localhost:3001/products/P100/history -H 'x-user: mfg1'

# 7. Queries
curl 'localhost:3001/products?status=SOLD' -H 'x-user: mfg1'
```

### Expected results

| Step | Expected |
|---|---|
| 1 | Product JSON, status `MANUFACTURED`, owner `mfg1` |
| 2 | Status `IN_TRANSIT`, `pendingOwner: dist1` |
| 3 | Error: `Only the intended recipient (dist1) can receive it` |
| 4 | Owner becomes `dist1`, status `RECEIVED`, checkpoint added, then `IN_TRANSIT` to `retail1` |
| 5 | Final status `SOLD`, `soldTo: CUST-8841` |
| 6 | Events list: CREATED, SHIPPED, RECEIVED, CHECKPOINT, SHIPPED, RECEIVED, SOLD. History shows one entry per transaction with tx IDs |
| 7 | List containing `P100` |

Try also: `dist1` calling create (denied by role), and `mfg1` shipping the product after it is sold (rejected).

Take screenshots of each step for your lab record.

## 9. Result

A working supply chain tracking system was built on Hyperledger Fabric. Products are registered by the manufacturer and tracked through every hand-over to the final sale; each event is signed, time-stamped and stored permanently, and role-based rules prevent unauthorised or out-of-order actions. The Node.js API makes the ledger usable from any client.

## 10. Viva Questions

1. What is a permissioned blockchain and why is it suitable for supply chains?
2. Explain the roles of peer, orderer, MSP and channel in Fabric.
3. What is chaincode, and what is the difference between `submitTransaction` and `evaluateTransaction`?
4. What is the endorsement policy and what does the default test-network policy require?
5. How does the world state differ from the ledger (blockchain)?
6. How does `getHistoryForKey` help with provenance?
7. How are roles enforced in this project?
8. Why does ownership change only at `receiveProduct` and not at `shipProduct`?
9. What happens when two transactions update the same product at the same time (MVCC conflict)?
10. How could IoT sensors (temperature, GPS) be integrated?

## 11. Possible Extensions

- Add IoT sensor data and automatic alerts for temperature breaches.
- Add QR codes so customers can scan a product and view its history.
- Add a web dashboard (React) on top of the API.
- Add private data collections for commercial prices between parties.
