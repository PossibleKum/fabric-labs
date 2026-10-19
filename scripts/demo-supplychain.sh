#!/usr/bin/env bash
# Exp 8 demo (API must be running on :3001)
source "$(dirname "$0")/pp.sh"
B=http://localhost:3001
P="P$(date +%s)"
post() { curl -s -X POST "$B$2" -H "x-user: $1" -H 'content-type: application/json' -d "$3" | pp; }
get()  { curl -s "$B$2" -H "x-user: $1" | pp; }
step() { echo; echo "=================== $1"; }

step "1. Manufacturer creates product $P";           post mfg1 /products "{\"productId\":\"$P\",\"name\":\"Paracetamol 500mg\",\"batchNo\":\"B-2026-11\",\"origin\":\"Pune Plant\"}"
step "2. Manufacturer ships to distributor";          post mfg1 /products/$P/ship '{"toUserId":"dist1","carrier":"BlueDart","location":"Pune Dispatch"}'
step "3. Wrong party (retail1) tries to receive -> rejected"; post retail1 /products/$P/receive '{"location":"Mumbai Store"}'
step "4a. Distributor receives";                      post dist1 /products/$P/receive '{"location":"Mumbai Warehouse"}'
step "4b. Distributor adds checkpoint";               post dist1 /products/$P/track '{"location":"Mumbai Warehouse","note":"Cold storage 4C"}'
step "4c. Distributor ships to retailer";             post dist1 /products/$P/ship '{"toUserId":"retail1","carrier":"Own fleet","location":"Mumbai Warehouse"}'
step "5a. Retailer receives";                         post retail1 /products/$P/receive '{"location":"Andheri Store"}'
step "5b. Retailer sells";                            post retail1 /products/$P/sell '{"customerRef":"CUST-8841"}'
step "6a. Final state with events";                   get mfg1 /products/$P
step "6b. Ledger history (provenance)";              get mfg1 /products/$P/history
step "7. Products with status SOLD";                  get mfg1 "/products?status=SOLD"
step "8. Distributor tries to create product -> denied"; post dist1 /products '{"productId":"X1","name":"x","batchNo":"x","origin":"x"}'
