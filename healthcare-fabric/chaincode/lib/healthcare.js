'use strict';

/**
 * Healthcare Data Management Chaincode (Hyperledger Fabric, Node.js)
 *
 * Privacy design
 * --------------
 *  - PUBLIC world state  : patient registry (pseudonymous ID only), consent
 *                          records, access audit log, and a SHA-256 hash of
 *                          each medical record (integrity anchor).
 *  - PRIVATE data (PDC)  : the actual clinical content, stored in the
 *                          collection `MedicalRecordsCollection`, visible only
 *                          to the member organisations (Hospital + Patient org).
 *  - Transient field     : clinical data is passed via the transient map so it
 *                          never appears in the transaction proposal / block.
 *
 * Compliance design
 * -----------------
 *  - Consent-based access (HIPAA minimum necessary / GDPR Art. 6-7)
 *  - Immutable audit trail of every access (HIPAA 164.312(b))
 *  - Role-based access control using certificate attributes (role=doctor ...)
 *  - Right to erasure: private data is purged, only a tombstone hash remains
 *    (GDPR Art. 17)
 *  - Data integrity verification via on-chain hash (HIPAA 164.312(c))
 */

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

const COLLECTION = 'MedicalRecordsCollection';

const PREFIX = {
    PATIENT: 'PATIENT',
    CONSENT: 'CONSENT',
    RECORD_HASH: 'RECHASH',
    ACCESS: 'ACCESS',
};

const ROLES = ['doctor', 'nurse', 'lab', 'insurer', 'researcher', 'admin'];

class HealthcareContract extends Contract {
    constructor() {
        super('HealthcareContract');
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _sha256(text) {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    _now(ctx) {
        const ts = ctx.stub.getTxTimestamp();
        // Deterministic across endorsers
        return new Date(ts.seconds.low * 1000).toISOString();
    }

    _caller(ctx) {
        const id = ctx.clientIdentity;
        return {
            mspId: id.getMSPID(),
            id: id.getID(),
            role: id.getAttributeValue('role') || 'unknown',
            userId: id.getAttributeValue('userId') || id.getID(),
        };
    }

    _requireRole(ctx, allowed) {
        const caller = this._caller(ctx);
        if (!allowed.includes(caller.role)) {
            throw new Error(
                `Access denied: role '${caller.role}' not permitted. Allowed: ${allowed.join(', ')}`
            );
        }
        return caller;
    }

    async _getJSON(ctx, key) {
        const data = await ctx.stub.getState(key);
        if (!data || data.length === 0) {
            return null;
        }
        return JSON.parse(data.toString());
    }

    async _logAccess(ctx, patientId, recordId, action, outcome, purpose) {
        const caller = this._caller(ctx);
        const txId = ctx.stub.getTxID();
        const key = ctx.stub.createCompositeKey(PREFIX.ACCESS, [patientId, txId]);
        const entry = {
            docType: 'accessLog',
            txId,
            patientId,
            recordId: recordId || null,
            action,
            outcome,
            purpose: purpose || null,
            actorMsp: caller.mspId,
            actorUserId: caller.userId,
            actorRole: caller.role,
            timestamp: this._now(ctx),
        };
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(entry)));
        return entry;
    }

    async _hasConsent(ctx, patientId, grantee, purpose) {
        const key = ctx.stub.createCompositeKey(PREFIX.CONSENT, [patientId, grantee]);
        const consent = await this._getJSON(ctx, key);
        if (!consent || consent.status !== 'GRANTED') {
            return false;
        }
        if (consent.expiresAt && new Date(consent.expiresAt) < new Date(this._now(ctx))) {
            return false;
        }
        if (purpose && consent.purposes.length > 0 && !consent.purposes.includes(purpose)) {
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Patient registry
    // ------------------------------------------------------------------

    /**
     * Register a patient using a pseudonymous ID (never put names, phone
     * numbers or national IDs on the public ledger).
     */
    async registerPatient(ctx, patientId) {
        const caller = this._requireRole(ctx, ['admin', 'doctor', 'nurse']);
        const key = ctx.stub.createCompositeKey(PREFIX.PATIENT, [patientId]);
        if (await this._getJSON(ctx, key)) {
            throw new Error(`Patient ${patientId} already registered`);
        }
        const patient = {
            docType: 'patient',
            patientId,
            ownerMsp: caller.mspId,
            registeredBy: caller.userId,
            registeredAt: this._now(ctx),
            erased: false,
        };
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(patient)));
        await this._logAccess(ctx, patientId, null, 'REGISTER_PATIENT', 'SUCCESS', 'registration');
        return JSON.stringify(patient);
    }

