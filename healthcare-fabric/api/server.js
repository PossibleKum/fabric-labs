'use strict';

/**
 * REST gateway for the Healthcare Fabric network.
 *
 * Identity: each request names a wallet identity in the `x-user` header
 * (e.g. dr_asha, nurse_ravi, insurer_amit). The identity's X.509 certificate
 * carries the `role` attribute that the chaincode uses for RBAC.
 *
 * Run: node server.js
 * Env: CCP_ORG1, CCP_ORG2, WALLET_PATH, CHANNEL, CHAINCODE
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Gateway, Wallets } = require('fabric-network');

// One connection profile per organisation (the identity's MSP selects which is used)
const CCP_PATHS = {
    Org1MSP: process.env.CCP_ORG1 || path.join(__dirname, 'connection-org1.json'),
    Org2MSP: process.env.CCP_ORG2 || path.join(__dirname, 'connection-org2.json'),
};
const WALLET_PATH = process.env.WALLET_PATH || path.join(__dirname, 'wallet');
const CHANNEL = process.env.CHANNEL || 'healthchannel';
const CHAINCODE = process.env.CHAINCODE || 'healthcare';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Fabric connection helper
// ---------------------------------------------------------------------------
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
        const contract = network.getContract(CHAINCODE, 'HealthcareContract');
        return await fn(contract);
    } finally {
        gateway.disconnect();
    }
}

const wrap = handler => async (req, res) => {
    try {
        const out = await handler(req, res);
        if (!res.headersSent) {
            res.json(out);
        }
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
};

const parse = buf => {
    const s = buf.toString();
    return s ? JSON.parse(s) : {};
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Register a patient (pseudonymous ID only)
app.post('/patients', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction('registerPatient', req.body.patientId)))
));

// Add a medical record. Clinical data goes in the transient map, never in args.
app.post('/patients/:patientId/records', wrap(req =>
    withContract(req.get('x-user'), async c => {
        const { recordId, recordType, content } = req.body;
        const tx = c.createTransaction('addMedicalRecord');
        tx.setTransient({ record: Buffer.from(JSON.stringify(content)) });
        // Restrict endorsement to collection members so private data is not sent elsewhere
        tx.setEndorsingOrganizations('Org1MSP', 'Org2MSP');
        const result = await tx.submit(req.params.patientId, recordId, recordType);
        return parse(result);
    })
));

// Read a record (consent + role checked on chain; audit entry written)
app.get('/patients/:patientId/records/:recordId', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction(
            'readMedicalRecord',
            req.params.patientId,
            req.params.recordId,
            req.query.purpose || 'treatment'
        )))
));

// Integrity check against the on-chain hash
app.get('/patients/:patientId/records/:recordId/verify', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.evaluateTransaction(
            'verifyRecordIntegrity', req.params.patientId, req.params.recordId)))
));

// Record version history
app.get('/patients/:patientId/records/:recordId/history', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.evaluateTransaction(
            'getRecordHistory', req.params.patientId, req.params.recordId)))
));

// Consent
app.post('/patients/:patientId/consent', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction(
            'grantConsent',
            req.params.patientId,
            req.body.grantee,
            (req.body.purposes || []).join(','),
            req.body.expiresAt || ''
        )))
));

app.delete('/patients/:patientId/consent/:grantee', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction(
            'revokeConsent', req.params.patientId, req.params.grantee)))
));

app.get('/patients/:patientId/consent/:grantee', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.evaluateTransaction(
            'getConsent', req.params.patientId, req.params.grantee)))
));

// Audit log
app.get('/patients/:patientId/audit', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.evaluateTransaction('getAccessLog', req.params.patientId)))
));

// Right to erasure
app.delete('/patients/:patientId/records/:recordId', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction(
            'eraseRecord', req.params.patientId, req.params.recordId)))
));

app.delete('/patients/:patientId', wrap(req =>
    withContract(req.get('x-user'), async c =>
        parse(await c.submitTransaction('erasePatient', req.params.patientId)))
));

if (require.main === module) {
    app.listen(PORT, () => console.log(`Healthcare API listening on :${PORT}`));
}

module.exports = app;
