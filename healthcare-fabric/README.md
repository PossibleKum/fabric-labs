# Exp 9 – Blockchain-Based Healthcare Data Management System

**Platform:** Hyperledger Fabric 2.5 · **Chaincode & API:** Node.js · **Focus:** Privacy and compliance (HIPAA / GDPR)

---

## 1. Aim

To develop a blockchain-based healthcare data management system using Hyperledger Fabric that keeps patient data private, lets patients control access through consent, records every access immutably, and supports regulatory requirements such as HIPAA and GDPR.

## 2. Objectives

1. Store clinical data off the public ledger using **Private Data Collections (PDC)**.
2. Keep only a **SHA-256 hash** of each record on the shared ledger to prove integrity.
3. Enforce **patient consent** and **role-based access control** inside the chaincode.
4. Maintain an **immutable audit trail** of every read, write, grant and revoke.
5. Support the **right to erasure** without breaking ledger integrity.

## 3. Why Fabric (vs Ethereum)

| Requirement | Hyperledger Fabric | Public Ethereum |
|---|---|---|
| Permissioned membership | Yes (MSP, CA) | No |
| Data confidentiality | Private data collections, channels | All state is public |
| Identity | X.509 certs with attributes | Pseudonymous addresses |
| Throughput / no gas cost | High, no gas | Gas fees, slower |
| Right to erasure | Private data can be purged | Not possible on-chain |

Fabric is therefore the better fit for healthcare.

## 4. System Architecture

```
 Client (Doctor / Nurse / Insurer / Patient portal)
            │  HTTPS + x-user identity
            ▼
   Node.js REST API (Express + fabric-network)
            │  gRPC (Gateway)
            ▼
 ┌─────────────────────── Fabric channel: healthchannel ───────────────────────┐
 │  HospitalMSP peer     PatientOrgMSP peer      InsurerMSP peer    Orderer(Raft)│
 │       │                      │                      │                         │
 │   Private data  ◄──── MedicalRecordsCollection ────► (NOT a member)          │
 │   (clinical content)                                                          │
 │   Public world state: patient registry, consent, record hash, audit log      │
 └──────────────────────────────────────────────────────────────────────────────┘
```

**Organisations**

- `HospitalMSP` – hospitals and clinics (doctors, nurses, lab)
- `PatientOrgMSP` – patient-controlled organisation
- `InsurerMSP` – insurer (sees only data the patient consents to, minimised view)

**What goes where**

| Data | Location | Reason |
|---|---|---|
| Diagnosis, prescription, notes | Private data collection (via transient field) | Confidential |
| SHA-256 of record | Public state | Integrity proof, no personal data |
| Pseudonymous patient ID | Public state | Linking only |
| Consent records | Public state | Transparent, auditable |
| Access log | Public state | Tamper-proof audit |

## 5. Project Structure

```
healthcare-fabric/
├── chaincode/
│   ├── package.json
│   ├── index.js
│   └── lib/healthcare.js        # Smart contract
├── api/
│   ├── package.json
│   └── server.js                # REST gateway
├── collections_config.json      # Private data collection definition
└── README.md
```

## 6. Smart Contract Functions

| Function | Who can call | Purpose |
|---|---|---|
| `registerPatient` | admin, doctor, nurse | Register pseudonymous patient |
| `addMedicalRecord` | doctor, lab | Store record in PDC, hash on ledger |
| `readMedicalRecord` | doctor, nurse, lab, insurer, researcher | Consent-checked read, logged |
| `verifyRecordIntegrity` | doctor, nurse, lab, admin | Compare computed hash to on-chain hash |
| `grantConsent` / `revokeConsent` / `getConsent` | admin, doctor | Manage patient consent |
| `getAccessLog` | admin, doctor | Full audit trail |
| `getRecordHistory` | admin, doctor | Ledger history of a record |
| `eraseRecord` / `erasePatient` | admin | Right to erasure |

## 7. Compliance Mapping

| Regulation | Requirement | How it is met |
|---|---|---|
| HIPAA 164.312(a) | Access control | RBAC using certificate attribute `role`, checked in every function |
| HIPAA 164.312(b) | Audit controls | `ACCESS` entries written for every action, including denied attempts |
| HIPAA 164.312(c) | Integrity | SHA-256 anchor plus `verifyRecordIntegrity` |
| HIPAA 164.312(e) | Transmission security | TLS / mutual TLS between all Fabric components |
| HIPAA minimum necessary | Limit exposure | Insurer / researcher get a reduced view |
| GDPR Art. 5(1)(c) | Data minimisation | Only hash and pseudonymous ID on shared ledger |
| GDPR Art. 6–7 | Lawful basis, consent | `grantConsent` / `revokeConsent` with purpose and expiry |
| GDPR Art. 17 | Right to erasure | `deletePrivateData`; only a tombstone hash remains |
| GDPR Art. 25 | Privacy by design | Transient field, PDC, no personal data in args |

**Known limitation to mention in your viva:** the on-chain hash and audit log cannot be deleted. They are pseudonymous and contain no clinical content, which is the accepted design approach, but it should be validated with legal counsel in a real deployment.

## 8. Setup and Execution

### 8.1 Prerequisites

- Docker and Docker Compose
- Node.js 18+
- Hyperledger Fabric binaries and samples (v2.5)

```bash
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh docker samples binary
```

