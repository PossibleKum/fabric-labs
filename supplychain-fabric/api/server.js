'use strict';

/**
 * REST gateway for the Supply Chain Fabric chaincode.
 *
 * Identity: each request names a wallet identity in the `x-user` header
 * (mfg1, dist1, retail1). The identity's certificate carries the `role`
 * attribute used by the chaincode.
 *
 * Run: node server.js
 * Env: CCP_ORG1, CCP_ORG2, WALLET_PATH, CHANNEL, CHAINCODE, PORT
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Gateway, Wallets } = require('fabric-network');

const CCP_PATHS = {
    Org1MSP: process.env.CCP_ORG1 || path.join(__dirname, 'connection-org1.json'),
    Org2MSP: process.env.CCP_ORG2 || path.join(__dirname, 'connection-org2.json'),
};
const WALLET_PATH = process.env.WALLET_PATH || path.join(__dirname, 'wallet');
const CHANNEL = process.env.CHANNEL || 'healthchannel';
const CHAINCODE = process.env.CHAINCODE || 'supplychain';
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());

async function withContract(user, fn) {
    if (!user) {
        const err = new Error('Missing x-user header');
        err.status = 401;
        throw err;
    }
    const wallet = await Wallets.newFileSystemWallet(WALLET_PATH);
    const identity = await wallet.get(user);
    if (!identity) {
        const err = new Error(`Identity '${user}' not found in wallet`);
        err.status = 401;
        throw err;
    }
    const ccp = JSON.parse(fs.readFileSync(CCP_PATHS[identity.mspId], 'utf8'));
    const gateway = new Gateway();
    try {
        await gateway.connect(ccp, {
            wallet,
            identity: user,
            discovery: { enabled: true, asLocalhost: true },
        });
        const network = await gateway.getNetwork(CHANNEL);
        const contract = network.getContract(CHAINCODE, 'SupplyChainContract');
        return await fn(contract);
    } finally {
        gateway.disconnect();
    }
}

const wrap = handler => async (req, res) => {
    try {
        res.json(await handler(req, res));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
};

const parse = buf => {
    const s = buf.toString();
    return s ? JSON.parse(s) : {};
};

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Create product (manufacturer)
app.post('/products', wrap(req =>
    withContract(req.get('x-user'), async c => {
        const { productId, name, batchNo, origin } = req.body;
        return parse(await c.submitTransaction('createProduct', productId, name, batchNo, origin));
    })
));

// Ship to next party
app.post('/products/:id/ship', wrap(req =>
    withContract(req.get('x-user'), async c => {
        const { toUserId, carrier, location } = req.body;
        return parse(await c.submitTransaction(
            'shipProduct', req.params.id, toUserId, carrier || 'N/A', location));
    })
));

// Recipient confirms receipt
app.post('/products/:id/receive', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction('receiveProduct', req.params.id, req.body.location)))
));

// Checkpoint event
app.post('/products/:id/track', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction(
            'addTrackingEvent', req.params.id, req.body.location, req.body.note || '')))
));

// Retail sale
app.post('/products/:id/sell', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction('sellProduct', req.params.id, req.body.customerRef)))
));

// List / filter
app.get('/products', wrap(req =>
    withContract(req.get('x-user'), async c => {
        if (req.query.status) {
            return parse(await c.evaluateTransaction('getProductsByStatus', req.query.status));
        }
        if (req.query.owner) {
            return parse(await c.evaluateTransaction('getProductsByOwner', req.query.owner));
        }
        return parse(await c.evaluateTransaction('getAllProducts'));
    })
));

// One product (current state + event list)
app.get('/products/:id', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.evaluateTransaction('getProduct', req.params.id)))
));

// Full ledger history (provenance)
app.get('/products/:id/history', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.evaluateTransaction('getProductHistory', req.params.id)))
));

if (require.main === module) {
    app.listen(PORT, () => console.log(`Supply chain API listening on :${PORT}`));
}

module.exports = app;