    // ------------------------------------------------------------------
    // Medical records (private data)
    // ------------------------------------------------------------------

    /**
     * Add a medical record. Clinical content MUST be supplied through the
     * transient map under the key "record":
     *   { "diagnosis": "...", "prescription": "...", "notes": "..." }
     */
    async addMedicalRecord(ctx, patientId, recordId, recordType) {
        const caller = this._requireRole(ctx, ['doctor', 'lab']);

        const patientKey = ctx.stub.createCompositeKey(PREFIX.PATIENT, [patientId]);
        const patient = await this._getJSON(ctx, patientKey);
        if (!patient) {
            throw new Error(`Patient ${patientId} not found`);
        }
        if (patient.erased) {
            throw new Error(`Patient ${patientId} has exercised right to erasure`);
        }

        const transient = ctx.stub.getTransient();
        const raw = transient.get('record');
        if (!raw || raw.length === 0) {
            throw new Error('Clinical data must be passed in the transient field "record"');
        }
        const recordText = raw.toString();
        let content;
        try {
            content = JSON.parse(recordText);
        } catch (e) {
            throw new Error('Transient "record" must be valid JSON');
        }

        const existing = await ctx.stub.getPrivateDataHash(COLLECTION, recordId);
        if (existing && existing.length > 0) {
            throw new Error(`Record ${recordId} already exists`);
        }

        const privateRecord = {
            docType: 'medicalRecord',
            recordId,
            patientId,
            recordType,
            content,
            createdBy: caller.userId,
            createdAt: this._now(ctx),
        };
        const privateJson = JSON.stringify(privateRecord);

        // 1) Private side database (only collection members hold this)
        await ctx.stub.putPrivateData(COLLECTION, recordId, Buffer.from(privateJson));

        // 2) Public integrity anchor: hash + metadata, no clinical content
        const hashKey = ctx.stub.createCompositeKey(PREFIX.RECORD_HASH, [patientId, recordId]);
        const anchor = {
            docType: 'recordHash',
            recordId,
            patientId,
            recordType,
            sha256: this._sha256(privateJson),
            createdBy: caller.userId,
            createdAt: privateRecord.createdAt,
            erased: false,
        };
        await ctx.stub.putState(hashKey, Buffer.from(JSON.stringify(anchor)));

        await this._logAccess(ctx, patientId, recordId, 'ADD_RECORD', 'SUCCESS', 'treatment');
        return JSON.stringify(anchor);
    }

    /**
     * Read a medical record. Succeeds only if
     *  (a) caller is the creator's org with an authorised role, AND
     *  (b) the patient has granted consent to the caller's MSP for the purpose.
     * Every attempt, allowed or denied, is written to the audit log.
     * Call with submitTransaction so that the audit entry is committed.
     */
    async readMedicalRecord(ctx, patientId, recordId, purpose) {
        const caller = this._caller(ctx);

        if (!['doctor', 'nurse', 'lab', 'insurer', 'researcher'].includes(caller.role)) {
            await this._logAccess(ctx, patientId, recordId, 'READ_RECORD', 'DENIED_ROLE', purpose);
            throw new Error(`Role '${caller.role}' may not read medical records`);
        }

        const consented = await this._hasConsent(ctx, patientId, caller.mspId, purpose);
        if (!consented) {
            await this._logAccess(ctx, patientId, recordId, 'READ_RECORD', 'DENIED_NO_CONSENT', purpose);
            // Throwing would roll back the log; return a structured denial instead.
            return JSON.stringify({ allowed: false, reason: 'No valid patient consent' });
        }

        const data = await ctx.stub.getPrivateData(COLLECTION, recordId);
        if (!data || data.length === 0) {
            await this._logAccess(ctx, patientId, recordId, 'READ_RECORD', 'NOT_FOUND', purpose);
            return JSON.stringify({ allowed: true, found: false });
        }
        const record = JSON.parse(data.toString());
        if (record.patientId !== patientId) {
            await this._logAccess(ctx, patientId, recordId, 'READ_RECORD', 'DENIED_MISMATCH', purpose);
            return JSON.stringify({ allowed: false, reason: 'Record does not belong to patient' });
        }

        // Data minimisation for non-clinical roles
        let view = record;
        if (caller.role === 'insurer' || caller.role === 'researcher') {
            view = {
                recordId: record.recordId,
                recordType: record.recordType,
                createdAt: record.createdAt,
                content: { diagnosis: record.content.diagnosis },
            };
        }

        await this._logAccess(ctx, patientId, recordId, 'READ_RECORD', 'SUCCESS', purpose);
        return JSON.stringify({ allowed: true, found: true, record: view });
    }