### 8.2 Start the test network with a CA

```bash
cd fabric-samples/test-network
./network.sh down
./network.sh up createChannel -c healthchannel -ca
```

The test network provides `Org1MSP` (used as the hospital) and `Org2MSP` (used as the patient organisation, and in the demo also as the insurer-side reader). The code and `collections_config.json` already use these names.

### 8.3 Deploy the chaincode with the private data collection

```bash
./network.sh deployCC -c healthchannel -ccn healthcare \
  -ccp /path/to/healthcare-fabric/chaincode -ccl javascript \
  -cccg /path/to/healthcare-fabric/collections_config.json
```

### 8.4 Register identities with a `role` attribute

Easiest: `cd api && npm install && node enrollUsers.js` creates `admin1`, `dr_asha` (Org1) and `insurer1` (Org2) in `api/wallet` with the right `role` attribute. Manual alternative with the Fabric CA client:

```bash
fabric-ca-client register --id.name dr_asha --id.secret pw --id.type client \
  --id.attrs 'role=doctor:ecert,userId=dr_asha:ecert'
fabric-ca-client enroll -u https://dr_asha:pw@localhost:7054 \
  --enrollment.attrs 'role,userId' -M ./dr_asha/msp
```



### 8.5 Run the API

```bash
cd api
npm install
export CCP_ORG1=~/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/connection-org1.json
export CCP_ORG2=~/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/connection-org2.json
node server.js
```

## 9. Demonstration (curl)

```bash
# 1. Register a patient (pseudonymous ID)
curl -X POST localhost:3000/patients -H 'x-user: admin1' \
  -H 'content-type: application/json' -d '{"patientId":"P-1001"}'

# 2. Doctor adds a record (clinical data travels in transient field)
curl -X POST localhost:3000/patients/P-1001/records -H 'x-user: dr_asha' \
  -H 'content-type: application/json' \
  -d '{"recordId":"R-1","recordType":"diagnosis",
       "content":{"diagnosis":"Type 2 diabetes","prescription":"Metformin 500mg","notes":"Follow up in 3 months"}}'

# 3. Insurer tries to read WITHOUT consent  -> denied, and logged
curl 'localhost:3000/patients/P-1001/records/R-1?purpose=claim' -H 'x-user: insurer1'

# 4. Patient consent granted to InsurerMSP for claims
curl -X POST localhost:3000/patients/P-1001/consent -H 'x-user: admin1' \
  -H 'content-type: application/json' \
  -d '{"grantee":"Org2MSP","purposes":["claim"],"expiresAt":"2027-01-01T00:00:00Z"}'

# 5. Insurer reads again -> minimised view (diagnosis only)
curl 'localhost:3000/patients/P-1001/records/R-1?purpose=claim' -H 'x-user: insurer1'

# 6. Integrity check
curl localhost:3000/patients/P-1001/records/R-1/verify -H 'x-user: dr_asha'

# 7. Audit trail
curl localhost:3000/patients/P-1001/audit -H 'x-user: admin1'

# 8. Revoke consent, then right to erasure
curl -X DELETE localhost:3000/patients/P-1001/consent/Org2MSP -H 'x-user: admin1'
curl -X DELETE localhost:3000/patients/P-1001/records/R-1 -H 'x-user: admin1'
```

### Expected observations

| Step | Expected result |
|---|---|
| 2 | Returns hash anchor only; no clinical text in the block (verify with `peer channel fetch` / block explorer) |
| 3 | `{"allowed":false,"reason":"No valid patient consent"}` and a `DENIED_NO_CONSENT` audit entry |
| 5 | `{"allowed":true,...}` with only the `diagnosis` field |
| 6 | `status: INTACT` |
| 7 | Chronological list of all actions with actor, role, MSP, timestamp |
| 8 | Record verification now returns `ERASED`; private data no longer readable |

Take screenshots of steps 2–8 for your lab record.

## 10. Testing Integrity (tamper test)

Modify the private record directly in the peer's private state DB (or re-submit altered data in a test chaincode), then call `verifyRecordIntegrity`. The result will be `TAMPERED`, since the computed hash no longer matches the on-chain anchor.

## 11. Result

A permissioned blockchain healthcare system was built where clinical data is confined to authorised organisations through private data collections, access is gated by patient consent and role, every action is permanently audited, record integrity is verifiable via hashing, and erasure requests are supported. This satisfies the key technical safeguards of HIPAA and GDPR.

## 12. Viva Questions

1. Why are private data collections used instead of storing data on the channel ledger?
2. What is the transient field and why is it important for privacy?
3. How does Fabric differ from Ethereum for healthcare data?
4. How is the right to erasure supported on an immutable ledger?
5. What does `blockToLive` do in a collection config?
6. How does the chaincode identify the caller's role?
7. Why is the audit entry written even when access is denied (and why return instead of throw)?
8. What is the difference between `evaluateTransaction` and `submitTransaction`?
9. What is the endorsement policy and why restrict endorsers for private data?
10. What are the limitations of storing hashes and audit logs permanently?

## 13. Possible Extensions

- Store large files (X-rays, PDFs) in IPFS/encrypted object storage and keep only the CID and hash on chain.
- Add a patient mobile app with its own identity.
- Add zero-knowledge proofs for eligibility checks without data disclosure.
- Add Hyperledger Explorer for block visualisation.
