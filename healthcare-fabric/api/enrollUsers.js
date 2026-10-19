'use strict';

/**
 * Creates wallet identities with the `role` / `userId` certificate attributes
 * that the chaincode relies on. Uses the Fabric test-network CAs (started with -ca).
 *
 * Usage: CCP_ORG1=... CCP_ORG2=... node enrollUsers.js
 */
const FabricCAServices = require('fabric-ca-client');
const { Wallets } = require('fabric-network');
const fs = require('fs');
const path = require('path');

const ORGS = [
    {
        msp: 'Org1MSP', affiliation: 'org1.department1',
        ccp: process.env.CCP_ORG1, ca: 'ca.org1.example.com',
        users: [['admin1', 'admin'], ['dr_asha', 'doctor']],
    },
    {
        msp: 'Org2MSP', affiliation: 'org2.department1',
        ccp: process.env.CCP_ORG2, ca: 'ca.org2.example.com',
        users: [['insurer1', 'insurer']],
    },
];

async function main() {
    const wallet = await Wallets.newFileSystemWallet(path.join(__dirname, 'wallet'));
    for (const org of ORGS) {
        if (!org.ccp) throw new Error(`Set CCP_ORG${org.msp[3]} to the connection profile path`);
        const ccp = JSON.parse(fs.readFileSync(org.ccp, 'utf8'));
        const caInfo = ccp.certificateAuthorities[org.ca];
        const ca = new FabricCAServices(
            caInfo.url, { trustedRoots: caInfo.tlsCACerts.pem, verify: false }, caInfo.caName);

        // CA bootstrap admin
        const boot = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const bootIdentity = {
            credentials: { certificate: boot.certificate, privateKey: boot.key.toBytes() },
            mspId: org.msp, type: 'X.509',
        };
        const provider = wallet.getProviderRegistry().getProvider('X.509');
        const registrar = await provider.getUserContext(bootIdentity, 'admin');

        for (const [name, role] of org.users) {
            if (await wallet.get(name)) { console.log(`${name}: already in wallet`); continue; }
            const secret = await ca.register({
                affiliation: org.affiliation, enrollmentID: name, role: 'client',
                attrs: [
                    { name: 'role', value: role, ecert: true },
                    { name: 'userId', value: name, ecert: true },
                ],
            }, registrar);
            const enr = await ca.enroll({
                enrollmentID: name, enrollmentSecret: secret,
                attr_reqs: [{ name: 'role', optional: false }, { name: 'userId', optional: false }],
            });
            await wallet.put(name, {
                credentials: { certificate: enr.certificate, privateKey: enr.key.toBytes() },
                mspId: org.msp, type: 'X.509',
            });
            console.log(`${name} (${role}, ${org.msp}) added to wallet`);
        }
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