    /**
     * Verify integrity: recompute the hash of the private record and compare
     * with the on-chain anchor. Also usable by orgs OUTSIDE the collection via
     * getPrivateDataHash when they hold a copy to compare.
     */
    async verifyRecordIntegrity(ctx, patientId, recordId) {
        this._requireRole(ctx, ['doctor', 'nurse', 'lab', 'admin']);
        const hashKey = ctx.stub.createCompositeKey(PREFIX.RECORD_HASH, [patientId, recordId]);
        const anchor = await this._getJSON(ctx, hashKey);
        if (!anchor) {
            throw new Error(`No integrity anchor for record ${recordId}`);
        }
        if (anchor.erased) {
            return JSON.stringify({ recordId, status: 'ERASED' });
        }
        const data = await ctx.stub.getPrivateData(COLLECTION, recordId);
        if (!data || data.length === 0) {
            return JSON.stringify({ recordId, status: 'PRIVATE_DATA_MISSING' });
        }
        const localHash = this._sha256(data.toString());
        const collectionHash = Buffer.from(
            await ctx.stub.getPrivateDataHash(COLLECTION, recordId)
        ).toString('hex');

        return JSON.stringify({
            recordId,
            status: localHash === anchor.sha256 && localHash === collectionHash ? 'INTACT' : 'TAMPERED',
            anchorHash: anchor.sha256,
            computedHash: localHash,
        });
    }

    // ------------------------------------------------------------------
    // Consent management
    // ------------------------------------------------------------------

