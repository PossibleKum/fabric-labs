#!/usr/bin/env bash
# Exp 9 demo (API must be running on :3000)
source "$(dirname "$0")/pp.sh"
B=http://localhost:3000
P="P$(date +%s)"
post() { curl -s -X POST "$B$2" -H "x-user: $1" -H 'content-type: application/json' -d "$3" | pp; }
get()  { curl -s "$B$2" -H "x-user: $1" | pp; }
del()  { curl -s -X DELETE "$B$2" -H "x-user: $1" | pp; }
step() { echo; echo "=================== $1"; }

step "1. Register patient $P";                         post admin1 /patients "{\"patientId\":\"$P\"}"
step "2. Doctor adds record (clinical data in transient field)"; post dr_asha /patients/$P/records '{"recordId":"R-1","recordType":"diagnosis","content":{"diagnosis":"Type 2 diabetes","prescription":"Metformin 500mg","notes":"Follow up in 3 months"}}'
step "3. Insurer reads WITHOUT consent -> denied and logged";  get insurer1 "/patients/$P/records/R-1?purpose=claim"
step "4. Patient consent granted to Org2MSP for claims";       post admin1 /patients/$P/consent '{"grantee":"Org2MSP","purposes":["claim"],"expiresAt":"2030-01-01T00:00:00Z"}'
step "5. Insurer reads again -> minimised view";               get insurer1 "/patients/$P/records/R-1?purpose=claim"
step "6. Integrity check";                                     get dr_asha /patients/$P/records/R-1/verify
step "7. Audit trail";                                         get admin1 /patients/$P/audit
step "8a. Revoke consent";                                     del admin1 /patients/$P/consent/Org2MSP
step "8b. Right to erasure";                                   del admin1 /patients/$P/records/R-1
step "8c. Integrity check after erasure (expect ERASED)";      get dr_asha /patients/$P/records/R-1/verify