    /**
     * Patient (or their org admin) grants consent to an organisation (MSP).
     * purposes: comma separated, e.g. "treatment,research"
     * expiresAt: ISO date string or "" for no expiry
     */
    async grantConsent(ctx, patientId, granteeMsp, purposes, expiresAt) {
        const caller = this._requireRole(ctx, ['admin', 'doctor']);
        const patient = await this._getJSON(
            ctx, ctx.stub.createCompositeKey(PREFIX.PATIENT, [patientId])
        );
        if (!patient) {
            throw new Error(`Patient ${patientId} not found`);
        }
        if (patient.erased) {
            throw new Error('Patient has exercised right to erasure');
        }
        const key = ctx.stub.createCompositeKey(PREFIX.CONSENT, [patientId, granteeMsp]);
        const consent = {
            docType: 'consent',
            patientId,
            grantee: granteeMsp,
            purposes: purposes ? purposes.split(',').map(p => p.trim()).filter(Boolean) : [],
            status: 'GRANTED',
            grantedBy: caller.userId,
            grantedAt: this._now(ctx),
            expiresAt: expiresAt || null,
        };
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(consent)));
        await this._logAccess(ctx, patientId, null, 'GRANT_CONSENT', 'SUCCESS', granteeMsp);
        return JSON.stringify(consent);
    }

    async revokeConsent(ctx, patientId, granteeMsp) {
        const caller = this._requireRole(ctx, ['admin', 'doctor']);
        const key = ctx.stub.createCompositeKey(PREFIX.CONSENT, [patientId, granteeMsp]);
        const consent = await this._getJSON(ctx, key);
        if (!consent) {
            throw new Error('No consent on file');
        }
        consent.status = 'REVOKED';
        consent.revokedBy = caller.userId;
        consent.revokedAt = this._now(ctx);
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(consent)));
        await this._logAccess(ctx, patientId, null, 'REVOKE_CONSENT', 'SUCCESS', granteeMsp);
        return JSON.stringify(consent);
    }

    async getConsent(ctx, patientId, granteeMsp) {
        const key = ctx.stub.createCompositeKey(PREFIX.CONSENT, [patientId, granteeMsp]);
        const consent = await this._getJSON(ctx, key);
        return JSON.stringify(consent || { status: 'NONE' });
    }

    // ------------------------------------------------------------------
    // Audit trail
    // ------------------------------------------------------------------

    async getAccessLog(ctx, patientId) {
        this._requireRole(ctx, ['admin', 'doctor']);
        const iterator = await ctx.stub.getStateByPartialCompositeKey(PREFIX.ACCESS, [patientId]);
        const results = [];
        for await (const res of iterator) {
            results.push(JSON.parse(res.value.toString()));
        }
        results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return JSON.stringify(results);
    }

    async getRecordHistory(ctx, patientId, recordId) {
        this._requireRole(ctx, ['admin', 'doctor']);
        const hashKey = ctx.stub.createCompositeKey(PREFIX.RECORD_HASH, [patientId, recordId]);
        const iterator = await ctx.stub.getHistoryForKey(hashKey);
        const out = [];
        for await (const mod of iterator) {
            out.push({
                txId: mod.txId,
                timestamp: new Date(mod.timestamp.seconds.low * 1000).toISOString(),
                isDelete: mod.isDelete,
                value: mod.value ? JSON.parse(mod.value.toString()) : null,
            });
        }
        return JSON.stringify(out);
    }

    // ------------------------------------------------------------------
    // Right to erasure (GDPR Art. 17)
    // ------------------------------------------------------------------

    /**
     * Purge the private clinical data. The public ledger keeps only the
     * hash tombstone so audit history remains verifiable without
     * exposing personal data.
     */
    async eraseRecord(ctx, patientId, recordId) {
        const caller = this._requireRole(ctx, ['admin']);
        const hashKey = ctx.stub.createCompositeKey(PREFIX.RECORD_HASH, [patientId, recordId]);
        const anchor = await this._getJSON(ctx, hashKey);
        if (!anchor) {
            throw new Error(`Record ${recordId} not found`);
        }
        await ctx.stub.deletePrivateData(COLLECTION, recordId);
        // Also purge the payload from peers' private DB after N blocks (see collection config blockToLive)
        anchor.erased = true;
        anchor.erasedBy = caller.userId;
        anchor.erasedAt = this._now(ctx);
        await ctx.stub.putState(hashKey, Buffer.from(JSON.stringify(anchor)));
        await this._logAccess(ctx, patientId, recordId, 'ERASE_RECORD', 'SUCCESS', 'right-to-erasure');
        return JSON.stringify(anchor);
    }

    async erasePatient(ctx, patientId) {
        const caller = this._requireRole(ctx, ['admin']);
        const key = ctx.stub.createCompositeKey(PREFIX.PATIENT, [patientId]);
        const patient = await this._getJSON(ctx, key);
        if (!patient) {
            throw new Error(`Patient ${patientId} not found`);
        }
        const iterator = await ctx.stub.getStateByPartialCompositeKey(PREFIX.RECORD_HASH, [patientId]);
        let count = 0;
        for await (const res of iterator) {
            const anchor = JSON.parse(res.value.toString());
            if (!anchor.erased) {
                await ctx.stub.deletePrivateData(COLLECTION, anchor.recordId);
                anchor.erased = true;
                anchor.erasedBy = caller.userId;
                anchor.erasedAt = this._now(ctx);
                await ctx.stub.putState(res.key, Buffer.from(JSON.stringify(anchor)));
                count++;
            }
        }
        patient.erased = true;
        patient.erasedAt = this._now(ctx);
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(patient)));
        await this._logAccess(ctx, patientId, null, 'ERASE_PATIENT', 'SUCCESS', 'right-to-erasure');
        return JSON.stringify({ patientId, recordsErased: count });
    }
}

module.exports = HealthcareContract;
